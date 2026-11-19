//! App Sandbox (the Mac App Store build).
//!
//! A sandboxed app can read only its own container until the user picks a
//! folder or a disk in an open panel. Each choice is kept as a
//! security-scoped bookmark, so the next launch reads the same places
//! without asking again. Without the sandbox (the build from source) every
//! function here is a no-op and every path counts as accessible.
//!
//! Full Disk Access still matters inside the sandbox: a granted disk gives
//! access to its files, and Full Disk Access additionally to the places
//! macOS protects (Mail, Messages, Safari, other apps' containers).

use objc2::MainThreadMarker;
use objc2::runtime::Bool;
use objc2_app_kit::NSOpenPanel;
use objc2_foundation::{NSData, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// `NSModalResponseOK`.
const MODAL_OK: isize = 1;

/// Whether this process runs in the App Sandbox (macOS sets this variable
/// for every sandboxed process).
pub fn is_sandboxed() -> bool {
    static SANDBOXED: OnceLock<bool> = OnceLock::new();
    *SANDBOXED.get_or_init(|| std::env::var_os("APP_SANDBOX_CONTAINER_ID").is_some())
}

/// Folders and disks the user has granted, with their bookmarks.
struct Grant {
    path: PathBuf,
    bookmark: Vec<u8>,
}

static GRANTS: Mutex<Vec<Grant>> = Mutex::new(Vec::new());
static STORE: OnceLock<PathBuf> = OnceLock::new();

/// Whether `path` lies inside a granted folder (always true outside the sandbox).
pub fn is_granted(path: &Path) -> bool {
    !is_sandboxed() || GRANTS.lock().iter().any(|g| path.starts_with(&g.path))
}

/// Granted folders, for diagnostics.
pub fn granted_paths() -> Vec<PathBuf> {
    GRANTS.lock().iter().map(|g| g.path.clone()).collect()
}

fn url_for(path: &Path) -> Option<objc2::rc::Retained<NSURL>> {
    let s = NSString::from_str(path.to_str()?);
    Some(NSURL::fileURLWithPath_isDirectory(&s, true))
}

fn path_of(url: &NSURL) -> Option<PathBuf> {
    url.path().map(|p| PathBuf::from(p.to_string()))
}

/// A security-scoped bookmark of a folder this process can access right now
/// (picked in an open panel or dropped on the window). Fails when the
/// sandbox has not granted the folder.
pub fn make_bookmark(path: &Path) -> Option<Vec<u8>> {
    let url = url_for(path)?;
    url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
        NSURLBookmarkCreationOptions::WithSecurityScope,
        None,
        None,
    )
    .ok()
    .map(|d| d.to_vec())
}

/// Resolves a bookmark and starts accessing it for the rest of the run.
/// Returns the folder and, when macOS reports the bookmark as stale, a fresh one.
fn open_bookmark(data: &[u8]) -> Option<(PathBuf, Option<Vec<u8>>)> {
    let data = NSData::with_bytes(data);
    let mut stale = Bool::NO;
    let url = unsafe {
        NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
            &data,
            NSURLBookmarkResolutionOptions::WithSecurityScope,
            None,
            &mut stale,
        )
    }
    .ok()?;
    if !unsafe { url.startAccessingSecurityScopedResource() } {
        return None;
    }
    let path = path_of(&url)?;
    let fresh = if stale.as_bool() { make_bookmark(&path) } else { None };
    Some((path, fresh))
}

// Bookmarks file: a sequence of (u32 little-endian length, bytes).

fn decode(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while rest.len() >= 4 {
        let len = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        rest = &rest[4..];
        if len > rest.len() {
            break;
        }
        out.push(rest[..len].to_vec());
        rest = &rest[len..];
    }
    out
}

fn encode(items: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for item in items {
        out.extend_from_slice(&(item.len() as u32).to_le_bytes());
        out.extend_from_slice(item);
    }
    out
}

fn save(grants: &[Grant]) {
    let Some(file) = STORE.get() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let items: Vec<&[u8]> = grants.iter().map(|g| g.bookmark.as_slice()).collect();
    if let Err(e) = std::fs::write(file, encode(&items)) {
        eprintln!("[sandbox] could not save access grants: {e}");
    }
}

/// Restores the grants of earlier runs. Call once at startup.
pub fn restore(app: &AppHandle) {
    if !is_sandboxed() {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else { return };
    let file = dir.join("access-grants.bin");
    let _ = STORE.set(file.clone());
    let saved = std::fs::read(&file).map(|b| decode(&b)).unwrap_or_default();
    let mut grants = GRANTS.lock();
    let mut changed = false;
    for data in saved {
        match open_bookmark(&data) {
            Some((path, fresh)) => {
                changed |= fresh.is_some();
                if !grants.iter().any(|g| g.path == path) {
                    grants.push(Grant { path, bookmark: fresh.unwrap_or(data) });
                }
            }
            // The folder is gone (an unplugged drive keeps its bookmark,
            // a deleted folder does not resolve) — forget it.
            None => changed = true,
        }
    }
    if changed {
        save(&grants);
    }
}

/// Remembers access to `path` (which this process can read right now).
fn remember(path: &Path) -> bool {
    let Some(bookmark) = make_bookmark(path) else { return false };
    let mut grants = GRANTS.lock();
    // A disk replaces the folders inside it.
    grants.retain(|g| !g.path.starts_with(path));
    grants.push(Grant { path: path.to_path_buf(), bookmark });
    save(&grants);
    true
}

/// Shows an open panel on the main thread. `start` is the folder the panel
/// opens in; confirming without picking anything else selects it.
fn run_panel(app: &AppHandle, start: Option<PathBuf>, message: String, prompt: String) -> Option<PathBuf> {
    let (tx, rx) = std::sync::mpsc::channel();
    let res = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(None);
            return;
        };
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setAllowsMultipleSelection(false);
        panel.setCanCreateDirectories(false);
        panel.setMessage(Some(&NSString::from_str(&message)));
        panel.setPrompt(Some(&NSString::from_str(&prompt)));
        if let Some(url) = start.as_deref().and_then(url_for) {
            panel.setDirectoryURL(Some(&url));
        }
        let picked = if panel.runModal() == MODAL_OK {
            panel.URL().as_deref().and_then(path_of)
        } else {
            None
        };
        let _ = tx.send(picked);
    });
    if res.is_err() {
        return None;
    }
    rx.recv().ok().flatten()
}

/// Lets the user pick a folder; in the sandbox the choice is remembered.
pub fn choose_folder(app: &AppHandle, message: String, prompt: String) -> Option<PathBuf> {
    let picked = run_panel(app, None, message, prompt)?;
    if is_sandboxed() {
        remember(&picked);
    }
    Some(picked)
}

/// Makes sure the app may read `path`, asking the user when needed.
/// Returns the folder to use: `path` itself, or what the user picked
/// instead; `None` when the user cancelled.
pub fn ensure_access(app: &AppHandle, path: &Path, message: String, prompt: String) -> Option<PathBuf> {
    if is_granted(path) {
        return Some(path.to_path_buf());
    }
    // A folder dropped on the window is accessible already: keep it.
    if remember(path) {
        return Some(path.to_path_buf());
    }
    let picked = run_panel(app, Some(path.to_path_buf()), message, prompt)?;
    remember(&picked);
    Some(if picked.as_path() != path && path.starts_with(&picked) { path.to_path_buf() } else { picked })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bookmark_file_round_trip() {
        let a = vec![1u8, 2, 3];
        let b = vec![9u8; 300];
        let bytes = encode(&[&a, &b]);
        assert_eq!(decode(&bytes), vec![a, b]);
        // A truncated file keeps the complete records.
        assert_eq!(decode(&bytes[..bytes.len() - 1]).len(), 1);
        assert!(decode(&[]).is_empty());
    }

    #[test]
    fn everything_is_granted_outside_the_sandbox() {
        if !is_sandboxed() {
            assert!(is_granted(Path::new("/")));
        }
    }
}

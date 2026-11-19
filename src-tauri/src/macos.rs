//! macOS integration: Full Disk Access, Finder, Quick Look, clipboard, Trash.
//!
//! Finder, System Settings and the clipboard go through AppKit rather than
//! `open`/`pbcopy`, so they work the same inside the App Sandbox.

use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString, NSWorkspace};
use objc2_foundation::{NSArray, NSString, NSURL};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Whether this process has Full Disk Access (TCC). Opening the TCC database
/// fails with EPERM without it. `None` = could not tell.
///
/// Note: in `tauri dev` the permission belongs to the terminal app that
/// launched the binary, in a built .app to the app itself.
pub fn has_full_disk_access() -> Option<bool> {
    let home = crate::volumes::home_dir()?;
    // In the App Sandbox the TCC databases may stay closed even with Full Disk
    // Access; folders that only Full Disk Access opens tell it reliably.
    let probes: Vec<PathBuf> = if crate::sandbox::is_sandboxed() {
        vec![home.join("Library/Safari"), home.join("Library/Mail")]
    } else {
        vec![
            home.join("Library/Application Support/com.apple.TCC/TCC.db"),
            PathBuf::from("/Library/Application Support/com.apple.TCC/TCC.db"),
            home.join("Library/Safari"),
        ]
    };
    for p in probes {
        let res = if p.is_dir() {
            std::fs::read_dir(&p).map(|_| ())
        } else {
            std::fs::File::open(&p).map(|_| ())
        };
        match res {
            Ok(()) => return Some(true),
            Err(e) if matches!(e.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)) => return Some(false),
            Err(_) => continue,
        }
    }
    None
}

fn file_url(path: &Path) -> std::io::Result<objc2::rc::Retained<NSURL>> {
    let s = path
        .to_str()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path is not UTF-8"))?;
    Ok(NSURL::fileURLWithPath(&NSString::from_str(s)))
}

fn opened(ok: bool) -> std::io::Result<()> {
    if ok { Ok(()) } else { Err(std::io::Error::other("macOS could not open it")) }
}

pub fn open_full_disk_access_settings() -> std::io::Result<()> {
    let url = NSURL::URLWithString(&NSString::from_str(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    ))
    .ok_or_else(|| std::io::Error::other("bad settings URL"))?;
    opened(NSWorkspace::sharedWorkspace().openURL(&url))
}

pub fn reveal_in_finder(path: &Path) -> std::io::Result<()> {
    let urls = NSArray::from_retained_slice(&[file_url(path)?]);
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
    Ok(())
}

pub fn open(path: &Path) -> std::io::Result<()> {
    opened(NSWorkspace::sharedWorkspace().openURL(&*file_url(path)?))
}

/// `qlmanage -p`. Not in the App Sandbox: qlmanage cannot set up its own
/// sandbox when started from a sandboxed app (the UI hides the command there).
pub fn quick_look(path: &Path) -> std::io::Result<()> {
    if crate::sandbox::is_sandboxed() {
        return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Quick Look is not available in the App Store version"));
    }
    Command::new("qlmanage")
        .arg("-p")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

pub fn copy_to_clipboard(text: &str) -> std::io::Result<()> {
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    let ok = pb.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
    if ok { Ok(()) } else { Err(std::io::Error::other("clipboard is not available")) }
}

/// Moves to the Trash via NSFileManager (no Finder automation prompt).
pub fn move_to_trash(path: &Path) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(path).map_err(|e| e.to_string())
}

//! Installed applications, via the system's own databases:
//! LaunchServices (which app owns a bundle id), Spotlight (when an app was
//! last opened) and CFBundle (the bundle id of an .app).
//!
//! This is what makes the clean-up assistant work for any app — Logic,
//! Blender, Steam… — instead of a hand-written list.

use std::collections::HashMap;
use std::ffi::{CStr, OsStr, c_char, c_void};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

type CFTypeRef = *const c_void;
type CFIndex = isize;
const UTF8: u32 = 0x0800_0100;
/// Seconds between 1970-01-01 and 2001-01-01 (CFAbsoluteTime epoch).
const CF_EPOCH: i64 = 978_307_200;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: CFIndex, encoding: u32, external: u8) -> CFTypeRef;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: CFIndex, encoding: u32) -> u8;
    fn CFURLCreateFromFileSystemRepresentation(alloc: CFTypeRef, buf: *const u8, len: CFIndex, is_dir: u8) -> CFTypeRef;
    fn CFURLGetFileSystemRepresentation(url: CFTypeRef, resolve: u8, buf: *mut u8, max: CFIndex) -> u8;
    fn CFBundleCreate(alloc: CFTypeRef, url: CFTypeRef) -> CFTypeRef;
    fn CFBundleGetIdentifier(bundle: CFTypeRef) -> CFTypeRef;
    fn CFArrayGetCount(array: CFTypeRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, index: CFIndex) -> CFTypeRef;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFDateGetTypeID() -> usize;
    fn CFDateGetAbsoluteTime(date: CFTypeRef) -> f64;
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSCopyApplicationURLsForBundleIdentifier(id: CFTypeRef, error: *mut CFTypeRef) -> CFTypeRef;
    fn MDItemCreate(alloc: CFTypeRef, path: CFTypeRef) -> CFTypeRef;
    fn MDItemCopyAttribute(item: CFTypeRef, name: CFTypeRef) -> CFTypeRef;
    static kMDItemLastUsedDate: CFTypeRef;
}

/// An owned Core Foundation object (released on drop).
struct Cf(CFTypeRef);

impl Cf {
    fn new(ptr: CFTypeRef) -> Option<Cf> {
        // Not `then_some`: it would build (and drop → release) a wrapper around NULL.
        if ptr.is_null() { None } else { Some(Cf(ptr)) }
    }
}

impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

fn cf_string(s: &str) -> Option<Cf> {
    Cf::new(unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as CFIndex, UTF8, 0) })
}

fn rust_string(s: CFTypeRef) -> Option<String> {
    let mut buf = vec![0 as c_char; 1024];
    if unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as CFIndex, UTF8) } == 0 {
        return None;
    }
    Some(unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned())
}

fn url_path(url: CFTypeRef) -> Option<PathBuf> {
    let mut buf = vec![0u8; 4096];
    if unsafe { CFURLGetFileSystemRepresentation(url, 1, buf.as_mut_ptr(), buf.len() as CFIndex) } == 0 {
        return None;
    }
    let len = buf.iter().position(|&b| b == 0)?;
    Some(PathBuf::from(OsStr::from_bytes(&buf[..len])))
}

/// Applications registered with this bundle id, anywhere on the Mac.
pub fn apps_for_bundle_id(id: &str) -> Vec<PathBuf> {
    let Some(s) = cf_string(id) else { return Vec::new() };
    let Some(array) = Cf::new(unsafe { LSCopyApplicationURLsForBundleIdentifier(s.0, std::ptr::null_mut()) }) else {
        return Vec::new();
    };
    let count = unsafe { CFArrayGetCount(array.0) };
    (0..count)
        .filter_map(|i| url_path(unsafe { CFArrayGetValueAtIndex(array.0, i) }))
        .collect()
}

/// `CFBundleIdentifier` of an .app (works for XML and binary Info.plist).
pub fn bundle_id(app: &Path) -> Option<String> {
    let bytes = app.as_os_str().as_bytes();
    let url = Cf::new(unsafe {
        CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as CFIndex, 1)
    })?;
    let bundle = Cf::new(unsafe { CFBundleCreate(std::ptr::null(), url.0) })?;
    let id = unsafe { CFBundleGetIdentifier(bundle.0) }; // not owned
    if id.is_null() { None } else { rust_string(id) }
}

/// When the item was last opened (Spotlight), as Unix seconds.
pub fn last_used(path: &Path) -> Option<i64> {
    let p = cf_string(path.to_str()?)?;
    let item = Cf::new(unsafe { MDItemCreate(std::ptr::null(), p.0) })?;
    let date = Cf::new(unsafe { MDItemCopyAttribute(item.0, kMDItemLastUsedDate) })?;
    if unsafe { CFGetTypeID(date.0) != CFDateGetTypeID() } {
        return None;
    }
    Some(unsafe { CFDateGetAbsoluteTime(date.0) } as i64 + CF_EPOCH)
}

/// "com.tinyspeck.slackmacgap"-like names (folder names in Caches, Containers…).
pub fn looks_like_bundle_id(s: &str) -> bool {
    let parts = s.split('.').count();
    parts >= 3 && !s.contains(' ') && !s.contains('/') && s.split('.').all(|p| !p.is_empty())
}

/// Bundle id → app name, cached. App extensions and helpers resolve to their
/// app through shorter prefixes ("com.getdropbox.dropbox.fileprovider" →
/// "Dropbox · fileprovider").
#[derive(Default)]
pub struct AppNames {
    cache: HashMap<String, Option<String>>,
}

impl AppNames {
    pub fn lookup(&mut self, id: &str) -> Option<String> {
        if let Some(hit) = self.cache.get(id) {
            return hit.clone();
        }
        let mut found = None;
        if looks_like_bundle_id(id) {
            let mut prefix = id;
            loop {
                if let Some(app) = apps_for_bundle_id(prefix).into_iter().next() {
                    let name = app
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| prefix.to_string());
                    found = Some(if prefix.len() == id.len() {
                        name
                    } else {
                        format!("{name} · {}", &id[prefix.len() + 1..])
                    });
                    break;
                }
                // Keep at least three components: "com.vendor.app".
                match prefix.rfind('.') {
                    Some(i) if prefix[..i].split('.').count() >= 3 => prefix = &prefix[..i],
                    _ => break,
                }
            }
        }
        self.cache.insert(id.to_string(), found.clone());
        found
    }

    /// Whether an application owns this id (exactly or as an extension/helper).
    pub fn installed(&mut self, id: &str) -> bool {
        self.lookup(id).is_some()
    }
}

/// The app bundle this process runs from (to leave it out of lists).
pub fn own_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

/// The current user may move this item to the Trash.
pub fn writable(path: &Path) -> bool {
    let ok = |p: &Path| {
        std::ffi::CString::new(p.as_os_str().as_bytes())
            .map(|c| unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0)
            .unwrap_or(false)
    };
    ok(path) && path.parent().is_some_and(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_ids_look_like_reverse_dns() {
        assert!(looks_like_bundle_id("com.spotify.client"));
        assert!(!looks_like_bundle_id("Google"));
        assert!(!looks_like_bundle_id("UBF8T346G9.Office"));
        assert!(!looks_like_bundle_id("Application Support"));
    }

    #[test]
    fn finds_system_apps() {
        // Finder is always registered; the name comes from the bundle.
        let finder = apps_for_bundle_id("com.apple.finder");
        assert!(finder.iter().any(|p| p.ends_with("Finder.app")), "{finder:?}");
        assert_eq!(bundle_id(Path::new("/System/Library/CoreServices/Finder.app")).as_deref(), Some("com.apple.finder"));
        let mut names = AppNames::default();
        assert_eq!(names.lookup("com.apple.finder").as_deref(), Some("Finder"));
        assert_eq!(names.lookup("com.apple.finder.SyncExtension").as_deref(), Some("Finder · SyncExtension"));
        assert!(!names.installed("com.example.surely-not-installed-anywhere"));
    }
}

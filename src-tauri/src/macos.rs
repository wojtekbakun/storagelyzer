//! macOS integration: Full Disk Access, Finder, Quick Look, clipboard, Trash.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Whether this process has Full Disk Access (TCC). Opening the TCC database
/// fails with EPERM without it. `None` = could not tell.
///
/// Note: in `tauri dev` the permission belongs to the terminal app that
/// launched the binary, in a built .app to the app itself.
pub fn has_full_disk_access() -> Option<bool> {
    let home = crate::volumes::home_dir()?;
    let probes: [PathBuf; 3] = [
        home.join("Library/Application Support/com.apple.TCC/TCC.db"),
        PathBuf::from("/Library/Application Support/com.apple.TCC/TCC.db"),
        home.join("Library/Safari"),
    ];
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

pub fn open_full_disk_access_settings() -> std::io::Result<()> {
    Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn()
        .map(|_| ())
}

pub fn reveal_in_finder(path: &Path) -> std::io::Result<()> {
    Command::new("open").arg("-R").arg(path).spawn().map(|_| ())
}

pub fn open(path: &Path) -> std::io::Result<()> {
    Command::new("open").arg(path).spawn().map(|_| ())
}

pub fn quick_look(path: &Path) -> std::io::Result<()> {
    Command::new("qlmanage")
        .arg("-p")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

pub fn copy_to_clipboard(text: &str) -> std::io::Result<()> {
    let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }
    child.wait().map(|_| ())
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

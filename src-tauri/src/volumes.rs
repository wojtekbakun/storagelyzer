//! Mounted file systems: the start-screen location list and the mount-point
//! policy used by the scanner.

use serde::Serialize;
use std::ffi::{CStr, CString, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const MNT_RDONLY: u32 = 0x0000_0001;
const MNT_LOCAL: u32 = 0x0000_1000;
const MNT_ROOTFS: u32 = 0x0000_4000;
const MNT_DONTBROWSE: u32 = 0x0010_0000;

#[derive(Clone, Debug)]
pub struct MountInfo {
    pub mount_on: PathBuf,
    pub mount_from: String,
    pub fs_type: String,
    pub flags: u32,
    pub total: u64,
    pub available: u64,
}

impl MountInfo {
    fn from_statfs(s: &libc::statfs) -> Self {
        let text = |a: &[libc::c_char]| unsafe { CStr::from_ptr(a.as_ptr()) };
        let bsize = s.f_bsize as u64;
        MountInfo {
            mount_on: PathBuf::from(OsStr::from_bytes(text(&s.f_mntonname).to_bytes())),
            mount_from: text(&s.f_mntfromname).to_string_lossy().into_owned(),
            fs_type: text(&s.f_fstypename).to_string_lossy().into_owned(),
            flags: s.f_flags,
            total: s.f_blocks.saturating_mul(bsize),
            available: s.f_bavail.saturating_mul(bsize),
        }
    }

    pub fn used(&self) -> u64 {
        self.total.saturating_sub(self.available)
    }

    /// Physical container of the volume. All APFS volumes of one container
    /// (System, Data, VM, Preboot, …) share free space, so a scan of
    /// "Macintosh HD" may cross between them; anything else is another disk.
    pub fn container(&self) -> String {
        container_key(&self.mount_from)
    }
}

/// `/dev/disk3s5` and `/dev/disk3s1s1` → `disk3`; other sources stay as they are
/// (`map auto_home`, `devfs`, `//user@server/share`, …).
pub fn container_key(mount_from: &str) -> String {
    if let Some(rest) = mount_from.strip_prefix("/dev/disk") {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            return format!("disk{digits}");
        }
    }
    mount_from.to_string()
}

/// `statfs(2)` for the file system that contains `path`.
pub fn statfs(path: &Path) -> Option<MountInfo> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut buf) } != 0 {
        return None;
    }
    Some(MountInfo::from_statfs(&buf))
}

/// All mounted file systems (`getfsstat(2)`, thread-safe unlike `getmntinfo`).
pub fn mounts() -> Vec<MountInfo> {
    const MNT_NOWAIT: libc::c_int = 2;
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, MNT_NOWAIT) };
    if count <= 0 {
        return Vec::new();
    }
    let mut buf: Vec<libc::statfs> = vec![unsafe { std::mem::zeroed() }; count as usize + 8];
    let size = (buf.len() * std::mem::size_of::<libc::statfs>()) as libc::c_int;
    let n = unsafe { libc::getfsstat(buf.as_mut_ptr(), size, MNT_NOWAIT) };
    if n <= 0 {
        return Vec::new();
    }
    buf.truncate(n as usize);
    buf.iter().map(MountInfo::from_statfs).collect()
}

/// Name Finder shows for the boot volume ("Macintosh HD"): /Volumes contains a
/// symlink with that name pointing at "/".
pub fn root_volume_name() -> String {
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        for de in rd.flatten() {
            if let Ok(target) = std::fs::read_link(de.path()) {
                if target == Path::new("/") {
                    return de.file_name().to_string_lossy().into_owned();
                }
            }
        }
    }
    "Macintosh HD".to_string()
}

/// Human name for a scan root: volume name for mount points, folder name otherwise.
pub fn display_name(path: &Path) -> String {
    if path == Path::new("/") {
        return root_volume_name();
    }
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// "home" | "root" | "volume" | "network"
    pub kind: &'static str,
    pub name: String,
    pub path: String,
    pub total: Option<u64>,
    pub available: Option<u64>,
    pub fs_type: Option<String>,
    pub read_only: bool,
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| p.is_dir())
}

pub fn locations() -> Vec<Location> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        out.push(Location {
            kind: "home",
            name: home
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Home".into()),
            path: home.to_string_lossy().into_owned(),
            total: None,
            available: None,
            fs_type: None,
            read_only: false,
        });
    }

    let mut volumes: Vec<Location> = mounts()
        .into_iter()
        .filter(|m| {
            let is_root = m.flags & MNT_ROOTFS != 0 || m.mount_on == Path::new("/");
            let hidden = m.flags & MNT_DONTBROWSE != 0
                || matches!(m.fs_type.as_str(), "devfs" | "autofs" | "nullfs" | "lifs");
            is_root || !hidden
        })
        .map(|m| {
            let is_root = m.mount_on == Path::new("/");
            Location {
                kind: if is_root {
                    "root"
                } else if m.flags & MNT_LOCAL == 0 {
                    "network"
                } else {
                    "volume"
                },
                name: display_name(&m.mount_on),
                path: m.mount_on.to_string_lossy().into_owned(),
                total: Some(m.total),
                available: Some(m.available),
                fs_type: Some(m.fs_type.clone()),
                read_only: m.flags & MNT_RDONLY != 0 && !is_root,
            }
        })
        .collect();
    volumes.sort_by(|a, b| (a.kind != "root").cmp(&(b.kind != "root")).then(a.name.cmp(&b.name)));
    out.extend(volumes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_keys() {
        assert_eq!(container_key("/dev/disk3s1s1"), "disk3");
        assert_eq!(container_key("/dev/disk3s5"), "disk3");
        assert_eq!(container_key("/dev/disk12s2"), "disk12");
        assert_eq!(container_key("map auto_home"), "map auto_home");
        assert_eq!(container_key("//me@nas/share"), "//me@nas/share");
    }

    #[test]
    fn root_is_listed() {
        let locs = locations();
        assert!(locs.iter().any(|l| l.kind == "root"));
    }
}

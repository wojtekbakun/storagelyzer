//! Low-level directory listing.
//!
//! On macOS a directory is read with `getattrlistbulk(2)`: one syscall returns
//! names, types, sizes, inode numbers and mount status for many entries at
//! once, so there is no separate `lstat()` per file. That is the same trick the
//! fast native disk analyzers use and it is 2–4× faster than `readdir`+`lstat`.
//!
//! File systems that reject the call (and non-Apple platforms) fall back to
//! `std::fs::read_dir` + `symlink_metadata`.

use std::ffi::{CString, OsStr};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// `st_flags` bit: the item is a "dataless" placeholder (iCloud Drive / File
/// Provider) whose content lives in the cloud.
pub const SF_DATALESS: u32 = 0x4000_0000;
/// `st_flags` bit: transparently compressed by the file system.
pub const UF_COMPRESSED: u32 = 0x0000_0020;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryType {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Copy, Debug)]
pub struct RawEntry {
    pub name_off: u32,
    pub name_len: u32,
    pub kind: EntryType,
    pub dev: u64,
    pub ino: u64,
    pub nlink: u32,
    /// Logical size in bytes (what Finder calls "size").
    pub size: u64,
    /// Bytes actually allocated on disk ("size on disk").
    pub alloc: u64,
    pub mtime: i64,
    /// `st_flags` (`SF_DATALESS`, `UF_COMPRESSED`, ...).
    pub flags: u32,
    /// The directory is a mount point of another file system.
    pub mount_point: bool,
    /// The directory is an automounter trigger (autofs).
    pub trigger: bool,
    /// Per-entry errno, 0 when the entry could be read.
    pub error: i32,
}

impl RawEntry {
    fn named(name_off: u32, name_len: u32) -> Self {
        RawEntry {
            name_off,
            name_len,
            kind: EntryType::Other,
            dev: 0,
            ino: 0,
            nlink: 1,
            size: 0,
            alloc: 0,
            mtime: 0,
            flags: 0,
            mount_point: false,
            trigger: false,
            error: 0,
        }
    }
}

/// Entries of one directory. Names are stored back to back in `names` so a
/// listing does not allocate per entry; the buffers are reused between calls.
#[derive(Default)]
pub struct Listing {
    pub entries: Vec<RawEntry>,
    pub names: Vec<u8>,
}

impl Listing {
    pub fn clear(&mut self) {
        self.entries.clear();
        self.names.clear();
    }

    pub fn name(&self, e: &RawEntry) -> &[u8] {
        &self.names[e.name_off as usize..(e.name_off + e.name_len) as usize]
    }

    fn push_name(&mut self, name: &[u8]) -> (u32, u32) {
        let off = self.names.len() as u32;
        self.names.extend_from_slice(name);
        (off, name.len() as u32)
    }
}

/// Identity of an opened directory (used to detect firmlinks / loops).
#[derive(Clone, Copy, Debug)]
pub struct DirInfo {
    pub dev: u64,
    pub ino: u64,
    pub mtime: i64,
}

pub fn dev64(dev: libc::dev_t) -> u64 {
    dev as u32 as u64
}

/// An open directory file descriptor.
pub struct Dir {
    fd: libc::c_int,
}

impl Dir {
    pub fn open(path: &Path) -> io::Result<Dir> {
        let c = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // O_NOFOLLOW: we only ever descend into real directories, never symlinks.
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Dir { fd })
        }
    }

    pub fn info(&self) -> io::Result<DirInfo> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(self.fd, &mut st) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(DirInfo {
            dev: dev64(st.st_dev),
            ino: st.st_ino as u64,
            mtime: st.st_mtime as i64,
        })
    }

    /// Reads all entries of the directory into `out` (cleared first).
    pub fn read(&self, path: &Path, out: &mut Listing) -> io::Result<()> {
        out.clear();
        #[cfg(target_os = "macos")]
        {
            match bulk::read(self.fd, out) {
                Ok(()) => return Ok(()),
                Err(bulk::BulkError::Unsupported) => out.clear(),
                Err(bulk::BulkError::Io(e)) => return Err(e),
            }
        }
        read_std(path, out)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

/// Portable fallback: `readdir` + `lstat`.
fn read_std(path: &Path, out: &mut Listing) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    for de in std::fs::read_dir(path)? {
        let Ok(de) = de else { continue };
        let file_name = de.file_name();
        let (off, len) = out.push_name(file_name.as_bytes());
        let mut e = RawEntry::named(off, len);
        match std::fs::symlink_metadata(path.join(OsStr::from_bytes(file_name.as_bytes()))) {
            Ok(md) => {
                let ft = md.file_type();
                e.kind = if ft.is_dir() {
                    EntryType::Dir
                } else if ft.is_file() {
                    EntryType::File
                } else if ft.is_symlink() {
                    EntryType::Symlink
                } else {
                    EntryType::Other
                };
                e.dev = md.dev() as u32 as u64;
                e.ino = md.ino();
                e.nlink = md.nlink() as u32;
                e.size = md.len();
                e.alloc = md.blocks() * 512;
                e.mtime = md.mtime();
                #[cfg(target_os = "macos")]
                {
                    use std::os::macos::fs::MetadataExt as MacMetadataExt;
                    e.flags = md.st_flags();
                }
            }
            Err(err) => e.error = err.raw_os_error().unwrap_or(libc::EIO),
        }
        out.entries.push(e);
    }
    Ok(())
}

/// Per-thread I/O policy for scanner threads (macOS):
/// - never download iCloud/File Provider "dataless" files just because we look at them,
/// - never trigger automounts (autofs, /net, home maps),
/// - do not update access times of the directories we read.
pub fn apply_scan_io_policy() {
    #[cfg(target_os = "macos")]
    unsafe {
        unsafe extern "C" {
            fn setiopolicy_np(iotype: libc::c_int, scope: libc::c_int, policy: libc::c_int) -> libc::c_int;
        }
        const IOPOL_TYPE_VFS_ATIME_UPDATES: libc::c_int = 2;
        const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES: libc::c_int = 3;
        const IOPOL_TYPE_VFS_TRIGGER_RESOLVE: libc::c_int = 5;
        const IOPOL_SCOPE_THREAD: libc::c_int = 1;
        // IOPOL_ATIME_UPDATES_OFF / IOPOL_MATERIALIZE_DATALESS_FILES_OFF / IOPOL_VFS_TRIGGER_RESOLVE_OFF
        const OFF: libc::c_int = 1;
        setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_THREAD, OFF);
        setiopolicy_np(IOPOL_TYPE_VFS_TRIGGER_RESOLVE, IOPOL_SCOPE_THREAD, OFF);
        setiopolicy_np(IOPOL_TYPE_VFS_ATIME_UPDATES, IOPOL_SCOPE_THREAD, OFF);
    }
}

#[cfg(target_os = "macos")]
mod bulk {
    //! `getattrlistbulk(2)` reader. Buffer layout per entry (see `man getattrlist`):
    //! `u32 length`, `attribute_set_t returned`, then each *returned* attribute in
    //! bit order (common → dir → file), every field 4-byte aligned. `ATTR_CMN_ERROR`
    //! is the exception: it comes right after the returned set.

    use super::{EntryType, Listing, RawEntry};
    use std::cell::RefCell;
    use std::io;

    #[repr(C)]
    struct AttrList {
        bitmapcount: u16,
        reserved: u16,
        commonattr: u32,
        volattr: u32,
        dirattr: u32,
        fileattr: u32,
        forkattr: u32,
    }

    unsafe extern "C" {
        fn getattrlistbulk(
            dirfd: libc::c_int,
            alist: *mut AttrList,
            attribute_buffer: *mut libc::c_void,
            buffer_size: libc::size_t,
            options: u64,
        ) -> libc::c_int;
    }

    const ATTR_BIT_MAP_COUNT: u16 = 5;
    const ATTR_CMN_NAME: u32 = 0x0000_0001;
    const ATTR_CMN_DEVID: u32 = 0x0000_0002;
    const ATTR_CMN_OBJTYPE: u32 = 0x0000_0008;
    const ATTR_CMN_MODTIME: u32 = 0x0000_0400;
    const ATTR_CMN_FLAGS: u32 = 0x0004_0000;
    const ATTR_CMN_FILEID: u32 = 0x0200_0000;
    const ATTR_CMN_ERROR: u32 = 0x2000_0000;
    const ATTR_CMN_RETURNED_ATTRS: u32 = 0x8000_0000;
    const ATTR_DIR_MOUNTSTATUS: u32 = 0x0000_0004;
    const ATTR_FILE_LINKCOUNT: u32 = 0x0000_0001;
    const ATTR_FILE_TOTALSIZE: u32 = 0x0000_0002;
    const ATTR_FILE_ALLOCSIZE: u32 = 0x0000_0004;
    const DIR_MNTSTATUS_MNTPOINT: u32 = 0x1;
    const DIR_MNTSTATUS_TRIGGER: u32 = 0x2;
    // enum vtype
    const VREG: u32 = 1;
    const VDIR: u32 = 2;
    const VLNK: u32 = 5;

    const BUF_BYTES: usize = 256 * 1024;

    thread_local! {
        // u64 storage guarantees 8-byte alignment of the buffer start.
        static BUF: RefCell<Vec<u64>> = RefCell::new(vec![0u64; BUF_BYTES / 8]);
    }

    pub enum BulkError {
        /// The file system does not support the call — use the fallback.
        Unsupported,
        Io(io::Error),
    }

    pub fn read(fd: libc::c_int, out: &mut Listing) -> Result<(), BulkError> {
        let mut al = AttrList {
            bitmapcount: ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: ATTR_CMN_RETURNED_ATTRS
                | ATTR_CMN_NAME
                | ATTR_CMN_ERROR
                | ATTR_CMN_DEVID
                | ATTR_CMN_OBJTYPE
                | ATTR_CMN_MODTIME
                | ATTR_CMN_FLAGS
                | ATTR_CMN_FILEID,
            volattr: 0,
            dirattr: ATTR_DIR_MOUNTSTATUS,
            fileattr: ATTR_FILE_LINKCOUNT | ATTR_FILE_TOTALSIZE | ATTR_FILE_ALLOCSIZE,
            forkattr: 0,
        };

        BUF.with(|cell| {
            let mut buf = cell.borrow_mut();
            let cap = buf.len() * 8;
            let base = buf.as_mut_ptr() as *mut u8;
            let mut first_call = true;
            loop {
                let n = unsafe { getattrlistbulk(fd, &mut al, base.cast(), cap, 0) };
                if n < 0 {
                    let err = io::Error::last_os_error();
                    match err.raw_os_error() {
                        Some(libc::EINTR) => continue,
                        Some(libc::ENOTSUP) | Some(libc::EINVAL) if first_call => {
                            return Err(BulkError::Unsupported);
                        }
                        _ => return Err(BulkError::Io(err)),
                    }
                }
                first_call = false;
                if n == 0 {
                    return Ok(());
                }
                let end = unsafe { base.add(cap) } as usize;
                let mut p = base as *const u8;
                for _ in 0..n {
                    if (p as usize) + 4 > end {
                        break;
                    }
                    let len = unsafe { rd::<u32>(p) } as usize;
                    if len < 24 || (p as usize) + len > end {
                        break;
                    }
                    unsafe { parse_entry(p, len, out) };
                    p = unsafe { p.add(len) };
                }
            }
        })
    }

    #[inline(always)]
    unsafe fn rd<T: Copy>(p: *const u8) -> T {
        unsafe { std::ptr::read_unaligned(p as *const T) }
    }

    unsafe fn parse_entry(entry: *const u8, len: usize, out: &mut Listing) {
        unsafe {
            let end = entry.add(len);
            // attribute_set_t { commonattr, volattr, dirattr, fileattr, forkattr }
            let ret_common = rd::<u32>(entry.add(4));
            let ret_dir = rd::<u32>(entry.add(12));
            let ret_file = rd::<u32>(entry.add(16));
            let mut p = entry.add(24);

            let mut error = 0i32;
            if ret_common & ATTR_CMN_ERROR != 0 {
                error = rd::<u32>(p) as i32;
                p = p.add(4);
            }

            let mut name: &[u8] = &[];
            if ret_common & ATTR_CMN_NAME != 0 {
                // attrreference_t { i32 offset (relative to itself), u32 length incl. NUL }
                let off = rd::<i32>(p) as isize;
                let nlen = rd::<u32>(p.add(4)) as usize;
                let np = p.offset(off);
                if nlen > 0 && np >= entry && np.add(nlen) <= end {
                    let s = std::slice::from_raw_parts(np, nlen);
                    let s = match s.iter().position(|&b| b == 0) {
                        Some(pos) => &s[..pos],
                        None => s,
                    };
                    name = s;
                }
                p = p.add(8);
            }
            if name.is_empty() {
                return;
            }

            let mut dev = 0u64;
            if ret_common & ATTR_CMN_DEVID != 0 {
                dev = rd::<i32>(p) as u32 as u64;
                p = p.add(4);
            }
            let mut objtype = 0u32;
            if ret_common & ATTR_CMN_OBJTYPE != 0 {
                objtype = rd::<u32>(p);
                p = p.add(4);
            }
            let mut mtime = 0i64;
            if ret_common & ATTR_CMN_MODTIME != 0 {
                mtime = rd::<i64>(p); // struct timespec { tv_sec, tv_nsec }
                p = p.add(16);
            }
            let mut flags = 0u32;
            if ret_common & ATTR_CMN_FLAGS != 0 {
                flags = rd::<u32>(p);
                p = p.add(4);
            }
            let mut ino = 0u64;
            if ret_common & ATTR_CMN_FILEID != 0 {
                ino = rd::<u64>(p);
                p = p.add(8);
            }
            let mut mount_status = 0u32;
            if ret_dir & ATTR_DIR_MOUNTSTATUS != 0 {
                mount_status = rd::<u32>(p);
                p = p.add(4);
            }
            let mut nlink = 1u32;
            if ret_file & ATTR_FILE_LINKCOUNT != 0 {
                nlink = rd::<u32>(p);
                p = p.add(4);
            }
            let mut size = 0u64;
            if ret_file & ATTR_FILE_TOTALSIZE != 0 {
                size = rd::<i64>(p).max(0) as u64;
                p = p.add(8);
            }
            let mut alloc = 0u64;
            if ret_file & ATTR_FILE_ALLOCSIZE != 0 {
                alloc = rd::<i64>(p).max(0) as u64;
            }

            let (name_off, name_len) = out.push_name(name);
            let mut e = RawEntry::named(name_off, name_len);
            e.kind = match objtype {
                VDIR => EntryType::Dir,
                VREG => EntryType::File,
                VLNK => EntryType::Symlink,
                _ => EntryType::Other,
            };
            e.dev = dev;
            e.ino = ino;
            e.nlink = nlink;
            e.size = size;
            e.alloc = alloc;
            e.mtime = mtime;
            e.flags = flags;
            e.mount_point = mount_status & DIR_MNTSTATUS_MNTPOINT != 0;
            e.trigger = mount_status & DIR_MNTSTATUS_TRIGGER != 0;
            e.error = error;
            out.entries.push(e);
        }
    }
}

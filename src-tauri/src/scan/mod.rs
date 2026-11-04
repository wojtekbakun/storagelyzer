//! Parallel directory scanner.
//!
//! Every directory is one rayon task: list it (one `getattrlistbulk` loop),
//! insert all entries into the shared tree under a short write lock, spawn a
//! task per subdirectory. Work stealing keeps all cores busy and the tree is
//! consistent at any moment, so the UI can render while the scan runs.
//!
//! macOS specifics handled here:
//! - **Firmlinks**: `/Users` and `/System/Volumes/Data/Users` are the same
//!   directory. Directories are de-duplicated by (dev, inode) and true mount
//!   points of the same APFS container are scanned in a later phase, so data
//!   is attributed to the familiar paths (`/Users`, `/Applications`, …).
//! - **Other volumes** (external disks, network shares, devfs, autofs) are not
//!   entered unless they are the scan root.
//! - **Hard links** are counted once.
//! - **iCloud placeholders** are never downloaded (dataless dirs are skipped,
//!   dataless files count with their local allocation, usually 0).

pub mod fs;

use crate::tree::{flag, ChildSpec, Kind, NodeId, Tree};
use crate::volumes;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

const MAX_DENIED_PATHS: usize = 500;
/// Files at least this big whose allocation is under half their length are "sparse".
const SPARSE_MIN: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub struct Stats {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub denied: AtomicU64,
    pub current: Mutex<String>,
    pub denied_paths: Mutex<Vec<String>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub errors: u64,
    pub denied: u64,
    pub current: String,
}

impl Stats {
    pub fn snapshot(&self) -> Progress {
        Progress {
            files: self.files.load(Relaxed),
            dirs: self.dirs.load(Relaxed),
            bytes: self.bytes.load(Relaxed),
            errors: self.errors.load(Relaxed),
            denied: self.denied.load(Relaxed),
            current: self.current.lock().clone(),
        }
    }
}

/// (dev, inode) set split into shards to keep lock contention low.
struct ShardedSet {
    shards: Vec<Mutex<HashSet<(u64, u64)>>>,
}

impl ShardedSet {
    fn new() -> Self {
        ShardedSet {
            shards: (0..64).map(|_| Mutex::new(HashSet::new())).collect(),
        }
    }

    /// Returns `true` if the key was not present yet.
    fn insert(&self, key: (u64, u64)) -> bool {
        let h = key.1.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ key.0.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
        self.shards[(h >> 58) as usize].lock().insert(key)
    }
}

enum Action {
    Scan,
    /// Mount point of a sibling volume in the same container — scan after
    /// everything else (see module docs).
    Defer,
    /// Different disk / network / pseudo file system.
    Skip,
}

pub struct Scanner {
    pub tree: Arc<RwLock<Tree>>,
    pub stats: Stats,
    pub cancel: AtomicBool,
    root_container: Option<String>,
    mount_points: HashSet<Vec<u8>>,
    /// Firmlink targets inside the Data volume (`/System/Volumes/Data/Users`, …)
    /// that are already reachable through their short path (`/Users`).
    firmlink_targets: HashSet<Vec<u8>>,
    visited: ShardedSet,
    hardlinks: ShardedSet,
    deferred: Mutex<Vec<(NodeId, PathBuf)>>,
    threads: usize,
}

thread_local! {
    static LISTING: std::cell::RefCell<fs::Listing> = std::cell::RefCell::new(fs::Listing::default());
    static SPECS: std::cell::RefCell<Vec<ChildSpec>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Folder-like bundles that Finder shows as a single item.
fn is_package(name: &[u8]) -> bool {
    const EXT: &[&str] = &[
        "app", "appex", "bundle", "framework", "plugin", "kext", "prefpane", "qlgenerator", "mdimporter",
        "saver", "component", "vst", "vst3", "aaxplugin", "photoslibrary", "musiclibrary", "tvlibrary",
        "photolibrary", "imovielibrary", "theater", "fcpbundle", "logicx", "band", "xcarchive",
        "xcodeproj", "xcworkspace", "playground", "pages", "numbers", "key", "rtfd", "sparsebundle",
        "docset", "dsym", "lrdata", "lrlibrary",
    ];
    let Some(dot) = name.iter().rposition(|&b| b == b'.') else { return false };
    if dot == 0 {
        return false;
    }
    let ext = &name[dot + 1..];
    EXT.iter().any(|e| e.as_bytes().eq_ignore_ascii_case(ext))
}

fn kind_of(t: fs::EntryType) -> Kind {
    match t {
        fs::EntryType::Dir => Kind::Dir,
        fs::EntryType::File => Kind::File,
        fs::EntryType::Symlink => Kind::Symlink,
        fs::EntryType::Other => Kind::Other,
    }
}

fn is_denied(errno: i32) -> bool {
    errno == libc::EACCES || errno == libc::EPERM
}

/// Worker threads for a scan (`STORAGELYZER_THREADS` overrides).
///
/// Measured on APFS (Apple silicon, 16 cores): directory enumeration is
/// limited by contention inside the kernel, not by this code — a lock-free
/// walk (`examples/rawwalk.rs`) behaves the same. 4 threads is the sweet spot;
/// 16 threads is ~5× *slower* on /System/Library and ~2× on /Applications.
/// When scanning "/", every firmlink target under /System/Volumes/Data is the
/// same directory as its firmlink (`/Users` ⇄ `/System/Volumes/Data/Users`).
/// The list comes from the system (`/usr/share/firmlinks`: "source<TAB>target").
pub fn firmlink_targets(root: &Path) -> HashSet<Vec<u8>> {
    let mut set = HashSet::new();
    if root != Path::new("/") {
        return set;
    }
    if let Ok(text) = std::fs::read_to_string("/usr/share/firmlinks") {
        for line in text.lines() {
            let mut parts = line.split('\t');
            if let (Some(_source), Some(target)) = (parts.next(), parts.next()) {
                let target = target.trim().trim_start_matches('/');
                if !target.is_empty() {
                    set.insert(format!("/System/Volumes/Data/{target}").into_bytes());
                }
            }
        }
    }
    set
}

pub fn default_threads() -> usize {
    if let Some(n) = std::env::var("STORAGELYZER_THREADS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return n.max(1);
    }
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    if cfg!(target_os = "macos") { cpus.min(4) } else { cpus.min(16) }
}

impl Scanner {
    /// A scanner working on `tree`; the container of the tree's root decides
    /// which mount points may be crossed.
    pub fn new(tree: Arc<RwLock<Tree>>) -> Self {
        let root_path = tree.read().root_path.clone();
        let root_container = volumes::statfs(&root_path).map(|m| m.container());
        let mount_points = volumes::mounts()
            .into_iter()
            .map(|m| m.mount_on.as_os_str().as_bytes().to_vec())
            .collect();
        Scanner {
            firmlink_targets: firmlink_targets(&root_path),
            tree,
            stats: Stats::default(),
            cancel: AtomicBool::new(false),
            root_container,
            mount_points,
            visited: ShardedSet::new(),
            hardlinks: ShardedSet::new(),
            deferred: Mutex::new(Vec::new()),
            threads: default_threads(),
        }
    }

    /// Scans the directory `start` (the root, or a subfolder for a rescan).
    /// Blocks until done or cancelled.
    pub fn run(&self, start: NodeId) {
        let path = {
            let mut t = self.tree.write();
            t.reset_dir(start);
            t.path_of(start)
        };
        let work = || {
            rayon::scope(|s| self.scan_dir(s, start, path));
            loop {
                if self.cancel.load(Relaxed) {
                    break;
                }
                let batch = std::mem::take(&mut *self.deferred.lock());
                if batch.is_empty() {
                    break;
                }
                rayon::scope(|s| {
                    for (id, p) in batch {
                        s.spawn(move |s| self.scan_dir(s, id, p));
                    }
                });
            }
        };
        match rayon::ThreadPoolBuilder::new()
            .num_threads(self.threads)
            .thread_name(|i| format!("scan-{i}"))
            .stack_size(8 << 20)
            .start_handler(|_| fs::apply_scan_io_policy())
            .build()
        {
            Ok(pool) => pool.install(work),
            Err(_) => work(),
        }
    }

    fn scan_dir<'s>(&'s self, scope: &rayon::Scope<'s>, id: NodeId, path: PathBuf) {
        if self.cancel.load(Relaxed) {
            return;
        }
        for (child, child_path) in self.list_dir(id, &path) {
            scope.spawn(move |s| self.scan_dir(s, child, child_path));
        }
    }

    fn fail(&self, id: NodeId, path: &Path, err: &std::io::Error) {
        let denied = err.raw_os_error().is_some_and(is_denied);
        let set = flag::ERROR | if denied { flag::DENIED } else { 0 };
        self.tree.write().set_flags(id, set, flag::PENDING);
        self.stats.errors.fetch_add(1, Relaxed);
        if denied {
            self.stats.denied.fetch_add(1, Relaxed);
            let mut list = self.stats.denied_paths.lock();
            if list.len() < MAX_DENIED_PATHS {
                list.push(path.to_string_lossy().into_owned());
            }
        }
    }

    fn classify(&self, e: &fs::RawEntry, path: &Path, parent_dev: u64) -> Action {
        if e.trigger {
            return Action::Skip;
        }
        let crossing = e.mount_point
            || (e.dev != 0 && e.dev != parent_dev)
            || self.mount_points.contains(path.as_os_str().as_bytes());
        if !crossing {
            return Action::Scan;
        }
        let Some(root) = &self.root_container else { return Action::Skip };
        match volumes::statfs(path) {
            Some(m) if m.container() == *root => {
                if m.mount_on == path {
                    Action::Defer
                } else {
                    Action::Scan
                }
            }
            _ => Action::Skip,
        }
    }

    /// Lists one directory into the tree; returns subdirectories to descend into.
    fn list_dir(&self, id: NodeId, path: &Path) -> Vec<(NodeId, PathBuf)> {
        let dir = match fs::Dir::open(path) {
            Ok(d) => d,
            Err(e) => {
                self.fail(id, path, &e);
                return Vec::new();
            }
        };
        let info = match dir.info() {
            Ok(i) => i,
            Err(e) => {
                self.fail(id, path, &e);
                return Vec::new();
            }
        };
        if !self.visited.insert((info.dev, info.ino)) {
            self.tree.write().set_flags(id, flag::DUPLICATE, flag::PENDING);
            return Vec::new();
        }

        LISTING.with_borrow_mut(|listing| {
            if let Err(e) = dir.read(path, listing) {
                self.fail(id, path, &e);
                return Vec::new();
            }
            drop(dir);
            SPECS.with_borrow_mut(|specs| {
                specs.clear();
                let mut subdirs: Vec<(usize, PathBuf)> = Vec::new();
                let mut deferred: Vec<(usize, PathBuf)> = Vec::new();
                let (mut files, mut bytes, mut errors) = (0u64, 0u64, 0u64);

                for (i, e) in listing.entries.iter().enumerate() {
                    let name = listing.name(e);
                    let mut s = ChildSpec {
                        name_off: e.name_off,
                        name_len: e.name_len,
                        kind: kind_of(e.kind),
                        flags: 0,
                        size: 0,
                        apparent: 0,
                        mtime: e.mtime,
                    };
                    if e.flags & fs::SF_DATALESS != 0 {
                        s.flags |= flag::CLOUD;
                    }
                    if e.error != 0 {
                        s.flags |= flag::ERROR | if is_denied(e.error) { flag::DENIED } else { 0 };
                        errors += 1;
                    } else if e.kind == fs::EntryType::Dir {
                        if is_package(name) {
                            s.flags |= flag::PACKAGE;
                        }
                        // A dataless folder would be downloaded by listing it — leave it alone.
                        if s.flags & flag::CLOUD == 0 {
                            let child_path = path.join(OsStr::from_bytes(name));
                            if self.firmlink_targets.contains(child_path.as_os_str().as_bytes()) {
                                s.flags |= flag::DUPLICATE;
                                specs.push(s);
                                continue;
                            }
                            match self.classify(e, &child_path, info.dev) {
                                Action::Scan => {
                                    s.flags |= flag::PENDING;
                                    subdirs.push((i, child_path));
                                }
                                Action::Defer => {
                                    s.flags |= flag::PENDING;
                                    deferred.push((i, child_path));
                                }
                                Action::Skip => s.flags |= flag::MOUNT,
                            }
                        }
                    } else {
                        files += 1;
                        if e.flags & fs::UF_COMPRESSED != 0 {
                            s.flags |= flag::COMPRESSED;
                        } else if s.flags & flag::CLOUD == 0
                            && e.size >= SPARSE_MIN
                            && e.alloc.saturating_mul(2) < e.size
                        {
                            s.flags |= flag::SPARSE;
                        }
                        let dev = if e.dev != 0 { e.dev } else { info.dev };
                        if e.nlink > 1 && !self.hardlinks.insert((dev, e.ino)) {
                            s.flags |= flag::HARDLINK;
                        } else {
                            s.size = e.alloc;
                            s.apparent = e.size;
                            bytes += e.alloc;
                        }
                    }
                    specs.push(s);
                }

                let first = self.tree.write().add_children(id, &listing.names, specs);

                let dirs = self.stats.dirs.fetch_add(1, Relaxed);
                self.stats.files.fetch_add(files, Relaxed);
                self.stats.bytes.fetch_add(bytes, Relaxed);
                if errors > 0 {
                    self.stats.errors.fetch_add(errors, Relaxed);
                }
                if dirs % 64 == 0 {
                    if let Some(mut cur) = self.stats.current.try_lock() {
                        *cur = path.to_string_lossy().into_owned();
                    }
                }
                if !deferred.is_empty() {
                    self.deferred
                        .lock()
                        .extend(deferred.into_iter().map(|(i, p)| (first + i as NodeId, p)));
                }
                subdirs.into_iter().map(|(i, p)| (first + i as NodeId, p)).collect()
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::{SizeMode, ROOT};
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("storagelyzer-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(p).unwrap()
    }

    fn write(path: &Path, bytes: usize) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
    }

    #[test]
    fn scans_tree_and_dedupes_hardlinks() {
        let root = temp_dir("scan");
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        write(&root.join("a/one.bin"), 100_000);
        write(&root.join("a/b/two.bin"), 50_000);
        write(&root.join("a/b/c/three.bin"), 10_000);
        write(&root.join("top.txt"), 10);
        std::fs::hard_link(root.join("a/one.bin"), root.join("a/b/one-link.bin")).unwrap();
        std::os::unix::fs::symlink(root.join("a"), root.join("loop")).unwrap();

        let tree = Arc::new(RwLock::new(Tree::new(root.clone(), "root", 0)));
        let scanner = Scanner::new(tree.clone());
        scanner.run(ROOT);
        let t = tree.read();

        // 3 dirs + 5 files + 1 symlink below root
        assert_eq!(t.node(ROOT).items, 9);
        let apparent = t.node(ROOT).apparent;
        // hard link counted once; symlink is a few bytes
        assert!(apparent >= 160_010 && apparent < 160_010 + 1024, "apparent = {apparent}");
        assert!(t.node(ROOT).size >= 160_000);
        let kids = t.sorted_children(ROOT, SizeMode::Apparent);
        assert_eq!(t.name(kids[0]), "a");
        assert_eq!(t.node(ROOT).flags & flag::PENDING, 0);
        assert_eq!(scanner.stats.errors.load(Relaxed), 0);

        drop(t);
        // rescan a subfolder after deleting a file
        std::fs::remove_file(root.join("a/b/c/three.bin")).unwrap();
        let a = kids[0];
        let rescanner = Scanner::new(tree.clone());
        rescanner.run(a);
        let t = tree.read();
        assert_eq!(t.node(ROOT).items, 8);
        assert!(t.node(ROOT).apparent < 150_100);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn firmlinks_only_for_root() {
        assert!(firmlink_targets(Path::new("/Users")).is_empty());
        let set = firmlink_targets(Path::new("/"));
        if Path::new("/usr/share/firmlinks").exists() {
            assert!(set.contains(b"/System/Volumes/Data/Users".as_slice()));
            assert!(set.contains(b"/System/Volumes/Data/Applications".as_slice()));
        }
    }

    #[test]
    fn packages() {
        assert!(is_package(b"Safari.app"));
        assert!(is_package(b"Photos Library.photoslibrary"));
        assert!(!is_package(b".app"));
        assert!(!is_package(b"notes.txt"));
    }
}

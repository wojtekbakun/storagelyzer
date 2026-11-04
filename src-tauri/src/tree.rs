//! In-memory file tree.
//!
//! All nodes live in one arena (`Vec<Node>`), names in one byte pool. The
//! children of a directory are appended together, so they always occupy the
//! contiguous id range `child_start..child_start + child_count`. Sizes are
//! propagated to all ancestors the moment a directory is listed, which keeps the
//! tree consistent *during* a scan — the UI can draw a live, growing chart.
//!
//! ~48 bytes per node + the name: a 2-million-file home folder needs ~140 MB.

use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub type NodeId = u32;
pub const ROOT: NodeId = 0;
pub const NONE: NodeId = u32::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum Kind {
    Dir,
    File,
    Symlink,
    Other,
}

pub mod flag {
    /// Directory found but not listed yet.
    pub const PENDING: u16 = 1 << 0;
    /// Could not be read (permissions, I/O error).
    pub const ERROR: u16 = 1 << 1;
    /// Mount point of another disk / network share — not scanned.
    pub const MOUNT: u16 = 1 << 2;
    /// The same directory is already counted elsewhere (firmlink, e.g.
    /// /System/Volumes/Data/Users == /Users). Hidden from views.
    pub const DUPLICATE: u16 = 1 << 3;
    /// Hard link to a file counted elsewhere (counted once).
    pub const HARDLINK: u16 = 1 << 4;
    /// iCloud / File Provider placeholder whose data is in the cloud.
    pub const CLOUD: u16 = 1 << 5;
    /// Moved to Trash from the app. Hidden from views.
    pub const REMOVED: u16 = 1 << 6;
    /// Bundle shown as a single item by Finder (.app, .photoslibrary, …).
    pub const PACKAGE: u16 = 1 << 7;
    /// Permission denied (subset of ERROR) — usually fixed by Full Disk Access.
    pub const DENIED: u16 = 1 << 8;
    /// Sparse file: its logical size is far bigger than what is allocated
    /// (disk images of Docker / virtual machines).
    pub const SPARSE: u16 = 1 << 9;
    /// Compressed by the file system (APFS/HFS+ transparent compression).
    pub const COMPRESSED: u16 = 1 << 10;

    pub const HIDDEN: u16 = DUPLICATE | REMOVED;
}

#[derive(Clone, Copy, Debug)]
pub struct Node {
    /// Bytes allocated on disk, whole subtree.
    pub size: u64,
    /// Logical bytes, whole subtree.
    pub apparent: u64,
    pub name_off: u32,
    pub parent: NodeId,
    pub child_start: u32,
    pub child_count: u32,
    /// Number of descendants (files + folders).
    pub items: u32,
    /// Newest modification time in the subtree (Unix seconds).
    pub mtime: u32,
    pub name_len: u16,
    pub kind: Kind,
    pub flags: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SizeMode {
    /// Allocated size (like `du`, Finder "on disk").
    #[default]
    Disk,
    /// Logical size (like `ls -l`).
    Apparent,
}

/// One child to insert; its name is a range in a caller-provided byte buffer.
#[derive(Clone, Copy, Debug)]
pub struct ChildSpec {
    pub name_off: u32,
    pub name_len: u32,
    pub kind: Kind,
    pub flags: u16,
    pub size: u64,
    pub apparent: u64,
    pub mtime: i64,
}

pub struct Tree {
    pub nodes: Vec<Node>,
    names: Vec<u8>,
    pub root_path: PathBuf,
}

fn clamp_mtime(t: i64) -> u32 {
    t.clamp(0, u32::MAX as i64) as u32
}

impl Tree {
    pub fn new(root_path: PathBuf, root_name: &str, root_mtime: i64) -> Self {
        let mut t = Tree {
            nodes: Vec::with_capacity(1 << 16),
            names: Vec::with_capacity(1 << 20),
            root_path,
        };
        t.names.extend_from_slice(root_name.as_bytes());
        t.nodes.push(Node {
            size: 0,
            apparent: 0,
            name_off: 0,
            parent: NONE,
            child_start: 0,
            child_count: 0,
            items: 0,
            mtime: clamp_mtime(root_mtime),
            name_len: root_name.len().min(u16::MAX as usize) as u16,
            kind: Kind::Dir,
            flags: flag::PENDING,
        });
        t
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn contains(&self, id: NodeId) -> bool {
        (id as usize) < self.nodes.len()
    }

    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id as usize]
    }

    pub fn name_bytes(&self, id: NodeId) -> &[u8] {
        let n = self.node(id);
        &self.names[n.name_off as usize..n.name_off as usize + n.name_len as usize]
    }

    pub fn name(&self, id: NodeId) -> Cow<'_, str> {
        String::from_utf8_lossy(self.name_bytes(id))
    }

    pub fn size_of(&self, id: NodeId, mode: SizeMode) -> u64 {
        let n = self.node(id);
        match mode {
            SizeMode::Disk => n.size,
            SizeMode::Apparent => n.apparent,
        }
    }

    /// Appends the listing of directory `parent`; returns the id of the first child.
    pub fn add_children(&mut self, parent: NodeId, names: &[u8], specs: &[ChildSpec]) -> NodeId {
        let first = self.nodes.len() as NodeId;
        let mut sum_size = 0u64;
        let mut sum_apparent = 0u64;
        let mut newest = 0u32;
        self.nodes.reserve(specs.len());
        for s in specs {
            let raw = &names[s.name_off as usize..(s.name_off + s.name_len) as usize];
            let raw = &raw[..raw.len().min(u16::MAX as usize)];
            let name_off = self.names.len() as u32;
            self.names.extend_from_slice(raw);
            let mtime = clamp_mtime(s.mtime);
            self.nodes.push(Node {
                size: s.size,
                apparent: s.apparent,
                name_off,
                parent,
                child_start: 0,
                child_count: 0,
                items: 0,
                mtime,
                name_len: raw.len() as u16,
                kind: s.kind,
                flags: s.flags,
            });
            sum_size += s.size;
            sum_apparent += s.apparent;
            newest = newest.max(mtime);
        }
        let p = &mut self.nodes[parent as usize];
        p.child_start = first;
        p.child_count = specs.len() as u32;
        p.flags &= !flag::PENDING;
        self.propagate(parent, sum_size as i64, sum_apparent as i64, specs.len() as i64, newest);
        first
    }

    fn propagate(&mut self, mut id: NodeId, d_size: i64, d_apparent: i64, d_items: i64, mtime: u32) {
        while id != NONE {
            let n = &mut self.nodes[id as usize];
            n.size = (n.size as i64 + d_size).max(0) as u64;
            n.apparent = (n.apparent as i64 + d_apparent).max(0) as u64;
            n.items = (n.items as i64 + d_items).clamp(0, u32::MAX as i64) as u32;
            n.mtime = n.mtime.max(mtime);
            id = n.parent;
        }
    }

    pub fn set_flags(&mut self, id: NodeId, set: u16, clear: u16) {
        let n = &mut self.nodes[id as usize];
        n.flags = (n.flags & !clear) | set;
    }

    /// Detaches a node (after it was moved to Trash) and subtracts its size
    /// from all ancestors.
    pub fn remove(&mut self, id: NodeId) {
        let n = *self.node(id);
        if n.flags & flag::REMOVED != 0 || n.parent == NONE {
            return;
        }
        self.set_flags(id, flag::REMOVED, 0);
        self.propagate(n.parent, -(n.size as i64), -(n.apparent as i64), -(n.items as i64 + 1), 0);
    }

    /// Clears a directory before it is listed again (rescan). Old children stay
    /// in the arena but become unreachable.
    pub fn reset_dir(&mut self, id: NodeId) {
        let n = *self.node(id);
        if n.parent != NONE {
            self.propagate(n.parent, -(n.size as i64), -(n.apparent as i64), -(n.items as i64), 0);
        }
        let node = &mut self.nodes[id as usize];
        node.size = 0;
        node.apparent = 0;
        node.items = 0;
        node.child_start = 0;
        node.child_count = 0;
        node.flags = (node.flags & !(flag::ERROR | flag::DENIED | flag::DUPLICATE)) | flag::PENDING;
    }

    pub fn children(&self, id: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        let n = self.node(id);
        (n.child_start..n.child_start + n.child_count)
            .filter(move |&c| self.nodes[c as usize].flags & flag::HIDDEN == 0)
    }

    pub fn has_children(&self, id: NodeId) -> bool {
        self.children(id).next().is_some()
    }

    /// Visible children, biggest first (ties by name).
    pub fn sorted_children(&self, id: NodeId, mode: SizeMode) -> Vec<NodeId> {
        let mut v: Vec<NodeId> = self.children(id).collect();
        v.sort_unstable_by(|&a, &b| {
            self.size_of(b, mode)
                .cmp(&self.size_of(a, mode))
                .then_with(|| self.name_bytes(a).cmp(self.name_bytes(b)))
        });
        v
    }

    /// Ids from the root down to `id` (inclusive).
    pub fn ancestry(&self, id: NodeId) -> Vec<NodeId> {
        let mut v = Vec::new();
        let mut cur = id;
        while cur != NONE {
            v.push(cur);
            cur = self.node(cur).parent;
        }
        v.reverse();
        v
    }

    /// Node of an absolute path inside the scanned tree, if it is there.
    pub fn find_path(&self, path: &Path) -> Option<NodeId> {
        let rel = path.strip_prefix(&self.root_path).ok()?;
        let mut cur = ROOT;
        for comp in rel.components() {
            let name = comp.as_os_str().as_bytes();
            cur = self.children(cur).find(|&c| self.name_bytes(c) == name)?;
        }
        Some(cur)
    }

    pub fn path_of(&self, id: NodeId) -> PathBuf {
        let mut p = self.root_path.clone();
        for a in self.ancestry(id).into_iter().skip(1) {
            p.push(OsStr::from_bytes(self.name_bytes(a)));
        }
        p
    }

    pub fn info(&self, id: NodeId) -> NodeInfo {
        let n = self.node(id);
        NodeInfo {
            id,
            name: self.name(id).into_owned(),
            kind: n.kind,
            size: n.size,
            apparent: n.apparent,
            items: n.items,
            mtime: n.mtime,
            flags: n.flags,
            has_children: n.kind == Kind::Dir && self.has_children(id),
            parent: (n.parent != NONE).then_some(n.parent),
        }
    }

    /// Pruned subtree for the ring chart: up to `max_depth` levels below `id`,
    /// only items that take at least `min_fraction` of `id`'s size. Everything
    /// smaller is summed into `other_size` of its parent.
    pub fn rings(&self, id: NodeId, max_depth: u32, min_fraction: f64, mode: SizeMode) -> RingNode {
        let total = self.size_of(id, mode);
        let threshold = ((total as f64 * min_fraction).ceil() as u64).max(1);
        self.ring_node(id, 0, max_depth, threshold, mode)
    }

    /// Why the logical size of `id` is bigger than what it occupies on disk:
    /// totals per reason and the files with the biggest difference.
    pub fn size_gap(&self, id: NodeId, top: usize) -> SizeGap {
        let n = self.node(id);
        let mut g = SizeGap {
            disk: n.size,
            apparent: n.apparent,
            ..SizeGap::default()
        };
        let mut best: Vec<(u64, NodeId, &'static str)> = Vec::new();
        let mut stack = vec![id];
        while let Some(cur) = stack.pop() {
            for c in self.children(cur) {
                let cn = self.node(c);
                if cn.kind == Kind::Dir {
                    stack.push(c);
                    continue;
                }
                if cn.apparent <= cn.size {
                    continue;
                }
                let gap = cn.apparent - cn.size;
                let reason = if cn.flags & flag::CLOUD != 0 {
                    g.cloud += gap;
                    g.cloud_files += 1;
                    "cloud"
                } else if cn.flags & flag::SPARSE != 0 {
                    g.sparse += gap;
                    "sparse"
                } else if cn.flags & flag::COMPRESSED != 0 {
                    g.compressed += gap;
                    "compressed"
                } else {
                    g.other += gap;
                    "other"
                };
                if gap >= 100_000_000 {
                    best.push((gap, c, reason));
                }
            }
        }
        best.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        g.top = best
            .into_iter()
            .take(top)
            .map(|(_, c, reason)| GapItem {
                id: c,
                name: self.name(c).into_owned(),
                path: self.path_of(c).to_string_lossy().into_owned(),
                disk: self.node(c).size,
                apparent: self.node(c).apparent,
                reason,
            })
            .collect();
        g
    }

    fn ring_node(&self, id: NodeId, depth: u32, max_depth: u32, threshold: u64, mode: SizeMode) -> RingNode {
        let n = self.node(id);
        let mut out = RingNode {
            id,
            name: self.name(id).into_owned(),
            kind: n.kind,
            size: self.size_of(id, mode),
            disk: n.size,
            apparent: n.apparent,
            items: n.items,
            flags: n.flags,
            children: Vec::new(),
            other_size: 0,
            other_count: 0,
        };
        if n.kind != Kind::Dir || depth >= max_depth {
            return out;
        }
        let mut visible = 0u32;
        let mut big: Vec<NodeId> = Vec::new();
        for c in self.children(id) {
            visible += 1;
            if self.size_of(c, mode) >= threshold {
                big.push(c);
            }
        }
        big.sort_unstable_by(|&a, &b| self.size_of(b, mode).cmp(&self.size_of(a, mode)));
        let shown: u64 = big.iter().map(|&c| self.size_of(c, mode)).sum();
        out.other_size = out.size.saturating_sub(shown);
        out.other_count = visible - big.len() as u32;
        out.children = big
            .into_iter()
            .map(|c| self.ring_node(c, depth + 1, max_depth, threshold, mode))
            .collect();
        out
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub id: NodeId,
    pub name: String,
    pub kind: Kind,
    pub size: u64,
    pub apparent: u64,
    pub items: u32,
    pub mtime: u32,
    pub flags: u16,
    pub has_children: bool,
    pub parent: Option<NodeId>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RingNode {
    pub id: NodeId,
    pub name: String,
    pub kind: Kind,
    /// Size in the requested mode (what the chart lays out).
    pub size: u64,
    /// Both sizes, so tooltips can explain the difference.
    pub disk: u64,
    pub apparent: u64,
    pub items: u32,
    pub flags: u16,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<RingNode>,
    pub other_size: u64,
    pub other_count: u32,
}

/// Breakdown of "Size" minus "On disk" (see [`Tree::size_gap`]).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SizeGap {
    pub disk: u64,
    pub apparent: u64,
    /// Sparse files: disk images of Docker and virtual machines.
    pub sparse: u64,
    /// iCloud / File Provider files that are only in the cloud.
    pub cloud: u64,
    pub cloud_files: u32,
    /// Transparently compressed by APFS.
    pub compressed: u64,
    pub other: u64,
    pub top: Vec<GapItem>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GapItem {
    pub id: NodeId,
    pub name: String,
    pub path: String,
    pub disk: u64,
    pub apparent: u64,
    /// "sparse" | "cloud" | "compressed" | "other"
    pub reason: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_gap_explains_logical_size() {
        let mut t = Tree::new(PathBuf::from("/r"), "r", 0);
        let mut names = Vec::new();
        let mut mk = |n: &str, size: u64, apparent: u64, flags: u16| {
            let off = names.len() as u32;
            names.extend_from_slice(n.as_bytes());
            ChildSpec { name_off: off, name_len: n.len() as u32, kind: Kind::File, flags, size, apparent, mtime: 0 }
        };
        let specs = vec![
            mk("Docker.raw", 20_000_000_000, 1_000_000_000_000, flag::SPARSE),
            mk("movie.mov", 0, 3_000_000_000, flag::CLOUD),
            mk("small.txt", 4096, 10, 0),
        ];
        t.add_children(ROOT, &names, &specs);
        let g = t.size_gap(ROOT, 5);
        assert_eq!(g.sparse, 980_000_000_000);
        assert_eq!(g.cloud, 3_000_000_000);
        assert_eq!(g.cloud_files, 1);
        assert_eq!(g.other, 0);
        assert_eq!(g.top.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Docker.raw", "movie.mov"]);
        assert_eq!(g.top[0].reason, "sparse");
    }

    fn spec(names: &mut Vec<u8>, name: &str, kind: Kind, size: u64) -> ChildSpec {
        let off = names.len() as u32;
        names.extend_from_slice(name.as_bytes());
        ChildSpec {
            name_off: off,
            name_len: name.len() as u32,
            kind,
            flags: if kind == Kind::Dir { flag::PENDING } else { 0 },
            size,
            apparent: size / 2,
            mtime: 1_700_000_000,
        }
    }

    fn sample() -> Tree {
        let mut t = Tree::new(PathBuf::from("/tmp/root"), "root", 0);
        let mut names = Vec::new();
        let specs = vec![
            spec(&mut names, "a", Kind::Dir, 0),
            spec(&mut names, "big.bin", Kind::File, 1000),
            spec(&mut names, "tiny", Kind::File, 1),
        ];
        let first = t.add_children(ROOT, &names, &specs);
        let mut names2 = Vec::new();
        let specs2 = vec![
            spec(&mut names2, "x", Kind::File, 500),
            spec(&mut names2, "y", Kind::File, 300),
        ];
        t.add_children(first, &names2, &specs2);
        t
    }

    #[test]
    fn sizes_propagate() {
        let t = sample();
        assert_eq!(t.node(ROOT).size, 1801);
        assert_eq!(t.node(ROOT).items, 5);
        assert_eq!(t.node(1).size, 800);
        assert_eq!(t.node(ROOT).flags & flag::PENDING, 0);
        assert_eq!(t.path_of(4), PathBuf::from("/tmp/root/a/x"));
    }

    #[test]
    fn sorted_and_removed() {
        let mut t = sample();
        let kids = t.sorted_children(ROOT, SizeMode::Disk);
        assert_eq!(kids.iter().map(|&k| t.name(k).into_owned()).collect::<Vec<_>>(), ["big.bin", "a", "tiny"]);
        t.remove(1);
        assert_eq!(t.node(ROOT).size, 1001);
        assert_eq!(t.node(ROOT).items, 2);
        assert_eq!(t.sorted_children(ROOT, SizeMode::Disk).len(), 2);
    }

    #[test]
    fn rings_prune_small_items() {
        let t = sample();
        let r = t.rings(ROOT, 4, 0.01, SizeMode::Disk);
        assert_eq!(r.children.len(), 2);
        assert_eq!(r.other_count, 1);
        assert_eq!(r.other_size, 1);
        let a = r.children.iter().find(|c| c.name == "a").unwrap();
        assert_eq!(a.children.len(), 2);
    }

    #[test]
    fn find_path_walks_names() {
        let t = sample();
        assert_eq!(t.find_path(Path::new("/tmp/root/a/y")), Some(5));
        assert_eq!(t.find_path(Path::new("/tmp/root")), Some(ROOT));
        assert_eq!(t.find_path(Path::new("/tmp/root/nope")), None);
        assert_eq!(t.find_path(Path::new("/elsewhere")), None);
    }

    #[test]
    fn reset_dir_subtracts() {
        let mut t = sample();
        t.reset_dir(1);
        assert_eq!(t.node(ROOT).size, 1001);
        assert_eq!(t.node(1).flags & flag::PENDING, flag::PENDING);
        assert!(!t.has_children(1));
    }
}

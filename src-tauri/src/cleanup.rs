//! "Free up space" assistant.
//!
//! The opaque "System Data" in macOS Settings is mostly made of things that
//! grow silently in well-known places: caches, logs, Xcode and Simulator data,
//! package-manager caches, old iPhone backups, installers, the Trash and
//! Time Machine local snapshots. This module measures those places (with the
//! same fast scanner) and performs the clean-up actions the user confirms.
//!
//! Nothing here is a list of specific apps: caches are found by the folders
//! macOS gives every app (`~/Library/Caches`, the sandbox container), web
//! caches by how Chromium/Electron lays them out (Chrome, Slack, Discord,
//! VS Code…), and app names and "is it still installed?" come from
//! LaunchServices — so it works for any app, including ones never seen here.
//!
//! Safety rules:
//! - files are only ever *moved to the Trash* (recoverable), except for the
//!   explicit "Empty Trash" action;
//! - only paths reported by the most recent analysis can be trashed
//!   (`Allowed`), so the UI cannot remove arbitrary locations;
//! - app data of installed apps and root-owned apps are shown for reference
//!   only (`locked`);
//! - protected places are skipped without Full Disk Access instead of
//!   triggering a cascade of permission prompts.

use crate::apps::{self, AppNames};
use crate::scan::Scanner;
use crate::tree::{Kind, NONE, NodeId, ROOT, SizeMode, Tree, flag};
use parking_lot::RwLock;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Identifies the entry; shown in Finder.
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: Kind,
    /// Extra description (e.g. device name of an iPhone backup, parent folder).
    pub detail: Option<String>,
    /// Paths moved to the Trash together, when not just `path` (an app's
    /// cache folders, the contents of a Caches folder).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// Shown for reference only (data of an installed app, root-owned app).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    /// Data of an app that is no longer installed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub leftover: bool,
    /// When the app was last opened (Unix seconds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<i64>,
}

impl Entry {
    fn new(path: &Path, name: impl Into<String>, size: u64, kind: Kind) -> Self {
        Entry {
            path: path.to_string_lossy().into_owned(),
            name: name.into(),
            size,
            kind,
            detail: None,
            paths: Vec::new(),
            locked: false,
            leftover: false,
            used: None,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: &'static str,
    /// "trash" | "safe" | "review" | "system"
    pub group: &'static str,
    /// "trash" (entries can be moved to the Trash), "emptyTrash", "brewCleanup",
    /// "simulators", "snapshots" or "info".
    pub action: &'static str,
    pub path: Option<String>,
    /// Bytes on disk.
    pub size: u64,
    /// Logical bytes (e.g. the maximum size of a sparse disk image).
    pub apparent: u64,
    pub entries: Vec<Entry>,
    /// Number of items for count-only categories (snapshots).
    pub count: u32,
    /// The place exists but could not be read (needs Full Disk Access).
    pub denied: bool,
}

impl Category {
    fn new(id: &'static str, group: &'static str, action: &'static str) -> Self {
        Category {
            id,
            group,
            action,
            path: None,
            size: 0,
            apparent: 0,
            entries: Vec::new(),
            count: 0,
            denied: false,
        }
    }

    fn add(&mut self, e: Entry) {
        self.size += e.size;
        self.apparent += e.size;
        self.entries.push(e);
    }

    fn sort(&mut self, max: usize) {
        self.entries.sort_by(|a, b| b.size.cmp(&a.size));
        self.entries.truncate(max);
    }
}

/// Paths the UI may move to the Trash (filled by the last analysis).
#[derive(Default)]
pub struct Allowed(pub parking_lot::Mutex<HashSet<PathBuf>>);

const MAX_ENTRIES: usize = 400;
const MIN_ENTRY: u64 = 4096;
/// Smallest app data folder worth listing.
const MIN_APP_DATA: u64 = 100_000_000;

fn scan(path: &Path) -> Option<Arc<RwLock<Tree>>> {
    let md = std::fs::symlink_metadata(path).ok()?;
    if !md.is_dir() {
        return None;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tree = Arc::new(RwLock::new(Tree::new(path.to_path_buf(), &name, 0)));
    Scanner::new(tree.clone()).run(ROOT);
    Some(tree)
}

fn file_sizes(path: &Path) -> Option<(u64, u64)> {
    let md = std::fs::symlink_metadata(path).ok()?;
    Some((md.blocks() * 512, md.len()))
}

/// Everything inside `roots` as individual entries (biggest first).
fn children_of(cat: &mut Category, roots: &[PathBuf]) {
    for root in roots {
        let Some(tree) = scan(root) else { continue };
        let t = tree.read();
        let r = t.node(ROOT);
        if r.flags & flag::ERROR != 0 && r.child_count == 0 {
            cat.denied = true;
            continue;
        }
        if cat.path.is_none() {
            cat.path = Some(root.to_string_lossy().into_owned());
        }
        cat.size += r.size;
        cat.apparent += r.apparent;
        for c in t.sorted_children(ROOT, SizeMode::Disk) {
            let n = t.node(c);
            if n.size >= MIN_ENTRY {
                cat.entries.push(Entry::new(&t.path_of(c), t.name(c), n.size, n.kind));
            }
        }
    }
    cat.sort(MAX_ENTRIES);
}

/// Each existing path as one entry, labelled.
fn whole(cat: &mut Category, items: &[(&str, PathBuf)]) {
    for (label, path) in items {
        let md = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let (size, apparent, kind) = if md.is_dir() {
            let Some(tree) = scan(path) else { continue };
            let t = tree.read();
            let r = t.node(ROOT);
            if r.flags & flag::ERROR != 0 && r.child_count == 0 {
                cat.denied = true;
                continue;
            }
            (r.size, r.apparent, Kind::Dir)
        } else {
            (md.blocks() * 512, md.len(), Kind::File)
        };
        if size < MIN_ENTRY {
            continue;
        }
        cat.size += size;
        cat.apparent += apparent;
        cat.entries.push(Entry::new(path, *label, size, kind));
    }
    cat.sort(MAX_ENTRIES);
}

/// `<key>Device Name</key><string>…</string>` from an XML plist.
fn plist_string(text: &str, key: &str) -> Option<String> {
    let k = format!("<key>{key}</key>");
    let rest = &text[text.find(&k)? + k.len()..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")?;
    Some(rest[start..start + end].trim().to_string())
}

fn brew_path() -> Option<PathBuf> {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

fn brew_command(brew: &Path) -> Command {
    let mut cmd = Command::new(brew);
    cmd.env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env("HOMEBREW_NO_ANALYTICS", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .env("HOMEBREW_NO_COLOR", "1");
    cmd
}

/// Parses "…would free approximately 544.9MB of disk space." (Homebrew uses 1024-based units).
fn parse_brew_size(output: &str) -> Option<u64> {
    let i = output.find("approximately ")? + "approximately ".len();
    let token: String = output[i..].chars().take_while(|c| !c.is_whitespace()).collect();
    let split = token.find(|c: char| c.is_ascii_alphabetic())?;
    let (num, unit) = token.split_at(split);
    let value: f64 = num.replace(',', "").parse().ok()?;
    let mult = match unit {
        "B" => 1.0,
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * mult) as u64)
}

pub fn local_snapshots() -> Vec<String> {
    Command::new("/usr/bin/tmutil")
        .args(["listlocalsnapshots", "/"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(str::trim)
                .filter(|l| l.starts_with("com.apple.TimeMachine"))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

fn is_ancestor_flagged(t: &Tree, id: NodeId, mask: u16) -> bool {
    let mut cur = t.node(id).parent;
    while cur != NONE {
        if t.node(cur).flags & mask != 0 {
            return true;
        }
        cur = t.node(cur).parent;
    }
    false
}

/// Only user folders: inside the home folder, not in ~/Library, not in
/// hidden tool folders (~/.vscode, ~/.cargo, …) and not inside app bundles.
fn is_user_area(t: &Tree, id: NodeId, home: &Path) -> bool {
    let path = t.path_of(id);
    let Ok(rel) = path.strip_prefix(home) else { return false };
    let mut comps = rel.components();
    match comps.next() {
        Some(c) if c.as_os_str() == "Library" => return false,
        None => return false,
        _ => {}
    }
    if rel.components().any(|c| c.as_os_str().as_bytes().first() == Some(&b'.')) {
        return false;
    }
    !is_ancestor_flagged(t, id, flag::PACKAGE | flag::REMOVED)
}

/// node_modules folders and cache folders (marked with CACHEDIR.TAG, e.g.
/// Rust `target/`) of your projects, found in the current scan.
fn project_junk(t: &Tree, home: &Path) -> Category {
    let mut cat = Category::new("projectJunk", "review", "trash");
    for id in 0..t.len() as NodeId {
        let n = t.node(id);
        if n.kind != Kind::Dir || n.flags & flag::HIDDEN != 0 || n.size < 1_000_000 {
            continue;
        }
        let name = t.name_bytes(id);
        let is_modules = name == b"node_modules";
        let is_cache = !is_modules
            && t.children(id)
                .any(|c| t.node(c).kind == Kind::File && t.name_bytes(c) == b"CACHEDIR.TAG");
        if !is_modules && !is_cache {
            continue;
        }
        // The outermost one only.
        let mut cur = n.parent;
        let mut nested = false;
        while cur != NONE {
            if t.name_bytes(cur) == b"node_modules" {
                nested = true;
                break;
            }
            cur = t.node(cur).parent;
        }
        if nested || !is_user_area(t, id, home) {
            continue;
        }
        let project = if n.parent != NONE { t.name(n.parent).into_owned() } else { String::new() };
        let mut e = Entry::new(&t.path_of(id), format!("{project}/{}", String::from_utf8_lossy(name)), n.size, Kind::Dir);
        e.detail = Some(t.path_of(n.parent).to_string_lossy().into_owned());
        cat.size += n.size;
        cat.apparent += n.apparent;
        cat.entries.push(e);
    }
    cat.sort(MAX_ENTRIES);
    cat
}

/// Biggest single files in your folders (from the current scan).
fn large_files(t: &Tree, home: &Path) -> Category {
    let mut cat = Category::new("largeFiles", "review", "trash");
    let mut found: Vec<NodeId> = (0..t.len() as NodeId)
        .filter(|&id| {
            let n = t.node(id);
            n.kind == Kind::File && n.size >= 500_000_000 && n.flags & flag::HIDDEN == 0
        })
        .filter(|&id| is_user_area(t, id, home))
        .collect();
    found.sort_by(|&a, &b| t.node(b).size.cmp(&t.node(a).size));
    for id in found.into_iter().take(40) {
        let n = t.node(id);
        let mut e = Entry::new(&t.path_of(id), t.name(id), n.size, Kind::File);
        e.detail = t.path_of(n.parent).to_str().map(String::from);
        cat.size += n.size;
        cat.apparent += n.apparent;
        cat.entries.push(e);
    }
    cat
}

// ------------------------------------------------------- app data rules ----

fn child_named(t: &Tree, id: NodeId, name: &[u8]) -> Option<NodeId> {
    t.children(id).find(|&c| t.name_bytes(c) == name)
}

fn descend(t: &Tree, mut id: NodeId, names: &[&[u8]]) -> Option<NodeId> {
    for name in names {
        id = child_named(t, id, name)?;
    }
    Some(id)
}

/// Cache folders of Chromium / Electron (Chrome, Edge, Brave, Slack, Discord,
/// VS Code, Teams, Figma, Notion…). The apps recreate them on demand.
fn is_web_cache(t: &Tree, id: NodeId) -> bool {
    const ALWAYS: &[&[u8]] = &[
        b"Code Cache",
        b"GPUCache",
        b"DawnCache",
        b"DawnGraphiteCache",
        b"DawnWebGPUCache",
        b"GraphiteDawnCache",
        b"GrShaderCache",
        b"ShaderCache",
        b"component_crx_cache",
    ];
    let n = t.node(id);
    if n.kind != Kind::Dir || n.parent == NONE {
        return false;
    }
    let name = t.name_bytes(id);
    if ALWAYS.contains(&name) {
        return true;
    }
    match name {
        b"CacheStorage" | b"ScriptCache" => t.name_bytes(n.parent) == b"Service Worker",
        // A plain "Cache" only next to other Chromium profile folders.
        b"Cache" => t
            .children(n.parent)
            .any(|c| matches!(t.name_bytes(c), b"Code Cache" | b"GPUCache" | b"Local Storage")),
        _ => false,
    }
}

fn find_web_caches(t: &Tree, start: NodeId, max_depth: u32) -> Vec<NodeId> {
    let mut found = Vec::new();
    let mut stack = vec![(start, 0u32)];
    while let Some((id, depth)) = stack.pop() {
        for c in t.children(id) {
            let n = t.node(c);
            if n.kind != Kind::Dir || n.flags & flag::PACKAGE != 0 {
                continue;
            }
            if is_web_cache(t, c) {
                found.push(c);
            } else if depth + 1 < max_depth {
                stack.push((c, depth + 1));
            }
        }
    }
    found
}

/// Folders that group several apps of one vendor (Google/Chrome, Microsoft/Teams…).
const VENDORS: &[&[u8]] = &[b"Google", b"Microsoft", b"BraveSoftware", b"Mozilla", b"JetBrains", b"Adobe"];

/// The app folder (one or, for vendor folders, two levels below `start`) that contains `id`.
fn app_folder(t: &Tree, start: NodeId, id: NodeId) -> NodeId {
    let mut chain = Vec::new();
    let mut cur = id;
    while cur != NONE && cur != start {
        chain.push(cur);
        cur = t.node(cur).parent;
    }
    chain.reverse();
    match chain.as_slice() {
        [top, second, _, ..] if VENDORS.contains(&t.name_bytes(*top)) => *second,
        [top, ..] => *top,
        [] => id,
    }
}

/// One entry per app with all its web cache folders.
fn web_cache_entries(
    t: &Tree,
    caches: Vec<NodeId>,
    owner_of: impl Fn(NodeId) -> NodeId,
    mut name_of: impl FnMut(NodeId) -> String,
) -> Vec<Entry> {
    let mut groups: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for c in caches {
        groups.entry(owner_of(c)).or_default().push(c);
    }
    let mut out = Vec::new();
    for (owner, mut dirs) in groups {
        let size: u64 = dirs.iter().map(|&d| t.node(d).size).sum();
        if size < 1_000_000 {
            continue;
        }
        dirs.sort_by_key(|&d| std::cmp::Reverse(t.node(d).size));
        let mut e = Entry::new(&t.path_of(dirs[0]), name_of(owner), size, Kind::Dir);
        e.paths = dirs.iter().map(|&d| t.path_of(d).to_string_lossy().into_owned()).collect();
        out.push(e);
    }
    out
}

/// The contents of a Caches folder as one entry (the folder itself stays).
fn caches_entry(t: &Tree, caches: NodeId, name: String) -> Option<Entry> {
    let size = t.node(caches).size;
    if size < 1_000_000 {
        return None;
    }
    let paths: Vec<String> = t.children(caches).map(|k| t.path_of(k).to_string_lossy().into_owned()).collect();
    if paths.is_empty() {
        return None;
    }
    let mut e = Entry::new(&t.path_of(caches), name, size, Kind::Dir);
    e.paths = paths;
    Some(e)
}

#[derive(Default)]
struct LibraryFinds {
    /// Caches of sandboxed apps (added to "caches").
    caches: Vec<Entry>,
    web: Vec<Entry>,
    data: Vec<Entry>,
}

/// ~/Library/Application Support: web caches and the biggest app folders.
fn application_support(t: &Tree, base: &Path, names: &mut AppNames, out: &mut LibraryFinds) {
    let caches = find_web_caches(t, ROOT, 6);
    out.web.extend(web_cache_entries(
        t,
        caches,
        |c| app_folder(t, ROOT, c),
        |o| {
            let parent = t.node(o).parent;
            if parent != ROOT && parent != NONE {
                format!("{} › {}", t.name(parent), t.name(o))
            } else {
                t.name(o).into_owned()
            }
        },
    ));
    for c in t.children(ROOT) {
        let n = t.node(c);
        let folder = t.name(c).into_owned();
        // iPhone backups have their own category.
        if n.kind != Kind::Dir || n.size < MIN_APP_DATA || folder == "MobileSync" {
            continue;
        }
        let name = names.lookup(&folder).unwrap_or(folder);
        let mut e = Entry::new(&t.path_of(c), name, n.size, Kind::Dir);
        e.detail = Some(base.to_string_lossy().into_owned());
        e.locked = true;
        out.data.push(e);
    }
}

/// ~/Library/Containers (sandboxed apps) or ~/Library/Group Containers.
fn containers(t: &Tree, base: &Path, group: bool, names: &mut AppNames, out: &mut LibraryFinds) {
    for c in t.children(ROOT) {
        let n = t.node(c);
        if n.kind != Kind::Dir {
            continue;
        }
        let folder = t.name(c).into_owned();
        let id = if group { folder.strip_prefix("group.").unwrap_or(&folder) } else { folder.as_str() };
        let app = names.lookup(id);
        // Caches and web caches only of apps that are installed — not of
        // system services or leftovers (those are listed as a whole below).
        let lib = if group { child_named(t, c, b"Library") } else { descend(t, c, &[b"Data", b"Library"]) };
        if let (Some(app_name), Some(lib)) = (&app, lib) {
            if let Some(mut e) = child_named(t, lib, b"Caches").and_then(|k| caches_entry(t, k, app_name.clone())) {
                e.detail = Some(base.to_string_lossy().into_owned());
                out.caches.push(e);
            }
            if let Some(support) = child_named(t, lib, b"Application Support") {
                let found = find_web_caches(t, support, 5);
                out.web.extend(web_cache_entries(t, found, |_| support, |_| app_name.clone()));
            }
        }
        // Docker's disk image has its own category.
        if folder == "com.docker.docker" || n.size < MIN_APP_DATA {
            continue;
        }
        let mut e = Entry::new(&t.path_of(c), app.clone().unwrap_or_else(|| folder.clone()), n.size, Kind::Dir);
        e.detail = Some(base.to_string_lossy().into_owned());
        // A container is named after its app's bundle id: when no app has that
        // id any more, it is left over from an uninstalled app.
        e.leftover = !group && app.is_none() && !folder.starts_with("com.apple.") && apps::looks_like_bundle_id(&folder);
        e.locked = !e.leftover;
        out.data.push(e);
    }
}

/// Big folders in a system-wide place (sound libraries in /Library/Application
/// Support, Apple Loops, simulator runtimes…). Shown for reference.
fn system_folders(dir: &Path, out: &mut Vec<Entry>) {
    let Some(tree) = scan(dir) else { return };
    let t = tree.read();
    for c in t.children(ROOT) {
        let n = t.node(c);
        if n.kind != Kind::Dir || n.size < MIN_APP_DATA {
            continue;
        }
        let mut e = Entry::new(&t.path_of(c), t.name(c), n.size, Kind::Dir);
        e.detail = Some(dir.to_string_lossy().into_owned());
        e.locked = true;
        out.push(e);
    }
}

/// Installed apps by size, with the date they were last opened.
fn applications(home: &Path) -> Category {
    let mut cat = Category::new("apps", "review", "trash");
    cat.path = Some("/Applications".into());
    let own = apps::own_bundle();
    for root in [PathBuf::from("/Applications"), home.join("Applications")] {
        let Some(tree) = scan(&root) else { continue };
        let t = tree.read();
        let is_app = |id: NodeId| t.node(id).kind == Kind::Dir && t.name_bytes(id).ends_with(b".app");
        let mut bundles = Vec::new();
        for c in t.children(ROOT) {
            if is_app(c) {
                bundles.push(c);
            } else if t.node(c).kind == Kind::Dir {
                // "Utilities", "Adobe Photoshop 2026", "Setapp"…
                bundles.extend(t.children(c).filter(|&k| is_app(k)));
            }
        }
        for b in bundles {
            let size = t.node(b).size;
            let path = t.path_of(b);
            if size < 20_000_000 || own.as_deref() == Some(path.as_path()) {
                continue;
            }
            let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let mut e = Entry::new(&path, name, size, Kind::Dir);
            e.used = apps::last_used(&path);
            // Apps installed by the App Store or an installer belong to root.
            e.locked = !apps::writable(&path);
            cat.add(e);
        }
    }
    cat.sort(80);
    cat
}

/// Measures everything; `emit` is called for each category as soon as it is
/// ready (a category may be sent again with more entries).
pub fn analyze(
    home: &Path,
    full_disk_access: bool,
    tree: Option<Arc<RwLock<Tree>>>,
    emit: &mut dyn FnMut(Category),
) {
    let lib = home.join("Library");
    let mut names = AppNames::default();

    // Slow, independent parts run alongside the rest.
    let brew = brew_path().map(|b| {
        std::thread::spawn(move || {
            let out = brew_command(&b).args(["cleanup", "--prune=all", "-n"]).output().ok()?;
            parse_brew_size(&String::from_utf8_lossy(&out.stdout))
        })
    });
    let installed = {
        let home = home.to_path_buf();
        std::thread::spawn(move || applications(&home))
    };

    fn push(cat: Category, emit: &mut dyn FnMut(Category)) {
        if cat.size > 0 || cat.denied || cat.count > 0 {
            emit(cat);
        }
    }

    // --- Trash
    {
        let mut cat = Category::new("trash", "trash", "emptyTrash");
        cat.path = Some(home.join(".Trash").to_string_lossy().into_owned());
        if full_disk_access {
            if let Some(tree) = scan(&home.join(".Trash")) {
                let t = tree.read();
                cat.size = t.node(ROOT).size;
                cat.apparent = t.node(ROOT).apparent;
                cat.count = t.children(ROOT).count() as u32;
            }
        } else {
            cat.denied = true;
        }
        push(cat, emit);
    }

    // --- Safe: regenerated automatically when needed
    let mut caches = Category::new("caches", "safe", "trash");
    children_of(&mut caches, &[lib.join("Caches")]);
    for e in &mut caches.entries {
        if let Some(app) = names.lookup(&e.name) {
            e.name = app;
        }
    }
    push(caches.clone(), emit);

    let mut cat = Category::new("logs", "safe", "trash");
    children_of(&mut cat, &[lib.join("Logs")]);
    push(cat, emit);

    let mut cat = Category::new("xcodeDerivedData", "safe", "trash");
    children_of(&mut cat, &[lib.join("Developer/Xcode/DerivedData")]);
    push(cat, emit);

    let mut cat = Category::new("xcodeDeviceSupport", "safe", "trash");
    let xcode = lib.join("Developer/Xcode");
    children_of(
        &mut cat,
        &["iOS DeviceSupport", "watchOS DeviceSupport", "tvOS DeviceSupport", "visionOS DeviceSupport", "xrOS DeviceSupport"]
            .map(|d| xcode.join(d)),
    );
    push(cat, emit);

    let mut cat = Category::new("simulatorCaches", "safe", "trash");
    children_of(&mut cat, &[lib.join("Developer/CoreSimulator/Caches")]);
    push(cat, emit);

    let mut cat = Category::new("devCaches", "safe", "trash");
    whole(
        &mut cat,
        &[
            ("npm", home.join(".npm/_cacache")),
            ("pnpm", lib.join("pnpm/store")),
            ("Yarn (Berry)", home.join(".yarn/berry/cache")),
            ("Bun", home.join(".bun/install/cache")),
            ("Cargo · registry/cache", home.join(".cargo/registry/cache")),
            ("Cargo · registry/src", home.join(".cargo/registry/src")),
            ("Cargo · git/checkouts", home.join(".cargo/git/checkouts")),
            ("Gradle", home.join(".gradle/caches")),
            ("Maven", home.join(".m2/repository")),
            ("Go modules", home.join("go/pkg/mod")),
            ("CocoaPods", home.join(".cocoapods/repos")),
        ],
    );
    push(cat, emit);

    let mut cat = Category::new("iosUpdates", "safe", "trash");
    whole(
        &mut cat,
        &[
            ("iPhone Software Updates", lib.join("iTunes/iPhone Software Updates")),
            ("iPad Software Updates", lib.join("iTunes/iPad Software Updates")),
        ],
    );
    push(cat, emit);

    if full_disk_access {
        let mut cat = Category::new("mailDownloads", "safe", "trash");
        children_of(&mut cat, &[lib.join("Containers/com.apple.mail/Data/Library/Mail Downloads")]);
        push(cat, emit);
    }

    // --- App folders in ~/Library: web caches, sandboxed apps' caches, app data
    let mut finds = LibraryFinds::default();
    let support = lib.join("Application Support");
    if let Some(tree) = scan(&support) {
        application_support(&tree.read(), &support, &mut names, &mut finds);
    }
    if full_disk_access {
        for (dir, group) in [(lib.join("Containers"), false), (lib.join("Group Containers"), true)] {
            if let Some(tree) = scan(&dir) {
                containers(&tree.read(), &dir, group, &mut names, &mut finds);
            }
        }
    }
    if !finds.caches.is_empty() {
        for e in finds.caches.drain(..) {
            caches.add(e);
        }
        caches.sort(MAX_ENTRIES);
        push(caches, emit);
    }
    let mut web = Category::new("webCaches", "safe", "trash");
    for e in finds.web.drain(..) {
        web.add(e);
    }
    web.sort(MAX_ENTRIES);
    push(web, emit);

    // --- Review: your data, decide yourself
    if full_disk_access {
        let mut cat = Category::new("iosBackups", "review", "trash");
        children_of(&mut cat, &[lib.join("Application Support/MobileSync/Backup")]);
        for e in &mut cat.entries {
            if let Ok(text) = std::fs::read_to_string(Path::new(&e.path).join("Info.plist")) {
                let name = plist_string(&text, "Device Name");
                let date = text
                    .find("<key>Last Backup Date</key>")
                    .and_then(|i| text[i..].find("<date>").map(|j| i + j + 6))
                    .and_then(|s| text[s..].find('T').map(|e| text[s..s + e].to_string()));
                e.detail = match (name, date) {
                    (Some(n), Some(d)) => Some(format!("{n} · {d}")),
                    (Some(n), None) => Some(n),
                    _ => None,
                };
            }
        }
        push(cat, emit);
    }

    let mut cat = Category::new("xcodeArchives", "review", "trash");
    children_of(&mut cat, &[lib.join("Developer/Xcode/Archives")]);
    push(cat, emit);

    let devices = lib.join("Developer/CoreSimulator/Devices");
    if devices.is_dir() {
        let mut cat = Category::new("simulators", "review", "simulators");
        if let Some(tree) = scan(&devices) {
            let t = tree.read();
            cat.size = t.node(ROOT).size;
            cat.apparent = t.node(ROOT).apparent;
            cat.count = t.children(ROOT).filter(|&c| t.node(c).kind == Kind::Dir).count() as u32;
        }
        cat.path = Some(devices.to_string_lossy().into_owned());
        push(cat, emit);
    }

    if full_disk_access {
        let mut cat = Category::new("installers", "review", "trash");
        let downloads = home.join("Downloads");
        if let Ok(rd) = std::fs::read_dir(&downloads) {
            for de in rd.flatten() {
                let path = de.path();
                let ext = path
                    .extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                if !matches!(ext.as_str(), "dmg" | "pkg" | "mpkg" | "xip" | "iso" | "ipsw") {
                    continue;
                }
                if let Some((size, apparent)) = file_sizes(&path) {
                    if size < 1_000_000 {
                        continue;
                    }
                    cat.size += size;
                    cat.apparent += apparent;
                    cat.entries.push(Entry::new(&path, de.file_name().to_string_lossy(), size, Kind::File));
                }
            }
            cat.sort(MAX_ENTRIES);
            cat.path = Some(downloads.to_string_lossy().into_owned());
        }
        push(cat, emit);
    }

    let mut cat = Category::new("toolCaches", "review", "trash");
    children_of(&mut cat, &[home.join(".cache")]);
    push(cat, emit);

    if let Some(tree) = tree {
        let (junk, large) = {
            let t = tree.read();
            (project_junk(&t, home), large_files(&t, home))
        };
        push(junk, emit);
        push(large, emit);
    }

    if full_disk_access {
        let raw = lib.join("Containers/com.docker.docker/Data/vms/0/data/Docker.raw");
        if let Some((size, apparent)) = file_sizes(&raw) {
            let mut cat = Category::new("docker", "review", "info");
            cat.size = size;
            cat.apparent = apparent;
            cat.path = Some(raw.to_string_lossy().into_owned());
            push(cat, emit);
        }
    }

    if let Ok(cat) = installed.join() {
        push(cat, emit);
    }

    let mut data = Category::new("appData", "review", "trash");
    for dir in ["/Library/Application Support", "/Library/Audio", "/Library/Developer"] {
        system_folders(Path::new(dir), &mut finds.data);
    }
    for e in finds.data.drain(..) {
        data.add(e);
    }
    data.sort(60);
    push(data, emit);

    if let Some(handle) = brew {
        if let Ok(Some(bytes)) = handle.join() {
            let mut cat = Category::new("homebrew", "safe", "brewCleanup");
            cat.size = bytes;
            cat.apparent = bytes;
            push(cat, emit);
        }
    }

    // --- System
    let snapshots = local_snapshots();
    if !snapshots.is_empty() {
        let mut cat = Category::new("snapshots", "system", "snapshots");
        cat.count = snapshots.len() as u32;
        push(cat, emit);
    }
}

/// Moves analysed paths to the Trash. Returns the paths that were moved and
/// the failures (path, message).
pub fn move_to_trash(allowed: &Allowed, paths: &[String]) -> (Vec<PathBuf>, Vec<(String, String)>) {
    let allowed = allowed.0.lock();
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    for p in paths {
        let path = PathBuf::from(p);
        if !allowed.contains(&path) {
            failed.push((p.clone(), "not-allowed".into()));
            continue;
        }
        match crate::macos::move_to_trash(&path) {
            Ok(()) => moved.push(path),
            Err(e) => failed.push((p.clone(), e)),
        }
    }
    (moved, failed)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashInfo {
    pub size: u64,
    pub items: u32,
    pub accessible: bool,
}

pub fn trash_info(home: &Path) -> TrashInfo {
    let trash = home.join(".Trash");
    if std::fs::read_dir(&trash).is_err() {
        return TrashInfo { size: 0, items: 0, accessible: false };
    }
    match scan(&trash) {
        Some(tree) => {
            let t = tree.read();
            TrashInfo {
                size: t.node(ROOT).size,
                items: t.children(ROOT).count() as u32,
                accessible: true,
            }
        }
        None => TrashInfo { size: 0, items: 0, accessible: false },
    }
}

/// Permanently deletes everything in ~/.Trash. Uses Finder when the folder
/// is not readable (no Full Disk Access).
pub fn empty_trash(home: &Path) -> Result<u32, String> {
    let trash = home.join(".Trash");
    match std::fs::read_dir(&trash) {
        Ok(rd) => {
            let mut failed = 0u32;
            for de in rd.flatten() {
                let p = de.path();
                let res = match std::fs::symlink_metadata(&p) {
                    Ok(md) if md.is_dir() => std::fs::remove_dir_all(&p),
                    Ok(_) => std::fs::remove_file(&p),
                    Err(e) => Err(e),
                };
                if res.is_err() {
                    failed += 1;
                }
            }
            Ok(failed)
        }
        Err(_) => {
            let status = Command::new("/usr/bin/osascript")
                .args(["-e", "tell application \"Finder\" to empty trash"])
                .status()
                .map_err(|e| e.to_string())?;
            if status.success() {
                Ok(0)
            } else {
                Err("Finder could not empty the Trash".into())
            }
        }
    }
}

/// Runs one of the fixed clean-up commands.
pub fn run_action(action: &str) -> Result<String, String> {
    let output = match action {
        "brewCleanup" => {
            let brew = brew_path().ok_or("Homebrew not found")?;
            brew_command(&brew).args(["cleanup", "--prune=all"]).output()
        }
        "simulators" => Command::new("/usr/bin/xcrun").args(["simctl", "delete", "unavailable"]).output(),
        "snapshots" => Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "do shell script \"/usr/bin/tmutil deletelocalsnapshots /\" with administrator privileges",
            ])
            .output(),
        other => return Err(format!("unknown action {other}")),
    }
    .map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        Ok(text.trim().lines().last().unwrap_or("").to_string())
    } else {
        Err(text.trim().lines().last().unwrap_or("failed").to_string())
    }
}

/// Paths of a category that may be moved to the Trash.
pub fn trashable_paths(cat: &Category) -> Vec<PathBuf> {
    if cat.action != "trash" {
        return Vec::new();
    }
    cat.entries
        .iter()
        .filter(|e| !e.locked)
        .flat_map(|e| {
            if e.paths.is_empty() {
                vec![PathBuf::from(&e.path)]
            } else {
                e.paths.iter().map(PathBuf::from).collect()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::ChildSpec;

    fn spec(names: &mut Vec<u8>, n: &str, kind: Kind, size: u64) -> ChildSpec {
        let off = names.len() as u32;
        names.extend_from_slice(n.as_bytes());
        ChildSpec { name_off: off, name_len: n.len() as u32, kind, flags: 0, size, apparent: size, mtime: 0 }
    }

    /// Test tree from a nested description: `D(name, children)` / `F(name, bytes)`.
    enum S {
        D(&'static str, Vec<S>),
        F(&'static str, u64),
    }
    use S::{D, F};

    fn build(t: &mut Tree, parent: NodeId, kids: &[S]) {
        let mut names = Vec::new();
        let specs: Vec<ChildSpec> = kids
            .iter()
            .map(|k| match k {
                D(n, _) => spec(&mut names, n, Kind::Dir, 0),
                F(n, s) => spec(&mut names, n, Kind::File, *s),
            })
            .collect();
        let first = t.add_children(parent, &names, &specs);
        for (i, k) in kids.iter().enumerate() {
            if let D(_, sub) = k {
                build(t, first + i as NodeId, sub);
            }
        }
    }

    #[test]
    fn brew_sizes() {
        let out = "Would remove: x\n==> This operation would free approximately 544.9MB of disk space.\n";
        assert_eq!(parse_brew_size(out), Some((544.9 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_brew_size("approximately 1.5GB of"), Some((1.5 * 1024.0 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_brew_size("nothing"), None);
    }

    #[test]
    fn plist_values() {
        let xml = "<dict><key>Device Name</key>\n\t<string>iPhone Wojtka</string><key>x</key></dict>";
        assert_eq!(plist_string(xml, "Device Name").as_deref(), Some("iPhone Wojtka"));
        assert_eq!(plist_string(xml, "Missing"), None);
    }

    #[test]
    fn junk_and_large_files_only_in_user_folders() {
        let home = PathBuf::from("/Users/me");
        let mut t = Tree::new(home.clone(), "me", 0);
        build(
            &mut t,
            ROOT,
            &[
                D("proj", vec![
                    D("node_modules", vec![F("big.js", 5_000_000)]),
                    D("target", vec![F("CACHEDIR.TAG", 4096), F("debug.bin", 9_000_000)]),
                ]),
                D(".vscode", vec![D("node_modules", vec![F("ext.js", 7_000_000)])]),
                F("movie.mov", 3_000_000_000),
            ],
        );
        let junk = project_junk(&t, &home);
        let names: Vec<_> = junk.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["proj/target", "proj/node_modules"]);
        let large = large_files(&t, &home);
        assert_eq!(large.entries.len(), 1);
        assert_eq!(large.entries[0].name, "movie.mov");
    }

    #[test]
    fn web_caches_grouped_per_app() {
        let mb = 1_000_000;
        let mut t = Tree::new(PathBuf::from("/S"), "S", 0);
        build(
            &mut t,
            ROOT,
            &[
                D("Slack", vec![
                    D("Cache", vec![F("data_1", 40 * mb)]),
                    D("Code Cache", vec![F("js", 20 * mb)]),
                    D("GPUCache", vec![F("g", 2 * mb)]),
                    D("Service Worker", vec![D("CacheStorage", vec![F("c", 9 * mb)]), D("Database", vec![F("d", 5 * mb)])]),
                    D("Local Storage", vec![F("l", 3 * mb)]),
                ]),
                D("Google", vec![D("Chrome", vec![D("Default", vec![D("Code Cache", vec![F("x", 30 * mb)])])])]),
                // "Cache" without Chromium siblings is somebody's data, not a web cache.
                D("SomeApp", vec![D("Cache", vec![F("important", 50 * mb)])]),
            ],
        );
        let mut names = AppNames::default();
        let mut finds = LibraryFinds::default();
        application_support(&t, Path::new("/S"), &mut names, &mut finds);
        let mut web: Vec<(String, u64, usize)> = finds.web.iter().map(|e| (e.name.clone(), e.size, e.paths.len())).collect();
        web.sort();
        assert_eq!(web, [("Google › Chrome".to_string(), 30 * mb, 1), ("Slack".to_string(), 71 * mb, 4)]);
        // Service Worker/Database is not a cache; nothing of SomeApp is.
        let slack = finds.web.iter().find(|e| e.name == "Slack").unwrap();
        assert!(slack.paths.iter().all(|p| !p.contains("Database") && !p.contains("Local Storage")));
        assert!(finds.web.iter().all(|e| !e.path.contains("SomeApp")));
    }

    #[test]
    fn containers_caches_and_leftovers() {
        let mb = 1_000_000;
        let base = PathBuf::from("/C");
        let mut t = Tree::new(base.clone(), "C", 0);
        build(
            &mut t,
            ROOT,
            &[
                // Finder is always installed: its caches count, its data is locked.
                D("com.apple.finder", vec![D("Data", vec![D("Library", vec![
                    D("Caches", vec![F("a", 2 * mb), F("b", 1 * mb)]),
                    D("Application Support", vec![D("Web", vec![D("Code Cache", vec![F("c", 3 * mb)])])]),
                    F("big", 200 * mb),
                ])])]),
                // No app has this id: left over from an uninstalled app.
                D("com.example.surely-not-installed-anywhere", vec![F("data", 150 * mb)]),
                // Apple's own services are never called leftovers.
                D("com.apple.example.not-an-app", vec![F("data", 120 * mb)]),
                // Docker's disk image has its own category.
                D("com.docker.docker", vec![F("Docker.raw", 300 * mb)]),
            ],
        );
        let mut names = AppNames::default();
        let mut finds = LibraryFinds::default();
        containers(&t, &base, false, &mut names, &mut finds);

        assert_eq!(finds.caches.len(), 1);
        assert_eq!(finds.caches[0].name, "Finder");
        assert_eq!(finds.caches[0].paths, ["/C/com.apple.finder/Data/Library/Caches/a", "/C/com.apple.finder/Data/Library/Caches/b"]);
        assert_eq!(finds.web.len(), 1);
        assert_eq!((finds.web[0].name.as_str(), finds.web[0].size), ("Finder", 3 * mb));

        let data: Vec<(&str, bool, bool)> = finds.data.iter().map(|e| (e.name.as_str(), e.leftover, e.locked)).collect();
        assert!(data.contains(&("Finder", false, true)), "{data:?}");
        assert!(data.contains(&("com.example.surely-not-installed-anywhere", true, false)), "{data:?}");
        assert!(data.contains(&("com.apple.example.not-an-app", false, true)), "{data:?}");
        assert!(!data.iter().any(|d| d.0.contains("docker")), "{data:?}");
    }

    #[test]
    fn locked_entries_are_not_trashable() {
        let mut cat = Category::new("appData", "review", "trash");
        let mut a = Entry::new(Path::new("/a"), "a", 1, Kind::Dir);
        a.locked = true;
        let mut b = Entry::new(Path::new("/b"), "b", 1, Kind::Dir);
        b.paths = vec!["/b/1".into(), "/b/2".into()];
        cat.add(a);
        cat.add(b);
        assert_eq!(trashable_paths(&cat), [PathBuf::from("/b/1"), PathBuf::from("/b/2")]);
        let info = Category::new("docker", "review", "info");
        assert!(trashable_paths(&info).is_empty());
    }
}

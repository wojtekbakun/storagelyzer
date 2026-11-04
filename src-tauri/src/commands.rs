//! Tauri commands (the IPC API used by the frontend).

use crate::cleanup::{self, Allowed, Category, TrashInfo};
use crate::macos;
use crate::scan::{Progress, Scanner};
use crate::tree::{NodeId, NodeInfo, RingNode, SizeGap, SizeMode, Tree, ROOT};
use crate::volumes::{self, Location};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

type CmdResult<T> = Result<T, String>;

/// One scan of one root folder. Subfolder rescans reuse the same tree.
pub struct Session {
    pub id: u64,
    pub tree: Arc<RwLock<Tree>>,
    /// The scan currently running on this tree (full scan or rescan).
    active: Mutex<Option<Arc<Scanner>>>,
    /// Paths that could not be read, collected across scans.
    denied: Mutex<Vec<String>>,
}

#[derive(Default)]
pub struct AppState {
    session: RwLock<Option<Arc<Session>>>,
    next_id: AtomicU64,
    /// Paths the clean-up assistant offered (only those can be trashed by it).
    cleanup_allowed: Allowed,
}

impl AppState {
    fn session(&self, scan_id: u64) -> CmdResult<Arc<Session>> {
        match &*self.session.read() {
            Some(s) if s.id == scan_id => Ok(s.clone()),
            _ => Err("stale-scan".into()),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    #[serde(flatten)]
    pub progress: Progress,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    #[serde(flatten)]
    pub progress: Progress,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// Node that was scanned (root for a full scan).
    pub node: NodeId,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScanEvent {
    Progress(ProgressEvent),
    Done(DoneEvent),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSummary {
    pub name: String,
    pub total: u64,
    pub available: u64,
    pub used: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStarted {
    pub scan_id: u64,
    pub root: NodeInfo,
    pub root_path: String,
    /// Set when the scanned folder is the root of a volume, to show how much
    /// of the used space the scan could see.
    pub volume: Option<VolumeSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Locations {
    pub items: Vec<Location>,
    pub full_disk_access: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildrenPage {
    pub total: u32,
    pub items: Vec<NodeInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    pub id: NodeId,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetails {
    #[serde(flatten)]
    pub info: NodeInfo,
    pub path: String,
}

/// Runs `scanner` from `start` on a background thread, streaming progress
/// every 150 ms and a final `Done` event.
fn spawn_scan(session: Arc<Session>, scanner: Arc<Scanner>, start: NodeId, on_event: Channel<ScanEvent>) {
    *session.active.lock() = Some(scanner.clone());
    std::thread::Builder::new()
        .name("scan-main".into())
        .spawn(move || {
            let started = Instant::now();
            let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
            let ticker = {
                let scanner = scanner.clone();
                let ch = on_event.clone();
                std::thread::spawn(move || {
                    while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                        stop_rx.recv_timeout(Duration::from_millis(150))
                    {
                        let _ = ch.send(ScanEvent::Progress(ProgressEvent {
                            progress: scanner.stats.snapshot(),
                            elapsed_ms: started.elapsed().as_millis() as u64,
                        }));
                    }
                })
            };

            scanner.run(start);

            drop(stop_tx);
            let _ = ticker.join();
            session
                .denied
                .lock()
                .extend(scanner.stats.denied_paths.lock().iter().cloned());
            {
                let mut active = session.active.lock();
                if active.as_ref().is_some_and(|a| Arc::ptr_eq(a, &scanner)) {
                    *active = None;
                }
            }
            let _ = on_event.send(ScanEvent::Done(DoneEvent {
                progress: scanner.stats.snapshot(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                cancelled: scanner.cancel.load(Ordering::Relaxed),
                node: start,
            }));
        })
        .expect("failed to spawn scan thread");
}

#[tauri::command]
pub async fn list_locations() -> CmdResult<Locations> {
    Ok(Locations {
        items: volumes::locations(),
        full_disk_access: macos::has_full_disk_access(),
    })
}

#[tauri::command]
pub async fn start_scan(state: State<'_, AppState>, path: String, on_event: Channel<ScanEvent>) -> CmdResult<ScanStarted> {
    let path = expand_home(&path);
    let path = std::fs::canonicalize(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }

    // Stop whatever is running.
    if let Some(old) = state.session.write().take() {
        if let Some(active) = old.active.lock().as_ref() {
            active.cancel.store(true, Ordering::Relaxed);
        }
    }

    let name = volumes::display_name(&path);
    let mtime = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let tree = Arc::new(RwLock::new(Tree::new(path.clone(), &name, mtime)));
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let session = Arc::new(Session {
        id,
        tree: tree.clone(),
        active: Mutex::new(None),
        denied: Mutex::new(Vec::new()),
    });
    *state.session.write() = Some(session.clone());

    let volume = volumes::statfs(&path)
        .filter(|m| m.mount_on == path)
        .map(|m| VolumeSummary {
            name: name.clone(),
            total: m.total,
            available: m.available,
            used: m.used(),
        });

    let scanner = Arc::new(Scanner::new(tree.clone()));
    spawn_scan(session, scanner, ROOT, on_event);

    let root = tree.read().info(ROOT);
    Ok(ScanStarted {
        scan_id: id,
        root,
        root_path: path.to_string_lossy().into_owned(),
        volume,
    })
}

#[tauri::command]
pub async fn rescan(state: State<'_, AppState>, scan_id: u64, id: NodeId, on_event: Channel<ScanEvent>) -> CmdResult<()> {
    let session = state.session(scan_id)?;
    if session.active.lock().is_some() {
        return Err("busy".into());
    }
    {
        let t = session.tree.read();
        if !t.contains(id) || t.node(id).kind != crate::tree::Kind::Dir {
            return Err("not-a-folder".into());
        }
    }
    let scanner = Arc::new(Scanner::new(session.tree.clone()));
    spawn_scan(session, scanner, id, on_event);
    Ok(())
}

#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(s) = &*state.session.read() {
        if let Some(active) = s.active.lock().as_ref() {
            active.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

fn check(t: &Tree, id: NodeId) -> CmdResult<()> {
    if t.contains(id) {
        Ok(())
    } else {
        Err("unknown-node".into())
    }
}

#[tauri::command]
pub async fn get_children(
    state: State<'_, AppState>,
    scan_id: u64,
    id: NodeId,
    mode: SizeMode,
    offset: u32,
    limit: u32,
) -> CmdResult<ChildrenPage> {
    let session = state.session(scan_id)?;
    let t = session.tree.read();
    check(&t, id)?;
    let kids = t.sorted_children(id, mode);
    let items = kids
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|&c| t.info(c))
        .collect();
    Ok(ChildrenPage {
        total: kids.len() as u32,
        items,
    })
}

#[tauri::command]
pub async fn get_rings(
    state: State<'_, AppState>,
    scan_id: u64,
    id: NodeId,
    depth: u32,
    min_fraction: f64,
    mode: SizeMode,
) -> CmdResult<RingNode> {
    let session = state.session(scan_id)?;
    let t = session.tree.read();
    check(&t, id)?;
    Ok(t.rings(id, depth.clamp(1, 16), min_fraction.clamp(0.0001, 0.5), mode))
}

/// Why "Size" (logical) is bigger than "On disk" for `id`.
#[tauri::command]
pub async fn get_size_gap(state: State<'_, AppState>, scan_id: u64, id: NodeId) -> CmdResult<SizeGap> {
    let session = state.session(scan_id)?;
    let t = session.tree.read();
    check(&t, id)?;
    Ok(t.size_gap(id, 6))
}

#[tauri::command]
pub async fn get_ancestors(state: State<'_, AppState>, scan_id: u64, id: NodeId) -> CmdResult<Vec<Crumb>> {
    let session = state.session(scan_id)?;
    let t = session.tree.read();
    check(&t, id)?;
    Ok(t.ancestry(id)
        .into_iter()
        .map(|a| Crumb {
            id: a,
            name: t.name(a).into_owned(),
        })
        .collect())
}

#[tauri::command]
pub async fn get_node(state: State<'_, AppState>, scan_id: u64, id: NodeId) -> CmdResult<NodeDetails> {
    let session = state.session(scan_id)?;
    let t = session.tree.read();
    check(&t, id)?;
    Ok(NodeDetails {
        info: t.info(id),
        path: t.path_of(id).to_string_lossy().into_owned(),
    })
}

fn node_path(state: &AppState, scan_id: u64, id: NodeId) -> CmdResult<(Arc<Session>, PathBuf)> {
    let session = state.session(scan_id)?;
    let path = {
        let t = session.tree.read();
        check(&t, id)?;
        t.path_of(id)
    };
    Ok((session, path))
}

#[tauri::command]
pub async fn node_action(state: State<'_, AppState>, scan_id: u64, id: NodeId, action: String) -> CmdResult<()> {
    let (_, path) = node_path(&state, scan_id, id)?;
    let res = match action.as_str() {
        "reveal" => macos::reveal_in_finder(&path),
        "open" => macos::open(&path),
        "quicklook" => macos::quick_look(&path),
        "copy" => macos::copy_to_clipboard(&path.to_string_lossy()),
        other => return Err(format!("unknown action {other}")),
    };
    res.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trash_node(state: State<'_, AppState>, scan_id: u64, id: NodeId) -> CmdResult<()> {
    if id == ROOT {
        return Err("root".into());
    }
    let (session, path) = node_path(&state, scan_id, id)?;
    if session.active.lock().is_some() {
        return Err("busy".into());
    }
    macos::move_to_trash(&path)?;
    session.tree.write().remove(id);
    Ok(())
}

#[tauri::command]
pub async fn get_denied(state: State<'_, AppState>, scan_id: u64) -> CmdResult<Vec<String>> {
    let session = state.session(scan_id)?;
    let mut list: Vec<String> = session.denied.lock().clone();
    // Drop entries that were removed in the meantime.
    list.retain(|p| Path::new(p).exists());
    list.sort();
    list.dedup();
    Ok(list)
}

#[tauri::command]
pub async fn open_full_disk_access() -> CmdResult<()> {
    macos::open_full_disk_access_settings().map_err(|e| e.to_string())
}

/// Shows any path in Finder (clean-up entries are not tree nodes).
#[tauri::command]
pub async fn reveal_path(path: String) -> CmdResult<()> {
    macos::reveal_in_finder(Path::new(&path)).map_err(|e| e.to_string())
}

/// Folder passed on the command line (`storagelyzer ~/Downloads`), scanned on launch.
#[tauri::command]
pub fn initial_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with("-psn_") && !a.starts_with("--"))
        .map(|a| expand_home(&a))
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Command-line switches, e.g. `--cleanup` opens the clean-up assistant.
#[tauri::command]
pub fn launch_flags() -> Vec<String> {
    std::env::args().skip(1).filter(|a| a.starts_with("--")).collect()
}

/// Lets the WebView report errors and scan milestones to stderr (diagnostics).
#[tauri::command]
pub fn frontend_log(level: String, message: String) {
    eprintln!("[ui:{level}] {message}");
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~") {
        if let Some(home) = volumes::home_dir() {
            return home.join(rest.trim_start_matches('/'));
        }
    }
    PathBuf::from(path)
}

// ------------------------------------------------------------- clean-up ---

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CleanupEvent {
    Category(Category),
    Done,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub path: String,
    pub error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashReport {
    pub moved: u32,
    pub failed: Vec<Failure>,
}

fn home() -> CmdResult<PathBuf> {
    volumes::home_dir().ok_or_else(|| "no home folder".to_string())
}

/// Measures the well-known places that fill up a Mac; streams one event per category.
#[tauri::command]
pub async fn analyze_cleanup(
    app: AppHandle,
    state: State<'_, AppState>,
    scan_id: Option<u64>,
    on_event: Channel<CleanupEvent>,
) -> CmdResult<()> {
    let home = home()?;
    let tree = scan_id.and_then(|id| state.session(id).ok()).map(|s| s.tree.clone());
    state.cleanup_allowed.0.lock().clear();
    std::thread::Builder::new()
        .name("cleanup".into())
        .spawn(move || {
            let fda = macos::has_full_disk_access() == Some(true);
            let state = app.state::<AppState>();
            cleanup::analyze(&home, fda, tree, &mut |cat| {
                state.cleanup_allowed.0.lock().extend(cleanup::trashable_paths(&cat));
                let _ = on_event.send(CleanupEvent::Category(cat));
            });
            let _ = on_event.send(CleanupEvent::Done);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes trashed paths from the current scan so the chart stays truthful.
fn forget_paths(state: &AppState, paths: &[PathBuf]) {
    if let Some(session) = &*state.session.read() {
        let mut t = session.tree.write();
        for p in paths {
            if let Some(id) = t.find_path(p) {
                t.remove(id);
            }
        }
    }
}

#[tauri::command]
pub async fn cleanup_trash(state: State<'_, AppState>, paths: Vec<String>) -> CmdResult<TrashReport> {
    let (moved, failed) = cleanup::move_to_trash(&state.cleanup_allowed, &paths);
    forget_paths(&state, &moved);
    {
        let mut allowed = state.cleanup_allowed.0.lock();
        for p in &moved {
            allowed.remove(p);
        }
    }
    Ok(TrashReport {
        moved: moved.len() as u32,
        failed: failed.into_iter().map(|(path, error)| Failure { path, error }).collect(),
    })
}

/// Homebrew clean-up, unavailable simulators, Time Machine local snapshots.
#[tauri::command]
pub async fn cleanup_action(action: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || cleanup::run_action(&action))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn trash_info() -> CmdResult<TrashInfo> {
    let home = home()?;
    tauri::async_runtime::spawn_blocking(move || cleanup::trash_info(&home))
        .await
        .map_err(|e| e.to_string())
}

/// Permanently deletes the contents of the Trash (after the UI confirmed it).
#[tauri::command]
pub async fn empty_trash(state: State<'_, AppState>) -> CmdResult<u32> {
    let home = home()?;
    let trash = home.join(".Trash");
    let failed = tauri::async_runtime::spawn_blocking(move || cleanup::empty_trash(&home))
        .await
        .map_err(|e| e.to_string())??;
    if let Some(session) = &*state.session.read() {
        let mut t = session.tree.write();
        if let Some(id) = t.find_path(&trash) {
            let kids: Vec<NodeId> = t.children(id).collect();
            for k in kids {
                t.remove(k);
            }
        }
    }
    Ok(failed)
}

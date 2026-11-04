import type {
  ChildrenPage,
  CleanupEvent,
  TrashInfo,
  TrashReport,
  Crumb,
  Locations,
  NodeAction,
  NodeDetails,
  RingNode,
  ScanEvent,
  ScanStarted,
  SizeGap,
  SizeMode,
} from "./types";

/** Everything the UI needs from the backend. Implemented by Tauri IPC, or by
 *  an in-memory mock when the UI runs in a plain browser (`npm run dev`). */
export interface Backend {
  listLocations(): Promise<Locations>;
  startScan(path: string, onEvent: (e: ScanEvent) => void): Promise<ScanStarted>;
  rescan(scanId: number, id: number, onEvent: (e: ScanEvent) => void): Promise<void>;
  cancelScan(): Promise<void>;
  getChildren(scanId: number, id: number, mode: SizeMode, offset: number, limit: number): Promise<ChildrenPage>;
  getRings(scanId: number, id: number, depth: number, minFraction: number, mode: SizeMode): Promise<RingNode>;
  /** Why the logical size of `id` is bigger than what it occupies. */
  getSizeGap(scanId: number, id: number): Promise<SizeGap>;
  getAncestors(scanId: number, id: number): Promise<Crumb[]>;
  getNode(scanId: number, id: number): Promise<NodeDetails>;
  nodeAction(scanId: number, id: number, action: NodeAction): Promise<void>;
  trashNode(scanId: number, id: number): Promise<void>;
  getDenied(scanId: number): Promise<string[]>;
  openFullDiskAccess(): Promise<void>;
  pickFolder(title: string): Promise<string | null>;
  confirm(message: string, title: string, okLabel: string, cancelLabel: string): Promise<boolean>;
  alert(message: string, title: string): Promise<void>;
  onFolderDrop(cb: (path: string) => void): () => void;
  /** Folder given on the command line, if any. */
  initialPath(): Promise<string | null>;
  /** Command-line switches (`--cleanup`). */
  launchFlags(): Promise<string[]>;
  log(level: "info" | "error", message: string): void;
  // clean-up assistant
  analyzeCleanup(scanId: number | null, onEvent: (e: CleanupEvent) => void): Promise<void>;
  cleanupTrash(paths: string[]): Promise<TrashReport>;
  cleanupAction(action: string): Promise<string>;
  trashInfo(): Promise<TrashInfo>;
  emptyTrash(): Promise<number>;
  revealPath(path: string): Promise<void>;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const dialog = await import("@tauri-apps/plugin-dialog");
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");

  const channel = (onEvent: (e: ScanEvent) => void) => {
    const ch = new Channel<ScanEvent>();
    ch.onmessage = onEvent;
    return ch;
  };

  return {
    listLocations: () => invoke("list_locations"),
    startScan: (path, onEvent) => invoke("start_scan", { path, onEvent: channel(onEvent) }),
    rescan: (scanId, id, onEvent) => invoke("rescan", { scanId, id, onEvent: channel(onEvent) }),
    cancelScan: () => invoke("cancel_scan"),
    getChildren: (scanId, id, mode, offset, limit) => invoke("get_children", { scanId, id, mode, offset, limit }),
    getRings: (scanId, id, depth, minFraction, mode) => invoke("get_rings", { scanId, id, depth, minFraction, mode }),
    getSizeGap: (scanId, id) => invoke("get_size_gap", { scanId, id }),
    getAncestors: (scanId, id) => invoke("get_ancestors", { scanId, id }),
    getNode: (scanId, id) => invoke("get_node", { scanId, id }),
    nodeAction: (scanId, id, action) => invoke("node_action", { scanId, id, action }),
    trashNode: (scanId, id) => invoke("trash_node", { scanId, id }),
    getDenied: (scanId) => invoke("get_denied", { scanId }),
    openFullDiskAccess: () => invoke("open_full_disk_access"),
    pickFolder: async (title) => {
      const res = await dialog.open({ directory: true, multiple: false, title });
      return typeof res === "string" ? res : null;
    },
    confirm: (message, title, okLabel, cancelLabel) =>
      dialog.ask(message, { title, kind: "warning", okLabel, cancelLabel }),
    alert: async (message, title) => {
      await dialog.message(message, { title, kind: "error" });
    },
    onFolderDrop: (cb) => {
      let unlisten: (() => void) | null = null;
      let disposed = false;
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "drop" && event.payload.paths.length > 0) cb(event.payload.paths[0]);
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        });
      return () => {
        disposed = true;
        unlisten?.();
      };
    },
    initialPath: () => invoke<string | null>("initial_path"),
    launchFlags: () => invoke<string[]>("launch_flags"),
    analyzeCleanup: (scanId, onEvent) => {
      const ch = new Channel<CleanupEvent>();
      ch.onmessage = onEvent;
      return invoke("analyze_cleanup", { scanId, onEvent: ch });
    },
    cleanupTrash: (paths) => invoke("cleanup_trash", { paths }),
    cleanupAction: (action) => invoke("cleanup_action", { action }),
    trashInfo: () => invoke("trash_info"),
    emptyTrash: () => invoke("empty_trash"),
    revealPath: (path) => invoke("reveal_path", { path }),
    log: (level, message) => {
      void invoke("frontend_log", { level, message }).catch(() => {});
    },
  };
}

let backendPromise: Promise<Backend> | null = null;

export function backend(): Promise<Backend> {
  if (!backendPromise) {
    backendPromise = isTauri ? tauriBackend() : import("./mock").then((m) => m.mockBackend());
  }
  return backendPromise;
}

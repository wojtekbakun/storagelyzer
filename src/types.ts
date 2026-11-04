export type Kind = "dir" | "file" | "symlink" | "other";
export type SizeMode = "disk" | "apparent";

/** Mirrors `tree::flag` in Rust. */
export const Flag = {
  PENDING: 1 << 0,
  ERROR: 1 << 1,
  MOUNT: 1 << 2,
  DUPLICATE: 1 << 3,
  HARDLINK: 1 << 4,
  CLOUD: 1 << 5,
  REMOVED: 1 << 6,
  PACKAGE: 1 << 7,
  DENIED: 1 << 8,
  SPARSE: 1 << 9,
  COMPRESSED: 1 << 10,
} as const;

export interface NodeInfo {
  id: number;
  name: string;
  kind: Kind;
  size: number;
  apparent: number;
  items: number;
  mtime: number;
  flags: number;
  hasChildren: boolean;
  parent: number | null;
}

export interface NodeDetails extends NodeInfo {
  path: string;
}

export interface RingNode {
  id: number;
  name: string;
  kind: Kind;
  size: number;
  disk: number;
  apparent: number;
  items: number;
  flags: number;
  children?: RingNode[];
  otherSize: number;
  otherCount: number;
}

export interface Location {
  kind: "home" | "root" | "volume" | "network";
  name: string;
  path: string;
  total: number | null;
  available: number | null;
  fsType: string | null;
  readOnly: boolean;
}

export interface Locations {
  items: Location[];
  fullDiskAccess: boolean | null;
}

export interface Progress {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  denied: number;
  current: string;
  elapsedMs: number;
}

export type ScanEvent =
  | ({ type: "progress" } & Progress)
  | ({ type: "done"; cancelled: boolean; node: number } & Progress);

export type DoneEvent = Extract<ScanEvent, { type: "done" }>;

export interface VolumeSummary {
  name: string;
  total: number;
  available: number;
  used: number;
}

export interface ScanStarted {
  scanId: number;
  root: NodeInfo;
  rootPath: string;
  volume: VolumeSummary | null;
}

export interface ChildrenPage {
  total: number;
  items: NodeInfo[];
}

export interface Crumb {
  id: number;
  name: string;
}

export type NodeAction = "reveal" | "open" | "quicklook" | "copy";

export function sizeOf(n: { size: number; apparent?: number }, mode: SizeMode): number {
  return mode === "apparent" && n.apparent !== undefined ? n.apparent : n.size;
}

export interface CleanupEntry {
  /** Identifies the entry; shown in Finder. */
  path: string;
  name: string;
  size: number;
  kind: Kind;
  detail: string | null;
  /** Paths moved to the Trash together (an app's cache folders), when not just `path`. */
  paths?: string[];
  /** Shown for reference only (data of an installed app, app owned by root). */
  locked?: boolean;
  /** Data of an app that is no longer installed. */
  leftover?: boolean;
  /** When the app was last opened (Unix seconds). */
  used?: number;
}

export const pathsOf = (e: CleanupEntry): string[] => (e.paths && e.paths.length > 0 ? e.paths : [e.path]);

/** Why "Size" (logical) is bigger than "On disk". */
export interface SizeGap {
  disk: number;
  apparent: number;
  sparse: number;
  cloud: number;
  cloudFiles: number;
  compressed: number;
  other: number;
  top: {
    id: number;
    name: string;
    path: string;
    disk: number;
    apparent: number;
    reason: "sparse" | "cloud" | "compressed" | "other";
  }[];
}

export type CleanupGroup = "trash" | "safe" | "review" | "system";
export type CleanupActionKind = "trash" | "emptyTrash" | "brewCleanup" | "simulators" | "snapshots" | "info";

export interface CleanupCategory {
  id: string;
  group: CleanupGroup;
  action: CleanupActionKind;
  path: string | null;
  size: number;
  apparent: number;
  entries: CleanupEntry[];
  count: number;
  denied: boolean;
}

export type CleanupEvent = ({ type: "category" } & CleanupCategory) | { type: "done" };

export interface TrashReport {
  moved: number;
  failed: { path: string; error: string }[];
}

export interface TrashInfo {
  size: number;
  items: number;
  accessible: boolean;
}

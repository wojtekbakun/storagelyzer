/**
 * In-memory backend used when the UI runs in a plain browser (`npm run dev`
 * without Tauri). It generates a realistic-looking "Macintosh HD" and fakes a
 * progressive scan, so the interface can be developed and previewed quickly.
 */
import type { Backend } from "./api";
import type {
  ChildrenPage,
  CleanupCategory,
  CleanupEntry,
  Kind,
  NodeDetails,
  NodeInfo,
  RingNode,
  ScanEvent,
  SizeGap,
  SizeMode,
} from "./types";
import { Flag, pathsOf } from "./types";

const KB = 1e3;
const MB = 1e6;
const GB = 1e9;

/** `apparent`: logical size of a file when it differs (sparse disk images). */
type Spec = [name: string, content: number | Spec[], flags?: number, apparent?: number];

interface MNode {
  id: number;
  name: string;
  kind: Kind;
  own: number;
  /** Logical size of a file, when it is not ~ its size on disk. */
  logical?: number;
  flags: number;
  mtime: number;
  parent: MNode | null;
  children: MNode[];
  removed: boolean;
  // computed for the current reveal state
  size: number;
  apparent: number;
  items: number;
  visible: boolean;
  pending: boolean;
  newest: number;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(20261103);
const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
const hex = (n: number) =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");

const FILE_PATTERNS = [
  () => `IMG_${1000 + Math.floor(r() * 9000)}.HEIC`,
  () => `${hex(8)}.bin`,
  () => `report-${2019 + Math.floor(r() * 7)}.pdf`,
  () => `archive-${hex(4)}.zip`,
  () => `${hex(12)}.log`,
  () => `index.${hex(6)}.js`,
  () => `Video ${100 + Math.floor(r() * 900)}.mov`,
  () => `data_${Math.floor(r() * 999)}.sqlite`,
  () => `${hex(2)}/${hex(6)}`.replace("/", ""),
  () => `Screenshot ${2024 + Math.floor(r() * 3)}-0${1 + Math.floor(r() * 9)}.png`,
];

/** Random subtree whose sizes add up to roughly `total`, skewed like real data. */
function randomTree(label: string, total: number, depth: number, fanout: number): Spec[] {
  const n = Math.max(2, Math.round(fanout * (0.5 + r())));
  const weights = Array.from({ length: n }, () => Math.pow(r(), 3) + 0.004);
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i): Spec => {
    const bytes = (total * w) / sum;
    if (depth > 0 && bytes > 3 * MB && r() < 0.5) {
      return [`${label} ${i + 1}`, randomTree(label, bytes, depth - 1, fanout)];
    }
    return [pick(FILE_PATTERNS)(), Math.max(4 * KB, Math.round(bytes))];
  });
}

function project(name: string, size: number): Spec {
  return [
    name,
    [
      ["node_modules", randomTree("package", size * 0.7, 3, 12)],
      ["src", randomTree("module", size * 0.04, 2, 10)],
      [".git", randomTree("objects", size * 0.18, 2, 8)],
      ["dist", randomTree("chunk", size * 0.08, 1, 8)],
      ["package.json", 2 * KB],
      ["README.md", 6 * KB],
    ],
  ];
}

function macintoshHD(): Spec[] {
  const P = Flag.PACKAGE;
  return [
    [
      "Applications",
      [
        ["Xcode.app", randomTree("Contents", 11.8 * GB, 3, 7), P],
        ["DaVinci Resolve.app", randomTree("Contents", 4.6 * GB, 2, 6), P],
        ["Logic Pro.app", randomTree("Contents", 3.1 * GB, 2, 6), P],
        ["Docker.app", randomTree("Contents", 2.2 * GB, 2, 5), P],
        ["Google Chrome.app", randomTree("Contents", 1.4 * GB, 2, 5), P],
        ["Visual Studio Code.app", randomTree("Contents", 0.62 * GB, 2, 5), P],
        ["Slack.app", randomTree("Contents", 0.51 * GB, 1, 5), P],
        ["Figma.app", randomTree("Contents", 0.42 * GB, 1, 5), P],
        ["Spotify.app", randomTree("Contents", 0.36 * GB, 1, 5), P],
        ["Claude.app", randomTree("Contents", 0.48 * GB, 1, 5), P],
      ],
    ],
    [
      "Library",
      [
        ["Application Support", randomTree("Support", 6.8 * GB, 2, 9)],
        ["Developer", [["CommandLineTools", randomTree("usr", 3.6 * GB, 2, 6)]]],
        ["Caches", randomTree("com.apple", 1.9 * GB, 1, 12)],
        ["Audio", randomTree("Apple Loops", 2.7 * GB, 2, 6)],
        ["Fonts", randomTree("Font", 0.4 * GB, 0, 30)],
      ],
    ],
    [
      "System",
      [
        ["Library", randomTree("Frameworks", 9.2 * GB, 3, 10)],
        ["Applications", randomTree("Utility", 0.9 * GB, 2, 8)],
        ["iOSSupport", randomTree("System", 1.1 * GB, 2, 6)],
      ],
    ],
    [
      "Users",
      [
        [
          "alex",
          [
            [
              "Library",
              [
                [
                  "Developer",
                  [
                    [
                      "Xcode",
                      [
                        ["DerivedData", randomTree("Build", 23.5 * GB, 3, 8)],
                        ["iOS DeviceSupport", randomTree("iPhone", 8.4 * GB, 2, 5)],
                      ],
                    ],
                    ["CoreSimulator", [["Devices", randomTree("Device", 16.2 * GB, 2, 7)]]],
                  ],
                ],
                ["Application Support", randomTree("App", 14.1 * GB, 3, 12)],
                [
                  "Containers",
                  [
                    // A sparse disk image: 21 GB on disk, 1.1 TB "Size" — the classic confusion.
                    ["com.docker.docker", [["Data", [["vms", [["0", [["data", [["Docker.raw", 21.4 * GB, Flag.SPARSE, 1.1e12]]]]]]]]]]],
                    ...randomTree("com.apple", 9.3 * GB, 2, 16),
                  ],
                ],
                ["Caches", randomTree("com.app", 7.4 * GB, 2, 18)],
                ["Mobile Documents", randomTree("iCloud", 4.9 * GB, 2, 8), Flag.CLOUD],
                ["Messages", randomTree("Attachments", 3.3 * GB, 2, 10)],
                ["Mail", [], Flag.ERROR | Flag.DENIED],
              ],
            ],
            [
              "Documents",
              [
                [
                  "projects",
                  [
                    project("storagelyzer", 0.6 * GB),
                    project("shop-frontend", 1.9 * GB),
                    project("portfolio-site", 1.2 * GB),
                    project("ml-experiments", 7.8 * GB),
                    project("old-portfolio", 0.4 * GB),
                  ],
                ],
                ["Invoices", randomTree("Invoice", 0.3 * GB, 1, 20)],
                ["University", randomTree("Semester", 2.1 * GB, 2, 8)],
              ],
            ],
            [
              "Downloads",
              [
                ["macOS Installer.dmg", 14.2 * GB],
                ["ubuntu-26.04-desktop-arm64.iso", 6.1 * GB],
                ["Xcode_27.xip", 4.3 * GB],
                ["footage-backup.zip", 9.6 * GB],
                ...randomTree("download", 3.2 * GB, 1, 30),
              ],
            ],
            [
              "Movies",
              [
                ["Iceland 2026.mov", 38.4 * GB],
                ["Wedding (4K).mov", 31.2 * GB],
                ["Drone footage.mov", 22.7 * GB],
                ["Final Cut Projects", randomTree("Project", 18.5 * GB, 2, 6)],
              ],
            ],
            ["Pictures", [["Photos Library.photoslibrary", randomTree("originals", 61.5 * GB, 2, 14), P]]],
            ["Music", randomTree("Album", 6.4 * GB, 2, 12)],
            ["Desktop", randomTree("Screenshot", 1.3 * GB, 1, 24)],
            [".cargo", randomTree("registry", 3.4 * GB, 2, 8)],
            [".rustup", randomTree("toolchains", 2.9 * GB, 2, 6)],
            [".npm", randomTree("_cacache", 2.2 * GB, 2, 8)],
            [".docker", randomTree("desktop", 1.1 * GB, 1, 5)],
          ],
        ],
        ["Shared", randomTree("Shared", 0.7 * GB, 1, 6)],
      ],
    ],
    [
      "private",
      [
        [
          "var",
          [
            ["vm", [["sleepimage", 2.1 * GB], ["swapfile0", 1.07 * GB], ["swapfile1", 1.07 * GB]]],
            ["folders", randomTree("T", 3.1 * GB, 2, 10)],
            ["db", [], Flag.ERROR | Flag.DENIED],
            ["log", randomTree("asl", 0.8 * GB, 1, 12)],
          ],
        ],
        ["tmp", randomTree("tmp", 0.2 * GB, 1, 10)],
      ],
    ],
    ["opt", [["homebrew", randomTree("Cellar", 6.6 * GB, 3, 10)]]],
    ["usr", randomTree("lib", 1.9 * GB, 2, 8)],
    ["Volumes", [["Backup", [], Flag.MOUNT]]],
  ];
}

class MockTree {
  nodes: MNode[] = [];
  root: MNode;
  revealed = Number.POSITIVE_INFINITY;
  private computedFor = -1;
  private version = 0;
  private computedVersion = -1;

  constructor(name: string, specs: Spec[]) {
    this.root = this.add(name, "dir", 0, 0, null);
    this.build(this.root, specs);
  }

  private add(name: string, kind: Kind, own: number, flags: number, parent: MNode | null): MNode {
    const n: MNode = {
      id: this.nodes.length,
      name,
      kind,
      own,
      flags,
      mtime: 1_700_000_000 + Math.floor(r() * 62_000_000),
      parent,
      children: [],
      removed: false,
      size: 0,
      apparent: 0,
      items: 0,
      visible: true,
      pending: false,
      newest: 0,
    };
    this.nodes.push(n);
    parent?.children.push(n);
    return n;
  }

  /** Files inside a CLOUD folder are cloud-only placeholders (0 bytes on disk). */
  private build(parent: MNode, specs: Spec[], inherited = 0) {
    for (const [name, content, flags = 0, apparent] of specs) {
      if (typeof content === "number") {
        const f = this.add(name, "file", content, flags | inherited, parent);
        if (apparent !== undefined) f.logical = apparent;
      } else {
        const dir = this.add(name, "dir", 0, flags, parent);
        this.build(dir, content, inherited | (flags & Flag.CLOUD));
      }
    }
  }

  touch() {
    this.version++;
  }

  compute() {
    if (this.computedFor === this.revealed && this.computedVersion === this.version) return;
    this.computedFor = this.revealed;
    this.computedVersion = this.version;
    const walk = (n: MNode): void => {
      n.visible = n.id <= this.revealed && !n.removed;
      const cloud = n.kind === "file" && (n.flags & Flag.CLOUD) !== 0;
      n.size = n.kind === "dir" || cloud ? 0 : n.own;
      n.apparent = n.kind === "dir" ? 0 : (n.logical ?? (cloud ? n.own : Math.round(n.own * 0.97)));
      n.items = 0;
      n.newest = n.mtime;
      n.pending = false;
      for (const c of n.children) {
        walk(c);
        if (!c.visible) {
          if (!c.removed) n.pending = true;
          continue;
        }
        n.size += c.size;
        n.apparent += c.apparent;
        n.items += c.items + 1;
        n.newest = Math.max(n.newest, c.newest);
        if (c.pending) n.pending = true;
      }
    };
    walk(this.root);
  }

  visibleChildren(n: MNode): MNode[] {
    return n.children.filter((c) => c.visible);
  }

  info(n: MNode): NodeInfo {
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      size: n.size,
      apparent: n.apparent,
      items: n.items,
      mtime: n.newest,
      flags: n.flags | (n.pending ? Flag.PENDING : 0),
      hasChildren: n.kind === "dir" && n.children.some((c) => c.visible),
      parent: n.parent ? n.parent.id : null,
    };
  }

  path(n: MNode, rootPath: string): string {
    const parts: string[] = [];
    for (let c: MNode | null = n; c && c.parent; c = c.parent) parts.unshift(c.name);
    return [rootPath.replace(/\/$/, ""), ...parts].join("/") || "/";
  }
}

const sizeIn = (n: MNode, mode: SizeMode) => (mode === "apparent" ? n.apparent : n.size);
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export function mockBackend(): Backend {
  const full = new MockTree("Macintosh HD", macintoshHD());
  let tree = full;
  let scanId = 0;
  let rootPath = "/";
  let timer: ReturnType<typeof setInterval> | null = null;
  let currentListener: ((e: ScanEvent) => void) | null = null;

  const userHome = () => full.nodes.find((n) => n.name === "alex" && n.parent?.name === "Users")!;

  const stats = () => {
    let files = 0;
    let dirs = 0;
    for (const n of tree.nodes) {
      if (n.id > tree.revealed || n.removed) continue;
      if (n.kind === "dir") dirs++;
      else files++;
    }
    tree.compute();
    const deniedCount = tree.nodes.filter((n) => n.flags & Flag.DENIED && n.id <= tree.revealed).length;
    return { files, dirs, bytes: tree.root.size, errors: deniedCount, denied: deniedCount };
  };

  const simulate = (onEvent: (e: ScanEvent) => void, ms: number, done: () => void) => {
    if (timer) clearInterval(timer);
    currentListener = onEvent;
    const started = performance.now();
    const total = tree.nodes.length;
    tree.revealed = 0;
    timer = setInterval(() => {
      const elapsed = performance.now() - started;
      const f = Math.min(1, elapsed / ms);
      tree.revealed = f >= 1 ? Number.POSITIVE_INFINITY : Math.floor(total * f * f);
      const current = tree.path(tree.nodes[Math.min(total - 1, Math.floor(total * f * f))], rootPath);
      if (f >= 1) {
        clearInterval(timer!);
        timer = null;
        onEvent({ type: "done", ...stats(), current: "", elapsedMs: elapsed, cancelled: false, node: tree.root.id });
        done();
      } else {
        onEvent({ type: "progress", ...stats(), current, elapsedMs: elapsed });
      }
    }, 120);
  };

  const node = (id: number) => {
    const n = tree.nodes[id];
    if (!n) throw new Error("unknown-node");
    tree.compute();
    return n;
  };

  const rings = (n: MNode, depth: number, threshold: number, mode: SizeMode, max: number): RingNode => {
    const out: RingNode = {
      id: n.id,
      name: n.name,
      kind: n.kind,
      size: sizeIn(n, mode),
      disk: n.size,
      apparent: n.apparent,
      items: n.items,
      flags: n.flags | (n.pending ? Flag.PENDING : 0),
      otherSize: 0,
      otherCount: 0,
    };
    if (n.kind !== "dir" || depth >= max) return out;
    const kids = tree.visibleChildren(n);
    const big = kids.filter((c) => sizeIn(c, mode) >= threshold).sort((a, b) => sizeIn(b, mode) - sizeIn(a, mode));
    const shown = big.reduce((a, c) => a + sizeIn(c, mode), 0);
    out.otherSize = Math.max(0, out.size - shown);
    out.otherCount = kids.length - big.length;
    out.children = big.map((c) => rings(c, depth + 1, threshold, mode, max));
    return out;
  };

  return {
    async listLocations() {
      return {
        items: [
          { kind: "home", name: "alex", path: "/Users/alex", total: null, available: null, fsType: null, readOnly: false },
          { kind: "root", name: "Macintosh HD", path: "/", total: 494.38 * GB, available: 121.7 * GB, fsType: "apfs", readOnly: false },
          { kind: "volume", name: "Backup", path: "/Volumes/Backup", total: 2 * 1e12, available: 0.82 * 1e12, fsType: "apfs", readOnly: false },
          { kind: "network", name: "NAS", path: "/Volumes/NAS", total: 8 * 1e12, available: 3.1 * 1e12, fsType: "smbfs", readOnly: false },
        ],
        // README screenshots (?shot) skip the "no Full Disk Access" banner.
        fullDiskAccess: document.documentElement.classList.contains("shot"),
      };
    },

    async startScan(path, onEvent) {
      await delay(80);
      scanId++;
      const home = path.startsWith("/Users/alex");
      rootPath = home ? "/Users/alex" : "/";
      if (home) {
        const h = userHome();
        const sub = new MockTree("alex", []);
        // Re-root: share node objects by rebuilding a tree view on the home subtree.
        sub.nodes = [];
        const copy = (n: MNode, parent: MNode | null): MNode => {
          const c: MNode = { ...n, id: sub.nodes.length, parent, children: [] };
          sub.nodes.push(c);
          for (const k of n.children) c.children.push(copy(k, c));
          return c;
        };
        sub.root = copy(h, null);
        tree = sub;
      } else {
        tree = full;
      }
      tree.touch();
      simulate(onEvent, 3200, () => {});
      tree.compute();
      return {
        scanId,
        root: tree.info(tree.root),
        rootPath,
        volume: home ? null : { name: "Macintosh HD", total: 494.38 * GB, available: 121.7 * GB, used: 372.68 * GB },
      };
    },

    async rescan(_scanId, _id, onEvent) {
      const started = performance.now();
      setTimeout(() => {
        onEvent({ type: "done", ...stats(), current: "", elapsedMs: performance.now() - started, cancelled: false, node: _id });
      }, 700);
    },

    async cancelScan() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        // Like a cancelled real scan: whatever was revealed so far stays.
        currentListener?.({ type: "done", ...stats(), current: "", elapsedMs: 0, cancelled: true, node: tree.root.id });
      }
    },

    async getChildren(_scanId, id, mode, offset, limit): Promise<ChildrenPage> {
      const n = node(id);
      const kids = tree
        .visibleChildren(n)
        .sort((a, b) => sizeIn(b, mode) - sizeIn(a, mode) || a.name.localeCompare(b.name));
      return { total: kids.length, items: kids.slice(offset, offset + limit).map((k) => tree.info(k)) };
    },

    async getRings(_scanId, id, depth, minFraction, mode) {
      const n = node(id);
      const threshold = Math.max(1, Math.ceil(sizeIn(n, mode) * minFraction));
      return rings(n, 0, threshold, mode, depth);
    },

    async getSizeGap(_scanId, id) {
      const start = node(id);
      const gap: SizeGap = {
        disk: start.size,
        apparent: start.apparent,
        sparse: 0,
        cloud: 0,
        cloudFiles: 0,
        compressed: 0,
        other: 0,
        top: [],
      };
      const best: { g: number; n: MNode; reason: SizeGap["top"][number]["reason"] }[] = [];
      const walk = (n: MNode) => {
        for (const c of tree.visibleChildren(n)) {
          if (c.kind === "dir") {
            walk(c);
            continue;
          }
          if (c.apparent <= c.size) continue;
          const g = c.apparent - c.size;
          let reason: SizeGap["top"][number]["reason"] = "other";
          if (c.flags & Flag.CLOUD) {
            reason = "cloud";
            gap.cloud += g;
            gap.cloudFiles += 1;
          } else if (c.flags & Flag.SPARSE) {
            reason = "sparse";
            gap.sparse += g;
          } else if (c.flags & Flag.COMPRESSED) {
            reason = "compressed";
            gap.compressed += g;
          } else gap.other += g;
          if (g >= 100 * MB) best.push({ g, n: c, reason });
        }
      };
      walk(start);
      best.sort((a, b) => b.g - a.g);
      gap.top = best.slice(0, 6).map(({ n, reason }) => ({
        id: n.id,
        name: n.name,
        path: tree.path(n, rootPath),
        disk: n.size,
        apparent: n.apparent,
        reason,
      }));
      return gap;
    },

    async getAncestors(_scanId, id) {
      const out = [];
      for (let n: MNode | null = node(id); n; n = n.parent) out.unshift({ id: n.id, name: n.name });
      return out;
    },

    async getNode(_scanId, id): Promise<NodeDetails> {
      const n = node(id);
      return { ...tree.info(n), path: tree.path(n, rootPath) };
    },

    async nodeAction(_scanId, id, action) {
      console.info(`[mock] ${action}`, tree.path(node(id), rootPath));
    },

    async trashNode(_scanId, id) {
      const n = node(id);
      n.removed = true;
      tree.touch();
    },

    async getDenied() {
      return tree.nodes.filter((n) => n.flags & Flag.DENIED).map((n) => tree.path(n, rootPath));
    },

    async openFullDiskAccess() {
      console.info("[mock] open Full Disk Access settings");
    },

    async pickFolder() {
      return "/Users/alex";
    },

    async confirm(message) {
      return window.confirm(message);
    },

    async alert(message) {
      window.alert(message);
    },

    onFolderDrop() {
      return () => {};
    },

    async initialPath() {
      return null;
    },

    async launchFlags() {
      return [];
    },

    log(level, message) {
      (level === "error" ? console.error : console.info)(`[mock] ${message}`);
    },

    async analyzeCleanup(_scanId, onEvent) {
      for (const cat of cleanupCats) {
        if (cat.size <= 0 && cat.count <= 0 && !cat.denied) continue;
        await delay(140);
        onEvent({ type: "category", ...cat, entries: cat.entries.filter((e) => !trashed.has(e.path)) });
      }
      await delay(120);
      onEvent({ type: "done" });
    },

    async cleanupTrash(paths) {
      await delay(400);
      const moved = new Set(paths);
      let bytes = 0;
      for (const c of cleanupCats) {
        for (const e of c.entries) {
          if (!trashed.has(e.path) && !e.locked && pathsOf(e).every((p) => moved.has(p))) {
            trashed.add(e.path);
            bytes += e.size;
            c.size -= e.size;
          }
        }
      }
      trashBytes += bytes;
      cleanupCats[0].size = trashBytes;
      return { moved: paths.length, failed: [] };
    },

    async cleanupAction(action) {
      await delay(900);
      const cat = cleanupCats.find((c) => c.action === action);
      if (cat) {
        cat.size = 0;
        cat.count = 0;
      }
      return "OK";
    },

    async trashInfo() {
      return { size: trashBytes, items: trashBytes > 0 ? 12 : 0, accessible: true };
    },

    async emptyTrash() {
      await delay(500);
      trashBytes = 0;
      cleanupCats[0].size = 0;
      return 0;
    },

    async revealPath(path) {
      console.info("[mock] reveal", path);
    },
  };
}

const H = "/Users/alex";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const entry = (
  path: string,
  size: number,
  kind: Kind = "dir",
  detail: string | null = null,
  extra: Partial<CleanupEntry> = {},
): CleanupEntry => ({
  path,
  name: path.split("/").pop()!,
  size,
  kind,
  detail,
  ...extra,
});
/** An app's web caches (one entry, several folders). */
const web = (name: string, base: string, size: number): CleanupEntry => ({
  ...entry(`${base}/Cache`, size, "dir"),
  name,
  paths: [`${base}/Cache`, `${base}/Code Cache`, `${base}/GPUCache`],
});
const app = (name: string, size: number, usedDaysAgo: number | null, locked = false): CleanupEntry =>
  entry(`/Applications/${name}.app`, size, "dir", null, {
    name,
    locked,
    ...(usedDaysAgo === null ? {} : { used: NOW - usedDaysAgo * DAY }),
  });
const cat = (
  id: string,
  group: CleanupCategory["group"],
  action: CleanupCategory["action"],
  entries: CleanupEntry[],
  extra: Partial<CleanupCategory> = {},
): CleanupCategory => ({
  id,
  group,
  action,
  path: null,
  size: entries.reduce((a, e) => a + e.size, 0),
  apparent: entries.reduce((a, e) => a + e.size, 0),
  entries,
  count: 0,
  denied: false,
  ...extra,
});

let trashBytes = 2.4 * GB;
const trashed = new Set<string>();
const cleanupCats: CleanupCategory[] = [
  cat("trash", "trash", "emptyTrash", [], { size: trashBytes, count: 12, path: `${H}/.Trash` }),
  cat("caches", "safe", "trash", [
    entry(`${H}/Library/Caches/Google`, 1.58 * GB),
    { ...entry(`${H}/Library/Caches/com.spotify.client`, 1.21 * GB), name: "Spotify" },
    entry(`${H}/Library/Caches/arduino`, 921 * MB),
    entry(`${H}/Library/Caches/pip`, 843 * MB),
    entry(`${H}/Library/Caches/Homebrew`, 612 * MB),
    {
      ...entry(`${H}/Library/Containers/com.apple.Safari/Data/Library/Caches`, 486 * MB, "dir", `${H}/Library/Containers`),
      name: "Safari",
      paths: [`${H}/Library/Containers/com.apple.Safari/Data/Library/Caches/com.apple.Safari`],
    },
    { ...entry(`${H}/Library/Caches/com.apple.Safari`, 214 * MB), name: "Safari" },
    entry(`${H}/Library/Caches/JetBrains`, 166 * MB),
  ], { path: `${H}/Library/Caches` }),
  cat("webCaches", "safe", "trash", [
    web("Slack", `${H}/Library/Application Support/Slack`, 1.12 * GB),
    web("Google › Chrome", `${H}/Library/Application Support/Google/Chrome/Default`, 864 * MB),
    web("discord", `${H}/Library/Application Support/discord`, 512 * MB),
    web("Code", `${H}/Library/Application Support/Code`, 403 * MB),
    web("Figma", `${H}/Library/Application Support/Figma`, 221 * MB),
  ]),
  cat("logs", "safe", "trash", [entry(`${H}/Library/Logs/Claude`, 61 * MB), entry(`${H}/Library/Logs/DiagnosticReports`, 12 * MB)], {
    path: `${H}/Library/Logs`,
  }),
  cat("xcodeDerivedData", "safe", "trash", [
    entry(`${H}/Library/Developer/Xcode/DerivedData/MyApp-abcdef`, 6.2 * GB),
    entry(`${H}/Library/Developer/Xcode/DerivedData/Widget-123456`, 2.9 * GB),
  ], { path: `${H}/Library/Developer/Xcode/DerivedData` }),
  cat("devCaches", "safe", "trash", [
    { ...entry(`${H}/.npm/_cacache`, 3.14 * GB), name: "npm" },
    { ...entry(`${H}/.cargo/registry/src`, 590 * MB), name: "Cargo · registry/src" },
  ]),
  cat("homebrew", "safe", "brewCleanup", [], { size: 571 * MB }),
  cat("iosBackups", "review", "trash", [entry(`${H}/Library/Application Support/MobileSync/Backup/00008110-001A`, 48 * GB, "dir", "Alex’s iPhone · 2025-02-11")], {
    path: `${H}/Library/Application Support/MobileSync/Backup`,
  }),
  cat("simulators", "review", "simulators", [], { size: 14.2 * GB, count: 11, path: `${H}/Library/Developer/CoreSimulator/Devices` }),
  cat("installers", "review", "trash", [
    entry(`${H}/Downloads/macOS Installer.dmg`, 14.2 * GB, "file"),
    entry(`${H}/Downloads/Xcode_27.xip`, 4.3 * GB, "file"),
  ], { path: `${H}/Downloads` }),
  cat("toolCaches", "review", "trash", [entry(`${H}/.cache/uv`, 4.69 * GB), entry(`${H}/.cache/huggingface`, 1.74 * GB)], { path: `${H}/.cache` }),
  cat("projectJunk", "review", "trash", [
    { ...entry(`${H}/Documents/projects/ml-experiments/node_modules`, 5.5 * GB), name: "ml-experiments/node_modules" },
    { ...entry(`${H}/Documents/projects/storagelyzer/src-tauri/target`, 3.1 * GB), name: "src-tauri/target" },
  ]),
  cat("docker", "review", "info", [], { size: 21.4 * GB, apparent: 1.1e12, path: `${H}/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw` }),
  cat("apps", "review", "trash", [
    app("Xcode", 11.8 * GB, 2, true),
    app("DaVinci Resolve", 4.6 * GB, 41, true),
    app("Logic Pro", 3.1 * GB, 412, true),
    app("Docker", 2.2 * GB, 9),
    app("GarageBand", 1.9 * GB, null, true),
    app("Blender", 1.4 * GB, 13),
    app("Google Chrome", 1.4 * GB, 0),
    app("Unity Hub", 0.83 * GB, 230),
    app("Visual Studio Code", 0.62 * GB, 1),
    app("Slack", 0.51 * GB, 0),
  ], { path: "/Applications" }),
  cat("appData", "review", "trash", [
    entry("/Library/Application Support/Logic", 38.6 * GB, "dir", "/Library/Application Support", { locked: true }),
    entry("/Library/Audio/Apple Loops", 6.2 * GB, "dir", "/Library/Audio", { locked: true }),
    entry(`${H}/Library/Application Support/Steam`, 5.8 * GB, "dir", `${H}/Library/Application Support`, { locked: true }),
    entry("/Library/Application Support/GarageBand", 2.4 * GB, "dir", "/Library/Application Support", { locked: true }),
    { ...entry(`${H}/Library/Containers/com.microsoft.teams`, 1.9 * GB, "dir", `${H}/Library/Containers`), leftover: true },
    { ...entry(`${H}/Library/Application Support/Blender`, 0.31 * GB, "dir", `${H}/Library/Application Support`), locked: true },
    { ...entry(`${H}/Library/Containers/com.loupedeck.Loupedeck2`, 0.24 * GB, "dir", `${H}/Library/Containers`), leftover: true },
  ]),
  cat("snapshots", "system", "snapshots", [], { count: 3 }),
];

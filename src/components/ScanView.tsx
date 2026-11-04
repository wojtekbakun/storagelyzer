import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../api";
import { formatBytes, formatCount, formatDuration, formatNumber, formatPercent, prettyPath } from "../format";
import { plural, t } from "../i18n";
import type { Segment } from "../ring/layout";
import {
  Flag,
  sizeOf,
  type Crumb,
  type DoneEvent,
  type NodeAction,
  type NodeDetails,
  type NodeInfo,
  type Progress,
  type RingNode,
  type ScanEvent,
  type ScanStarted,
  type SizeGap,
  type SizeMode,
  type TrashInfo,
} from "../types";
import { CleanupView } from "./CleanupView";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { GapPopover } from "./GapPopover";
import {
  ArrowUpIcon,
  ChevronLeft,
  ChevronRight,
  CopyIcon,
  DiskIcon,
  EyeIcon,
  FinderIcon,
  FolderIcon,
  HomeIcon,
  InfoIcon,
  LockIcon,
  OpenIcon,
  RefreshIcon,
  SparklesIcon,
  StopIcon,
  TargetIcon,
  TrashIcon,
} from "./Icons";
import { RingChart, type RingChartHandle } from "./RingChart";
import { NodeIcon, TreeList } from "./TreeList";
import { TweenBytes } from "./TweenBytes";

const RINGS = 6;
const MIN_FRACTION = 0.002;
const LIVE_REFRESH_MS = 650;

interface Target {
  id: number;
  name: string;
  kind: string;
  flags: number;
  isFocus: boolean;
}

type Running = null | { kind: "full" } | { kind: "rescan"; id: number; name: string };

interface Props {
  api: Backend;
  path: string;
  home: string | null;
  onBack(): void;
}

interface ViewData {
  rings: RingNode;
  node: NodeDetails;
  crumbs: Crumb[];
  root: NodeDetails;
}

const WIDTH_KEY = "storagelyzer.listWidth";

function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v >= 320) return v;
  } catch {
    /* storage unavailable */
  }
  return 520;
}

export function ScanView({ api, path, home, onBack }: Props) {
  const [session, setSession] = useState<ScanStarted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const [running, setRunning] = useState<Running>({ kind: "full" });
  const [focusId, setFocusId] = useState(0);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [focus, setFocus] = useState<NodeDetails | null>(null);
  const [root, setRoot] = useState<NodeDetails | null>(null);
  const [rings, setRings] = useState<RingNode | null>(null);
  const [enterFrom, setEnterFrom] = useState<number | null>(null);
  const [mode, setMode] = useState<SizeMode>("disk");
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [listKey, setListKey] = useState(0);
  const [menu, setMenu] = useState<{ target: Target; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [denied, setDenied] = useState<string[] | null>(null);
  const [listWidth, setListWidth] = useState(loadWidth);
  const [nonce, setNonce] = useState(0);
  const [selectedInfo, setSelectedInfo] = useState<NodeDetails | null>(null);
  const [trashInfo, setTrashInfo] = useState<TrashInfo | null>(null);
  const [showCleanup, setShowCleanup] = useState(false);
  const [gap, setGap] = useState<SizeGap | null>(null);

  const chartRef = useRef<RingChartHandle>(null);
  const navigating = useRef(false);
  const scanIdRef = useRef<number | null>(null);
  const focusRef = useRef(0);
  focusRef.current = focusId;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const runningRef = useRef<Running>(running);
  runningRef.current = running;
  const lastLive = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, ms = 2400) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  const refreshTrash = useCallback(() => {
    void api.trashInfo().then(setTrashInfo).catch(() => {});
  }, [api]);

  useEffect(refreshTrash, [refreshTrash]);

  const fetchView = useCallback(
    async (scanId: number, id: number, m: SizeMode): Promise<ViewData> => {
      const [r, node, anc, rootNode] = await Promise.all([
        api.getRings(scanId, id, RINGS, MIN_FRACTION, m),
        api.getNode(scanId, id),
        api.getAncestors(scanId, id),
        api.getNode(scanId, 0),
      ]);
      return { rings: r, node, crumbs: anc, root: rootNode };
    },
    [api],
  );

  const apply = (id: number, v: ViewData, enter: number | null) => {
    setFocusId(id);
    setFocus(v.node);
    setCrumbs(v.crumbs);
    setRoot(v.root);
    setEnterFrom(enter);
    setRings(v.rings);
  };

  /** Re-reads the current focus (live scan updates, size mode, trash). */
  const refresh = useCallback(async (): Promise<ViewData | null> => {
    const scanId = scanIdRef.current;
    if (scanId === null || navigating.current) return null;
    const id = focusRef.current;
    try {
      const v = await fetchView(scanId, id, modeRef.current);
      if (navigating.current || id !== focusRef.current || scanId !== scanIdRef.current) return null;
      apply(id, v, null);
      return v;
    } catch {
      return null; /* stale */
    }
  }, [fetchView]);

  /** Diagnostics: what the chart shows once a scan has finished. */
  const logChart = useCallback(
    (r: RingNode) => {
      const count = (n: RingNode): number => 1 + (n.children ?? []).reduce((a, c) => a + count(c), 0);
      const top = (r.children ?? [])
        .slice(0, 3)
        .map((c) => `${c.name}=${formatBytes(c.size)}`)
        .join(", ");
      api.log("info", `chart: ${r.name} ${formatBytes(r.size)}, ${count(r)} segments; top: ${top}`);
    },
    [api],
  );

  const liveTick = useCallback(() => {
    const now = performance.now();
    if (now - lastLive.current > LIVE_REFRESH_MS) {
      lastLive.current = now;
      void refresh();
      setListKey((k) => k + 1);
    }
  }, [refresh]);

  // Start (or restart) the full scan.
  useEffect(() => {
    let alive = true;
    scanIdRef.current = null;
    navigating.current = false;
    setError(null);
    setDone(null);
    setProgress(null);
    setRunning({ kind: "full" });
    setRings(null);
    setFocusId(0);
    setFocus(null);
    setSelectedId(null);
    setHoverId(null);
    setDenied(null);

    let finished = false;
    const onEvent = (e: ScanEvent) => {
      if (!alive) return;
      setProgress(e);
      if (e.type === "progress") {
        liveTick();
      } else {
        finished = true;
        setDone(e);
        setRunning(null);
        api.log(
          "info",
          `scan ${e.cancelled ? "cancelled" : "done"}: ${e.files} files, ${e.dirs} dirs, ${e.bytes} bytes, ` +
            `${e.denied} denied, ${Math.round(e.elapsedMs)} ms`,
        );
        void refresh().then((v) => v && logChart(v.rings));
        setListKey((k) => k + 1);
      }
    };

    api
      .startScan(path, onEvent)
      .then((s) => {
        if (!alive) return;
        api.log("info", `scan started: ${s.rootPath} (scan ${s.scanId})`);
        scanIdRef.current = s.scanId;
        setSession(s);
        setRoot({ ...s.root, path: s.rootPath });
        setFocus({ ...s.root, path: s.rootPath });
        setCrumbs([{ id: s.root.id, name: s.root.name }]);
        // A small folder can finish before this promise resolves.
        void refresh().then((v) => finished && v && logChart(v.rings));
      })
      .catch((e) => {
        if (alive) {
          setError(String(e));
          setRunning(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [api, path, nonce, refresh, liveTick, logChart]);

  useEffect(() => {
    void refresh();
  }, [mode, refresh]);

  const zoomInto = useCallback(
    async (id: number) => {
      const scanId = scanIdRef.current;
      if (scanId === null || navigating.current || id === focusRef.current) return;
      navigating.current = true;
      setHoverId(null);
      try {
        const [v] = await Promise.all([
          fetchView(scanId, id, modeRef.current),
          chartRef.current?.zoomInto(id) ?? Promise.resolve(),
        ]);
        if (scanId === scanIdRef.current) {
          apply(id, v, null);
          setSelectedId(null);
        }
      } catch {
        /* stale */
      } finally {
        navigating.current = false;
      }
    },
    [fetchView],
  );

  const goTo = useCallback(
    async (id: number) => {
      const scanId = scanIdRef.current;
      if (scanId === null || navigating.current || id === focusRef.current) return;
      navigating.current = true;
      const from = focusRef.current;
      setHoverId(null);
      try {
        const v = await fetchView(scanId, id, modeRef.current);
        if (scanId === scanIdRef.current) {
          apply(id, v, from);
          setSelectedId(from);
        }
      } catch {
        /* stale */
      } finally {
        navigating.current = false;
      }
    },
    [fetchView],
  );

  const goUp = useCallback(() => {
    if (crumbs.length > 1) void goTo(crumbs[crumbs.length - 2].id);
  }, [crumbs, goTo]);
  const goUpRef = useRef(goUp);
  goUpRef.current = goUp;

  const act = useCallback(
    (id: number, action: NodeAction) => {
      const scanId = scanIdRef.current;
      if (scanId === null) return Promise.resolve();
      return api.nodeAction(scanId, id, action).catch((e) => showToast(String(e)));
    },
    [api, showToast],
  );

  const rescanNode = useCallback(
    async (target: { id: number; name: string }) => {
      const scanId = scanIdRef.current;
      if (scanId === null || runningRef.current) return;
      if (target.id === 0) {
        setNonce((n) => n + 1);
        return;
      }
      setRunning({ kind: "rescan", id: target.id, name: target.name });
      setProgress(null);
      try {
        await api.rescan(scanId, target.id, (e) => {
          if (scanId !== scanIdRef.current) return;
          setProgress(e);
          if (e.type === "progress") liveTick();
          else {
            setRunning(null);
            void refresh();
            setListKey((k) => k + 1);
          }
        });
      } catch (e) {
        setRunning(null);
        showToast(String(e));
      }
    },
    [api, liveTick, refresh, showToast],
  );

  const trash = useCallback(
    async (id: number) => {
      const scanId = scanIdRef.current;
      if (scanId === null || id === 0) return;
      if (runningRef.current) {
        showToast(t("busy"));
        return;
      }
      try {
        const d = await api.getNode(scanId, id);
        const ok = await api.confirm(
          t("trashConfirm", { name: d.name, size: formatBytes(sizeOf(d, modeRef.current)), path: prettyPath(d.path, home) }),
          t("trashConfirmTitle"),
          t("trashOk"),
          t("cancel"),
        );
        if (!ok) return;
        await api.trashNode(scanId, id);
        showToast(t("movedToTrashHint", { name: d.name }), 4500);
        setSelectedId((sel) => (sel === id ? null : sel));
        refreshTrash();
        if (id === focusRef.current && d.parent !== null) await goTo(d.parent);
        else await refresh();
        setListKey((k) => k + 1);
      } catch (e) {
        await api.alert(String(e), t("trashFailed"));
      }
    },
    [api, goTo, home, refresh, refreshTrash, showToast],
  );

  const emptyTrash = useCallback(async () => {
    const info = await api.trashInfo().catch(() => null);
    const ok = await api.confirm(
      t("emptyTrashConfirm", { size: info?.accessible ? formatBytes(info.size) : "—" }),
      t("emptyTrashTitle"),
      t("emptyTrashOk"),
      t("cancel"),
    );
    if (!ok) return;
    try {
      const failed = await api.emptyTrash();
      showToast(failed > 0 ? t("trashEmptyPartial", { count: failed }) : t("trashEmptied"));
      refreshTrash();
      void refresh();
      setListKey((k) => k + 1);
    } catch (e) {
      await api.alert(String(e), t("trashFailed"));
    }
  }, [api, refresh, refreshTrash, showToast]);

  // Details of the selected row/segment (for the list toolbar actions).
  useEffect(() => {
    const scanId = scanIdRef.current;
    if (selectedId === null || scanId === null) {
      setSelectedInfo(null);
      return;
    }
    let alive = true;
    api
      .getNode(scanId, selectedId)
      .then((d) => {
        if (!alive) return;
        if (d.flags & Flag.REMOVED) {
          setSelectedInfo(null);
          setSelectedId(null);
        } else setSelectedInfo(d);
      })
      .catch(() => alive && setSelectedInfo(null));
    return () => {
      alive = false;
    };
  }, [api, selectedId, listKey]);

  // The "back" button of a mouse goes one level up.
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 && !showCleanup) {
        e.preventDefault();
        goUpRef.current();
      }
    };
    window.addEventListener("mouseup", onMouse);
    return () => window.removeEventListener("mouseup", onMouse);
  }, [showCleanup]);

  const cancel = () => void api.cancelScan();

  const openMenu = (target: Target, x: number, y: number) => setMenu({ target, x, y });

  const menuItems = (tg: Target): MenuEntry[] => {
    const isDir = tg.kind === "dir";
    const items: MenuEntry[] = [
      { label: t("menuOpen"), icon: <OpenIcon />, onSelect: () => void act(tg.id, "open") },
      { label: t("menuReveal"), icon: <FinderIcon />, onSelect: () => void act(tg.id, "reveal") },
      { label: t("menuQuickLook"), icon: <EyeIcon />, onSelect: () => void act(tg.id, "quicklook") },
      {
        label: t("menuCopyPath"),
        icon: <CopyIcon />,
        onSelect: () => void act(tg.id, "copy").then(() => showToast(t("copied"))),
      },
    ];
    if (isDir) {
      items.push({ separator: true });
      if (!tg.isFocus) items.push({ label: t("menuFocus"), icon: <TargetIcon />, onSelect: () => void zoomInto(tg.id) });
      items.push({
        label: t("menuRescan"),
        icon: <RefreshIcon />,
        disabled: running !== null,
        onSelect: () => void rescanNode(tg),
      });
    }
    if (tg.id !== 0) {
      items.push({ separator: true });
      items.push({
        label: t("menuTrash"),
        icon: <TrashIcon />,
        danger: true,
        disabled: running !== null,
        onSelect: () => void trash(tg.id),
      });
    }
    return items;
  };

  // Global shortcuts: ⌘↑ / ⌘[ / ⌫ = up, ⌘R = rescan focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showCleanup) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") {
        setDenied(null);
        return;
      }
      if ((e.metaKey && (e.key === "ArrowUp" || e.key === "[")) || (e.key === "Backspace" && !e.metaKey)) {
        e.preventDefault();
        goUp();
      } else if (e.metaKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (focus) void rescanNode({ id: focus.id, name: focus.name });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goUp, focus, rescanNode, showCleanup]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = listWidth;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(320, Math.min(window.innerWidth - 340, startW + ev.clientX - startX));
      setListWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("is-resizing");
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(latest)));
      } catch {
        /* storage unavailable */
      }
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const showDenied = async () => {
    const scanId = scanIdRef.current;
    if (scanId === null) return;
    setDenied(await api.getDenied(scanId).catch(() => []));
  };

  /** "Why is Size bigger than On disk?" for a folder (the root or the chart's focus). */
  const showGap = async (id: number) => {
    const scanId = scanIdRef.current;
    if (scanId === null) return;
    const g = await api.getSizeGap(scanId, id).catch(() => null);
    if (g) setGap(g);
  };

  const focusSize = rings?.size ?? 0;


  /** "logical 1.2 TB" / "on disk 3 GB" when the two sizes differ a lot. */
  const otherSize = (s: { disk: number; apparent: number }) => {
    const big = Math.max(s.disk, s.apparent);
    if (big < 1e6 || Math.abs(s.disk - s.apparent) < big * 0.15) return null;
    return (
      <div className="tip-line">
        {mode === "disk"
          ? `${t("logical")}: ${formatBytes(s.apparent)}`
          : `${t("onDisk")}: ${formatBytes(s.disk)}`}
      </div>
    );
  };

  const renderTooltip = (s: Segment) => {
    const total = focusSize || 1;
    if (s.depth === 0) {
      return (
        <>
          <div className="tip-title">{s.name}</div>
          <div className="tip-size">{formatBytes(s.size)}</div>
          {otherSize(s)}
          <div className="tip-line">{formatCount("item", s.items)}</div>
          {crumbs.length > 1 ? <div className="tip-hint">{t("clickToGoUp")}</div> : null}
        </>
      );
    }
    if (s.kind === "other") {
      return (
        <>
          <div className="tip-title tip-muted">{t("smallerItems")}</div>
          <div className="tip-size">
            {formatBytes(s.size)} <span className="tip-pct">{formatPercent(s.size / total)}</span>
          </div>
          <div className="tip-line">{t("smallerCount", { count: formatNumber(s.otherCount) })}</div>
        </>
      );
    }
    const flags: string[] = [];
    if (s.flags & Flag.PACKAGE) flags.push(t("flagPackage"));
    if (s.flags & Flag.SPARSE) flags.push(t("flagSparse"));
    if (s.flags & Flag.COMPRESSED) flags.push(t("flagCompressed"));
    if (s.flags & Flag.CLOUD) flags.push(t("flagCloud"));
    if (s.flags & Flag.DENIED) flags.push(t("flagDenied"));
    if (s.flags & Flag.PENDING && running) flags.push(t("flagPending"));
    return (
      <>
        <div className="tip-title">
          <NodeIcon node={{ kind: s.kind, flags: s.flags }} />
          <span>{s.name}</span>
        </div>
        <div className="tip-size">
          {formatBytes(s.size)} <span className="tip-pct">{formatPercent(s.size / total)}</span>
        </div>
        {otherSize(s)}
        {s.parent && s.parent.depth > 0 && s.parent.size > 0 ? (
          <div className="tip-line">{t("ofParent", { pct: formatPercent(s.size / s.parent.size) })}</div>
        ) : null}
        <div className="tip-line">
          {s.kind === "dir" ? formatCount("item", s.items) : s.kind === "symlink" ? t("symlinkKind") : t("fileKind")}
        </div>
        {flags.length ? <div className="tip-line tip-flags">{flags.join(" · ")}</div> : null}
        <div className="tip-hint">{s.kind === "dir" ? t("clickToOpen") : t("rightClickHint")}</div>
      </>
    );
  };

  const volume = session?.volume ?? null;
  const hidden = volume && root && done && !done.cancelled ? volume.used - root.size : 0;
  const showHidden = volume !== null && hidden > volume.used * 0.01;

  const visibleCrumbs: (Crumb | null)[] =
    crumbs.length > 6 ? [crumbs[0], null, ...crumbs.slice(crumbs.length - 4)] : crumbs;

  if (error) {
    return (
      <div className="app">
        <header className="toolbar" data-tauri-drag-region>
          <div className="traffic-space" data-tauri-drag-region />
          <button className="tb-button" onClick={onBack} title={t("back")}>
            <ChevronLeft />
          </button>
        </header>
        <div className="error-state">
          <h2>{t("scanError")}</h2>
          <p>{error}</p>
          <button className="button" onClick={onBack}>
            {t("back")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="toolbar" data-tauri-drag-region>
        <div className="traffic-space" data-tauri-drag-region />
        <button className="tb-button" onClick={onBack} title={t("back")}>
          <ChevronLeft />
        </button>
        <nav className="crumbs" data-tauri-drag-region>
          {visibleCrumbs.map((c, i) =>
            c === null ? (
              <span key="gap" className="crumb-gap">
                …<ChevronRight size={11} className="crumb-sep" />
              </span>
            ) : (
              <span key={c.id} className="crumb-wrap">
                <button
                  className={`crumb ${c.id === focusId ? "is-current" : ""}`}
                  onClick={() => void goTo(c.id)}
                  title={c.name}
                >
                  {i === 0 ? (
                    <span className="crumb-icon">
                      {volume ? (
                        <DiskIcon size={14} />
                      ) : root?.path === home ? (
                        <HomeIcon size={14} />
                      ) : (
                        <FolderIcon size={15} />
                      )}
                    </span>
                  ) : null}
                  <span className="crumb-label">{c.name}</span>
                </button>
                {i < visibleCrumbs.length - 1 ? <ChevronRight size={11} className="crumb-sep" /> : null}
              </span>
            ),
          )}
        </nav>
        <div className="tb-spacer" data-tauri-drag-region />
        <button className="tb-button tb-button-label" onClick={() => setShowCleanup(true)} title={t("toolCleanupText")}>
          <SparklesIcon />
          <span>{t("cleanupButton")}</span>
        </button>
        <div className="segmented" role="radiogroup" title={t("sizeModeHint")}>
          <button className={mode === "disk" ? "is-on" : ""} onClick={() => setMode("disk")} role="radio" aria-checked={mode === "disk"}>
            {t("sizeOnDisk")}
          </button>
          <button
            className={mode === "apparent" ? "is-on" : ""}
            onClick={() => setMode("apparent")}
            role="radio"
            aria-checked={mode === "apparent"}
          >
            {t("sizeLogical")}
          </button>
        </div>
        <button
          className="tb-button"
          onClick={() => focus && void rescanNode({ id: focus.id, name: focus.name })}
          disabled={running !== null || !focus}
          title={`${t("rescan")} (⌘R)`}
        >
          <RefreshIcon />
        </button>
      </header>

      <main className="scan-main">
        <section className="pane-list" style={{ width: listWidth }}>
          <div className="list-bar">
            <button className="tb-button" onClick={goUp} disabled={crumbs.length <= 1} title={t("listUp")}>
              <ArrowUpIcon />
            </button>
            <span className="list-bar-name" title={focus?.path}>
              <span className="row-icon">
                <NodeIcon node={{ kind: "dir", flags: focus?.flags ?? 0 }} />
              </span>
              <span className="row-name">{focus?.name ?? ""}</span>
            </span>
            <span className="flex-spacer" />
            {selectedInfo && selectedInfo.id !== 0 ? (
              <>
                <button
                  className="tb-button"
                  title={`${t("revealSelected")}: ${selectedInfo.name}`}
                  onClick={() => void act(selectedInfo.id, "reveal")}
                >
                  <FinderIcon />
                </button>
                <button
                  className="list-bar-trash"
                  disabled={running !== null}
                  title={`${t("trashSelectedHint")}: ${selectedInfo.name}`}
                  onClick={() => void trash(selectedInfo.id)}
                >
                  <TrashIcon size={14} />
                  {t("trashSelected")}
                </button>
              </>
            ) : null}
          </div>
          {session ? (
            <TreeList
              api={api}
              scanId={session.scanId}
              rootId={focusId}
              rootSize={focusSize}
              mode={mode}
              refreshKey={listKey}
              scanning={running !== null}
              hoveredId={hoverId}
              selectedId={selectedId}
              onHover={setHoverId}
              onSelect={setSelectedId}
              onOpen={(n: NodeInfo) => {
                if (n.kind === "dir") void zoomInto(n.id);
                else void act(n.id, "quicklook");
              }}
              onContext={(n, x, y) => openMenu({ id: n.id, name: n.name, kind: n.kind, flags: n.flags, isFocus: false }, x, y)}
              onQuickLook={(n) => void act(n.id, "quicklook")}
              onTrash={(n) => void trash(n.id)}
            />
          ) : (
            <div className="pane-empty">
              <span className="spinner" />
            </div>
          )}
        </section>
        <div className="splitter" onMouseDown={startDrag} />
        <section className="pane-chart">
          <RingChart
            ref={chartRef}
            data={rings}
            enterFrom={enterFrom}
            rings={RINGS}
            highlightId={hoverId}
            scanning={running !== null}
            canGoUp={crumbs.length > 1}
            onHover={(s) => setHoverId(s && s.kind !== "other" && s.depth > 0 ? s.id : null)}
            onActivate={(s) => {
              if (s.kind === "dir") void zoomInto(s.id);
              else if (s.kind !== "other") setSelectedId(s.id);
            }}
            onCenterClick={goUp}
            onContext={(s, x, y) =>
              openMenu({ id: s.id, name: s.name, kind: s.kind, flags: s.flags, isFocus: s.depth === 0 }, x, y)
            }
            renderTooltip={renderTooltip}
            center={
              <div className="center-label">
                <div className="center-name" title={focus?.path}>
                  {focus?.name ?? ""}
                </div>
                <div className="center-size">
                  <TweenBytes value={focusSize} resetKey={`${focusId}:${mode}`} />
                </div>
                <div className="center-sub">
                  {running && focus && focus.flags & Flag.PENDING ? t("scanningShort") + "…" : formatCount("item", rings?.items ?? 0)}
                </div>
              </div>
            }
          />
          {!rings ? (
            <div className="chart-loading">
              <span className="spinner" />
            </div>
          ) : null}
          {crumbs.length > 1 ? (
            <button className="chart-up" onClick={goUp} title={t("listUp")}>
              <ArrowUpIcon size={14} />
              <span>{t("upTo", { name: crumbs[crumbs.length - 2].name })}</span>
            </button>
          ) : null}
          {mode === "apparent" && rings && rings.apparent - rings.disk > Math.max(1e8, rings.disk * 0.02) ? (
            <div className="chart-note">
              <InfoIcon size={13} />
              <span>
                {t("gapNote", { gap: formatBytes(rings.apparent - rings.disk) })}{" "}
                <button className="link-button" onClick={() => void showGap(focusId)}>
                  {t("gapWhy")}
                </button>
              </span>
            </div>
          ) : null}
        </section>
      </main>

      <footer className="statusbar">
        {running ? (
          <>
            <span className="spinner spinner-sm" />
            <span className="status-main">
              {running.kind === "full" ? t("scanning") : `${t("scanningShort")} „${running.name}”…`}
            </span>
            {progress ? (
              <>
                <span className="status-stat">
                  {formatNumber(progress.files + progress.dirs)} {plural("item", progress.files + progress.dirs)}
                </span>
                <span className="status-stat">{formatBytes(progress.bytes)}</span>
                <span className="status-stat">{formatDuration(progress.elapsedMs)}</span>
                <span className="status-path" title={progress.current}>
                  {prettyPath(progress.current, home)}
                </span>
              </>
            ) : (
              <span className="flex-spacer" />
            )}
            <button className="status-button" onClick={cancel}>
              <StopIcon size={12} /> {t("stop")}
            </button>
          </>
        ) : (
          <>
            <span className={`status-size ${mode === "disk" ? "is-active" : ""}`}>
              {t("statusDisk", { size: formatBytes(root?.size ?? 0) })}
            </span>
            {root && root.apparent - root.size > Math.max(1e9, root.size * 0.05) ? (
              <button
                className={`status-size status-size-button ${mode === "apparent" ? "is-active" : ""}`}
                title={t("logicalHint")}
                onClick={() => void showGap(0)}
              >
                {t("statusLogical", { size: formatBytes(root.apparent) })}
                <InfoIcon size={12} />
              </button>
            ) : (
              <span className={`status-size ${mode === "apparent" ? "is-active" : ""}`}>
                {t("statusLogical", { size: formatBytes(root?.apparent ?? 0) })}
              </span>
            )}
            <span className="status-stat">{formatCount("item", root?.items ?? 0)}</span>
            {done ? (
              <span className="status-stat">
                {done.cancelled ? t("scanStopped") : t("scanned", { time: formatDuration(done.elapsedMs) })}
              </span>
            ) : null}
            {done && done.denied > 0 ? (
              <button className="status-warn" onClick={() => void showDenied()}>
                <LockIcon size={12} /> {t("noAccess", { count: formatNumber(done.denied) })}
              </button>
            ) : null}
            {showHidden && volume ? (
              <span
                className="status-stat status-info"
                title={t("hiddenHelp", { used: formatBytes(volume.used) })}
              >
                <InfoIcon size={12} /> {t("hidden", { size: formatBytes(hidden) })}
              </span>
            ) : null}
            <span className="flex-spacer" />
            {trashInfo?.accessible && trashInfo.size > 0 ? (
              <button className="status-trash" onClick={() => void emptyTrash()} title={t("trashChipHint")}>
                <TrashIcon size={12} /> {t("trashChip", { size: formatBytes(trashInfo.size) })}
              </button>
            ) : null}
            {volume ? (
              <span className="status-stat">
                {t("volumeUsed", { used: formatBytes(volume.used), total: formatBytes(volume.total) })}
              </span>
            ) : null}
          </>
        )}
      </footer>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} title={menu.target.name} items={menuItems(menu.target)} onClose={() => setMenu(null)} />
      ) : null}

      {denied ? (
        <div className="popover-backdrop" onMouseDown={() => setDenied(null)}>
          <div className="popover" onMouseDown={(e) => e.stopPropagation()}>
            <h3>{t("noAccessTitle")}</h3>
            <p className="popover-help">{t("noAccessHelp")}</p>
            <ul className="denied-list">
              {denied.slice(0, 300).map((p) => (
                <li key={p} title={p}>
                  <LockIcon size={12} /> {prettyPath(p, home)}
                </li>
              ))}
            </ul>
            <div className="popover-actions">
              <button className="button" onClick={() => setDenied(null)}>
                {t("close")}
              </button>
              <button className="button button-primary" onClick={() => void api.openFullDiskAccess()}>
                {t("openSettings")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {gap ? <GapPopover gap={gap} home={home} onReveal={(id) => void act(id, "reveal")} onClose={() => setGap(null)} /> : null}

      {toast ? <div className="toast">{toast}</div> : null}

      {showCleanup ? (
        <CleanupView
          api={api}
          scanId={session?.scanId ?? null}
          home={home}
          onClose={(changed) => {
            setShowCleanup(false);
            refreshTrash();
            if (changed) {
              void refresh();
              setListKey((k) => k + 1);
            }
          }}
        />
      ) : null}
    </div>
  );
}

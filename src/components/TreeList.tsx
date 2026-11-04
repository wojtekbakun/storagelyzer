import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "../api";
import { formatBytes, formatDate, formatNumber, formatPercent } from "../format";
import { t } from "../i18n";
import { Flag, sizeOf, type NodeInfo, type SizeMode } from "../types";
import { ChevronRight, CloudIcon, DiskIcon, FileIcon, FolderIcon, LinkIcon, LockIcon, PackageIcon } from "./Icons";

const ROW_H = 26;
const PAGE = 300;

interface Page {
  total: number;
  items: NodeInfo[];
  limit: number;
}

type Row =
  | { type: "node"; node: NodeInfo; depth: number; parentSize: number; parentId: number }
  | { type: "more"; parentId: number; depth: number; remaining: number }
  | { type: "status"; depth: number; text: string };

interface Props {
  api: Backend;
  scanId: number;
  rootId: number;
  rootSize: number;
  mode: SizeMode;
  refreshKey: number;
  scanning: boolean;
  hoveredId: number | null;
  selectedId: number | null;
  onHover(id: number | null): void;
  onSelect(id: number | null): void;
  onOpen(node: NodeInfo): void;
  onContext(node: NodeInfo, clientX: number, clientY: number): void;
  onQuickLook(node: NodeInfo): void;
  onTrash(node: NodeInfo): void;
}

export function NodeIcon({ node }: { node: Pick<NodeInfo, "kind" | "flags"> }) {
  if (node.kind === "dir") return node.flags & Flag.PACKAGE ? <PackageIcon /> : <FolderIcon />;
  if (node.kind === "symlink") return <LinkIcon className="muted" />;
  return <FileIcon />;
}

export function FlagBadges({ flags, scanning }: { flags: number; scanning: boolean }) {
  return (
    <>
      {flags & (Flag.DENIED | Flag.ERROR) ? (
        <span className="badge badge-warn" title={flags & Flag.DENIED ? t("flagDenied") : t("flagError")}>
          <LockIcon size={12} />
        </span>
      ) : null}
      {flags & Flag.CLOUD ? (
        <span className="badge" title={t("flagCloud")}>
          <CloudIcon size={12} />
        </span>
      ) : null}
      {flags & Flag.MOUNT ? (
        <span className="badge" title={t("flagMount")}>
          <DiskIcon size={12} />
        </span>
      ) : null}
      {flags & Flag.HARDLINK ? (
        <span className="badge" title={t("flagHardlink")}>
          <LinkIcon size={12} />
        </span>
      ) : null}
      {scanning && flags & Flag.PENDING ? <span className="spinner spinner-sm" title={t("flagPending")} /> : null}
    </>
  );
}

export function TreeList(props: Props) {
  const { api, scanId, rootId, rootSize, mode, refreshKey, scanning, hoveredId, selectedId } = props;
  const [pages, setPages] = useState<Map<number, Page>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const genRef = useRef(0);

  const load = useCallback(
    async (id: number, limit: number) => {
      const gen = genRef.current;
      try {
        const page = await api.getChildren(scanId, id, mode, 0, limit);
        if (gen !== genRef.current) return;
        setPages((prev) => {
          const next = new Map(prev);
          next.set(id, { total: page.total, items: page.items, limit });
          return next;
        });
      } catch {
        /* stale scan or removed node */
      }
    },
    [api, scanId, mode],
  );

  // New focus / scan / size mode → start fresh.
  useEffect(() => {
    genRef.current++;
    setPages(new Map());
    setExpanded(new Set());
    scrollRef.current?.scrollTo({ top: 0 });
    void load(rootId, PAGE);
  }, [rootId, load]);

  // Refresh everything that is loaded (scan progress, trash, rescan).
  useEffect(() => {
    if (refreshKey === 0) return;
    for (const [id, page] of pagesRef.current) void load(id, page.limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (id: number, depth: number, parentSize: number) => {
      const page = pages.get(id);
      if (!page) {
        out.push({ type: "status", depth, text: t("loading") });
        return;
      }
      if (page.items.length === 0) {
        out.push({ type: "status", depth, text: t("emptyFolder") });
        return;
      }
      for (const node of page.items) {
        out.push({ type: "node", node, depth, parentSize, parentId: id });
        if (node.kind === "dir" && expanded.has(node.id)) walk(node.id, depth + 1, sizeOf(node, mode));
      }
      if (page.total > page.items.length) {
        out.push({ type: "more", parentId: id, depth, remaining: page.total - page.items.length });
      }
    };
    walk(rootId, 0, rootSize);
    return out;
  }, [pages, expanded, rootId, rootSize, mode]);

  const toggle = (node: NodeInfo, open?: boolean) => {
    if (node.kind !== "dir" || !node.hasChildren) return;
    const isOpen = expanded.has(node.id);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (want) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
    if (want && !pages.has(node.id)) void load(node.id, PAGE);
  };

  const indexOf = (id: number | null) =>
    id === null ? -1 : rows.findIndex((r) => r.type === "node" && r.node.id === id);

  const ensureVisible = (index: number) => {
    const el = scrollRef.current;
    if (!el || index < 0) return;
    const top = index * ROW_H;
    if (top < el.scrollTop + ROW_H) el.scrollTop = Math.max(0, top - ROW_H);
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + 2 * ROW_H - el.clientHeight;
  };

  // Selection coming from the chart.
  useEffect(() => {
    ensureVisible(indexOf(selectedId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const nodeRows = rows.filter((r): r is Extract<Row, { type: "node" }> => r.type === "node");
    if (nodeRows.length === 0) return;
    const cur = nodeRows.findIndex((r) => r.node.id === selectedId);
    const select = (i: number) => {
      const r = nodeRows[Math.max(0, Math.min(nodeRows.length - 1, i))];
      props.onSelect(r.node.id);
      ensureVisible(indexOf(r.node.id));
    };
    const row = cur >= 0 ? nodeRows[cur] : null;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        select(cur + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        select(cur <= 0 ? 0 : cur - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row) toggle(row.node, true);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row) {
          if (expanded.has(row.node.id)) toggle(row.node, false);
          else if (row.parentId !== rootId) {
            props.onSelect(row.parentId);
            ensureVisible(indexOf(row.parentId));
          }
        }
        break;
      case "Enter":
        e.preventDefault();
        if (row) props.onOpen(row.node);
        break;
      case " ":
        e.preventDefault();
        if (row) props.onQuickLook(row.node);
        break;
      case "Backspace":
      case "Delete":
        if (row && e.metaKey) {
          e.preventDefault();
          props.onTrash(row.node);
        }
        break;
    }
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 8);

  return (
    <div className="tree">
      <div className="tree-head" role="row">
        <div className="col-name">{t("colName")}</div>
        <div className="col-size">{t("colSize")}</div>
        <div className="col-share">{t("colShare")}</div>
        <div className="col-items">{t("colItems")}</div>
        <div className="col-date">{t("colModified")}</div>
      </div>
      <div
        className="tree-body"
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onMouseLeave={() => props.onHover(null)}
        role="treegrid"
      >
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(first, last).map((row, i) => {
            const index = first + i;
            const style = { top: index * ROW_H, height: ROW_H };
            if (row.type === "status") {
              return (
                <div key={`s${index}`} className="tree-row tree-status" style={style}>
                  <div className="col-name" style={{ paddingLeft: 30 + row.depth * 16 }}>
                    {row.text}
                  </div>
                </div>
              );
            }
            if (row.type === "more") {
              return (
                <div key={`m${row.parentId}`} className="tree-row tree-more" style={style}>
                  <button
                    className="col-name link-button"
                    style={{ paddingLeft: 30 + row.depth * 16 }}
                    onClick={() => {
                      const page = pages.get(row.parentId);
                      if (page) void load(row.parentId, page.limit + PAGE * 4);
                    }}
                  >
                    {t("moreItems", { count: formatNumber(row.remaining) })}
                  </button>
                </div>
              );
            }
            const n = row.node;
            const size = sizeOf(n, mode);
            const share = row.parentSize > 0 ? size / row.parentSize : 0;
            const isOpen = expanded.has(n.id);
            const cls = [
              "tree-row",
              n.id === selectedId ? "is-selected" : "",
              n.id === hoveredId ? "is-hovered" : "",
              n.flags & (Flag.DENIED | Flag.ERROR | Flag.MOUNT) ? "is-dim" : "",
            ].join(" ");
            return (
              <div
                key={n.id}
                className={cls}
                style={style}
                role="row"
                aria-expanded={n.kind === "dir" && n.hasChildren ? isOpen : undefined}
                onMouseEnter={() => props.onHover(n.id)}
                onClick={() => props.onSelect(n.id)}
                onDoubleClick={() => props.onOpen(n)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onSelect(n.id);
                  props.onContext(n, e.clientX, e.clientY);
                }}
              >
                <div className="col-name" style={{ paddingLeft: 6 + row.depth * 16 }}>
                  {n.kind === "dir" && n.hasChildren ? (
                    <button
                      className={`disclosure ${isOpen ? "is-open" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(n);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                      tabIndex={-1}
                      aria-label="toggle"
                    >
                      <ChevronRight size={12} />
                    </button>
                  ) : (
                    <span className="disclosure-spacer" />
                  )}
                  <span className="row-icon">
                    <NodeIcon node={n} />
                  </span>
                  <span className="row-name" title={n.name}>
                    {n.name}
                  </span>
                  <FlagBadges flags={n.flags} scanning={scanning} />
                </div>
                <div className="col-size">{formatBytes(size)}</div>
                <div className="col-share">
                  <span className="share-bar">
                    <span style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
                  </span>
                  <span className="share-pct">{formatPercent(share)}</span>
                </div>
                <div className="col-items">{n.kind === "dir" ? formatNumber(n.items) : ""}</div>
                <div className="col-date">{formatDate(n.mtime)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

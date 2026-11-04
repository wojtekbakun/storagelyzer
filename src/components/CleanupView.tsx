import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Backend } from "../api";
import { formatAgo, formatBytes, formatCount, formatNumber, prettyPath } from "../format";
import { t, type TKey } from "../i18n";
import { Flag, pathsOf, type CleanupCategory, type CleanupEntry, type CleanupGroup } from "../types";
import {
  ChevronLeft,
  ChevronRight,
  FinderIcon,
  InfoIcon,
  LockIcon,
  RefreshIcon,
  SparklesIcon,
  TrashIcon,
  WarningIcon,
} from "./Icons";
import { NodeIcon } from "./TreeList";

interface Props {
  api: Backend;
  /** Current scan (adds node_modules/build folders and the largest files). */
  scanId: number | null;
  home: string | null;
  /** `changed`: something was removed, views should refresh. */
  onClose(changed: boolean): void;
}

const GROUPS: { id: CleanupGroup; title: TKey; hint?: TKey }[] = [
  { id: "trash", title: "groupTrash" },
  { id: "safe", title: "groupSafe", hint: "groupSafeHint" },
  { id: "review", title: "groupReview", hint: "groupReviewHint" },
  { id: "system", title: "groupSystem" },
];

const COLLAPSED = 6;
/** Your apps and their data are listed for reference, not counted as "found". */
const NOT_IN_TOTAL = new Set(["apps", "appData"]);
/** Apps not opened for this long are highlighted. */
const STALE_DAYS = 180;

function Check({ state, onChange, label }: { state: "on" | "off" | "mixed"; onChange(): void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "mixed";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="cl-check"
      checked={state === "on"}
      onChange={onChange}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Rows slide to their new place (and new ones fade in) when categories arrive or reorder. */
function useFlip(container: React.RefObject<HTMLElement | null>) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const next = new Map<string, number>();
    root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
      const key = el.dataset.flip!;
      const top = el.offsetTop;
      next.set(key, top);
      const prev = tops.current.get(key);
      if (prev === undefined) {
        el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], {
          duration: 260,
          easing: "ease-out",
        });
      } else if (Math.abs(prev - top) > 1) {
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: "none" }], {
          duration: 340,
          easing: "cubic-bezier(.2,.75,.25,1)",
        });
      }
    });
    tops.current = next;
  });
}

export function CleanupView({ api, scanId, home, onClose }: Props) {
  const [cats, setCats] = useState<CleanupCategory[]>([]);
  const [analyzing, setAnalyzing] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [run, setRun] = useState(0);
  const changed = useRef(false);
  const seen = useRef(new Set<string>());
  const innerRef = useRef<HTMLDivElement>(null);
  useFlip(innerRef);

  useEffect(() => {
    let alive = true;
    setCats([]);
    setSelected(new Set());
    setAnalyzing(true);
    seen.current = new Set();
    let found = 0;
    let bytes = 0;
    api
      .analyzeCleanup(scanId, (e) => {
        if (!alive) return;
        if (e.type === "done") {
          setAnalyzing(false);
          api.log("info", `cleanup: ${found} categories, ${bytes} bytes`);
          return;
        }
        const { type: _type, ...cat } = e;
        found += 1;
        bytes += cat.size;
        setCats((prev) => [...prev.filter((c) => c.id !== cat.id), cat]);
        // Suggest everything that is recreated automatically — once: a category
        // sent again with more entries must not re-select what the user unticked.
        if (cat.group === "safe" && cat.action === "trash") {
          const fresh = cat.entries.filter((en) => !en.locked && !seen.current.has(en.path)).map((en) => en.path);
          if (fresh.length > 0) setSelected((prev) => new Set([...prev, ...fresh]));
        }
        for (const en of cat.entries) seen.current.add(en.path);
      })
      .catch((err) => {
        if (!alive) return;
        setAnalyzing(false);
        setNotice({ kind: "error", text: String(err) });
      });
    return () => {
      alive = false;
    };
  }, [api, scanId, run]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose(changed.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const entryByKey = useMemo(() => {
    const m = new Map<string, CleanupEntry>();
    for (const c of cats) for (const e of c.entries) m.set(e.path, e);
    return m;
  }, [cats]);

  const selectedBytes = useMemo(() => {
    let sum = 0;
    for (const k of selected) sum += entryByKey.get(k)?.size ?? 0;
    return sum;
  }, [selected, entryByKey]);

  const denied = cats.some((c) => c.denied);

  // The same file can be in two categories (an installer that is also a large file): count it once.
  const total = useMemo(() => {
    const counted = new Set<string>();
    let sum = 0;
    for (const c of cats) {
      if (c.group === "system" || c.action === "info" || NOT_IN_TOTAL.has(c.id)) continue;
      let dup = 0;
      for (const e of c.entries) {
        if (counted.has(e.path)) dup += e.size;
        else counted.add(e.path);
      }
      sum += Math.max(0, c.size - dup);
    }
    return sum;
  }, [cats]);

  const toggle = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const toggleSet = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const refreshTrashRow = async () => {
    const info = await api.trashInfo().catch(() => null);
    if (!info || !info.accessible) return;
    setCats((prev) => {
      const rest = prev.filter((c) => c.id !== "trash");
      if (info.size <= 0) return rest;
      const old = prev.find((c) => c.id === "trash");
      return [
        ...rest,
        {
          id: "trash",
          group: "trash",
          action: "emptyTrash",
          path: old?.path ?? null,
          size: info.size,
          apparent: info.size,
          entries: [],
          count: info.items,
          denied: false,
        },
      ];
    });
  };

  const moveSelected = async () => {
    const keys = [...selected];
    if (keys.length === 0) return;
    const ok = await api.confirm(
      t("cleanupConfirm", { count: formatCount("item", keys.length), size: formatBytes(selectedBytes) }),
      t("cleanupConfirmTitle"),
      t("moveSelected"),
      t("cancel"),
    );
    if (!ok) return;
    setBusy("trash");
    setNotice(null);
    const realPaths = (k: string) => {
      const e = entryByKey.get(k);
      return e ? pathsOf(e) : [k];
    };
    try {
      const report = await api.cleanupTrash(keys.flatMap(realPaths));
      const failedPaths = new Set(report.failed.map((f) => f.path));
      const moved = new Set(keys.filter((k) => realPaths(k).every((p) => !failedPaths.has(p))));
      const failedKeys = keys.filter((k) => !moved.has(k));
      const movedBytes = [...moved].reduce((a, k) => a + (entryByKey.get(k)?.size ?? 0), 0);
      changed.current = changed.current || moved.size > 0;
      setCats((prev) =>
        prev
          .map((c) => {
            const removed = c.entries.filter((e) => moved.has(e.path)).reduce((a, e) => a + e.size, 0);
            return removed > 0
              ? { ...c, size: Math.max(0, c.size - removed), entries: c.entries.filter((e) => !moved.has(e.path)) }
              : c;
          })
          .filter((c) => c.size > 0 || c.count > 0 || c.denied || c.action !== "trash"),
      );
      setSelected(new Set(failedKeys));
      const parts = [t("cleanupMoved", { count: formatCount("item", moved.size), size: formatBytes(movedBytes) })];
      if (failedKeys.length) parts.push(t("cleanupFailed", { count: formatCount("item", failedKeys.length) }));
      setNotice({ kind: failedKeys.length ? "error" : "ok", text: parts.join(" ") });
      await refreshTrashRow();
    } catch (e) {
      setNotice({ kind: "error", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const emptyTrash = async (cat: CleanupCategory) => {
    const ok = await api.confirm(
      t("emptyTrashConfirm", { size: formatBytes(cat.size) }),
      t("emptyTrashTitle"),
      t("emptyTrashOk"),
      t("cancel"),
    );
    if (!ok) return;
    setBusy("emptyTrash");
    setNotice(null);
    try {
      const failed = await api.emptyTrash();
      changed.current = true;
      setNotice({
        kind: failed ? "error" : "ok",
        text: failed ? t("trashEmptyPartial", { count: failed }) : t("trashEmptied"),
      });
      setCats((prev) => prev.filter((c) => c.id !== "trash"));
      await refreshTrashRow();
    } catch (e) {
      setNotice({ kind: "error", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (cat: CleanupCategory) => {
    const confirmKey: Record<string, TKey> = {
      brewCleanup: "confirmBrew",
      simulators: "confirmSimulators",
      snapshots: "confirmSnapshots",
    };
    const ok = await api.confirm(t(confirmKey[cat.action]), t("actionConfirmTitle"), t("actionRun"), t("cancel"));
    if (!ok) return;
    setBusy(cat.id);
    setNotice(null);
    try {
      const out = await api.cleanupAction(cat.action);
      changed.current = true;
      setNotice({ kind: "ok", text: `${t(`cat.${cat.id}` as TKey)}: ${out || t("actionDone")}` });
      setCats((prev) => prev.filter((c) => c.id !== cat.id || cat.action === "simulators"));
      if (cat.action === "simulators") setRun((r) => r + 1);
    } catch (e) {
      setNotice({ kind: "error", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const actionButton = (cat: CleanupCategory) => {
    const labels: Partial<Record<string, TKey>> = {
      emptyTrash: "emptyTrashOk",
      brewCleanup: "actionRun",
      simulators: "actionDeleteUnavailable",
      snapshots: "actionDeleteSnapshots",
    };
    const label = labels[cat.action];
    if (!label || cat.denied) return null;
    return (
      <button
        className={`button ${cat.action === "emptyTrash" ? "button-danger" : ""}`}
        disabled={busy !== null}
        onClick={() => void (cat.action === "emptyTrash" ? emptyTrash(cat) : runAction(cat))}
      >
        {busy === cat.id || (busy === "emptyTrash" && cat.action === "emptyTrash") ? <span className="spinner spinner-sm" /> : null}
        {t(label)}
      </button>
    );
  };

  const subline = (cat: CleanupCategory) => {
    const bits: string[] = [];
    if (cat.id === "trash" && cat.count) bits.push(t("trashItems", { count: formatNumber(cat.count) }));
    if (cat.id === "snapshots") bits.push(t("snapshotsCount", { count: formatNumber(cat.count) }));
    if (cat.id === "simulators" && cat.count) bits.push(t("simulatorsCount", { count: formatNumber(cat.count) }));
    // A sparse disk image: the size column shows what it takes, this is how big it may get.
    if (cat.id === "docker" && cat.apparent > cat.size * 1.5) bits.push(t("dockerMax", { size: formatBytes(cat.apparent) }));
    if (cat.path) bits.push(prettyPath(cat.path, home));
    return bits.join(" · ");
  };

  const now = Date.now() / 1000;

  const entryRow = (cat: CleanupCategory, e: CleanupEntry) => {
    const canTrash = cat.action === "trash" && !e.locked;
    const on = selected.has(e.path);
    const stale = e.used !== undefined && now - e.used > STALE_DAYS * 86_400;
    return (
      <div
        key={e.path}
        className={`cl-entry ${canTrash ? "is-checkable" : ""}`}
        title={e.path}
        onClick={() => canTrash && toggle([e.path], !on)}
      >
        {canTrash ? (
          <input
            type="checkbox"
            className="cl-check"
            checked={on}
            aria-label={e.name}
            onClick={(ev) => ev.stopPropagation()}
            onChange={() => toggle([e.path], !on)}
          />
        ) : cat.action === "trash" ? (
          <span className="cl-check-spacer cl-lock" title={cat.id === "apps" ? t("lockedApp") : t("lockedHint")}>
            <LockIcon size={12} />
          </span>
        ) : (
          <span className="cl-check-spacer" />
        )}
        <span className="row-icon">
          <NodeIcon node={{ kind: e.kind, flags: cat.id === "apps" ? Flag.PACKAGE : 0 }} />
        </span>
        <span className="cl-entry-name">
          {e.name}
          {e.leftover ? <span className="tag tag-warn">{t("notInstalled")}</span> : null}
          {e.used !== undefined ? (
            <span className={`cl-entry-detail ${stale ? "is-stale" : ""}`}>{t("lastUsed", { ago: formatAgo(e.used, now) })}</span>
          ) : e.detail ? (
            <span className="cl-entry-detail">{prettyPath(e.detail, home)}</span>
          ) : null}
        </span>
        <span className="cl-entry-size">{formatBytes(e.size)}</span>
        <button
          className="tb-button cl-entry-reveal"
          title={t("revealSelected")}
          onClick={(ev) => {
            ev.stopPropagation();
            void api.revealPath(e.path);
          }}
        >
          <FinderIcon size={14} />
        </button>
      </div>
    );
  };

  return (
    <div className="cleanup">
      <header className="toolbar" data-tauri-drag-region>
        <div className="traffic-space" data-tauri-drag-region />
        <button className="tb-button" onClick={() => onClose(changed.current)} disabled={busy !== null} title={t("close")}>
          <ChevronLeft />
        </button>
        <div className="cleanup-title" data-tauri-drag-region>
          <SparklesIcon /> {t("cleanupTitle")}
        </div>
        <div className="tb-spacer" data-tauri-drag-region />
        <button
          className="tb-button"
          onClick={() => setRun((r) => r + 1)}
          disabled={analyzing || busy !== null}
          title={t("cleanupReanalyze")}
        >
          <RefreshIcon />
        </button>
      </header>

      <main className="cleanup-body">
        <div className="cleanup-inner" ref={innerRef}>
          <p className="cleanup-intro">{t("cleanupIntro")}</p>

          {denied ? (
            <div className="banner banner-compact">
              <WarningIcon size={16} className="banner-icon" />
              <div className="banner-text">
                <span>{t("cleanupFdaHint")}</span>
              </div>
              <button className="button" onClick={() => void api.openFullDiskAccess()}>
                {t("fdaOpen")}
              </button>
            </div>
          ) : null}

          {notice ? <div className={`notice notice-${notice.kind}`}>{notice.text}</div> : null}

          {GROUPS.map((g) => {
            const list = cats
              .filter((c) => c.group === g.id && !(c.id === "trash" && c.denied))
              .sort((a, b) => b.size - a.size || b.count - a.count);
            if (list.length === 0) return null;
            return (
              <section key={g.id} className="cl-group">
                <h2 className="section-title" data-flip={`g:${g.id}`}>
                  {t(g.title)}
                  {g.hint ? <span className="section-hint"> — {t(g.hint)}</span> : null}
                </h2>
                <div className="cl-list">
                  {list.map((cat) => {
                    const keys = cat.action === "trash" ? cat.entries.filter((e) => !e.locked).map((e) => e.path) : [];
                    const on = keys.filter((k) => selected.has(k)).length;
                    const state = on === 0 ? "off" : on === keys.length ? "on" : "mixed";
                    const isOpen = expanded.has(cat.id);
                    const entries = showAll.has(cat.id) ? cat.entries : cat.entries.slice(0, isOpen ? 60 : COLLAPSED);
                    return (
                      <div key={cat.id} className={`cl-cat ${cat.denied ? "is-denied" : ""}`} data-flip={cat.id}>
                        <div
                          className="cl-row"
                          onClick={() => cat.entries.length > 0 && toggleSet(expanded, setExpanded, cat.id)}
                        >
                          {keys.length > 0 ? (
                            <Check
                              state={state}
                              label={t(`cat.${cat.id}` as TKey)}
                              onChange={() => toggle(keys, state !== "on")}
                            />
                          ) : (
                            <span className="cl-check-spacer">
                              {cat.action === "info" ? <InfoIcon size={15} /> : cat.id === "trash" ? <TrashIcon size={15} /> : <SparklesIcon size={15} />}
                            </span>
                          )}
                          <div className="cl-main">
                            <div className="cl-title">
                              {t(`cat.${cat.id}` as TKey)}
                              {cat.denied ? <span className="tag">{t("needsFda")}</span> : null}
                            </div>
                            <div className="cl-desc">{t(`cat.${cat.id}.d` as TKey)}</div>
                            <div className="cl-sub">{subline(cat)}</div>
                          </div>
                          <div className="cl-size">{cat.size > 0 ? formatBytes(cat.size) : "—"}</div>
                          <div className="cl-actions" onClick={(e) => e.stopPropagation()}>
                            {actionButton(cat)}
                            {cat.path && cat.action !== "trash" && cat.action !== "emptyTrash" ? (
                              <button className="tb-button" title={t("revealSelected")} onClick={() => void api.revealPath(cat.path!)}>
                                <FinderIcon />
                              </button>
                            ) : null}
                          </div>
                          {cat.entries.length > 0 ? (
                            <span className={`cl-disclosure ${isOpen ? "is-open" : ""}`}>
                              <ChevronRight size={12} />
                            </span>
                          ) : (
                            <span className="cl-disclosure" />
                          )}
                        </div>
                        {isOpen ? (
                          <div className="cl-entries">
                            {entries.map((e) => entryRow(cat, e))}
                            {!showAll.has(cat.id) && cat.entries.length > entries.length ? (
                              <button className="link-button cl-more" onClick={() => toggleSet(showAll, setShowAll, cat.id)}>
                                {t("showAll", { count: formatNumber(cat.entries.length) })}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {analyzing ? (
            <div className="cl-analyzing" data-flip="analyzing">
              <span className="spinner spinner-sm" /> {t("cleanupAnalyzing")}
            </div>
          ) : cats.length === 0 ? (
            <div className="cl-analyzing">{t("cleanupNothing")}</div>
          ) : null}
        </div>
      </main>

      <footer className="cleanup-footer">
        <span className="cleanup-total">{total > 0 ? t("foundTotal", { size: formatBytes(total) }) : null}</span>
        <span className="flex-spacer" />
        <span className="cleanup-selected">
          {t("selectedSummary", { size: formatBytes(selectedBytes), count: formatCount("item", selected.size) })}
        </span>
        <button
          className="button button-primary"
          disabled={selected.size === 0 || busy !== null}
          onClick={() => void moveSelected()}
        >
          {busy === "trash" ? <span className="spinner spinner-sm spinner-light" /> : <TrashIcon size={14} />}
          {t("moveSelected")}
        </button>
      </footer>
    </div>
  );
}

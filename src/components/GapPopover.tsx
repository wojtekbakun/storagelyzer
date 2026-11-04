import { useEffect } from "react";
import { formatBytes, formatCount, prettyPath } from "../format";
import { t } from "../i18n";
import { Flag, type SizeGap } from "../types";
import { FinderIcon } from "./Icons";
import { NodeIcon } from "./TreeList";

interface Props {
  gap: SizeGap;
  home: string | null;
  onReveal(id: number): void;
  onClose(): void;
}

/** Explains, with this Mac's own files, why "Size" can be far bigger than "On disk". */
export function GapPopover({ gap, home, onReveal, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const max = Math.max(gap.apparent, gap.disk, 1);
  const width = (v: number) => `${Math.max(0.6, (v / max) * 100)}%`;
  const minShown = Math.max(50e6, gap.apparent * 0.002);
  const reasons = [
    { key: "sparse", value: gap.sparse, title: t("gapSparse"), desc: t("gapSparseD") },
    { key: "cloud", value: gap.cloud, title: t("gapCloud"), desc: t("gapCloudD", { count: formatCount("file", gap.cloudFiles) }) },
    { key: "compressed", value: gap.compressed, title: t("gapCompressed"), desc: t("gapCompressedD") },
    { key: "other", value: gap.other, title: t("gapOther"), desc: t("gapOtherD") },
  ]
    .filter((r) => r.value > minShown)
    .sort((a, b) => b.value - a.value);
  const parent = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf("/")));

  return (
    <div className="popover-backdrop" onMouseDown={onClose}>
      <div className="popover gap-popover" role="dialog" aria-label={t("gapTitle")} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t("gapTitle")}</h3>
        <p className="popover-help">{t("gapLead")}</p>

        <div className="gap-bars">
          <span className="gap-bar-label">{t("sizeOnDisk")}</span>
          <span className="gap-bar">
            <span className="gap-fill is-disk" style={{ width: width(gap.disk) }} />
          </span>
          <b>{formatBytes(gap.disk)}</b>
          <span className="gap-bar-label">{t("sizeLogical")}</span>
          <span className="gap-bar">
            <span className="gap-fill is-disk" style={{ width: width(Math.min(gap.disk, gap.apparent)) }} />
            {gap.apparent > gap.disk ? (
              <span className="gap-fill is-extra" style={{ width: `${((gap.apparent - gap.disk) / max) * 100}%` }} />
            ) : null}
          </span>
          <b>{formatBytes(gap.apparent)}</b>
        </div>

        {reasons.length === 0 ? (
          <p className="gap-none">{t("gapNone")}</p>
        ) : (
          <ul className="gap-reasons">
            {reasons.map((r) => (
              <li key={r.key}>
                <span className="gap-plus">+{formatBytes(r.value)}</span>
                <span className="gap-what">
                  <b>{r.title}</b>
                  <span>{r.desc}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {gap.top.length > 0 ? (
          <>
            <h4 className="section-title gap-files-title">{t("gapBiggest")}</h4>
            <ul className="gap-files">
              {gap.top.map((f) => (
                <li key={f.id} title={f.path}>
                  <span className="row-icon">
                    <NodeIcon node={{ kind: "file", flags: f.reason === "cloud" ? Flag.CLOUD : 0 }} />
                  </span>
                  <span className="gap-file-name">
                    {f.name}
                    <span className="gap-file-path">{prettyPath(parent(f.path), home)}</span>
                  </span>
                  <span className="gap-file-sizes">
                    {t("gapItem", { apparent: formatBytes(f.apparent), disk: formatBytes(f.disk) })}
                  </span>
                  <button className="tb-button" title={t("revealSelected")} onClick={() => onReveal(f.id)}>
                    <FinderIcon size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <div className="popover-actions gap-actions">
          <span className="gap-footer">{t("gapFooter")}</span>
          <button className="button button-primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

import type { Backend } from "../api";
import { formatBytes } from "../format";
import { t } from "../i18n";
import type { Location, Locations } from "../types";
import {
  DiskIcon,
  ExternalDiskIcon,
  FolderPlusIcon,
  HomeIcon,
  LogoMark,
  NetworkIcon,
  SparklesIcon,
  WarningIcon,
} from "./Icons";

interface Props {
  api: Backend;
  locations: Locations | null;
  isDev: boolean;
  onScan(path: string): void;
  onRefresh(): void;
  onCleanup(): void;
}

function LocationIcon({ loc }: { loc: Location }) {
  switch (loc.kind) {
    case "home":
      return <HomeIcon size={22} />;
    case "root":
      return <DiskIcon size={22} />;
    case "network":
      return <NetworkIcon size={22} />;
    default:
      return <ExternalDiskIcon size={22} />;
  }
}

export function StartScreen({ api, locations, isDev, onScan, onRefresh, onCleanup }: Props) {
  const pick = async () => {
    const path = await api.pickFolder(t("pickMessage"), t("pickPrompt"));
    if (path) onScan(path);
  };

  // Mac App Store build: macOS lets the app read only what the user allowed.
  const root = locations?.items.find((l) => l.kind === "root");
  const needsRoot = locations?.sandboxed && root && !root.granted ? root : null;
  const allow = async (loc: Location) => {
    await api.ensureAccess(loc.path, t("accessMessage", { name: loc.name }), t("accessAllow")).catch(() => null);
    onRefresh();
  };

  return (
    <div className="app">
      <header className="toolbar toolbar-plain" data-tauri-drag-region>
        <div className="traffic-space" data-tauri-drag-region />
        <div className="toolbar-title" data-tauri-drag-region>
          Storagelyzer
        </div>
        <div className="tb-spacer" data-tauri-drag-region />
      </header>
      <main className="start">
        <div className="start-inner">
          <div className="hero">
            <LogoMark size={64} />
            <div>
              <h1>Storagelyzer</h1>
              <p>{t("appSubtitle")}</p>
            </div>
          </div>

          {needsRoot ? (
            <div className="banner">
              <DiskIcon size={18} className="banner-icon" />
              <div className="banner-text">
                <strong>{t("accessTitle")}</strong>
                <span>{t("accessText", { name: needsRoot.name })}</span>
              </div>
              <div className="banner-actions">
                <button className="button button-primary" onClick={() => void allow(needsRoot)}>
                  {t("accessButton")}
                </button>
              </div>
            </div>
          ) : null}

          {locations?.fullDiskAccess === false ? (
            <div className="banner">
              <WarningIcon size={18} className="banner-icon" />
              <div className="banner-text">
                <strong>{t("fdaTitle")}</strong>
                <span>{t("fdaText")}</span>
                {isDev ? <span className="banner-note">{t("fdaDevNote")}</span> : null}
              </div>
              <div className="banner-actions">
                <button className="button button-primary" onClick={() => void api.openFullDiskAccess()}>
                  {t("fdaOpen")}
                </button>
                <button className="button" onClick={onRefresh}>
                  {t("fdaRecheck")}
                </button>
              </div>
            </div>
          ) : null}

          <h2 className="section-title">{t("locations")}</h2>
          <div className="locations">
            {(locations?.items ?? []).map((loc) => {
              const used = loc.total !== null && loc.available !== null ? loc.total - loc.available : null;
              const frac = used !== null && loc.total ? used / loc.total : 0;
              return (
                <button key={loc.path} className="location" onClick={() => onScan(loc.path)} title={loc.path}>
                  <span className={`location-icon kind-${loc.kind}`}>
                    <LocationIcon loc={loc} />
                  </span>
                  <span className="location-body">
                    <span className="location-name">
                      {loc.kind === "home" ? t("homeFolder") : loc.name}
                      {loc.kind === "network" ? <span className="tag">{t("network")}</span> : null}
                      {loc.readOnly ? <span className="tag">{t("readOnly")}</span> : null}
                      {!loc.granted ? <span className="tag">{t("needsAccess")}</span> : null}
                    </span>
                    <span className="location-path">{loc.path}</span>
                    {used !== null && loc.total ? (
                      <>
                        <span className="usage">
                          <span
                            className={`usage-fill ${frac > 0.9 ? "is-critical" : frac > 0.75 ? "is-warn" : ""}`}
                            style={{ width: `${Math.min(100, frac * 100)}%` }}
                          />
                        </span>
                        <span className="location-meta">
                          {t("freeOf", { free: formatBytes(loc.available ?? 0), total: formatBytes(loc.total) })}
                        </span>
                      </>
                    ) : null}
                  </span>
                </button>
              );
            })}
            <button className="location location-pick" onClick={() => void pick()}>
              <span className="location-icon">
                <FolderPlusIcon size={22} />
              </span>
              <span className="location-body">
                <span className="location-name">{t("chooseFolder")}</span>
                <span className="location-path">{t("dropHint")}</span>
              </span>
            </button>
          </div>

          <h2 className="section-title section-spaced">{t("toolsSection")}</h2>
          <div className="locations">
            <button className="location" onClick={onCleanup}>
              <span className="location-icon kind-tool">
                <SparklesIcon size={22} />
              </span>
              <span className="location-body">
                <span className="location-name">{t("toolCleanupTitle")}</span>
                <span className="location-path">{t("toolCleanupText")}</span>
              </span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

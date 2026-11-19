import { useCallback, useEffect, useRef, useState } from "react";
import { backend, isTauri, type Backend } from "./api";
import { CleanupView } from "./components/CleanupView";
import { ScanView } from "./components/ScanView";
import { StartScreen } from "./components/StartScreen";
import { t } from "./i18n";
import type { Locations } from "./types";

export default function App() {
  const [api, setApi] = useState<Backend | null>(null);
  const [locations, setLocations] = useState<Locations | null>(null);
  const [scan, setScan] = useState<{ path: string; nonce: number } | null>(null);
  const [cleanup, setCleanup] = useState(false);

  useEffect(() => {
    void backend().then(setApi);
  }, []);

  const refreshLocations = useCallback(() => {
    if (api) void api.listLocations().then(setLocations).catch(() => {});
  }, [api]);

  useEffect(refreshLocations, [refreshLocations]);

  // Re-check volumes and Full Disk Access when the user comes back to the app
  // (e.g. after granting the permission in System Settings or plugging a drive).
  useEffect(() => {
    const onFocus = () => {
      if (!scan) refreshLocations();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scan, refreshLocations]);

  // Read through a ref so that `startScan` stays stable (the launch effect below runs once).
  const locationsRef = useRef(locations);
  locationsRef.current = locations;

  // In the Mac App Store build a disk or folder must be allowed once before it can be read.
  const startScan = useCallback(
    async (path: string) => {
      if (!api) return;
      const loc = locationsRef.current?.items.find((l) => l.path === path);
      const name = loc ? (loc.kind === "home" ? t("homeFolder") : loc.name) : (path.split("/").filter(Boolean).pop() ?? path);
      const target = await api.ensureAccess(path, t("accessMessage", { name }), t("accessAllow")).catch((e) => {
        api.log("error", `access to ${path}: ${String(e)}`);
        return path;
      });
      if (target) setScan({ path: target, nonce: Date.now() });
    },
    [api],
  );

  useEffect(() => (api ? api.onFolderDrop((p) => void startScan(p)) : undefined), [api, startScan]);

  // `storagelyzer ~/Downloads` opens that folder right away; UI errors go to the log.
  useEffect(() => {
    if (!api) return;
    const onError = (e: ErrorEvent) => api.log("error", `${e.message} (${e.filename}:${e.lineno})`);
    const onRejection = (e: PromiseRejectionEvent) => api.log("error", `unhandled rejection: ${String(e.reason)}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    api.log("info", `ui ready (${navigator.language})`);
    void api.initialPath().then((p) => p && void startScan(p));
    void api.launchFlags().then((flags) => flags.includes("--cleanup") && setCleanup(true));
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [api, startScan]);

  if (!api) return <div className="app" />;

  const home = locations?.items.find((l) => l.kind === "home")?.path ?? null;

  if (scan) {
    return (
      <ScanView
        key={scan.nonce}
        api={api}
        path={scan.path}
        home={home}
        sandboxed={locations?.sandboxed ?? false}
        onBack={() => {
          void api.cancelScan();
          setScan(null);
          refreshLocations();
        }}
      />
    );
  }

  return (
    <>
      <StartScreen
        api={api}
        locations={locations}
        isDev={import.meta.env.DEV || !isTauri}
        onScan={(p) => void startScan(p)}
        onRefresh={refreshLocations}
        onCleanup={() => setCleanup(true)}
      />
      {cleanup ? (
        <CleanupView
          api={api}
          scanId={null}
          home={home}
          onClose={() => {
            setCleanup(false);
            refreshLocations();
          }}
        />
      ) : null}
    </>
  );
}

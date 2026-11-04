import { useCallback, useEffect, useState } from "react";
import { backend, isTauri, type Backend } from "./api";
import { CleanupView } from "./components/CleanupView";
import { ScanView } from "./components/ScanView";
import { StartScreen } from "./components/StartScreen";
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

  const startScan = useCallback((path: string) => setScan({ path, nonce: Date.now() }), []);

  useEffect(() => (api ? api.onFolderDrop(startScan) : undefined), [api, startScan]);

  // `storagelyzer ~/Downloads` opens that folder right away; UI errors go to the log.
  useEffect(() => {
    if (!api) return;
    const onError = (e: ErrorEvent) => api.log("error", `${e.message} (${e.filename}:${e.lineno})`);
    const onRejection = (e: PromiseRejectionEvent) => api.log("error", `unhandled rejection: ${String(e.reason)}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    void api.initialPath().then((p) => p && startScan(p));
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
        onScan={startScan}
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

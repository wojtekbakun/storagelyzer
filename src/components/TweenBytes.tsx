import { useEffect, useRef, useState } from "react";
import { formatBytes } from "../format";

/**
 * A byte count that counts up/down smoothly instead of jumping (live scan).
 * A new `resetKey` (another folder) shows the new value at once.
 */
export function TweenBytes({ value, resetKey, ms = 480 }: { value: number; resetKey: unknown; ms?: number }) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const keyRef = useRef(resetKey);

  useEffect(() => {
    const set = (v: number) => {
      shownRef.current = v;
      setShown(v);
    };
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      set(value);
      return;
    }
    const from = shownRef.current;
    if (from === value) return;
    const start = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / ms);
      set(from + (value - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
    });
    // rAF pauses in hidden windows — still end on the right number.
    const timer = setTimeout(() => set(value), ms + 200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [value, resetKey, ms]);

  return <>{formatBytes(shown)}</>;
}

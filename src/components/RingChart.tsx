import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Flag, type RingNode } from "../types";
import {
  IDENTITY,
  TAU,
  buildMorph,
  css,
  easeInOut,
  easeOut,
  geometry,
  hitTest,
  layout,
  lerp,
  lerpView,
  morphProgress,
  radius,
  segmentRGB,
  type Geom,
  type Layout,
  type Morph,
  type Palette,
  type Segment,
  type View,
} from "../ring/layout";
import { newCalloutState, paintCallouts, resetCallouts, type CalloutStyle, type Kid } from "../ring/callouts";

export interface RingChartHandle {
  /** Animates the view into the segment of node `id` (if visible). */
  zoomInto(id: number): Promise<void>;
}

interface Props {
  data: RingNode | null;
  /** When `data` changes: start zoomed into this node and zoom out (navigating up). */
  enterFrom: number | null;
  rings: number;
  highlightId: number | null;
  /** A scan is running: folders not listed yet pulse softly. */
  scanning: boolean;
  onHover(seg: Segment | null): void;
  onActivate(seg: Segment): void;
  onCenterClick(): void;
  onContext(seg: Segment, clientX: number, clientY: number): void;
  renderTooltip(seg: Segment): ReactNode;
  center: ReactNode;
  canGoUp: boolean;
  /** Height kept free at the bottom of the pane (a note under the chart): labels stay above it. */
  bottomInset?: number;
}

/** Zoom in/out. */
const DURATION = 430;
/** First appearance: the rings sweep in clockwise. */
const REVEAL_MS = 750;

type ChartPalette = Palette & { callout: CalloutStyle };

function readPalette(el: HTMLElement): ChartPalette {
  const st = getComputedStyle(el);
  const dark = st.getPropertyValue("--is-dark").trim() === "1";
  const parse = (v: string, fallback: [number, number, number]) => {
    const m = v.match(/\d+(\.\d+)?/g);
    return m && m.length >= 3 ? ([+m[0], +m[1], +m[2]] as [number, number, number]) : fallback;
  };
  const v = (name: string, light: string, darkValue: string) => st.getPropertyValue(name).trim() || (dark ? darkValue : light);
  return {
    dark,
    center: parse(st.getPropertyValue("--chart-center"), dark ? [44, 45, 49] : [246, 246, 248]),
    separator: v("--chart-separator", "#ffffff", "#1e1f22"),
    highlight: v("--chart-highlight", "rgba(0,0,0,.45)", "rgba(255,255,255,.85)"),
    callout: {
      font: st.fontFamily || "-apple-system, BlinkMacSystemFont, sans-serif",
      text: v("--text", "#1d1d1f", "#f5f5f7"),
      text2: v("--text-2", "#6e6e73", "#a1a1a6"),
      fill: v("--tip-bg", "rgba(255,255,255,.94)", "rgba(44,44,47,.95)"),
      border: v("--line-strong", "rgba(0,0,0,.14)", "rgba(255,255,255,.15)"),
      leader: v("--chart-leader", "rgba(0,0,0,.55)", "rgba(255,255,255,.72)"),
      halo: v("--chart-halo", "rgba(251,251,252,.75)", "rgba(25,25,27,.7)"),
    },
  };
}

export const RingChart = forwardRef<RingChartHandle, Props>(function RingChart(props, ref) {
  const { data, enterFrom, rings, highlightId, scanning } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const layoutRef = useRef<Layout | null>(null);
  const viewRef = useRef<View>(IDENTITY);
  const geomRef = useRef<Geom | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const paletteRef = useRef<ChartPalette | null>(null);
  const animRef = useRef<{ raf: number; timer: ReturnType<typeof setTimeout>; cancel: () => void } | null>(null);
  const morphRef = useRef<Morph | null>(null);
  const revealRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const tickRef = useRef(0);
  /** Labels for what is inside the hovered folder; `busy` while they fade or glide. */
  const calloutRef = useRef(newCalloutState());
  const calloutBusyRef = useRef(false);
  const hoverRef = useRef<Segment | null>(null);
  const highlightRef = useRef<number | null>(highlightId);
  const propsRef = useRef(props);
  propsRef.current = props;

  const [hovered, setHovered] = useState<Segment | null>(null);
  const [animating, setAnimating] = useState(false);
  const [geom, setGeom] = useState<Geom | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const lay = layoutRef.current;
    const g = geomRef.current;
    if (!canvas || !g) return;
    const { w, h, dpr } = sizeRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pal = (paletteRef.current ??= readPalette(canvas));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!lay) return;

    const now = performance.now();
    const view = viewRef.current;
    const span = view.x1 - view.x0;
    const hover = hoverRef.current;
    const hl = highlightRef.current;
    const rootKey = lay.segments[0]?.key;

    const morph = morphRef.current;
    const m = morph ? morphProgress(morph, now) : 1;
    if (morph && m >= 1) morphRef.current = null;
    const revealStart = revealRef.current;
    const reveal = revealStart === null ? 1 : easeOut(Math.min(1, (now - revealStart) / REVEAL_MS));
    if (revealStart !== null && reveal >= 1) revealRef.current = null;
    const pulseAt = propsRef.current.scanning ? now : null;

    // (Assigned inside `paint`; the cast keeps TS from narrowing it to `null`.)
    let outline = null as { a0: number; a1: number; inner: number; outer: number; full: boolean } | null;
    /** Children of the hovered segment, where they are drawn this frame. */
    const kids: Kid[] = [];
    ctx.lineJoin = "round";

    const paint = (s: Segment, alpha: number, leaving = false) => {
      const ring = s.depth - view.d;
      if (ring <= -1 + 1e-6 || alpha <= 0.01) return;
      const inner = radius(ring, g);
      const outer = Math.min(radius(ring + 1, g), g.R);
      if (outer <= 0.5 || inner >= g.R - 0.5) return;
      let f0 = (s.x0 - view.x0) / span;
      let f1 = (s.x1 - view.x0) / span;
      if (ring > 0.001 && reveal < 1) {
        if (f0 >= reveal) return;
        f1 = Math.min(f1, reveal);
      }
      if (f1 <= 0 || f0 >= 1) return;
      f0 = Math.max(0, f0);
      f1 = Math.min(1, f1);
      const full = f1 - f0 > 0.99999;
      const a0 = f0 * TAU - TAU / 4;
      const a1 = f1 * TAU - TAU / 4;
      const arc = (a1 - a0) * outer;
      if (arc < 0.7) return;

      const isHover = hover !== null && hover.key === s.key;
      const isHighlight = hl !== null && s.kind !== "other" && s.id === hl && s.depth > 0;
      const isCenter = ring < 0.001 && full && s.key === rootKey;

      ctx.beginPath();
      if (full) {
        ctx.arc(g.cx, g.cy, outer, 0, TAU);
        if (inner > 0) {
          ctx.moveTo(g.cx + inner, g.cy);
          ctx.arc(g.cx, g.cy, inner, 0, TAU, true);
        }
      } else {
        ctx.arc(g.cx, g.cy, outer, a0, a1);
        if (inner > 0) ctx.arc(g.cx, g.cy, inner, a1, a0, true);
        else ctx.lineTo(g.cx, g.cy);
        ctx.closePath();
      }
      let rgb = isCenter
        ? isHover && propsRef.current.canGoUp
          ? mixWhite(pal.center, pal.dark ? 0.06 : -0.035)
          : pal.center
        : segmentRGB(s, view, pal, isHover || isHighlight);
      if (pulseAt !== null && !isCenter && s.kind === "dir" && s.flags & Flag.PENDING) {
        // Not listed yet: a soft wave running around the ring.
        const k = 0.5 + 0.5 * Math.sin(pulseAt / 240 - (s.x0 + s.x1) * Math.PI * 2);
        rgb = mixWhite(rgb, (pal.dark ? 0.14 : 0.38) * k);
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = css(rgb);
      ctx.fill("evenodd");
      if (arc > 2.5 && !isCenter) {
        ctx.strokeStyle = pal.separator;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if ((isHover || isHighlight) && !isCenter && s.depth > 0) outline = { a0, a1, inner, outer, full };
      if (!leaving && hover !== null && s.kind !== "other" && s.parent?.key === hover.key) {
        kids.push({ key: s.key, name: s.name, size: s.size, a0, a1, inner, outer, color: css(segmentRGB(s, view, pal, false)) });
      }
    };

    if (morph && m < 1) {
      for (const x of morph.exiting) {
        paint({ ...x.seg, x0: lerp(x.from.x0, x.to.x0, m), x1: lerp(x.from.x1, x.to.x1, m) }, x.from.a * (1 - m), true);
      }
    }
    for (const s of lay.segments) {
      const f = morph && m < 1 ? morph.from.get(s.key) : undefined;
      if (f) paint({ ...s, x0: lerp(f.x0, s.x0, m), x1: lerp(f.x1, s.x1, m) }, lerp(f.a, 1, m));
      else paint(s, 1);
    }

    if (outline) {
      const { a0, a1, inner, outer, full } = outline;
      ctx.beginPath();
      if (full) {
        ctx.arc(g.cx, g.cy, outer - 1, 0, TAU);
        if (inner > 0) {
          ctx.moveTo(g.cx + inner + 1, g.cy);
          ctx.arc(g.cx, g.cy, inner + 1, 0, TAU, true);
        }
      } else {
        ctx.arc(g.cx, g.cy, outer - 1, a0, a1);
        ctx.arc(g.cx, g.cy, Math.max(0, inner + 1), a1, a0, true);
        ctx.closePath();
      }
      ctx.strokeStyle = pal.highlight;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (animRef.current) {
      // Zooming: labels would not follow the moving rings.
      resetCallouts(calloutRef.current);
      calloutBusyRef.current = false;
    } else {
      calloutBusyRef.current = paintCallouts(ctx, calloutRef.current, hover?.key ?? null, kids, now, {
        g,
        width: w,
        height: h,
        style: pal.callout,
        topLeft: propsRef.current.canGoUp ? 52 : 0,
        bottom: propsRef.current.bottomInset ?? 0,
      });
    }
  }, []);

  /** Keeps drawing while a morph, the reveal or the "still scanning" pulse needs frames. */
  const kick = useCallback(() => {
    if (tickRef.current) return;
    const tick = () => {
      tickRef.current = 0;
      // A zoom animation draws every frame by itself.
      if (!animRef.current) draw();
      const busy =
        morphRef.current !== null ||
        revealRef.current !== null ||
        calloutBusyRef.current ||
        (propsRef.current.scanning && pendingRef.current);
      if (busy) tickRef.current = requestAnimationFrame(tick);
    };
    tickRef.current = requestAnimationFrame(tick);
  }, [draw]);

  useEffect(() => () => cancelAnimationFrame(tickRef.current), []);

  // Canvas sizing (HiDPI aware).
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      geomRef.current = geometry(rect.width, rect.height, propsRef.current.rings);
      setGeom(geomRef.current);
      draw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    const { w, h } = sizeRef.current;
    if (w > 0) {
      geomRef.current = geometry(w, h, rings);
      setGeom(geomRef.current);
    }
    draw();
  }, [rings, draw]);

  // Theme changes.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      paletteRef.current = null;
      requestAnimationFrame(draw);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [draw]);

  // The pulse starts/stops with the scan.
  useEffect(() => {
    draw();
    kick();
  }, [scanning, draw, kick]);

  const stopAnimation = () => {
    animRef.current?.cancel();
    animRef.current = null;
  };

  const animate = useCallback(
    (from: View, to: View) =>
      new Promise<void>((resolve) => {
        animRef.current?.cancel();
        const start = performance.now();
        let done = false;
        const end = (finalView: boolean) => {
          if (done) return;
          done = true;
          if (animRef.current) {
            cancelAnimationFrame(animRef.current.raf);
            clearTimeout(animRef.current.timer);
          }
          animRef.current = null;
          if (finalView) {
            viewRef.current = to;
            draw();
          }
          setAnimating(false);
          resolve();
        };
        const step = (now: number) => {
          if (done) return;
          const t = Math.min(1, (now - start) / DURATION);
          if (t >= 1) return end(true);
          viewRef.current = lerpView(from, to, easeInOut(t));
          draw();
          if (animRef.current) animRef.current.raf = requestAnimationFrame(step);
        };
        setAnimating(true);
        animRef.current = {
          raf: requestAnimationFrame(step),
          // rAF does not run in hidden/minimized windows — never leave the chart half-zoomed.
          timer: setTimeout(() => end(true), DURATION + 250),
          cancel: () => end(false),
        };
      }),
    [draw],
  );

  // New data → new layout, with a transition that fits what happened.
  useEffect(() => {
    if (!data) {
      layoutRef.current = null;
      morphRef.current = null;
      draw();
      return;
    }
    const prev = layoutRef.current;
    const lay = layout(data, rings);
    const now = performance.now();
    pendingRef.current = lay.segments.some((s) => s.kind === "dir" && (s.flags & Flag.PENDING) !== 0);
    const rootKey = lay.segments[0].key;
    const sameRoot = prev !== null && prev.segments[0]?.key === rootKey;

    const resetHover = () => {
      hoverRef.current = null;
      setHovered(null);
      resetCallouts(calloutRef.current);
    };
    const keepHover = () => {
      const key = hoverRef.current?.key;
      if (!key) return;
      const s = lay.byKey.get(key) ?? null;
      hoverRef.current = s;
      setHovered(s);
      if (!s) propsRef.current.onHover(null);
    };

    const from = enterFrom !== null ? lay.byId.get(enterFrom) : undefined;
    if (from && from.depth > 0) {
      // Going up: start zoomed into where we came from, then zoom out.
      layoutRef.current = lay;
      morphRef.current = null;
      resetHover();
      const start: View = { x0: from.x0, x1: from.x1, d: from.depth };
      viewRef.current = start;
      void animate(start, IDENTITY);
    } else if (prev && animRef.current) {
      // A zoom is running: let it finish on the fresh data.
      layoutRef.current = lay;
      if (sameRoot) keepHover();
    } else if (prev && prev.byKey.has(rootKey)) {
      // The same folder grew (live scan), changed size mode, lost an item —
      // or we just zoomed into a child: morph from what is on screen.
      morphRef.current = buildMorph(prev, lay, viewRef.current, morphRef.current, now);
      layoutRef.current = lay;
      viewRef.current = IDENTITY;
      if (sameRoot) keepHover();
      else resetHover();
      draw();
      kick();
    } else {
      // Something new: sweep in.
      stopAnimation();
      setAnimating(false);
      layoutRef.current = lay;
      morphRef.current = null;
      viewRef.current = IDENTITY;
      revealRef.current = now;
      resetHover();
      draw();
      kick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    highlightRef.current = highlightId;
    if (!animRef.current) draw();
  }, [highlightId, draw]);

  useImperativeHandle(
    ref,
    () => ({
      zoomInto(id: number) {
        const lay = layoutRef.current;
        const seg = lay?.byId.get(id);
        if (!lay || !seg || seg.depth === 0) return Promise.resolve();
        hoverRef.current = null;
        setHovered(null);
        resetCallouts(calloutRef.current);
        return animate(viewRef.current, { x0: seg.x0, x1: seg.x1, d: seg.depth });
      },
    }),
    [animate],
  );

  const segmentAt = (e: React.MouseEvent): Segment | null => {
    const lay = layoutRef.current;
    const g = geomRef.current;
    if (!lay || !g || animRef.current) return null;
    const rect = canvasRef.current!.getBoundingClientRect();
    return hitTest(lay, g, e.clientX - rect.left, e.clientY - rect.top);
  };

  const mouseRef = useRef({ x: 0, y: 0 });

  const placeTip = useCallback(() => {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const { x, y } = mouseRef.current;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = x + 18 + tw > rect.width - 6 ? x - tw - 14 : x + 18;
    const top = y + 20 + th > rect.height - 6 ? y - th - 14 : y + 20;
    tip.style.transform = `translate(${Math.max(6, left)}px, ${Math.max(6, top)}px)`;
  }, []);

  const moveTip = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    placeTip();
  };

  // Content changed → its size changed: re-place before paint.
  useLayoutEffect(placeTip, [hovered, placeTip]);

  const onMove = (e: React.MouseEvent) => {
    const seg = segmentAt(e);
    if (seg?.key !== hoverRef.current?.key) {
      hoverRef.current = seg;
      setHovered(seg);
      propsRef.current.onHover(seg);
      draw();
      kick();
    }
    moveTip(e);
  };

  const onLeave = () => {
    if (hoverRef.current) {
      hoverRef.current = null;
      setHovered(null);
      propsRef.current.onHover(null);
      draw();
      kick();
    }
  };

  const onClick = (e: React.MouseEvent) => {
    const seg = segmentAt(e);
    if (!seg) return;
    if (seg.depth === 0) propsRef.current.onCenterClick();
    else propsRef.current.onActivate(seg);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const seg = segmentAt(e);
    if (seg && seg.kind !== "other") propsRef.current.onContext(seg, e.clientX, e.clientY);
  };

  const clickable =
    hovered !== null && (hovered.depth === 0 ? props.canGoUp : hovered.kind === "dir" || hovered.kind === "file");

  return (
    <div className="ring-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="ring-canvas"
        style={{ cursor: clickable ? "pointer" : "default" }}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onClick={onClick}
        onContextMenu={onContextMenu}
      />
      <div className={`ring-center ${animating || !data ? "is-hidden" : ""}`} style={centerStyle(geom)}>
        {props.center}
      </div>
      <div ref={tipRef} className={`ring-tip ${hovered && !animating ? "is-visible" : ""}`}>
        {hovered ? props.renderTooltip(hovered) : null}
      </div>
    </div>
  );
});

/** Mixes towards white (t > 0) or black (t < 0). */
function mixWhite(rgb: [number, number, number], t: number): [number, number, number] {
  const target = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  return [rgb[0] + (target - rgb[0]) * k, rgb[1] + (target - rgb[1]) * k, rgb[2] + (target - rgb[2]) * k];
}

function centerStyle(g: Geom | null): React.CSSProperties {
  if (!g) return { opacity: 0 };
  const size = g.r0 * 2 * 0.86;
  return { left: g.cx - size / 2, top: g.cy - size / 2, width: size, height: size };
}

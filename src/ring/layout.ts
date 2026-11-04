import type { Kind, RingNode } from "../types";

export const TAU = Math.PI * 2;

/** One arc of the chart. Angles are fractions of the full circle [0, 1]. */
export interface Segment {
  key: string;
  /** Node id; for an "other" segment, the id of its parent. */
  id: number;
  name: string;
  kind: Kind | "other";
  size: number;
  disk: number;
  apparent: number;
  items: number;
  flags: number;
  depth: number;
  x0: number;
  x1: number;
  parent: Segment | null;
  /** Number of items folded into an "other" segment. */
  otherCount: number;
}

/** Visible window into the layout: angle domain [x0, x1] and depth offset d. */
export interface View {
  x0: number;
  x1: number;
  d: number;
}

export const IDENTITY: View = { x0: 0, x1: 1, d: 0 };

export interface Layout {
  segments: Segment[];
  byDepth: Segment[][];
  byId: Map<number, Segment>;
  /** Every segment, including "other" ones (keys are stable across updates). */
  byKey: Map<string, Segment>;
}

export function layout(root: RingNode, maxDepth: number): Layout {
  const segments: Segment[] = [];
  const mk = (n: RingNode, depth: number, x0: number, x1: number, parent: Segment | null): Segment => ({
    key: String(n.id),
    id: n.id,
    name: n.name,
    kind: n.kind,
    size: n.size,
    disk: n.disk,
    apparent: n.apparent,
    items: n.items,
    flags: n.flags,
    depth,
    x0,
    x1,
    parent,
    otherCount: 0,
  });

  const rootSeg = mk(root, 0, 0, 1, null);
  segments.push(rootSeg);

  const visit = (node: RingNode, seg: Segment) => {
    if (seg.depth >= maxDepth || node.size <= 0) return;
    const span = seg.x1 - seg.x0;
    let x = seg.x0;
    for (const c of node.children ?? []) {
      const w = (c.size / node.size) * span;
      const s = mk(c, seg.depth + 1, x, x + w, seg);
      segments.push(s);
      visit(c, s);
      x += w;
    }
    if (node.otherCount > 0 && node.otherSize > 0) {
      const w = (node.otherSize / node.size) * span;
      segments.push({
        key: `other:${node.id}`,
        id: node.id,
        name: "",
        kind: "other",
        size: node.otherSize,
        disk: node.otherSize,
        apparent: node.otherSize,
        items: node.otherCount,
        flags: 0,
        depth: seg.depth + 1,
        x0: x,
        x1: Math.min(seg.x1, x + w),
        parent: seg,
        otherCount: node.otherCount,
      });
    }
  };
  visit(root, rootSeg);

  const byDepth: Segment[][] = [];
  const byId = new Map<number, Segment>();
  const byKey = new Map<string, Segment>();
  for (const s of segments) {
    (byDepth[s.depth] ??= []).push(s);
    if (s.kind !== "other") byId.set(s.id, s);
    byKey.set(s.key, s);
  }
  return { segments, byDepth, byId, byKey };
}

export interface Geom {
  cx: number;
  cy: number;
  /** Outer radius of the last ring. */
  R: number;
  /** Radius of the center disc. */
  r0: number;
  ringW: number;
  rings: number;
}

export function geometry(width: number, height: number, rings: number): Geom {
  const R = Math.max(60, Math.min(width, height) / 2 - 18);
  const r0 = R * 0.25;
  return { cx: width / 2, cy: height / 2, R, r0, ringW: (R - r0) / rings, rings };
}

/** Inner radius of (possibly fractional, during animation) ring index. */
export function radius(ring: number, g: Geom): number {
  if (ring <= 0) return 0;
  if (ring < 1) return ring * g.r0;
  return g.r0 + (ring - 1) * g.ringW;
}

export function lerpView(a: View, b: View, t: number): View {
  return { x0: a.x0 + (b.x0 - a.x0) * t, x1: a.x1 + (b.x1 - a.x1) * t, d: a.d + (b.d - a.d) * t };
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Fast start, soft landing — for updates that should feel immediate. */
export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where a segment is drawn: angle fractions on screen and opacity. */
export interface Pos {
  x0: number;
  x1: number;
  a: number;
}

/**
 * Transition between two layouts of the same folder (a live scan update, a
 * size-mode switch) or into a child that was just zoomed into. Matching
 * segments move from where they are drawn now; new ones fade in at their
 * place inside the parent; removed ones shrink into the parent and fade out.
 */
export interface Morph {
  start: number;
  from: Map<string, Pos>;
  exiting: { seg: Segment; from: Pos; to: Pos }[];
}

export const MORPH_MS = 520;

export function morphProgress(m: Morph, now: number): number {
  return easeOut(Math.min(1, (now - m.start) / MORPH_MS));
}

export function buildMorph(prev: Layout, next: Layout, view: View, inflight: Morph | null, now: number): Morph {
  const span = view.x1 - view.x0 || 1;
  const p = inflight ? morphProgress(inflight, now) : 1;
  // What is on screen right now, in screen fractions (the view applied).
  const shown = new Map<string, Pos>();
  for (const s of prev.segments) {
    let x0 = s.x0;
    let x1 = s.x1;
    let a = 1;
    const f = inflight && p < 1 ? inflight.from.get(s.key) : undefined;
    if (f) {
      x0 = lerp(f.x0, s.x0, p);
      x1 = lerp(f.x1, s.x1, p);
      a = lerp(f.a, 1, p);
    }
    shown.set(s.key, { x0: (x0 - view.x0) / span, x1: (x1 - view.x0) / span, a });
  }

  const into = (child: Segment, parent: Segment, parentPos: Pos): Pos => {
    const ps = parent.x1 - parent.x0;
    const r0 = ps > 0 ? (child.x0 - parent.x0) / ps : 0;
    const r1 = ps > 0 ? (child.x1 - parent.x0) / ps : 0;
    const w = parentPos.x1 - parentPos.x0;
    return { x0: parentPos.x0 + r0 * w, x1: parentPos.x0 + r1 * w, a: 0 };
  };

  const from = new Map<string, Pos>();
  for (const s of next.segments) {
    const cur = shown.get(s.key);
    if (cur) {
      from.set(s.key, cur);
      continue;
    }
    const parentPos = s.parent ? from.get(s.parent.key) : undefined;
    from.set(s.key, s.parent && parentPos ? into(s, s.parent, parentPos) : { x0: s.x0, x1: s.x1, a: 0 });
  }

  const exiting: Morph["exiting"] = [];
  for (const s of prev.segments) {
    if (next.byKey.has(s.key) || s.depth - view.d < 1) continue;
    const cur = shown.get(s.key)!;
    if (cur.a < 0.02 || cur.x1 <= 0 || cur.x0 >= 1) continue;
    let to: Pos = { ...cur, a: 0 };
    const parentNow = s.parent ? shown.get(s.parent.key) : undefined;
    const parentNext = s.parent ? next.byKey.get(s.parent.key) : undefined;
    if (parentNow && parentNext && parentNow.x1 > parentNow.x0) {
      // Keep its relative place inside the parent while the parent moves.
      const w = parentNow.x1 - parentNow.x0;
      const r0 = (cur.x0 - parentNow.x0) / w;
      const r1 = (cur.x1 - parentNow.x0) / w;
      const nw = parentNext.x1 - parentNext.x0;
      to = { x0: parentNext.x0 + r0 * nw, x1: parentNext.x0 + r1 * nw, a: 0 };
    }
    exiting.push({ seg: { ...s, depth: s.depth - view.d }, from: cur, to });
  }
  return { start: now, from, exiting };
}

/** Segment under the point (CSS px relative to the canvas), assuming the identity view. */
export function hitTest(lay: Layout, g: Geom, x: number, y: number): Segment | null {
  const dx = x - g.cx;
  const dy = y - g.cy;
  const r = Math.hypot(dx, dy);
  if (r <= g.r0) return lay.segments[0] ?? null;
  if (r > g.R) return null;
  const depth = Math.floor((r - g.r0) / g.ringW) + 1;
  const list = lay.byDepth[depth];
  if (!list || list.length === 0) return null;
  let a = Math.atan2(dy, dx) + TAU / 4;
  if (a < 0) a += TAU;
  const f = a / TAU;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = list[mid];
    if (f < s.x0) hi = mid - 1;
    else if (f >= s.x1) lo = mid + 1;
    else return s;
  }
  return null;
}

// ---------------------------------------------------------------- colors ----

export interface Palette {
  dark: boolean;
  center: [number, number, number];
  separator: string;
  highlight: string;
}

type RGB = [number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** OKLCH → sRGB (0–255). Perceptually even: every hue gets the same lightness. */
function oklch(L: number, C: number, hueDeg: number): RGB {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((x) => {
    const v = clamp(x, 0, 1);
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  }) as RGB;
}

/**
 * Like Baobab: the hue follows the angular position of a segment, so the
 * children of a folder stay in its hue family and colors move smoothly while
 * zooming. Deeper rings get lighter (light theme) or darker (dark theme).
 * Files use a muted tone of the same hue; "smaller items" are neutral gray.
 */
export function segmentRGB(s: Segment, view: View, p: Palette, hovered: boolean): RGB {
  const ring = s.depth - view.d;
  let rgb: RGB;
  if (s.kind === "other") {
    rgb = p.dark ? [58, 59, 64] : [222, 223, 228];
  } else {
    const span = view.x1 - view.x0 || 1;
    const mid = clamp(((s.x0 + s.x1) / 2 - view.x0) / span, 0, 1);
    const hue = 150 + mid * 360;
    const level = Math.max(0, ring - 1);
    if (s.kind === "dir") {
      rgb = p.dark
        ? oklch(clamp(0.7 - level * 0.045, 0.42, 0.72), clamp(0.135 - level * 0.012, 0.06, 0.14), hue)
        : oklch(clamp(0.68 + level * 0.04, 0.6, 0.9), clamp(0.15 - level * 0.014, 0.06, 0.15), hue);
    } else {
      rgb = p.dark
        ? oklch(clamp(0.5 - level * 0.025, 0.36, 0.52), 0.028, hue)
        : oklch(clamp(0.83 + level * 0.018, 0.8, 0.93), 0.032, hue);
    }
  }
  if (hovered) {
    const t = p.dark ? 0.22 : 0.3;
    rgb = [rgb[0] + (255 - rgb[0]) * t, rgb[1] + (255 - rgb[1]) * t, rgb[2] + (255 - rgb[2]) * t];
  }
  if (ring < 1) {
    // Fading into the center disc during a zoom animation.
    const t = clamp(ring, 0, 1);
    rgb = [
      p.center[0] + (rgb[0] - p.center[0]) * t,
      p.center[1] + (rgb[1] - p.center[1]) * t,
      p.center[2] + (rgb[2] - p.center[2]) * t,
    ];
  }
  return rgb;
}

export function css(rgb: RGB): string {
  return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
}

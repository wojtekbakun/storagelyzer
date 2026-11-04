import { formatBytes } from "../format";
import { TAU, easeOut, type Geom } from "./layout";

// What is inside the hovered folder: a line from each of its biggest items to a
// small label with the item's name and size, in a column left or right of the
// chart.

export const LABEL_H = 20;
/** Label height plus the space between two labels. */
const PITCH = LABEL_H + 4;
/** The label columns keep this far from the chart's outer edge... */
const GAP = 10;
/** ...and from the edges of the pane. */
const EDGE = 8;
const MAX_LABELS = 10;
const FADE_IN_MS = 180;
const FADE_OUT_MS = 140;
/** Smoothing time constant when labels make room for each other. */
const GLIDE_MS = 80;

const PAD_L = 19; // swatch and the space after it
const PAD_R = 8;
const SPACE = 6; // between the name and the size
const nameFont = (family: string) => `600 11.5px ${family}`;
const sizeFont = (family: string) => `500 11.5px ${family}`;

/** A child of the hovered segment, as it is drawn right now. */
export interface Kid {
  key: string;
  name: string;
  size: number;
  /** Canvas angles of the drawn arc and the radii of its ring. */
  a0: number;
  a1: number;
  inner: number;
  outer: number;
  color: string;
}

export interface CalloutStyle {
  font: string;
  text: string;
  text2: string;
  fill: string;
  border: string;
  leader: string;
  halo: string;
}

interface Placed {
  kid: Kid;
  side: 1 | -1;
  /** Where the line starts (on the item's arc), its direction and distance from the center. */
  ax: number;
  ay: number;
  cos: number;
  sin: number;
  r: number;
  /** The label: its edge facing the chart, its middle, its width and texts. */
  lx: number;
  ly: number;
  w: number;
  name: string;
  nameW: number;
  size: string;
}

interface Callout extends Placed {
  /** Where the line turns towards its label. */
  ex: number;
  ey: number;
  alpha: number;
}

export interface CalloutState {
  /** Segment the labels belong to. */
  key: string | null;
  last: number;
  shown: Map<string, { x: number; y: number; a: number; side: 1 | -1 }>;
  drawn: Callout[];
  /** Labels of the segment the pointer just left, fading out. */
  fading: Callout[];
  fadeStart: number | null;
}

export const newCalloutState = (): CalloutState => ({
  key: null,
  last: 0,
  shown: new Map(),
  drawn: [],
  fading: [],
  fadeStart: null,
});

/** Drops everything at once (zooming, new data): no fading over a moving chart. */
export function resetCallouts(st: CalloutState): void {
  st.key = null;
  st.shown.clear();
  st.drawn = [];
  st.fading = [];
  st.fadeStart = null;
}

export interface CalloutEnv {
  g: Geom;
  width: number;
  height: number;
  style: CalloutStyle;
  /** Space to keep free at the top of the left side (the "Up" button)... */
  topLeft: number;
  /** ...and at the bottom (a note under the chart). */
  bottom: number;
}

/**
 * Draws the labels for the children of segment `key` and returns true while
 * they still fade or glide (the caller keeps drawing frames).
 */
export function paintCallouts(
  ctx: CanvasRenderingContext2D,
  st: CalloutState,
  key: string | null,
  kids: Kid[],
  now: number,
  env: CalloutEnv,
): boolean {
  if (key !== st.key) {
    if (st.drawn.length) {
      st.fading = st.drawn;
      st.fadeStart = now;
    }
    st.key = key;
    st.shown.clear();
  }
  const dt = Math.min(64, Math.max(0, now - st.last));
  st.last = now;
  const glide = 1 - Math.exp(-dt / GLIDE_MS);
  let busy = false;

  const list: Callout[] = [];
  const keep = new Set<string>();
  for (const p of place(ctx, kids, env)) {
    keep.add(p.kid.key);
    let s = st.shown.get(p.kid.key);
    if (!s || s.side !== p.side) {
      s = { x: p.lx, y: p.ly, a: 0, side: p.side };
      st.shown.set(p.kid.key, s);
    } else {
      s.x = approach(s.x, p.lx, glide);
      s.y = approach(s.y, p.ly, glide);
      s.a = Math.min(1, s.a + dt / FADE_IN_MS);
    }
    if (s.a < 1 || s.x !== p.lx || s.y !== p.ly) busy = true;
    const [ex, ey] = elbow(env.g, p, s.x, s.y);
    list.push({ ...p, lx: s.x, ly: s.y, ex, ey, alpha: easeOut(s.a) });
  }
  for (const k of [...st.shown.keys()]) if (!keep.has(k)) st.shown.delete(k);

  if (list.length > 0) {
    st.fading = [];
    st.fadeStart = null;
  } else if (st.fadeStart !== null) {
    const t = (now - st.fadeStart) / FADE_OUT_MS;
    if (t >= 1) {
      st.fading = [];
      st.fadeStart = null;
    } else {
      draw(ctx, st.fading, env.style, 1 - t);
      busy = true;
    }
  }
  draw(ctx, list, env.style, 1);
  st.drawn = list;
  return busy;
}

const approach = (v: number, target: number, k: number) => (Math.abs(target - v) < 0.3 ? target : v + (target - v) * k);

/**
 * The biggest children wide enough to point at, each with a label in the
 * column on its side of the chart: just outside the rings when the pane has
 * room, otherwise at the pane's edge (over the outer rings).
 */
function place(ctx: CanvasRenderingContext2D, kids: Kid[], env: CalloutEnv): Placed[] {
  const { g, width, height } = env;
  const maxNameW = Math.min(170, Math.max(70, width * 0.2));
  const picked = kids
    .filter((k) => (k.a1 - k.a0) * k.outer >= 2)
    .sort((a, b) => b.size - a.size)
    .slice(0, MAX_LABELS)
    .map((kid) => {
      const mid = (kid.a0 + kid.a1) / 2;
      const cos = Math.cos(mid);
      const sin = Math.sin(mid);
      const r = (kid.inner + kid.outer) / 2;
      const side: 1 | -1 = cos >= 0 ? 1 : -1;
      return { kid, side, ax: g.cx + r * cos, ay: g.cy + r * sin, cos, sin, r, wish: g.cy + (g.R + GAP) * sin };
    });
  const out: Placed[] = [];
  for (const side of [1, -1] as const) {
    const list = picked.filter((t) => t.side === side).sort((a, b) => a.wish - b.wish);
    if (list.length === 0) continue;
    const labels = list.map((t) => measureLabel(ctx, env.style.font, t.kid.name, formatBytes(t.kid.size), maxNameW));
    const widest = Math.max(...labels.map((l) => l.w));
    const lx = side > 0 ? Math.min(g.cx + g.R + GAP, width - EDGE - widest) : Math.max(g.cx - g.R - GAP, EDGE + widest);
    const ys = spread(
      list.map((t) => t.wish),
      PITCH,
      (side < 0 ? Math.max(EDGE, env.topLeft) : EDGE) + LABEL_H / 2,
      height - Math.max(EDGE, env.bottom) - LABEL_H / 2,
    );
    list.forEach(({ wish: _, ...t }, i) => out.push({ ...t, ...labels[i], lx, ly: ys[i] }));
  }
  return out;
}

/**
 * Moves wished positions (ascending) at least `pitch` apart inside [lo, hi],
 * each as little as possible: labels that would overlap are stacked around the
 * average of their wishes.
 */
export function spread(wish: number[], pitch: number, lo: number, hi: number): number[] {
  const n = wish.length;
  if (n === 0) return [];
  const p = n > 1 ? Math.min(pitch, Math.max(0, hi - lo) / (n - 1)) : pitch;
  const stacks: { n: number; y: number }[] = [];
  for (const w of wish) {
    let s = { n: 1, y: w };
    let prev = stacks[stacks.length - 1];
    while (prev && prev.y + prev.n * p > s.y) {
      stacks.pop();
      s = { n: prev.n + s.n, y: (prev.y * prev.n + (s.y - prev.n * p) * s.n) / (prev.n + s.n) };
      prev = stacks[stacks.length - 1];
    }
    stacks.push(s);
  }
  const out: number[] = [];
  for (const s of stacks) for (let k = 0; k < s.n; k++) out.push(s.y + k * p);
  out[0] = Math.max(out[0], lo);
  for (let i = 1; i < n; i++) out[i] = Math.max(out[i], out[i - 1] + p);
  out[n - 1] = Math.min(out[n - 1], hi);
  for (let i = n - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - p);
  return out;
}

/**
 * Where the line turns towards its label (lx, ly). Every choice keeps the line
 * between the item and the column, so it never runs under another label:
 * - straight out of the item to the label's height, then across — stacked
 *   labels keep the order of their items, so these lines never cross;
 * - otherwise a turn just outside the chart, then on to the label;
 * - when the column covers the rings there (a narrow pane), a straight line.
 */
function elbow(g: Geom, p: Placed, lx: number, ly: number): [number, number] {
  if (Math.abs(p.sin) > 0.05) {
    const r = (ly - g.cy) / p.sin;
    const x = g.cx + r * p.cos;
    if (r >= p.r && r <= g.R + 60 && p.side * (lx - x) >= 6) return [x, ly];
  }
  const ex = g.cx + (g.R + 4) * p.cos;
  if (p.side * (lx - ex) >= 6) return [ex, g.cy + (g.R + 4) * p.sin];
  return [p.ax, p.ay];
}

function measureLabel(ctx: CanvasRenderingContext2D, family: string, name: string, size: string, maxNameW: number) {
  ctx.font = nameFont(family);
  let text = name;
  let nameW = ctx.measureText(text).width;
  if (nameW > maxNameW) {
    const chars = Array.from(name);
    let lo = 1;
    let hi = chars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(chars.slice(0, mid).join("") + "…").width <= maxNameW) lo = mid;
      else hi = mid - 1;
    }
    text = chars.slice(0, lo).join("").trimEnd() + "…";
    nameW = ctx.measureText(text).width;
  }
  ctx.font = sizeFont(family);
  const sizeW = ctx.measureText(size).width;
  return { name: text, nameW, size, w: Math.ceil(PAD_L + nameW + SPACE + sizeW + PAD_R) };
}

function draw(ctx: CanvasRenderingContext2D, list: Callout[], st: CalloutStyle, alpha: number): void {
  if (list.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const c of list) {
    const a = c.alpha * alpha;
    if (a < 0.01) continue;
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.moveTo(c.ax, c.ay);
    ctx.lineTo(c.ex, c.ey);
    ctx.lineTo(c.lx, c.ly);
    ctx.strokeStyle = st.halo;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = st.leader;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c.ax, c.ay, 2.5, 0, TAU);
    ctx.fillStyle = st.leader;
    ctx.fill();
    ctx.strokeStyle = st.halo;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const c of list) {
    const a = c.alpha * alpha;
    if (a < 0.01) continue;
    ctx.globalAlpha = a;
    const x = c.side > 0 ? c.lx : c.lx - c.w;
    roundRect(ctx, x + 0.5, c.ly - LABEL_H / 2 + 0.5, c.w - 1, LABEL_H - 1, 6);
    ctx.fillStyle = st.fill;
    ctx.fill();
    ctx.strokeStyle = st.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    roundRect(ctx, x + 7, c.ly - 3.5, 7, 7, 2);
    ctx.fillStyle = c.kid.color;
    ctx.fill();
    ctx.font = nameFont(st.font);
    ctx.fillStyle = st.text;
    ctx.fillText(c.name, x + PAD_L, c.ly + 0.5);
    ctx.font = sizeFont(st.font);
    ctx.fillStyle = st.text2;
    ctx.fillText(c.size, x + PAD_L + c.nameW + SPACE, c.ly + 0.5);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

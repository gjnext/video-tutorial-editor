/**
 * Highlights: shapes drawn over the recording to call out UI elements.
 * Every shape is converted here into `poly` draw ops (plain polylines /
 * polygons), including draw-on trimming, hand-drawn jitter and arrowheads, so
 * the preview and the native exporter render identical geometry.
 * See docs/COMPOSITION_SPEC.md §4.1.
 */
import type { Highlight, HighlightLine, HighlightShape } from './schema';
import { newId } from './schema';
import type { DrawOp } from './drawOps';
import { parseColor, withAlpha } from './color';
import { easeOutCubic } from './easing';
import { sourceToCanvas, type Size, type VideoPlacement } from './geometry';
import { msToFlicks, secondsToFlicks, type Flicks } from './time';

export const DEFAULT_HIGHLIGHT_DURATION: Flicks = secondsToFlicks(2.5);
export const INTRO_DURATION: Record<Highlight['intro'], Flicks> = { draw: msToFlicks(450), fade: msToFlicks(250), pop: msToFlicks(300), none: 0 };
export const OUTRO_DURATION: Flicks = msToFlicks(250);
/** Spotlight edge softness (fraction of canvas height) and layer count. */
export const SPOT_FEATHER = 0.018;
export const SPOT_FEATHER_STEPS = 6;

export const HIGHLIGHT_COLORS = ['#ff3b5c', '#ffcc00', '#3ad1bd', '#7380ff', '#ff8a3d', '#ffffff'];

export interface HighlightStyle {
  id: string;
  label: string;
  color: string;
  line: HighlightLine;
  thickness: number;
  fill: number;
  glow: boolean;
}

/** One-click looks. Applying a style keeps the shape, position and timing. */
export const HIGHLIGHT_STYLES: HighlightStyle[] = [
  { id: 'outline', label: 'Outline', color: '#ff3b5c', line: 'solid', thickness: 4, fill: 0, glow: false },
  { id: 'neon', label: 'Neon', color: '#3ad1bd', line: 'solid', thickness: 3.5, fill: 0.08, glow: true },
  { id: 'soft', label: 'Soft fill', color: '#ffcc00', line: 'solid', thickness: 2, fill: 0.22, glow: false },
  { id: 'dashed', label: 'Dashed', color: '#7380ff', line: 'dashed', thickness: 3.5, fill: 0, glow: false },
  { id: 'marker', label: 'Marker', color: '#ffcc00', line: 'marker', thickness: 5, fill: 0, glow: false },
  { id: 'sketch', label: 'Sketch', color: '#ff3b5c', line: 'sketch', thickness: 3.5, fill: 0, glow: false },
];

export const HIGHLIGHT_SHAPES: { id: HighlightShape; label: string; hint: string }[] = [
  { id: 'rect', label: 'Box', hint: 'Drag a box around a button or panel' },
  { id: 'ellipse', label: 'Circle', hint: 'Drag a circle around an element' },
  { id: 'underline', label: 'Underline', hint: 'Drag along text to underline it' },
  { id: 'arrow', label: 'Arrow', hint: 'Drag from the tail to the tip' },
  { id: 'spotlight', label: 'Spotlight', hint: 'Drag over the area to keep bright; the rest dims' },
];

const SHAPE_DEFAULTS: Record<HighlightShape, Partial<Highlight>> = {
  rect: {},
  ellipse: {},
  underline: { line: 'marker', thickness: 5 },
  arrow: { line: 'solid', thickness: 4.5, fill: 0 },
  spotlight: { line: 'solid', thickness: 0, fill: 0, glow: false },
};

export function createHighlight(shape: HighlightShape, box: { x: number; y: number; w: number; h: number }, start: Flicks, style: HighlightStyle = HIGHLIGHT_STYLES[0]): Highlight {
  return {
    id: newId('hl'),
    start,
    end: start + DEFAULT_HIGHLIGHT_DURATION,
    shape,
    ...box,
    color: style.color,
    line: style.line,
    thickness: style.thickness,
    fill: style.fill,
    glow: style.glow,
    cornerRadius: 0.008,
    dim: 0.55,
    intro: 'draw',
    ...SHAPE_DEFAULTS[shape],
  };
}

export function applyStyle(h: Highlight, s: HighlightStyle): Highlight {
  const lineShape = h.shape === 'underline' || h.shape === 'arrow';
  return { ...h, color: s.color, line: lineShape && s.line === 'marker' && h.shape === 'arrow' ? 'solid' : s.line, thickness: s.thickness, fill: lineShape ? 0 : s.fill, glow: s.glow };
}

export const isLineShape = (s: HighlightShape) => s === 'underline' || s === 'arrow';

// ---------------------------------------------------------------- geometry helpers

type Pt = [number, number];

function roundedRectPoints(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  // Start at the top edge (left end), clockwise; the last point closes the loop.
  if (rr < 0.5) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  const pts: Pt[] = [[x + rr, y]];
  const corners: [number, number, number][] = [
    [x + w - rr, y + rr, -Math.PI / 2],
    [x + w - rr, y + h - rr, 0],
    [x + rr, y + h - rr, Math.PI / 2],
    [x + rr, y + rr, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
  }
  pts.push([x + rr, y]);
  return pts;
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, n = 96): Pt[] {
  const pts: Pt[] = [];
  // Start at the top, clockwise; the last point closes the loop.
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

function pathLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** First `fraction` of a polyline by arc length. */
export function trimPolyline(pts: Pt[], fraction: number): Pt[] {
  if (fraction >= 1) return pts;
  if (fraction <= 0 || pts.length < 2) return pts.slice(0, 1);
  const target = pathLength(pts) * fraction;
  const out: Pt[] = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= target) {
      const f = seg > 0 ? (target - acc) / seg : 0;
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]);
      return out;
    }
    acc += seg;
    out.push(pts[i]);
  }
  return out;
}

/** Deterministic PRNG seeded from the highlight id (same jitter in preview and export). */
function seeded(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** Hand-drawn look: smooth low-frequency wobble along the path, resolution independent. */
function sketchify(pts: Pt[], amp: number, rand: () => number, overshoot: boolean): Pt[] {
  const L = pathLength(pts);
  const waves = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const out: Pt[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const u = L > 0 ? acc / L : 0;
    const dx = Math.sin(u * 6.28 * 2 + waves[0]) * 0.6 + Math.sin(u * 6.28 * 5 + waves[1]) * 0.4;
    const dy = Math.cos(u * 6.28 * 3 + waves[2]) * 0.6 + Math.sin(u * 6.28 * 7 + waves[0]) * 0.4;
    out.push([pts[i][0] + dx * amp, pts[i][1] + dy * amp]);
  }
  // Closed hand-drawn loops overshoot their start a little, like a pen stroke.
  if (overshoot && out.length > 8) out.push(...out.slice(1, Math.max(2, Math.round(out.length * 0.08))).map(([x, y]) => [x + amp * 0.8, y - amp * 0.5] as Pt));
  return out;
}

/** Densify a 2-point line so trimming/sketching looks smooth. */
function lineSamples(a: Pt, b: Pt, n = 32): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as Pt);
}

const flat = (pts: Pt[]) => pts.flatMap((p) => [p[0], p[1]]);

// ---------------------------------------------------------------- evaluation

export interface HighlightPhase {
  /** 0..1 progress of the intro animation. */
  intro: number;
  /** 0..1 overall opacity (intro fade × outro fade). */
  alpha: number;
}

export function highlightPhase(h: Highlight, t: Flicks): HighlightPhase | null {
  if (t < h.start || t >= h.end) return null;
  const dIn = INTRO_DURATION[h.intro] ?? 0;
  const intro = dIn > 0 ? Math.min(1, (t - h.start) / dIn) : 1;
  const out = Math.min(OUTRO_DURATION, (h.end - h.start) / 2);
  const outro = out > 0 ? Math.min(1, (h.end - t) / out) : 1;
  const inAlpha = h.intro === 'fade' || h.intro === 'pop' ? easeOutCubic(intro) : h.intro === 'draw' ? Math.min(1, intro * 3) : 1;
  return { intro, alpha: Math.max(0, Math.min(1, inAlpha * outro)) };
}

/** Draw ops for all highlights visible at t, in canvas pixels (drawn clipped to the video). */
export function highlightOps(highlights: Highlight[], t: Flicks, placement: VideoPlacement, canvas: Size): DrawOp[] {
  const ops: DrawOp[] = [];
  const active = highlights.filter((h) => t >= h.start && t < h.end).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  // Spotlights first so outlines/arrows remain bright on top of the dimming.
  for (const h of [...active.filter((x) => x.shape === 'spotlight'), ...active.filter((x) => x.shape !== 'spotlight')]) {
    const ph = highlightPhase(h, t)!;
    ops.push(...shapeOps(h, ph, placement, canvas));
  }
  return ops;
}

function shapeOps(h: Highlight, ph: HighlightPhase, placement: VideoPlacement, canvas: Size): DrawOp[] {
  const H = canvas.height;
  const c0 = sourceToCanvas({ x: h.x, y: h.y }, placement);
  const c1 = sourceToCanvas({ x: h.x + h.w, y: h.y + h.h }, placement);
  const color = parseColor(h.color);
  const lw = Math.max(0, (h.thickness / 1000) * H);
  const rand = seeded(h.id);
  const ops: DrawOp[] = [];
  const pop = h.intro === 'pop' ? 0.85 + 0.15 * easeOutCubic(ph.intro) : 1;
  const drawP = h.intro === 'draw' ? easeOutCubic(ph.intro) : 1;

  // Box in canvas px (normalized so w,h ≥ 0), with the pop scale about its center.
  let bx = Math.min(c0.x, c1.x);
  let by = Math.min(c0.y, c1.y);
  let bw = Math.abs(c1.x - c0.x);
  let bh = Math.abs(c1.y - c0.y);
  if (pop !== 1) {
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    bw *= pop;
    bh *= pop;
    bx = cx - bw / 2;
    by = cy - bh / 2;
  }
  const radius = h.cornerRadius * H;

  /** Soft light around the line: a wide translucent halo stroke (plus a blurred glow). */
  const halo = (pts: Pt[], closed: boolean): DrawOp | null =>
    h.glow && ph.alpha > 0 && lw > 0
      ? { op: 'poly', points: flat(pts), closed, stroke: withAlpha(color, 0.22 * ph.alpha), lineWidth: lineStyle(h.line, lw).width * 3.4, cap: 'round', join: 'round' }
      : null;
  const strokeProps = (alphaMul = 1) => {
    const st = lineStyle(h.line, lw);
    return {
      stroke: withAlpha(color, ph.alpha * st.alpha * alphaMul),
      lineWidth: st.width,
      dash: st.dash,
      cap: st.cap,
      join: st.join,
      glow: h.glow && ph.alpha > 0 ? { blur: Math.max(6, lw * 4), offsetX: 0, offsetY: 0, color: withAlpha(color, ph.alpha) } : undefined,
    } as const;
  };

  if (h.shape === 'spotlight') {
    const hole = roundedRectPoints(bx, by, bw, bh, radius);
    const d = placement.dest;
    // Cover the whole video; even-odd holes keep the element bright. The edge is
    // feathered by stacking N layers whose holes grow outward, each with alpha a
    // so that 1 − (1 − a)^N = dim far from the element.
    const outer = flat([[d.x - 2, d.y - 2], [d.x + d.w + 2, d.y - 2], [d.x + d.w + 2, d.y + d.h + 2], [d.x - 2, d.y + d.h + 2]]);
    const dim = Math.max(0, Math.min(0.95, h.dim * ph.alpha));
    const N = SPOT_FEATHER_STEPS;
    const feather = SPOT_FEATHER * H;
    const a = 1 - Math.pow(1 - dim, 1 / N);
    for (let i = 0; i < N; i++) {
      const g = (feather * i) / (N - 1);
      ops.push({ op: 'poly', points: outer, closed: true, holes: [flat(roundedRectPoints(bx - g, by - g, bw + 2 * g, bh + 2 * g, radius + g))], fill: [0, 0, 0, a] });
    }
    if (lw > 0) ops.push({ op: 'poly', points: flat(trimPolyline(hole, drawP)), closed: drawP >= 1, ...strokeProps() });
    return ops;
  }

  if (h.shape === 'rect' || h.shape === 'ellipse') {
    let pts = h.shape === 'rect' ? roundedRectPoints(bx, by, bw, bh, radius) : ellipsePoints(bx + bw / 2, by + bh / 2, bw / 2, bh / 2);
    const closedFull = drawP >= 1 && h.line !== 'sketch';
    if (h.fill > 0) ops.push({ op: 'poly', points: flat(pts), closed: true, fill: withAlpha(color, h.fill * ph.alpha * (h.intro === 'draw' ? drawP : 1)) });
    if (h.line === 'sketch') {
      pts = sketchify(pts, Math.max(1.5, lw * 0.95), rand, true);
      ops.push({ op: 'poly', points: flat(trimPolyline(pts, drawP)), closed: false, ...strokeProps() });
      // A second, lighter pass makes it read as pen-drawn.
      const second = sketchify(pts, Math.max(1, lw * 0.55), rand, false);
      ops.push({ op: 'poly', points: flat(trimPolyline(second, drawP)), closed: false, ...strokeProps(0.45), glow: undefined });
    } else if (lw > 0) {
      const part = trimPolyline(pts, drawP);
      const hal = halo(part, closedFull);
      if (hal) ops.push(hal);
      ops.push({ op: 'poly', points: flat(part), closed: closedFull, ...strokeProps() });
    }
    return ops;
  }

  // Lines: underline / arrow from c0 → c1 (with pop scaling around the midpoint).
  let a: Pt = [c0.x, c0.y];
  let b: Pt = [c1.x, c1.y];
  if (pop !== 1) {
    const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    a = [m[0] + (a[0] - m[0]) * pop, m[1] + (a[1] - m[1]) * pop];
    b = [m[0] + (b[0] - m[0]) * pop, m[1] + (b[1] - m[1]) * pop];
  }
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1) return ops;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  if (h.shape === 'underline') {
    let pts = lineSamples(a, b);
    if (h.line === 'sketch') pts = sketchify(pts, Math.max(1.2, lw * 0.8), rand, false);
    const part = trimPolyline(pts, drawP);
    const hal = halo(part, false);
    if (hal) ops.push(hal);
    ops.push({ op: 'poly', points: flat(part), closed: false, ...strokeProps() });
    return ops;
  }
  // Arrow: shaft draws first (75 %), then the head appears.
  const st = lineStyle(h.line, lw);
  const head = Math.max(st.width * 3.2, H * 0.012);
  const shaftEnd: Pt = [b[0] - ux * head * 0.6, b[1] - uy * head * 0.6];
  let shaft = lineSamples(a, shaftEnd);
  if (h.line === 'sketch') shaft = sketchify(shaft, Math.max(1.2, lw * 0.8), rand, false);
  const shaftP = Math.min(1, drawP / 0.75);
  const shaftHalo = halo(trimPolyline(shaft, shaftP), false);
  if (shaftHalo) ops.push(shaftHalo);
  ops.push({ op: 'poly', points: flat(trimPolyline(shaft, shaftP)), closed: false, ...strokeProps(), dash: h.line === 'dashed' || h.line === 'dotted' ? st.dash : undefined });
  const headP = h.intro === 'draw' ? Math.max(0, (drawP - 0.75) / 0.25) : 1;
  if (headP > 0) {
    const s = head * (0.6 + 0.4 * headP);
    const px = -uy;
    const py = ux;
    const tip: Pt = [b[0], b[1]];
    const left: Pt = [b[0] - ux * s + px * s * 0.62, b[1] - uy * s + py * s * 0.62];
    const right: Pt = [b[0] - ux * s - px * s * 0.62, b[1] - uy * s - py * s * 0.62];
    ops.push({ op: 'poly', points: flat([tip, left, right]), closed: true, fill: withAlpha(color, ph.alpha * st.alpha * headP), stroke: withAlpha(color, ph.alpha * st.alpha * headP), lineWidth: Math.max(1, st.width * 0.5), join: 'round', glow: strokeProps().glow });
  }
  return ops;
}

function lineStyle(line: HighlightLine, lw: number): { width: number; alpha: number; dash?: number[]; cap: 'butt' | 'round'; join: 'miter' | 'round' } {
  switch (line) {
    case 'dashed':
      return { width: lw, alpha: 1, dash: [lw * 3, lw * 2], cap: 'butt', join: 'round' };
    case 'dotted':
      return { width: lw, alpha: 1, dash: [0.001, lw * 2.2], cap: 'round', join: 'round' };
    case 'marker':
      // Highlighter pen: wide, translucent, rounded.
      return { width: lw * 2.6, alpha: 0.45, cap: 'round', join: 'round' };
    case 'sketch':
      return { width: lw, alpha: 0.95, cap: 'round', join: 'round' };
    default:
      return { width: lw, alpha: 1, cap: 'round', join: 'round' };
  }
}

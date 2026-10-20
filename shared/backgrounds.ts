/**
 * Built-in procedural backgrounds. Original designs, defined as data and
 * compiled to primitive draw ops, so they render identically (and sharply)
 * at any resolution in both the preview and the exporter. No bitmaps needed.
 */
import type { Background, GradientStop, MediaAsset } from './schema';
import type { DrawOp } from './drawOps';
import { parseColor } from './color';
import { coverSourceRect, type Size } from './geometry';

interface Blob {
  x: number;
  y: number;
  /** Radius as a fraction of the canvas diagonal. */
  r: number;
  color: string;
  alpha: number;
}

type Pattern =
  | { kind: 'grid'; spacing: number; color: string; alpha: number }
  | { kind: 'dots'; spacing: number; radius: number; color: string; alpha: number }
  | { kind: 'rings'; cx: number; cy: number; count: number; spacing: number; color: string; alpha: number }
  | { kind: 'bands'; angle: number; count: number; color: string; alpha: number };

export interface BackgroundPreset {
  id: string;
  name: string;
  category: 'Dark' | 'Pastel' | 'Neutral' | 'Colorful' | 'Geometric' | 'Warm';
  angle: number;
  stops: GradientStop[];
  blobs?: Blob[];
  pattern?: Pattern;
}

const s = (color: string, pos: number): GradientStop => ({ color, pos });

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'aurora-violet',
    name: 'Aurora Violet',
    category: 'Dark',
    angle: 135,
    stops: [s('#17123d', 0), s('#261a63', 0.55), s('#33237f', 1)],
    blobs: [
      { x: 0.12, y: 0.18, r: 0.55, color: '#6c5cff', alpha: 0.55 },
      { x: 0.92, y: 0.88, r: 0.6, color: '#b46bff', alpha: 0.42 },
      { x: 0.88, y: 0.08, r: 0.35, color: '#3aa7ff', alpha: 0.28 },
    ],
  },
  {
    id: 'midnight-indigo',
    name: 'Midnight Indigo',
    category: 'Dark',
    angle: 160,
    stops: [s('#0a0f24', 0), s('#121a3f', 1)],
    blobs: [
      { x: 0.5, y: -0.1, r: 0.6, color: '#3f51d9', alpha: 0.45 },
      { x: 0.05, y: 1.0, r: 0.45, color: '#5b2fc2', alpha: 0.3 },
    ],
  },
  {
    id: 'blue-violet-soft',
    name: 'Blue Violet',
    category: 'Colorful',
    angle: 120,
    stops: [s('#4b5cf0', 0), s('#7a5af5', 0.5), s('#a77bf3', 1)],
    blobs: [
      { x: 0.2, y: 0.85, r: 0.5, color: '#38bdf8', alpha: 0.35 },
      { x: 0.85, y: 0.15, r: 0.45, color: '#f0abfc', alpha: 0.3 },
    ],
  },
  {
    id: 'lavender-mist',
    name: 'Lavender Mist',
    category: 'Pastel',
    angle: 140,
    stops: [s('#ece8ff', 0), s('#f6eaf6', 1)],
    blobs: [
      { x: 0.1, y: 0.1, r: 0.45, color: '#c4b5fd', alpha: 0.55 },
      { x: 0.95, y: 0.9, r: 0.5, color: '#f9c6e4', alpha: 0.55 },
    ],
  },
  {
    id: 'sky-pastel',
    name: 'Sky Pastel',
    category: 'Pastel',
    angle: 180,
    stops: [s('#dfeeff', 0), s('#eef0ff', 1)],
    blobs: [
      { x: 0.85, y: 0.15, r: 0.45, color: '#a5c8ff', alpha: 0.6 },
      { x: 0.1, y: 0.95, r: 0.45, color: '#d6c8ff', alpha: 0.5 },
    ],
  },
  {
    id: 'mint-breeze',
    name: 'Mint Breeze',
    category: 'Pastel',
    angle: 135,
    stops: [s('#dcf7ee', 0), s('#d4ecff', 1)],
    blobs: [
      { x: 0.15, y: 0.2, r: 0.4, color: '#9ee6cc', alpha: 0.5 },
      { x: 0.9, y: 0.85, r: 0.45, color: '#a9d3ff', alpha: 0.45 },
    ],
  },
  {
    id: 'rose-quartz',
    name: 'Rose Quartz',
    category: 'Pastel',
    angle: 115,
    stops: [s('#f8d7dc', 0), s('#d9d5f2', 0.6), s('#b9c9ec', 1)],
  },
  {
    id: 'peach-sorbet',
    name: 'Peach Sorbet',
    category: 'Warm',
    angle: 135,
    stops: [s('#ffe2cf', 0), s('#ffc6bd', 0.5), s('#f8b3d0', 1)],
    blobs: [{ x: 0.85, y: 0.1, r: 0.4, color: '#fff2c4', alpha: 0.6 }],
  },
  {
    id: 'citrus-glow',
    name: 'Citrus Glow',
    category: 'Warm',
    angle: 150,
    stops: [s('#fff4c9', 0), s('#ffd99a', 0.55), s('#ffbe86', 1)],
    blobs: [{ x: 0.1, y: 0.9, r: 0.45, color: '#ff9e7a', alpha: 0.35 }],
  },
  {
    id: 'sunset-blend',
    name: 'Sunset Blend',
    category: 'Colorful',
    angle: 125,
    stops: [s('#ff8a65', 0), s('#ff5e98', 0.5), s('#8f5cff', 1)],
    blobs: [{ x: 0.1, y: 0.1, r: 0.4, color: '#ffc46b', alpha: 0.35 }],
  },
  {
    id: 'royal-dusk',
    name: 'Royal Dusk',
    category: 'Colorful',
    angle: 145,
    stops: [s('#3a1c71', 0), s('#a24a83', 0.55), s('#f19a7c', 1)],
  },
  {
    id: 'dusk-purple',
    name: 'Dusk Purple',
    category: 'Dark',
    angle: 170,
    stops: [s('#2b1055', 0), s('#5d5fb8', 0.65), s('#7f9be0', 1)],
  },
  {
    id: 'ocean-depth',
    name: 'Ocean Depth',
    category: 'Dark',
    angle: 155,
    stops: [s('#071f36', 0), s('#0c3e66', 1)],
    blobs: [
      { x: 0.85, y: 0.2, r: 0.45, color: '#22b8cf', alpha: 0.32 },
      { x: 0.1, y: 0.95, r: 0.4, color: '#3b5bdb', alpha: 0.3 },
    ],
  },
  {
    id: 'emerald-night',
    name: 'Emerald Night',
    category: 'Dark',
    angle: 145,
    stops: [s('#04201e', 0), s('#0a3f3a', 1)],
    blobs: [
      { x: 0.2, y: 0.15, r: 0.45, color: '#14b8a6', alpha: 0.3 },
      { x: 0.9, y: 0.9, r: 0.45, color: '#22c55e', alpha: 0.2 },
    ],
  },
  {
    id: 'graphite',
    name: 'Graphite',
    category: 'Neutral',
    angle: 180,
    stops: [s('#24262c', 0), s('#17181c', 1)],
    blobs: [{ x: 0.5, y: 0.0, r: 0.55, color: '#4a4f5c', alpha: 0.35 }],
  },
  {
    id: 'charcoal-glow',
    name: 'Charcoal Glow',
    category: 'Neutral',
    angle: 180,
    stops: [s('#121317', 0), s('#0c0d10', 1)],
    blobs: [{ x: 0.5, y: 1.05, r: 0.55, color: '#4c5bd4', alpha: 0.3 }],
  },
  {
    id: 'slate-blue',
    name: 'Slate Blue',
    category: 'Neutral',
    angle: 160,
    stops: [s('#334155', 0), s('#1e293b', 1)],
    blobs: [{ x: 0.9, y: 0.1, r: 0.45, color: '#60a5fa', alpha: 0.22 }],
  },
  {
    id: 'paper-white',
    name: 'Paper White',
    category: 'Neutral',
    angle: 180,
    stops: [s('#f7f8fa', 0), s('#e8ebf0', 1)],
  },
  {
    id: 'warm-stone',
    name: 'Warm Stone',
    category: 'Neutral',
    angle: 160,
    stops: [s('#eeebe7', 0), s('#d9d4ce', 1)],
  },
  {
    id: 'product-blue',
    name: 'Product Blue',
    category: 'Colorful',
    angle: 135,
    stops: [s('#2556f5', 0), s('#4f86ff', 0.6), s('#7db4ff', 1)],
    blobs: [{ x: 0.85, y: 0.1, r: 0.4, color: '#ffffff', alpha: 0.22 }],
  },
  {
    id: 'blueprint-grid',
    name: 'Blueprint Grid',
    category: 'Geometric',
    angle: 160,
    stops: [s('#0d1b3d', 0), s('#14295a', 1)],
    blobs: [{ x: 0.5, y: 0.5, r: 0.5, color: '#2f5bd3', alpha: 0.25 }],
    pattern: { kind: 'grid', spacing: 0.05, color: '#8fb0ff', alpha: 0.09 },
  },
  {
    id: 'dots-light',
    name: 'Dot Grid Light',
    category: 'Geometric',
    angle: 180,
    stops: [s('#f5f6fb', 0), s('#e9ecf6', 1)],
    pattern: { kind: 'dots', spacing: 0.035, radius: 0.0022, color: '#6b7aa6', alpha: 0.28 },
  },
  {
    id: 'dots-dark',
    name: 'Dot Grid Dark',
    category: 'Geometric',
    angle: 180,
    stops: [s('#15161c', 0), s('#0f1015', 1)],
    blobs: [{ x: 0.2, y: 0.1, r: 0.45, color: '#5a4fcf', alpha: 0.28 }],
    pattern: { kind: 'dots', spacing: 0.035, radius: 0.0022, color: '#c7cbe0', alpha: 0.16 },
  },
  {
    id: 'violet-rings',
    name: 'Violet Rings',
    category: 'Geometric',
    angle: 140,
    stops: [s('#21184f', 0), s('#3a2a86', 1)],
    pattern: { kind: 'rings', cx: 0.82, cy: 0.18, count: 14, spacing: 0.06, color: '#c7b8ff', alpha: 0.09 },
  },
  {
    id: 'soft-bands',
    name: 'Soft Bands',
    category: 'Geometric',
    angle: 135,
    stops: [s('#e6ecff', 0), s('#f3e9ff', 1)],
    pattern: { kind: 'bands', angle: 35, count: 7, color: '#ffffff', alpha: 0.35 },
  },
  {
    id: 'aurora-green',
    name: 'Northern Lights',
    category: 'Dark',
    angle: 180,
    stops: [s('#06141c', 0), s('#0b2230', 1)],
    blobs: [
      { x: 0.25, y: 0.1, r: 0.5, color: '#2dd4bf', alpha: 0.3 },
      { x: 0.75, y: 0.0, r: 0.45, color: '#818cf8', alpha: 0.28 },
    ],
  },
];

export const BACKGROUND_PRESET_MAP = new Map(BACKGROUND_PRESETS.map((b) => [b.id, b]));

/** CSS gradient-line endpoints for an angle (0° = to top, 90° = to right). */
export function linearGradientPoints(angleDeg: number, w: number, h: number) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  return { x0: cx - (dx * len) / 2, y0: cy - (dy * len) / 2, x1: cx + (dx * len) / 2, y1: cy + (dy * len) / 2 };
}

function stopsOps(stops: GradientStop[]) {
  const sorted = stops.slice().sort((a, b) => a.pos - b.pos);
  return sorted.map((st) => ({ pos: Math.min(1, Math.max(0, st.pos)), color: parseColor(st.color) }));
}

function presetOps(p: BackgroundPreset, size: Size): DrawOp[] {
  const { width: w, height: h } = size;
  const ops: DrawOp[] = [{ op: 'linear', ...linearGradientPoints(p.angle, w, h), stops: stopsOps(p.stops) }];
  const diag = Math.hypot(w, h);
  for (const b of p.blobs ?? []) {
    const c = parseColor(b.color);
    ops.push({
      op: 'radial',
      cx: b.x * w,
      cy: b.y * h,
      r: b.r * diag,
      stops: [
        { pos: 0, color: [c[0], c[1], c[2], b.alpha] },
        { pos: 0.45, color: [c[0], c[1], c[2], b.alpha * 0.45] },
        { pos: 1, color: [c[0], c[1], c[2], 0] },
      ],
    });
  }
  const pat = p.pattern;
  if (pat) {
    const color = parseColor(pat.color, pat.alpha);
    if (pat.kind === 'grid') {
      const step = pat.spacing * h;
      const lw = Math.max(1, h / 1080);
      for (let x = (w % step) / 2; x <= w; x += step) ops.push({ op: 'line', x0: x, y0: 0, x1: x, y1: h, stroke: color, lineWidth: lw });
      for (let y = (h % step) / 2; y <= h; y += step) ops.push({ op: 'line', x0: 0, y0: y, x1: w, y1: y, stroke: color, lineWidth: lw });
    } else if (pat.kind === 'dots') {
      const step = pat.spacing * h;
      const r = pat.radius * h;
      for (let y = step / 2; y < h; y += step) for (let x = ((w % step) + step) / 2; x < w; x += step) ops.push({ op: 'circle', cx: x, cy: y, r, fill: color });
    } else if (pat.kind === 'rings') {
      const lw = Math.max(1, (1.5 * h) / 1080);
      for (let i = 1; i <= pat.count; i++) {
        ops.push({ op: 'circle', cx: pat.cx * w, cy: pat.cy * h, r: i * pat.spacing * h, stroke: color, lineWidth: lw });
      }
    } else if (pat.kind === 'bands') {
      // Wide soft diagonal bands built from very large circles' edges would be costly; use thick lines.
      const a = (pat.angle * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const L = diag;
      const step = diag / pat.count;
      for (let i = -pat.count; i <= pat.count; i += 2) {
        const ox = w / 2 + -dy * i * step;
        const oy = h / 2 + dx * i * step;
        ops.push({ op: 'line', x0: ox - dx * L, y0: oy - dy * L, x1: ox + dx * L, y1: oy + dy * L, stroke: color, lineWidth: step * 0.5 });
      }
    }
  }
  return ops;
}

/** Compile a project background to draw ops at a canvas pixel size. */
export function backgroundOps(bg: Background, size: Size, media: MediaAsset[]): DrawOp[] {
  switch (bg.kind) {
    case 'solid':
      return [{ op: 'fill', color: parseColor(bg.color) }];
    case 'gradient':
      return [{ op: 'linear', ...linearGradientPoints(bg.angle, size.width, size.height), stops: stopsOps(bg.stops) }];
    case 'image': {
      const a = media.find((m) => m.id === bg.assetId);
      const ops: DrawOp[] = [{ op: 'fill', color: [0.08, 0.08, 0.1, 1] }];
      if (a?.width && a?.height) {
        ops.push({
          op: 'image',
          assetId: a.id,
          src: coverSourceRect({ width: a.width, height: a.height }, size),
          dest: { x: 0, y: 0, w: size.width, h: size.height },
        });
      }
      return ops;
    }
    case 'preset':
    default: {
      const p = BACKGROUND_PRESET_MAP.get((bg as { id: string }).id) ?? BACKGROUND_PRESETS[0];
      return presetOps(p, size);
    }
  }
}

/** CSS approximation for small UI swatches only (not used for rendering). */
export function presetSwatchCss(p: BackgroundPreset): string {
  const lin = `linear-gradient(${p.angle}deg, ${p.stops.map((x) => `${x.color} ${x.pos * 100}%`).join(', ')})`;
  const blobs = (p.blobs ?? []).map((b) => {
    const c = parseColor(b.color);
    const rgb = `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`;
    return `radial-gradient(circle at ${b.x * 100}% ${b.y * 100}%, rgba(${rgb},${b.alpha}) 0%, rgba(${rgb},0) ${b.r * 160}%)`;
  });
  return [...blobs, lin].join(', ');
}

/**
 * Canvas 2D executor for shared DrawOps — the preview twin of the native
 * OpExecutor (native/Sources/studio-render/Draw.swift). Keep them in sync:
 * any rendering rule must be expressed in shared/ ops, not here.
 */
import type { ClipRect, DrawOp } from '../../shared/drawOps';
import { rgbaToCss } from '../../shared/color';
import { CURSOR_BOUNDS, CURSOR_THEMES } from '../../shared/cursorThemes';
import type { VideoDraw } from '../../shared/compose';

const pathCache = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

export type ImageLookup = (assetId: string) => CanvasImageSource | null;

export function runOps(ctx: CanvasRenderingContext2D, ops: DrawOp[], w: number, h: number, images?: ImageLookup) {
  for (const op of ops) runOp(ctx, op, w, h, images);
}

function gradientStops(g: CanvasGradient, stops: { pos: number; color: [number, number, number, number] }[]) {
  for (const s of stops) g.addColorStop(s.pos, rgbaToCss(s.color));
}

export function runOp(ctx: CanvasRenderingContext2D, op: DrawOp, w: number, h: number, images?: ImageLookup) {
  switch (op.op) {
    case 'fill':
      ctx.fillStyle = rgbaToCss(op.color);
      ctx.fillRect(0, 0, w, h);
      break;
    case 'linear': {
      const g = ctx.createLinearGradient(op.x0, op.y0, op.x1, op.y1);
      gradientStops(g, op.stops);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case 'radial': {
      const g = ctx.createRadialGradient(op.cx, op.cy, 0, op.cx, op.cy, op.r);
      gradientStops(g, op.stops);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case 'circle':
      ctx.beginPath();
      ctx.arc(op.cx, op.cy, Math.max(0, op.r), 0, Math.PI * 2);
      if (op.fill) {
        ctx.fillStyle = rgbaToCss(op.fill);
        ctx.fill();
      }
      if (op.stroke) {
        ctx.strokeStyle = rgbaToCss(op.stroke);
        ctx.lineWidth = op.lineWidth ?? 1;
        ctx.stroke();
      }
      break;
    case 'line':
      ctx.beginPath();
      ctx.moveTo(op.x0, op.y0);
      ctx.lineTo(op.x1, op.y1);
      ctx.strokeStyle = rgbaToCss(op.stroke);
      ctx.lineWidth = op.lineWidth;
      ctx.lineCap = 'butt';
      ctx.stroke();
      break;
    case 'image': {
      const img = images?.(op.assetId);
      if (img) ctx.drawImage(img, op.src.x, op.src.y, op.src.w, op.src.h, op.dest.x, op.dest.y, op.dest.w, op.dest.h);
      break;
    }
    case 'cursor':
      drawCursor(ctx, op);
      break;
  }
}

// Cursor is drawn as a group (layers composited, then shadow + alpha applied
// once), matching the native transparency-layer rendering.
let cursorCanvas: HTMLCanvasElement | null = null;
function drawCursor(ctx: CanvasRenderingContext2D, op: Extract<DrawOp, { op: 'cursor' }>) {
  const theme = CURSOR_THEMES[op.theme] ?? CURSOR_THEMES.macos;
  const s = op.scale;
  const b = CURSOR_BOUNDS;
  const cw = Math.ceil(b.w * s) + 2;
  const ch = Math.ceil(b.h * s) + 2;
  if (!cursorCanvas) cursorCanvas = document.createElement('canvas');
  if (cursorCanvas.width < cw || cursorCanvas.height < ch) {
    cursorCanvas.width = Math.max(cw, cursorCanvas.width);
    cursorCanvas.height = Math.max(ch, cursorCanvas.height);
  }
  const c = cursorCanvas.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  // Hotspot (0,0) sits at (-b.x, -b.y) units inside the offscreen canvas.
  c.setTransform(s, 0, 0, s, -b.x * s, -b.y * s);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  for (const l of theme.layers) {
    const p = path2d(l.d);
    if (l.stroke) {
      c.strokeStyle = l.stroke;
      c.lineWidth = l.lineWidth ?? 1;
      c.stroke(p);
    }
    if (l.fill) {
      c.fillStyle = l.fill;
      c.fill(p);
    }
  }
  ctx.save();
  ctx.globalAlpha = op.alpha;
  if (op.shadow) {
    // Canvas shadowBlur is in device pixels and ignores the transform.
    const m = ctx.getTransform();
    const k = Math.hypot(m.a, m.b);
    ctx.shadowColor = theme.shadow.color;
    ctx.shadowBlur = theme.shadow.blur * s * k;
    ctx.shadowOffsetX = theme.shadow.offsetX * s * k;
    ctx.shadowOffsetY = theme.shadow.offsetY * s * k;
  }
  ctx.drawImage(cursorCanvas, 0, 0, cw, ch, op.x + b.x * s, op.y + b.y * s, cw, ch);
  ctx.restore();
}

export function roundRectPath(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, radius: number) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, radius));
}

/** Video layer: shadow (rounded rect fill), then the cropped frame clipped to the rounded rect. */
export function drawVideo(ctx: CanvasRenderingContext2D, v: VideoDraw, frame: CanvasImageSource | null, drawShadow = true) {
  if (drawShadow && v.shadow && v.shadow.color[3] > 0) {
    // Draw only the shadow (as the native renderer does): the casting shape is
    // placed far off-canvas and the shadow is offset back into place.
    const OFF = 100_000;
    ctx.save();
    const m = ctx.getTransform();
    const k = Math.hypot(m.a, m.b);
    ctx.shadowColor = rgbaToCss(v.shadow.color);
    ctx.shadowBlur = v.shadow.blur * k;
    ctx.shadowOffsetX = (v.shadow.offsetX + OFF) * k;
    ctx.shadowOffsetY = v.shadow.offsetY * k;
    ctx.fillStyle = '#000';
    roundRectPath(ctx, { ...v.dest, x: v.dest.x - OFF }, v.radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRectPath(ctx, v.dest, v.radius);
  ctx.clip();
  if (frame) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, v.src.x, v.src.y, v.src.w, v.src.h, v.dest.x, v.dest.y, v.dest.w, v.dest.h);
  } else {
    ctx.fillStyle = '#1b1c20';
    ctx.fillRect(v.dest.x, v.dest.y, v.dest.w, v.dest.h);
  }
  ctx.restore();
}

export function clipTo(ctx: CanvasRenderingContext2D, c: ClipRect | null) {
  if (!c) return;
  roundRectPath(ctx, c, c.radius);
  ctx.clip();
}

/**
 * Composition geometry. See docs/COMPOSITION_SPEC.md §2.
 *
 * Coordinate spaces (all origin top-left, +x right, +y down):
 *  1. Source normalized  (u, v) ∈ [0,1]²  — full recorded frame after orientation.
 *  2. Source pixels      (u·srcW, v·srcH).
 *  3. Crop rect          source-normalized rect that remains after cropping.
 *  4. Canvas normalized  (x, y) ∈ [0,1]²  — composition canvas.
 *  5. Canvas pixels      (x·W, y·H) — export resolution OR preview backing store.
 *
 * Every function here is pure; preview and export call the same code with a
 * different canvas pixel size, so geometry is identical up to that scale.
 */
import type { Crop, VideoLayout } from './schema';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

const MIN_VISIBLE = 0.02; // never crop away more than 98% on an axis

export function sanitizeCrop(c: Crop): Crop {
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
  let { left, top, right, bottom } = { left: clamp01(c.left), top: clamp01(c.top), right: clamp01(c.right), bottom: clamp01(c.bottom) };
  if (left + right > 1 - MIN_VISIBLE) {
    const k = (1 - MIN_VISIBLE) / (left + right);
    left *= k;
    right *= k;
  }
  if (top + bottom > 1 - MIN_VISIBLE) {
    const k = (1 - MIN_VISIBLE) / (top + bottom);
    top *= k;
    bottom *= k;
  }
  return { left, top, right, bottom };
}

/** Crop rect in source-normalized coordinates. */
export function cropRectNormalized(c: Crop): Rect {
  const s = sanitizeCrop(c);
  return { x: s.left, y: s.top, w: 1 - s.left - s.right, h: 1 - s.top - s.bottom };
}

/** Crop rect in source pixels. */
export function cropRectPixels(c: Crop, src: Size): Rect {
  const r = cropRectNormalized(c);
  return { x: r.x * src.width, y: r.y * src.height, w: r.w * src.width, h: r.h * src.height };
}

/**
 * Where the cropped video is placed on the canvas, in canvas-normalized units.
 * 1. Available area = canvas minus padding (fractions of W for left/right, H for top/bottom).
 * 2. Fit the cropped source (aspect preserved, "contain") into the area.
 * 3. Multiply size by layout.scale.
 * 4. Align inside the available area (left/center/right, top/center/bottom).
 * 5. Add offsetX·W, offsetY·H.
 */
export function videoRectNormalized(layout: VideoLayout, crop: Crop, src: Size, canvasAspect: number): Rect {
  const pad = layout.padding;
  const availW = Math.max(0.01, 1 - pad.left - pad.right);
  const availH = Math.max(0.01, 1 - pad.top - pad.bottom);
  const cr = cropRectNormalized(crop);
  const contentAspect = (cr.w * src.width) / (cr.h * src.height); // width / height in pixels
  // In canvas-normalized units, a pixel aspect a corresponds to w/h = a / canvasAspect.
  const normAspect = contentAspect / canvasAspect;
  let w = availW;
  let h = w / normAspect;
  if (h > availH) {
    h = availH;
    w = h * normAspect;
  }
  const scale = Number.isFinite(layout.scale) && layout.scale > 0 ? layout.scale : 1;
  w *= scale;
  h *= scale;
  let x: number;
  let y: number;
  switch (layout.hAlign) {
    case 'left':
      x = pad.left;
      break;
    case 'right':
      x = 1 - pad.right - w;
      break;
    default:
      x = pad.left + (availW - w) / 2;
  }
  switch (layout.vAlign) {
    case 'top':
      y = pad.top;
      break;
    case 'bottom':
      y = 1 - pad.bottom - h;
      break;
    default:
      y = pad.top + (availH - h) / 2;
  }
  return { x: x + layout.offsetX, y: y + layout.offsetY, w, h };
}

export function toPixels(r: Rect, canvas: Size): Rect {
  return { x: r.x * canvas.width, y: r.y * canvas.height, w: r.w * canvas.width, h: r.h * canvas.height };
}

export interface VideoPlacement {
  /** Source pixel rect sampled from the decoded frame. */
  srcRect: Rect;
  /** Destination rect in canvas pixels. */
  dest: Rect;
  /** Corner radius in canvas pixels (clamped to half the short side). */
  radius: number;
  /** Crop rect in source-normalized coordinates. */
  cropNorm: Rect;
}

export function computeVideoPlacement(layout: VideoLayout, crop: Crop, src: Size, canvas: Size): VideoPlacement {
  const norm = videoRectNormalized(layout, crop, src, canvas.width / canvas.height);
  const dest = toPixels(norm, canvas);
  const radius = Math.max(0, Math.min(layout.cornerRadius * canvas.height, dest.w / 2, dest.h / 2));
  return { srcRect: cropRectPixels(crop, src), dest, radius, cropNorm: cropRectNormalized(crop) };
}

/** Source-normalized point → canvas pixels, through the crop and layout. */
export function sourceToCanvas(p: Point, placement: VideoPlacement): Point {
  const c = placement.cropNorm;
  return {
    x: placement.dest.x + ((p.x - c.x) / c.w) * placement.dest.w,
    y: placement.dest.y + ((p.y - c.y) / c.h) * placement.dest.h,
  };
}

/** Canvas pixels → source-normalized point (inverse of sourceToCanvas). */
export function canvasToSource(p: Point, placement: VideoPlacement): Point {
  const c = placement.cropNorm;
  return {
    x: c.x + ((p.x - placement.dest.x) / placement.dest.w) * c.w,
    y: c.y + ((p.y - placement.dest.y) / placement.dest.h) * c.h,
  };
}

/** True when a source-normalized point is inside the visible (cropped) area. */
export function isInsideCrop(p: Point, crop: Crop): boolean {
  const c = cropRectNormalized(crop);
  return p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
}

/** Fit `content` into `box` ("contain"), centered. */
export function fitRect(content: Size, box: Rect): Rect {
  const s = Math.min(box.w / content.width, box.h / content.height);
  const w = content.width * s;
  const h = content.height * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Source rect of an image that "covers" the destination, centered. */
export function coverSourceRect(image: Size, dest: Size): Rect {
  const s = Math.max(dest.width / image.width, dest.height / image.height);
  const w = dest.width / s;
  const h = dest.height / s;
  return { x: (image.width - w) / 2, y: (image.height - h) / 2, w, h };
}

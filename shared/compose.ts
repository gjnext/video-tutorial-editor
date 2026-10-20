/**
 * Frame composition: evaluate the project at a project time and produce the
 * complete, renderer-independent description of that frame.
 *
 * Layer order (docs/COMPOSITION_SPEC.md §4):
 *   1. background ops (static)        3. video layer (cropped, scaled, rounded)
 *   2. video drop shadow              4. cursor highlight halo
 *                                     5. synthetic cursor
 *                                     6. click effects
 * Layers 4–6 ("overlay") are optionally clipped to the video's rounded rect.
 */
import type { MediaAsset, Project } from './schema';
import { parseColor, withAlpha, type RGBA } from './color';
import { computeVideoPlacement, sourceToCanvas, type Rect, type Size, type VideoPlacement } from './geometry';
import { mapProjectTime } from './timeline';
import { evaluateClickEffects, evaluateCursor } from './cursor';
import { easeOutCubic } from './easing';
import { CURSOR_BASE_HEIGHT, CURSOR_THEMES, cursorPixelsPerUnit } from './cursorThemes';
import type { ClipRect, DrawOp, ShadowOp } from './drawOps';
import type { Flicks } from './time';

export interface VideoDraw {
  assetId: string;
  /** Source media time of the frame to show (latest frame with pts ≤ sourceTime). */
  sourceTime: Flicks;
  frozen: boolean;
  /** Source pixel rect to sample. */
  src: Rect;
  /** Destination rect in canvas pixels. */
  dest: Rect;
  radius: number;
  shadow: ShadowOp | null;
}

export interface FrameDescription {
  t: Flicks;
  video: VideoDraw | null;
  overlay: DrawOp[];
  overlayClip: ClipRect | null;
}

export function assetMap(media: MediaAsset[]): Map<string, MediaAsset> {
  return new Map(media.map((m) => [m.id, m]));
}

export function assetSize(a: MediaAsset | undefined): Size {
  return { width: a?.width || 1920, height: a?.height || 1080 };
}

/** Aspect ratio used to measure cursor distances: that of the first video segment. */
export function cursorSpaceAspect(p: Project, assets?: Map<string, MediaAsset>): number {
  const first = p.video.segments[0];
  if (!first) return 16 / 9;
  const a = (assets ?? assetMap(p.media)).get(first.assetId);
  const s = assetSize(a);
  return s.width / s.height;
}

/**
 * Placement used for rendering: the destination rect is snapped to whole
 * canvas pixels so UI text in the recording is resampled as cleanly as
 * possible. Cursor mapping uses this same snapped rect, so they stay aligned.
 */
export function placementFor(p: Project, asset: MediaAsset | undefined, canvas: Size): VideoPlacement {
  const pl = computeVideoPlacement(p.video.layout, p.video.crop, assetSize(asset), canvas);
  const x0 = Math.round(pl.dest.x);
  const y0 = Math.round(pl.dest.y);
  const x1 = Math.round(pl.dest.x + pl.dest.w);
  const y1 = Math.round(pl.dest.y + pl.dest.h);
  const dest = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  return { ...pl, dest, radius: Math.min(pl.radius, dest.w / 2, dest.h / 2) };
}

/** Placement of the video visible at time t (or the first segment's asset). */
export function placementAt(p: Project, t: Flicks, canvas: Size, assets?: Map<string, MediaAsset>): VideoPlacement | null {
  const map = assets ?? assetMap(p.media);
  const m = mapProjectTime(p.video.segments, t);
  if (!m) return null;
  return placementFor(p, map.get(m.assetId), canvas);
}

export function videoShadow(p: Project, canvas: Size): ShadowOp | null {
  const s = p.video.layout.shadow;
  if (!s.enabled || s.opacity <= 0) return null;
  return {
    blur: s.blur * canvas.height,
    offsetX: s.offsetX * canvas.height,
    offsetY: s.offsetY * canvas.height,
    color: parseColor(s.color, s.opacity),
  };
}

const RIGHT_CLICK_COLOR: RGBA = [1, 0.71, 0.28, 1];

/** Overlay ops (cursor + effects) for time t, given the active placement. */
export function cursorOverlayOps(p: Project, t: Flicks, canvas: Size, placement: VideoPlacement, aspect: number): DrawOp[] {
  const track = p.cursor;
  const style = track.style;
  const ops: DrawOp[] = [];
  const st = evaluateCursor(track, t, aspect);
  if (!st) return ops;
  const theme = CURSOR_THEMES[style.theme] ?? CURSOR_THEMES.macos;
  const unitScale = cursorPixelsPerUnit(theme, style.size, canvas.height);
  const alpha = Math.max(0, Math.min(1, style.opacity * st.visibility));
  const pt = sourceToCanvas(st, placement);

  if (alpha > 0.001) {
    if (style.highlight || (theme.highlight && style.theme === 'tutorial')) {
      const hc = parseColor(style.highlightColor);
      ops.push({ op: 'circle', cx: pt.x, cy: pt.y, r: unitScale * 9, fill: withAlpha(hc, 0.34 * alpha) });
    }
    ops.push({ op: 'cursor', theme: theme.id, x: pt.x, y: pt.y, scale: unitScale * st.pressScale, alpha, shadow: style.shadow });
  }

  const R = 2.1 * CURSOR_BASE_HEIGHT * canvas.height * style.size;
  for (const fx of evaluateClickEffects(track, t, aspect)) {
    const c = sourceToCanvas(fx, placement);
    const base = fx.click.button === 'right' ? RIGHT_CLICK_COLOR : parseColor(style.clickColor);
    const e = easeOutCubic(fx.progress);
    const fade = Math.pow(1 - fx.progress, 1.4);
    if (style.clickEffect === 'ripple') {
      ops.push({ op: 'circle', cx: c.x, cy: c.y, r: R * (0.25 + 0.75 * e), stroke: withAlpha(base, 0.9 * fade), lineWidth: Math.max(1, R * 0.07 * (1 - 0.5 * fx.progress)) });
      ops.push({ op: 'circle', cx: c.x, cy: c.y, r: R * 0.5 * e, fill: withAlpha(base, 0.22 * fade) });
    } else if (style.clickEffect === 'pulse') {
      ops.push({ op: 'circle', cx: c.x, cy: c.y, r: R * (0.35 + 0.35 * e), fill: withAlpha(base, 0.38 * Math.pow(1 - fx.progress, 2)) });
    }
  }
  return ops;
}

/** Evaluate the full frame at project time t for a canvas of `canvas` pixels. */
export function composeFrame(p: Project, t: Flicks, canvas: Size, assets?: Map<string, MediaAsset>): FrameDescription {
  const map = assets ?? assetMap(p.media);
  const m = mapProjectTime(p.video.segments, t);
  if (!m) return { t, video: null, overlay: [], overlayClip: null };
  const asset = map.get(m.assetId);
  const placement = placementFor(p, asset, canvas);
  const video: VideoDraw = {
    assetId: m.assetId,
    sourceTime: m.sourceTime,
    frozen: m.frozen,
    src: placement.srcRect,
    dest: placement.dest,
    radius: placement.radius,
    shadow: videoShadow(p, canvas),
  };
  const aspect = cursorSpaceAspect(p, map);
  const overlay = cursorOverlayOps(p, t, canvas, placement, aspect);
  const overlayClip = p.cursor.style.clipToVideo ? { ...placement.dest, radius: placement.radius } : null;
  return { t, video, overlay, overlayClip };
}

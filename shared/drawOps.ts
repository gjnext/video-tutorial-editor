/**
 * Primitive draw operations — the contract between the shared composition
 * layer (which decides WHAT to draw and WHERE) and the two renderers (Canvas
 * 2D preview, Core Graphics/Core Image export) which only execute them.
 *
 * All coordinates are canvas pixels, origin top-left, +y down.
 * Gradients interpolate in non-linear sRGB between straight-alpha stops.
 * Shadows use HTML canvas semantics: Gaussian with σ = blur / 2.
 */
import type { RGBA } from './color';
import type { CursorThemeId } from './schema';

export interface GradientStopOp {
  pos: number;
  color: RGBA;
}

export interface ShadowOp {
  blur: number;
  offsetX: number;
  offsetY: number;
  color: RGBA;
}

export type DrawOp =
  /** Fill the whole canvas with a color. */
  | { op: 'fill'; color: RGBA }
  /** Fill the whole canvas with a linear gradient from (x0,y0) to (x1,y1), extended (pad). */
  | { op: 'linear'; x0: number; y0: number; x1: number; y1: number; stops: GradientStopOp[] }
  /** Fill the whole canvas with a radial gradient centered at (cx,cy) with radius r (pad beyond). */
  | { op: 'radial'; cx: number; cy: number; r: number; stops: GradientStopOp[] }
  /** Circle; fill and/or stroke. */
  | { op: 'circle'; cx: number; cy: number; r: number; fill?: RGBA; stroke?: RGBA; lineWidth?: number }
  /** Axis-aligned line segment (used for subtle grids). */
  | { op: 'line'; x0: number; y0: number; x1: number; y1: number; stroke: RGBA; lineWidth: number }
  /** Image asset: sample `src` (image pixels) into `dest` (canvas pixels). */
  | { op: 'image'; assetId: string; src: { x: number; y: number; w: number; h: number }; dest: { x: number; y: number; w: number; h: number } }
  /**
   * Generic polyline/polygon. `points` = [x0,y0,x1,y1,…]. `holes` are extra
   * closed subpaths filled with the even-odd rule (spotlight). `dash` lengths
   * in canvas px; `glow` is a shadow with zero offset in the given color.
   */
  | {
      op: 'poly';
      points: number[];
      closed: boolean;
      holes?: number[][];
      fill?: RGBA;
      stroke?: RGBA;
      lineWidth?: number;
      dash?: number[];
      cap?: 'butt' | 'round';
      join?: 'miter' | 'round';
      glow?: ShadowOp;
    }
  /** Synthetic cursor: theme layers placed with hotspot at (x,y), `scale` canvas px per cursor unit. */
  | {
      op: 'cursor';
      theme: CursorThemeId;
      x: number;
      y: number;
      scale: number;
      alpha: number;
      shadow: boolean;
      /** Optional outline override: replaces the stroke color/width of the theme's outline layers. */
      stroke?: RGBA;
      /** Outline width in cursor units; 0 removes the outline. */
      lineWidth?: number;
    };

export interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

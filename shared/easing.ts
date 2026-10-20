/**
 * Easing curves for synthetic cursor motion.
 *
 * All presets are CSS-style cubic Béziers whose control points satisfy
 * 0 ≤ y1 ≤ y2 ≤ 1. That constraint makes the curve monotonic on [0,1], so the
 * cursor never overshoots its target or moves backwards.
 */
import type { BezierControls, EasingPreset } from './schema';

export interface EasingDefinition {
  id: EasingPreset;
  label: string;
  description: string;
  bezier: BezierControls;
  /** Multiplier applied to automatic movement durations. */
  durationFactor: number;
}

export const EASINGS: Record<Exclude<EasingPreset, 'custom'>, EasingDefinition> = {
  smooth: {
    id: 'smooth',
    label: 'Smooth',
    description: 'Gentle acceleration, soft landing. The default.',
    bezier: [0.42, 0, 0.18, 1],
    durationFactor: 1,
  },
  gentle: {
    id: 'gentle',
    label: 'Gentle',
    description: 'Slower and softer, for calm explanations.',
    bezier: [0.5, 0, 0.3, 1],
    durationFactor: 1.35,
  },
  quick: {
    id: 'quick',
    label: 'Quick',
    description: 'Fast but controlled; decelerates into the target.',
    bezier: [0.3, 0, 0.08, 1],
    durationFactor: 0.7,
  },
  linear: {
    id: 'linear',
    label: 'Linear',
    description: 'Constant speed.',
    bezier: [0, 0, 1, 1],
    durationFactor: 1,
  },
};

export const DEFAULT_CUSTOM_BEZIER: BezierControls = [0.42, 0, 0.18, 1];

/** Clamp custom control points into the overshoot-free domain. */
export function sanitizeBezier(b: BezierControls | undefined): BezierControls {
  const [x1r, y1r, x2r, y2r] = b ?? DEFAULT_CUSTOM_BEZIER;
  const c = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
  const x1 = c(x1r);
  const x2 = c(x2r);
  let y1 = c(y1r);
  let y2 = c(y2r);
  if (y1 > y2) {
    const m = (y1 + y2) / 2;
    y1 = m;
    y2 = m;
  }
  return [x1, y1, x2, y2];
}

export function bezierFor(preset: EasingPreset, custom?: BezierControls): BezierControls {
  if (preset === 'custom') return sanitizeBezier(custom);
  return EASINGS[preset]?.bezier ?? EASINGS.smooth.bezier;
}

export function durationFactor(preset: EasingPreset): number {
  return preset === 'custom' ? 1 : (EASINGS[preset]?.durationFactor ?? 1);
}

/**
 * Evaluate a cubic-bezier timing function at progress x ∈ [0,1].
 * Deterministic: fixed Newton iterations followed by bisection fallback.
 */
export function cubicBezier(b: BezierControls, x: number): number {
  const [x1, y1, x2, y2] = b;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x; // linear
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return sampleY(t);
    const d = slopeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

export function ease(preset: EasingPreset, custom: BezierControls | undefined, x: number): number {
  return cubicBezier(bezierFor(preset, custom), x);
}

export const easeOutCubic = (p: number) => 1 - Math.pow(1 - Math.min(Math.max(p, 0), 1), 3);

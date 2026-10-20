/**
 * Synthetic cursor evaluation. Pure functions of (cursor track, project time).
 * See docs/COMPOSITION_SPEC.md §3.
 *
 * Model
 *  - Keyframes say WHERE the cursor is and WHEN it arrives there.
 *  - The movement into keyframe k lasts `moveDuration` (or an automatic
 *    duration derived from distance), ending exactly at k.time. Before the
 *    movement starts the cursor rests at the previous keyframe.
 *  - User timestamps always win: durations are clamped to the gap.
 *  - Clicks and visibility are independent events in project time; a click
 *    happens wherever the cursor is at that moment.
 */
import type { CursorClick, CursorKeyframe, CursorTrack, CursorVisibilityEvent } from './schema';
import { bezierFor, cubicBezier, durationFactor, easeOutCubic } from './easing';
import { FLICKS_PER_SECOND, type Flicks, msToFlicks } from './time';

export interface CursorState {
  /** Source-normalized position of the hotspot. */
  x: number;
  y: number;
  /** 0..1 combined visibility (fades) — multiply with style opacity. */
  visibility: number;
  /** Cursor scale from the press animation (1 = rest). */
  pressScale: number;
  moving: boolean;
  /** Index of the keyframe the cursor is moving towards / resting at. */
  activeKeyframe: number;
}

export interface ClickEffectState {
  click: CursorClick;
  /** 0..1 progress of the effect animation. */
  progress: number;
  /** Source-normalized position where the click happened. */
  x: number;
  y: number;
}

export const VISIBILITY_FADE: Flicks = msToFlicks(160);
export const CLICK_EFFECT_DURATION: Flicks = msToFlicks(520);
export const DOUBLE_CLICK_GAP: Flicks = msToFlicks(150);
const PRESS_LEAD: Flicks = msToFlicks(60);
const PRESS_DURATION: Flicks = msToFlicks(240);
const PRESS_DEPTH = 0.14;

const MIN_AUTO_S = 0.18;
const MAX_AUTO_S = 2.0;

export function sortByTime<T extends { time: Flicks; id: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Distance between two source-normalized points measured in units of source
 * height (aspect-corrected), so automatic durations are isotropic.
 */
export function cursorDistance(a: { x: number; y: number }, b: { x: number; y: number }, sourceAspect: number): number {
  const dx = (b.x - a.x) * sourceAspect;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Suggested movement duration in flicks for a distance (Fitts-like, sqrt). */
export function suggestedMoveDuration(distance: number, preset: CursorKeyframe['easing']): Flicks {
  if (distance <= 1e-6) return 0;
  const s = (0.32 + 0.52 * Math.sqrt(distance)) * durationFactor(preset);
  return Math.round(Math.min(MAX_AUTO_S, Math.max(MIN_AUTO_S, s)) * FLICKS_PER_SECOND);
}

export interface MoveSegment {
  from: CursorKeyframe;
  to: CursorKeyframe;
  /** Project time the movement starts. */
  start: Flicks;
  end: Flicks;
  /** Requested duration was longer than the available gap. */
  clamped: boolean;
}

/** Resolve the actual movement interval into keyframe `to` from `from`. */
export function resolveMove(from: CursorKeyframe, to: CursorKeyframe, sourceAspect: number): MoveSegment {
  const gap = Math.max(0, to.time - from.time);
  const requested =
    to.moveDuration != null ? Math.max(0, to.moveDuration) : suggestedMoveDuration(cursorDistance(from, to, sourceAspect), to.easing);
  const dur = Math.min(requested, gap);
  return { from, to, start: to.time - dur, end: to.time, clamped: to.moveDuration != null && requested > gap };
}

/** Quadratic control point for a curved move (perpendicular offset). */
export function curveControl(from: { x: number; y: number }, to: { x: number; y: number }, curve: number, sourceAspect: number) {
  // Work in aspect-corrected space so the bulge is perpendicular on screen.
  const ax = from.x * sourceAspect;
  const bx = to.x * sourceAspect;
  const mx = (ax + bx) / 2;
  const my = (from.y + to.y) / 2;
  const dx = bx - ax;
  const dy = to.y - from.y;
  const c = Math.max(-0.5, Math.min(0.5, curve || 0));
  // Perpendicular (rotate +90° in screen space: (dx,dy) → (-dy, dx)).
  return { x: (mx - dy * c) / sourceAspect, y: my + dx * c };
}

/** Point on the movement path at path-parameter s ∈ [0,1] (arc-length uniform). */
export function pathPoint(from: { x: number; y: number }, to: { x: number; y: number }, curve: number, sourceAspect: number, s: number) {
  if (!curve) return { x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s };
  const c = curveControl(from, to, curve, sourceAspect);
  const u = arcLengthToParam(from, c, to, sourceAspect, s);
  const iu = 1 - u;
  return {
    x: iu * iu * from.x + 2 * iu * u * c.x + u * u * to.x,
    y: iu * iu * from.y + 2 * iu * u * c.y + u * u * to.y,
  };
}

const ARC_SAMPLES = 48;

function arcLengthToParam(p0: { x: number; y: number }, c: { x: number; y: number }, p1: { x: number; y: number }, aspect: number, s: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  const lens: number[] = [0];
  let px = p0.x * aspect;
  let py = p0.y;
  let total = 0;
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    const u = i / ARC_SAMPLES;
    const iu = 1 - u;
    const x = (iu * iu * p0.x + 2 * iu * u * c.x + u * u * p1.x) * aspect;
    const y = iu * iu * p0.y + 2 * iu * u * c.y + u * u * p1.y;
    total += Math.hypot(x - px, y - py);
    lens.push(total);
    px = x;
    py = y;
  }
  if (total <= 0) return s;
  const target = s * total;
  let i = 1;
  while (i < ARC_SAMPLES && lens[i] < target) i++;
  const l0 = lens[i - 1];
  const l1 = lens[i];
  const f = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
  return (i - 1 + f) / ARC_SAMPLES;
}

/** Visibility 0..1 from show/hide events. State before the first event is its opposite. */
export function evaluateVisibility(events: CursorVisibilityEvent[], t: Flicks): number {
  if (events.length === 0) return 1;
  const ev = sortByTime(events);
  const initial = ev[0].visible ? 0 : 1;
  let from = initial;
  let target = initial;
  let fadeStart = -Infinity;
  const valueAt = (time: Flicks) =>
    fadeStart === -Infinity ? target : from + (target - from) * Math.min(1, (time - fadeStart) / VISIBILITY_FADE);
  for (const e of ev) {
    if (e.time > t) break;
    from = valueAt(e.time);
    target = e.visible ? 1 : 0;
    fadeStart = e.time;
  }
  return Math.min(1, Math.max(0, valueAt(t)));
}

function pressTimes(c: CursorClick): Flicks[] {
  return c.button === 'double' ? [c.time, c.time + DOUBLE_CLICK_GAP] : [c.time];
}

export function evaluatePressScale(clicks: CursorClick[], t: Flicks): number {
  let scale = 1;
  for (const c of clicks) {
    for (const pt of pressTimes(c)) {
      const p = (t - (pt - PRESS_LEAD)) / PRESS_DURATION;
      if (p > 0 && p < 1) scale = Math.min(scale, 1 - PRESS_DEPTH * Math.sin(Math.PI * p));
    }
  }
  return scale;
}

/** Evaluate the cursor position at project time t. */
export function evaluateCursorPosition(
  keyframes: CursorKeyframe[],
  t: Flicks,
  sourceAspect: number,
): { x: number; y: number; moving: boolean; active: number } | null {
  if (keyframes.length === 0) return null;
  const kf = sortByTime(keyframes);
  if (t <= kf[0].time) return { x: kf[0].x, y: kf[0].y, moving: false, active: 0 };
  for (let i = 1; i < kf.length; i++) {
    const to = kf[i];
    if (t < to.time) {
      const from = kf[i - 1];
      const mv = resolveMove(from, to, sourceAspect);
      if (t < mv.start) return { x: from.x, y: from.y, moving: false, active: i - 1 };
      const dur = mv.end - mv.start;
      const lin = dur > 0 ? (t - mv.start) / dur : 1;
      const e = cubicBezier(bezierFor(to.easing, to.customBezier), lin);
      const p = pathPoint(from, to, to.curve, sourceAspect, e);
      return { x: p.x, y: p.y, moving: true, active: i };
    }
  }
  const last = kf[kf.length - 1];
  return { x: last.x, y: last.y, moving: false, active: kf.length - 1 };
}

// ---------------------------------------------------------------- auto-hide when idle

/** Cursor appears this long before a move/click begins (fully visible at that moment). */
export const AUTO_HIDE_LEAD: Flicks = msToFlicks(150);
/** Fade duration for auto-hide in/out. */
export const AUTO_HIDE_FADE: Flicks = msToFlicks(250);

export interface ActivityWindow {
  /** Fully visible from `start` to `end`; fades in before and out after. */
  start: Flicks;
  end: Flicks;
}

/**
 * Activity = movements between keyframes and clicks (including their effect).
 * With auto-hide on, the cursor is fully visible from AUTO_HIDE_LEAD before an
 * activity until `autoHideDelay` after it, fading over AUTO_HIDE_FADE on both sides.
 * Overlapping/nearby windows merge, so the cursor never flickers between actions.
 */
export function autoHideWindows(track: CursorTrack, sourceAspect: number): ActivityWindow[] {
  const delay = Math.round(Math.max(0, track.style.autoHideDelay) * FLICKS_PER_SECOND);
  const raw: [Flicks, Flicks][] = [];
  const kf = sortByTime(track.keyframes);
  for (let i = 1; i < kf.length; i++) {
    const mv = resolveMove(kf[i - 1], kf[i], sourceAspect);
    if (mv.end > mv.start || kf[i].x !== kf[i - 1].x || kf[i].y !== kf[i - 1].y) raw.push([mv.start, mv.end]);
  }
  for (const c of track.clicks) {
    const last = c.button === 'double' ? c.time + DOUBLE_CLICK_GAP : c.time;
    raw.push([c.time - PRESS_LEAD, last + CLICK_EFFECT_DURATION]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: ActivityWindow[] = [];
  for (const [a, b] of raw) {
    const w = { start: a - AUTO_HIDE_LEAD, end: b + delay };
    const prev = out[out.length - 1];
    // Merge when the gap would not even allow a full fade out and back in.
    if (prev && w.start - prev.end <= 2 * AUTO_HIDE_FADE) prev.end = Math.max(prev.end, w.end);
    else out.push(w);
  }
  return out;
}

/** 0..1 auto-hide factor at time t (1 when auto-hide is off). */
export function evaluateAutoHide(track: CursorTrack, t: Flicks, sourceAspect: number, windows?: ActivityWindow[]): number {
  if (!track.style.autoHide) return 1;
  let v = 0;
  for (const w of windows ?? autoHideWindows(track, sourceAspect)) {
    let x: number;
    if (t >= w.start && t <= w.end) x = 1;
    else if (t < w.start) x = 1 - (w.start - t) / AUTO_HIDE_FADE;
    else x = 1 - (t - w.end) / AUTO_HIDE_FADE;
    if (x > v) v = x;
    if (v >= 1) return 1;
  }
  return Math.max(0, v);
}

export function evaluateCursor(track: CursorTrack, t: Flicks, sourceAspect: number): CursorState | null {
  const pos = evaluateCursorPosition(track.keyframes, t, sourceAspect);
  if (!pos) return null;
  return {
    x: pos.x,
    y: pos.y,
    visibility: evaluateVisibility(track.visibility, t) * evaluateAutoHide(track, t, sourceAspect),
    pressScale: track.style.pressAnimation ? evaluatePressScale(track.clicks, t) : 1,
    moving: pos.moving,
    activeKeyframe: pos.active,
  };
}

/** Click effects active at time t (each double click yields two effects). */
export function evaluateClickEffects(track: CursorTrack, t: Flicks, sourceAspect: number): ClickEffectState[] {
  if (track.style.clickEffect === 'none' || track.keyframes.length === 0) return [];
  const out: ClickEffectState[] = [];
  for (const c of sortByTime(track.clicks)) {
    for (const pt of pressTimes(c)) {
      if (t < pt || t >= pt + CLICK_EFFECT_DURATION) continue;
      const pos = evaluateCursorPosition(track.keyframes, pt, sourceAspect)!;
      out.push({ click: c, progress: (t - pt) / CLICK_EFFECT_DURATION, x: pos.x, y: pos.y });
    }
  }
  return out;
}

export { easeOutCubic };

// ---------------------------------------------------------------- diagnostics

export type CursorWarningKind = 'same-time' | 'duration-clamped' | 'outside-crop' | 'click-while-moving' | 'click-before-first';

export interface CursorWarning {
  kind: CursorWarningKind;
  id: string;
  message: string;
}

export function cursorWarnings(
  track: CursorTrack,
  sourceAspect: number,
  isVisible: (p: { x: number; y: number }) => boolean,
): CursorWarning[] {
  const w: CursorWarning[] = [];
  const kf = sortByTime(track.keyframes);
  for (let i = 0; i < kf.length; i++) {
    const k = kf[i];
    if (i > 0 && kf[i - 1].time === k.time) {
      w.push({ kind: 'same-time', id: k.id, message: 'Two keyframes share the same time — the cursor will jump instantly.' });
    } else if (i > 0) {
      const mv = resolveMove(kf[i - 1], k, sourceAspect);
      if (mv.clamped) {
        w.push({ kind: 'duration-clamped', id: k.id, message: 'Move duration is longer than the time since the previous keyframe; it was shortened.' });
      }
    }
    if (!isVisible(k)) w.push({ kind: 'outside-crop', id: k.id, message: 'This position is outside the cropped area and will not be visible.' });
  }
  for (const c of track.clicks) {
    if (kf.length && c.time < kf[0].time) {
      w.push({ kind: 'click-before-first', id: c.id, message: 'Click happens before the first cursor keyframe.' });
      continue;
    }
    const pos = evaluateCursorPosition(kf, c.time, sourceAspect);
    if (pos?.moving) w.push({ kind: 'click-while-moving', id: c.id, message: 'Click happens while the cursor is still moving.' });
  }
  return w;
}

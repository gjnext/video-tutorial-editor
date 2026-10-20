/**
 * Project time representation.
 *
 * All timeline positions (project time and source media time) are stored as
 * integer "flicks": 1 flick = 1/705,600,000 s. Every common video frame rate
 * (24, 25, 30, 48, 50, 60, 120, and the NTSC x/1.001 variants) and every
 * common audio sample rate (8k … 192k, 44.1k, 48k) divides this evenly, so
 * frame and sample boundaries are exact integers and never drift.
 *
 * Integers stay exact in a JS double up to 2^53 flicks (~147 days).
 * Native code converts with CMTime(value: flicks, timescale: 705_600_000).
 */
export type Flicks = number;

export const FLICKS_PER_SECOND = 705_600_000;

export interface FrameRate {
  num: number;
  den: number;
}

export const FPS_30: FrameRate = { num: 30, den: 1 };
export const FPS_60: FrameRate = { num: 60, den: 1 };

export function secondsToFlicks(seconds: number): Flicks {
  return Math.round(seconds * FLICKS_PER_SECOND);
}

export function flicksToSeconds(f: Flicks): number {
  return f / FLICKS_PER_SECOND;
}

export function msToFlicks(ms: number): Flicks {
  return Math.round((ms * FLICKS_PER_SECOND) / 1000);
}

/** Duration of one frame in flicks (exact for all rates that divide FLICKS_PER_SECOND). */
export function frameDuration(rate: FrameRate): Flicks {
  return Math.round((rate.den * FLICKS_PER_SECOND) / rate.num);
}

/** Start time of output frame `index`. Computed from the index, never accumulated. */
export function frameToFlicks(index: number, rate: FrameRate): Flicks {
  return Math.round((index * rate.den * FLICKS_PER_SECOND) / rate.num);
}

/** Index of the frame that contains time `t` (floor). */
export function flicksToFrame(t: Flicks, rate: FrameRate): number {
  // Small epsilon guards values produced by float math that land a hair below a boundary.
  return Math.floor((t * rate.num) / (rate.den * FLICKS_PER_SECOND) + 1e-9);
}

/** Snap a time to the start of the frame containing it. */
export function snapToFrame(t: Flicks, rate: FrameRate): Flicks {
  return frameToFlicks(flicksToFrame(t, rate), rate);
}

/** Number of output frames needed to cover `duration` (ceil). */
export function frameCount(duration: Flicks, rate: FrameRate): number {
  if (duration <= 0) return 0;
  return Math.ceil((duration * rate.num) / (rate.den * FLICKS_PER_SECOND) - 1e-9);
}

/** Audio sample index at time t for a given sample rate (floor). */
export function flicksToSample(t: Flicks, sampleRate: number): number {
  return Math.floor((t * sampleRate) / FLICKS_PER_SECOND + 1e-9);
}

export function sampleToFlicks(sample: number, sampleRate: number): Flicks {
  return Math.round((sample * FLICKS_PER_SECOND) / sampleRate);
}

/** Format as H:MM:SS:FF timecode (or MM:SS:FF when under an hour). */
export function formatTimecode(t: Flicks, rate: FrameRate): string {
  const totalFrames = flicksToFrame(Math.max(0, t), rate);
  const fpsInt = Math.round(rate.num / rate.den);
  const ff = totalFrames % fpsInt;
  const totalSeconds = Math.floor(totalFrames / fpsInt);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}:${p(ff)}` : `${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Human readable seconds, e.g. "4.25s". */
export function formatSeconds(t: Flicks, digits = 2): string {
  return `${flicksToSeconds(t).toFixed(digits)}s`;
}

/** Short clock format M:SS.s for rulers. */
export function formatClock(t: Flicks, showFraction = false): string {
  const s = flicksToSeconds(Math.max(0, t));
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (showFraction) return `${m}:${rem.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.floor(rem)).padStart(2, '0')}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

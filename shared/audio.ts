/**
 * Audio timeline: clip placement, gain envelopes, and edit operations.
 * Audio lives in PROJECT time; it never stretches with freezes.
 * See docs/COMPOSITION_SPEC.md §5.
 */
import type { AudioClip, AudioTrackId, MediaAsset, Project } from './schema';
import { newId } from './schema';
import { placeSegments } from './timeline';
import type { Flicks } from './time';

export const EXPORT_SAMPLE_RATE = 48_000;

export interface AudioPlacement {
  /** Source clip id (or `seg:<id>` for audio taken from the video track). */
  id: string;
  assetId: string;
  /** Project time where playback starts. */
  start: Flicks;
  sourceIn: Flicks;
  sourceOut: Flicks;
  gain: number;
  fadeIn: Flicks;
  fadeOut: Flicks;
}

export function clipDuration(c: { sourceIn: Flicks; sourceOut: Flicks }): Flicks {
  return c.sourceOut - c.sourceIn;
}

export function clipEnd(c: AudioClip): Flicks {
  return c.start + clipDuration(c);
}

/** Linear gain envelope (volume × fade-in ramp × fade-out ramp) at project time t. */
export function gainAt(pl: AudioPlacement, t: Flicks): number {
  const dur = pl.sourceOut - pl.sourceIn;
  const local = t - pl.start;
  if (local < 0 || local >= dur) return 0;
  let g = pl.gain;
  if (pl.fadeIn > 0 && local < pl.fadeIn) g *= local / pl.fadeIn;
  const remain = dur - local;
  if (pl.fadeOut > 0 && remain < pl.fadeOut) g *= remain / pl.fadeOut;
  return g;
}

/**
 * Everything that should be audible, truncated to the project duration.
 * Muted clips and zero-gain clips are omitted.
 */
export function audioPlacements(p: Project, duration: Flicks, assets: Map<string, MediaAsset>): AudioPlacement[] {
  const out: AudioPlacement[] = [];
  const add = (pl: AudioPlacement) => {
    if (pl.gain <= 0) return;
    if (pl.start >= duration) return;
    const maxDur = duration - pl.start;
    const sourceOut = Math.min(pl.sourceOut, pl.sourceIn + maxDur);
    if (sourceOut <= pl.sourceIn) return;
    // A fade-out on a truncated clip still ends at the project end.
    out.push({ ...pl, sourceOut });
  };
  for (const c of p.audio) {
    if (c.muted) continue;
    const a = assets.get(c.assetId);
    if (!a || a.missing) continue;
    add({ id: c.id, assetId: c.assetId, start: c.start, sourceIn: c.sourceIn, sourceOut: c.sourceOut, gain: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut });
  }
  if (p.video.sourceAudio && p.video.sourceAudioVolume > 0) {
    for (const ps of placeSegments(p.video.segments)) {
      const s = ps.segment;
      if (s.kind !== 'clip') continue; // freezes are silent
      const a = assets.get(s.assetId);
      if (!a?.hasAudio || a.missing) continue;
      add({ id: `seg:${s.id}`, assetId: s.assetId, start: ps.start, sourceIn: s.sourceIn, sourceOut: s.sourceOut, gain: p.video.sourceAudioVolume, fadeIn: 0, fadeOut: 0 });
    }
  }
  return out;
}

/** Clips playing at project time t, with the source time being heard. */
export function activeAudioAt(p: Project, t: Flicks): { clip: AudioClip; sourceTime: Flicks }[] {
  return p.audio
    .filter((c) => !c.muted && t >= c.start && t < clipEnd(c))
    .map((clip) => ({ clip, sourceTime: clip.sourceIn + (t - clip.start) }));
}

// ---------------------------------------------------------------- edits

export function createAudioClip(asset: MediaAsset, track: AudioTrackId, start: Flicks): AudioClip {
  return { id: newId('aud'), assetId: asset.id, track, start, sourceIn: 0, sourceOut: asset.duration, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 };
}

/** Earliest free start on `track` at or after `t` for a clip of `dur` (no overlaps). */
export function findFreeStart(clips: AudioClip[], track: AudioTrackId, t: Flicks, dur: Flicks, ignoreId?: string): Flicks {
  const others = clips.filter((c) => c.track === track && c.id !== ignoreId).sort((a, b) => a.start - b.start);
  let start = Math.max(0, t);
  for (const o of others) {
    if (start + dur <= o.start) break;
    if (start < clipEnd(o)) start = clipEnd(o);
  }
  return start;
}

/**
 * Resolve a drag of `clip` to `desired` start on `track` so it does not overlap
 * neighbours: it stops at the nearest neighbour edge, or jumps to the closest
 * free gap that fits.
 */
export function resolveAudioMove(clips: AudioClip[], id: string, desired: Flicks, track: AudioTrackId): Flicks {
  const clip = clips.find((c) => c.id === id);
  if (!clip) return desired;
  const dur = clipDuration(clip);
  const others = clips.filter((c) => c.track === track && c.id !== id).sort((a, b) => a.start - b.start);
  const want = Math.max(0, desired);
  const fits = (s: Flicks) => others.every((o) => s + dur <= o.start || s >= clipEnd(o));
  if (fits(want)) return want;
  // Candidate positions adjacent to each neighbour; choose the nearest that fits.
  const candidates = [0, ...others.flatMap((o) => [o.start - dur, clipEnd(o)])].filter((s) => s >= 0 && fits(s));
  if (candidates.length === 0) return findFreeStart(clips, track, want, dur, id);
  return candidates.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best));
}

/** Split an audio clip at project time t; returns the new clip list and the id of the right part. */
export function splitAudioClip(clips: AudioClip[], id: string, t: Flicks): { clips: AudioClip[]; rightId?: string } {
  const c = clips.find((x) => x.id === id);
  if (!c || t <= c.start || t >= clipEnd(c)) return { clips };
  const local = t - c.start;
  const left: AudioClip = { ...c, sourceOut: c.sourceIn + local, fadeOut: 0 };
  const right: AudioClip = { ...c, id: newId('aud'), start: t, sourceIn: c.sourceIn + local, fadeIn: 0 };
  return { clips: clips.flatMap((x) => (x.id === id ? [left, right] : [x])), rightId: right.id };
}

export function splitAudioAt(clips: AudioClip[], t: Flicks, onlyIds?: Set<string>): AudioClip[] {
  let out = clips;
  for (const c of clips) {
    if (onlyIds && !onlyIds.has(c.id)) continue;
    out = splitAudioClip(out, c.id, t).clips;
  }
  return out;
}

/**
 * Trim an edge. `edge: 'start'` moves the in-point and the clip start together
 * (content stays anchored in project time); `edge: 'end'` moves the out-point.
 */
export function trimAudioClip(clips: AudioClip[], id: string, edge: 'start' | 'end', projectTime: Flicks, asset: MediaAsset | undefined): AudioClip[] {
  const MIN = 705_600 * 20; // 20 ms
  return clips.map((c) => {
    if (c.id !== id) return c;
    const assetDur = asset?.duration ?? c.sourceOut;
    if (edge === 'start') {
      // Leftmost allowed start: source time 0. Rightmost: MIN before end.
      const minStart = c.start - c.sourceIn;
      const maxStart = clipEnd(c) - MIN;
      const start = Math.max(Math.max(0, minStart), Math.min(projectTime, maxStart));
      return { ...c, start, sourceIn: c.sourceIn + (start - c.start) };
    }
    const maxEnd = c.start + (assetDur - c.sourceIn);
    const end = Math.max(c.start + MIN, Math.min(projectTime, maxEnd));
    return { ...c, sourceOut: c.sourceIn + (end - c.start) };
  });
}

/**
 * Swap two clips on the same track, keeping the gap between them and the
 * overall span: [A][gap][B] → [B][gap][A]. Returns null if the result would
 * overlap another clip (then the caller falls back to a normal move).
 */
export function swapAudioClips(clips: AudioClip[], aId: string, bId: string): AudioClip[] | null {
  const a = clips.find((c) => c.id === aId);
  const b = clips.find((c) => c.id === bId);
  if (!a || !b || a.track !== b.track) return null;
  const [first, second] = a.start <= b.start ? [a, b] : [b, a];
  const gap = Math.max(0, second.start - clipEnd(first));
  const newSecondFirst = { ...second, start: first.start };
  const newFirstSecond = { ...first, start: first.start + clipDuration(second) + gap };
  const next = clips.map((c) => (c.id === second.id ? newSecondFirst : c.id === first.id ? newFirstSecond : c));
  const lane = next.filter((c) => c.track === a.track).sort((x, y) => x.start - y.start);
  for (let i = 1; i < lane.length; i++) if (lane[i].start < clipEnd(lane[i - 1])) return null;
  return next;
}

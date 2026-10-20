/**
 * Explicit project-time ↔ source-time mapping for the primary video track.
 *
 * The video track is a magnetic sequence: segments are laid end to end with
 * no gaps, so project time of a segment = sum of previous durations. A clip
 * segment maps project time linearly onto a source range; a freeze segment
 * maps every project time inside it to one fixed source time.
 *
 * Intervals are half-open: a segment covers [start, end). Cursor and audio
 * tracks live in PROJECT time and are never remapped by this module, except
 * through the explicit ripple helpers below.
 */
import type { AudioClip, ClipSegment, CursorTrack, FreezeSegment, Highlight, Project, VideoSegment } from './schema';
import { newId } from './schema';
import type { Flicks } from './time';

export interface PlacedSegment {
  segment: VideoSegment;
  index: number;
  start: Flicks;
  end: Flicks;
}

export interface SourceMapping {
  segmentIndex: number;
  segment: VideoSegment;
  assetId: string;
  /** Source media time of the visible frame (latest frame with pts ≤ sourceTime). */
  sourceTime: Flicks;
  frozen: boolean;
  /** Project-time bounds of the active segment. */
  segmentStart: Flicks;
  segmentEnd: Flicks;
}

export function segmentDuration(s: VideoSegment): Flicks {
  return s.kind === 'clip' ? s.sourceOut - s.sourceIn : s.duration;
}

export function placeSegments(segments: VideoSegment[]): PlacedSegment[] {
  const out: PlacedSegment[] = [];
  let t = 0;
  segments.forEach((segment, index) => {
    const d = segmentDuration(segment);
    out.push({ segment, index, start: t, end: t + d });
    t += d;
  });
  return out;
}

export function sequenceDuration(segments: VideoSegment[]): Flicks {
  let t = 0;
  for (const s of segments) t += segmentDuration(s);
  return t;
}

/** Index of the segment containing project time t (half-open), or -1. */
export function segmentIndexAt(segments: VideoSegment[], t: Flicks): number {
  let start = 0;
  for (let i = 0; i < segments.length; i++) {
    const end = start + segmentDuration(segments[i]);
    if (t >= start && t < end) return i;
    start = end;
  }
  return -1;
}

/**
 * Map a project time to the source frame to display.
 * Times at or past the end show the final frame of the last segment, so
 * the preview at the very end (and any audio tail) never shows black.
 */
export function mapProjectTime(segments: VideoSegment[], t: Flicks): SourceMapping | null {
  if (segments.length === 0) return null;
  let start = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const d = segmentDuration(s);
    const end = start + d;
    if (t < end || i === segments.length - 1) {
      const local = Math.max(0, Math.min(t - start, d));
      if (s.kind === 'freeze') {
        return { segmentIndex: i, segment: s, assetId: s.assetId, sourceTime: s.sourceTime, frozen: true, segmentStart: start, segmentEnd: end };
      }
      // At/after the end of the last clip, hold its final frame (pts < sourceOut).
      const sourceTime = local >= d ? s.sourceOut - 1 : s.sourceIn + local;
      return { segmentIndex: i, segment: s, assetId: s.assetId, sourceTime, frozen: local >= d, segmentStart: start, segmentEnd: end };
    }
    start = end;
  }
  return null;
}

/**
 * Project duration. The video sequence defines the program length; audio that
 * extends past it is reported by `audioOverhang` so the UI can suggest a freeze.
 */
export function projectDuration(p: Pick<Project, 'video'>): Flicks {
  return sequenceDuration(p.video.segments);
}

export function audioEnd(clips: AudioClip[]): Flicks {
  let e = 0;
  for (const c of clips) e = Math.max(e, c.start + (c.sourceOut - c.sourceIn));
  return e;
}

export function audioOverhang(p: Pick<Project, 'video' | 'audio'>): Flicks {
  return Math.max(0, audioEnd(p.audio) - projectDuration(p));
}

// ---------------------------------------------------------------- edit results

export interface TimeShift {
  /** Project time at which time was inserted (delta > 0) or removed (delta < 0). */
  at: Flicks;
  delta: Flicks;
  /** For removals: events strictly inside [at, at - delta) are deleted when rippling. */
}

export interface SegmentEditResult {
  segments: VideoSegment[];
  shift?: TimeShift;
  /** Id of the segment the UI should select after the edit. */
  selectId?: string;
}

const MIN_SEGMENT: Flicks = 705_600; // 1 ms — segments shorter than this are never created

function cloneSeg<T extends VideoSegment>(s: T, patch: Partial<T>): T {
  return { ...s, ...patch, id: newId('seg') };
}

/** Split the segment under t into two. No-op when t is on a boundary. */
export function splitAt(segments: VideoSegment[], t: Flicks): SegmentEditResult {
  const placed = placeSegments(segments);
  const p = placed.find((x) => t > x.start && t < x.end);
  if (!p) return { segments };
  const local = t - p.start;
  if (local < MIN_SEGMENT || p.end - t < MIN_SEGMENT) return { segments };
  const s = p.segment;
  let a: VideoSegment;
  let b: VideoSegment;
  if (s.kind === 'clip') {
    a = { ...s, sourceOut: s.sourceIn + local };
    b = cloneSeg(s, { sourceIn: s.sourceIn + local });
  } else {
    a = { ...s, duration: local };
    b = cloneSeg(s, { duration: s.duration - local });
  }
  const next = segments.slice();
  next.splice(p.index, 1, a, b);
  return { segments: next, selectId: b.id };
}

/**
 * Insert a freeze of `duration` at project time t showing the frame visible at t.
 * If t falls inside an existing freeze, that freeze is extended instead.
 * At the very end of the sequence, the final frame is held.
 */
export function insertFreeze(segments: VideoSegment[], t: Flicks, duration: Flicks): SegmentEditResult {
  if (segments.length === 0 || duration <= 0) return { segments };
  const total = sequenceDuration(segments);
  const at = Math.max(0, Math.min(t, total));
  const m = mapProjectTime(segments, at)!;
  if (m.segment.kind === 'freeze' && at < total) {
    const next = segments.slice();
    const f = m.segment;
    next[m.segmentIndex] = { ...f, duration: f.duration + duration };
    return { segments: next, shift: { at, delta: duration }, selectId: f.id };
  }
  const freeze: FreezeSegment = {
    id: newId('seg'),
    kind: 'freeze',
    assetId: m.assetId,
    sourceTime: m.sourceTime,
    duration,
  };
  if (at >= total) {
    return { segments: [...segments, freeze], shift: { at, delta: duration }, selectId: freeze.id };
  }
  const split = splitAt(segments, at);
  const placed = placeSegments(split.segments);
  const idx = placed.findIndex((x) => x.start === at);
  const next = split.segments.slice();
  next.splice(idx < 0 ? next.length : idx, 0, freeze);
  return { segments: next, shift: { at, delta: duration }, selectId: freeze.id };
}

export function deleteSegment(segments: VideoSegment[], id: string): SegmentEditResult {
  const placed = placeSegments(segments);
  const p = placed.find((x) => x.segment.id === id);
  if (!p) return { segments };
  const next = segments.filter((s) => s.id !== id);
  return { segments: next, shift: { at: p.start, delta: -(p.end - p.start) } };
}

export function duplicateSegment(segments: VideoSegment[], id: string): SegmentEditResult {
  const placed = placeSegments(segments);
  const p = placed.find((x) => x.segment.id === id);
  if (!p) return { segments };
  const copy = cloneSeg(p.segment, {});
  const next = segments.slice();
  next.splice(p.index + 1, 0, copy);
  return { segments: next, shift: { at: p.end, delta: p.end - p.start }, selectId: copy.id };
}

/** Move a segment to a new index in the sequence (reorder). */
export function moveSegment(segments: VideoSegment[], id: string, toIndex: number): SegmentEditResult {
  const from = segments.findIndex((s) => s.id === id);
  if (from < 0) return { segments };
  const next = segments.slice();
  const [s] = next.splice(from, 1);
  const idx = Math.max(0, Math.min(toIndex, next.length));
  next.splice(idx, 0, s);
  return { segments: next, selectId: id };
}

/**
 * Trim a segment edge. For clips, `value` is the new source in/out point and
 * is limited to the asset duration. For freezes, trimming either edge changes
 * the hold duration. The sequence ripples: later segments move.
 */
export function trimSegment(
  segments: VideoSegment[],
  id: string,
  edge: 'start' | 'end',
  newDuration: Flicks,
  assetDuration: Flicks,
): SegmentEditResult {
  const placed = placeSegments(segments);
  const p = placed.find((x) => x.segment.id === id);
  if (!p) return { segments };
  const s = p.segment;
  const oldDur = p.end - p.start;
  let dur = Math.max(MIN_SEGMENT * 10, Math.round(newDuration));
  let updated: VideoSegment;
  if (s.kind === 'clip') {
    if (edge === 'end') {
      dur = Math.min(dur, assetDuration - s.sourceIn);
      updated = { ...s, sourceOut: s.sourceIn + dur };
    } else {
      dur = Math.min(dur, s.sourceOut);
      updated = { ...s, sourceIn: s.sourceOut - dur };
    }
  } else {
    updated = { ...s, duration: dur };
  }
  const delta = dur - oldDur;
  if (delta === 0) return { segments };
  const next = segments.slice();
  next[p.index] = updated;
  // Head trims change content at the segment start; tail trims at its end.
  const at = edge === 'end' ? p.start + Math.min(oldDur, dur) : p.start;
  return { segments: next, shift: { at, delta }, selectId: id };
}

export function setFreezeDuration(segments: VideoSegment[], id: string, duration: Flicks): SegmentEditResult {
  return trimSegment(segments, id, 'end', duration, Infinity);
}

/** Add a whole asset to the end of the sequence. */
export function appendClip(segments: VideoSegment[], assetId: string, duration: Flicks): SegmentEditResult {
  const clip: ClipSegment = { id: newId('seg'), kind: 'clip', assetId, sourceIn: 0, sourceOut: duration };
  return { segments: [...segments, clip], selectId: clip.id };
}

// ---------------------------------------------------------------- ripple

/**
 * Apply a time shift to cursor events. Events strictly after `at` move by
 * `delta`; on removal, events inside the removed range are dropped.
 */
export function rippleCursor(track: CursorTrack, shift: TimeShift): CursorTrack {
  const { at, delta } = shift;
  const removedEnd = delta < 0 ? at - delta : at;
  const move = <T extends { time: Flicks }>(items: T[]): T[] => {
    const out: T[] = [];
    for (const it of items) {
      if (delta < 0 && it.time > at && it.time < removedEnd) continue;
      if (delta < 0 ? it.time >= removedEnd : it.time > at) out.push({ ...it, time: Math.max(0, it.time + delta) });
      else out.push(it);
    }
    return out;
  };
  return {
    ...track,
    keyframes: move(track.keyframes),
    clicks: move(track.clicks),
    visibility: move(track.visibility),
  };
}

/**
 * Highlights are tied to what the recording shows, so they ripple with the
 * cursor setting: those starting after `at` move; on removal, highlights
 * entirely inside the removed range are dropped.
 */
export function rippleHighlights(items: Highlight[], shift: TimeShift): Highlight[] {
  const { at, delta } = shift;
  const removedEnd = delta < 0 ? at - delta : at;
  const out: Highlight[] = [];
  for (const h of items) {
    if (delta < 0 && h.start > at && h.end <= removedEnd) continue;
    if (delta < 0 ? h.start >= removedEnd : h.start > at) out.push({ ...h, start: Math.max(0, h.start + delta), end: Math.max(0, h.end + delta) });
    else out.push(h);
  }
  return out;
}

/** Audio clips that start strictly after `at` move by `delta` (never before 0). */
export function rippleAudio(clips: AudioClip[], shift: TimeShift): AudioClip[] {
  const { at, delta } = shift;
  return clips.map((c) => (c.start > at || (delta < 0 && c.start >= at) ? { ...c, start: Math.max(at, c.start + delta) } : c));
}

/** Apply a segment edit to the whole project, honoring the ripple settings. */
export function applySegmentEdit(p: Project, r: SegmentEditResult): Project {
  let next: Project = { ...p, video: { ...p.video, segments: r.segments } };
  if (r.shift && r.shift.delta !== 0) {
    if (p.ripple.cursor) next = { ...next, cursor: rippleCursor(next.cursor, r.shift), highlights: rippleHighlights(next.highlights ?? [], r.shift) };
    if (p.ripple.audio) next = { ...next, audio: rippleAudio(next.audio, r.shift) };
  }
  return next;
}

// ---------------------------------------------------------------- snapping

/** Meaningful edit boundaries for snapping: segment edges, audio edges, cursor events. */
export function snapPoints(p: Project, exclude?: Set<string>): Flicks[] {
  const pts = new Set<number>([0]);
  for (const s of placeSegments(p.video.segments)) {
    pts.add(s.start);
    pts.add(s.end);
  }
  for (const c of p.audio) {
    if (exclude?.has(c.id)) continue;
    pts.add(c.start);
    pts.add(c.start + (c.sourceOut - c.sourceIn));
  }
  for (const k of p.cursor.keyframes) if (!exclude?.has(k.id)) pts.add(k.time);
  for (const k of p.cursor.clicks) if (!exclude?.has(k.id)) pts.add(k.time);
  for (const h of p.highlights ?? []) {
    if (exclude?.has(h.id)) continue;
    pts.add(h.start);
    pts.add(h.end);
  }
  return [...pts].sort((a, b) => a - b);
}

export function snapTime(t: Flicks, points: Flicks[], tolerance: Flicks): { time: Flicks; snapped: boolean } {
  let best = t;
  let bestD = tolerance;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= bestD) {
      bestD = d;
      best = p;
    }
  }
  return { time: best, snapped: best !== t };
}

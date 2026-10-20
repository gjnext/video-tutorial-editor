import { describe, expect, it } from 'vitest';
import { applySegmentEdit, deleteSegment, duplicateSegment, insertFreeze, mapProjectTime, moveSegment, placeSegments, sequenceDuration, splitAt, trimSegment } from '../../shared/timeline';
import { evaluateCursorPosition } from '../../shared/cursor';
import { flicksToFrame, frameCount, frameToFlicks, FLICKS_PER_SECOND, secondsToFlicks as S, snapToFrame } from '../../shared/time';
import type { VideoSegment } from '../../shared/schema';
import { kf, projectWithVideo } from './helpers';

const clip8: VideoSegment[] = [{ id: 's', kind: 'clip', assetId: 'vid', sourceIn: 0, sourceOut: S(8) }];

describe('time representation', () => {
  it('frame boundaries are exact integers for common rates', () => {
    for (const rate of [{ num: 24, den: 1 }, { num: 25, den: 1 }, { num: 30, den: 1 }, { num: 60, den: 1 }, { num: 30000, den: 1001 }]) {
      for (const i of [0, 1, 7, 1799, 107_999]) {
        const t = frameToFlicks(i, rate);
        expect(Number.isInteger(t)).toBe(true);
        expect(flicksToFrame(t, rate)).toBe(i);
        expect(snapToFrame(t + 5, rate)).toBe(t);
      }
    }
    expect(FLICKS_PER_SECOND % 48000).toBe(0);
    expect(FLICKS_PER_SECOND % 44100).toBe(0);
  });

  it('no drift over a long timeline: frame N start computed from index', () => {
    const rate = { num: 60, den: 1 };
    expect(frameToFlicks(60 * 3600, rate)).toBe(S(3600));
    expect(frameCount(S(12), { num: 30, den: 1 })).toBe(360);
  });
});

describe('freeze mapping (Test 3)', () => {
  const r = insertFreeze(clip8, S(3), S(4));
  const segs = r.segments;

  it('extends the duration to 12 s and structures the sequence', () => {
    expect(sequenceDuration(segs)).toBe(S(12));
    expect(segs.map((s) => s.kind)).toEqual(['clip', 'freeze', 'clip']);
    expect(r.shift).toEqual({ at: S(3), delta: S(4) });
  });

  it('output 0–3 s maps to source 0–3 s', () => {
    for (const t of [0, 1, 2.5, 2.999]) {
      const m = mapProjectTime(segs, S(t))!;
      expect(m.sourceTime).toBe(S(t));
      expect(m.frozen).toBe(false);
    }
  });

  it('output 3–7 s shows the frozen frame at source 3 s', () => {
    for (const t of [3, 4, 6.999]) {
      const m = mapProjectTime(segs, S(t))!;
      expect(m.frozen).toBe(true);
      expect(m.sourceTime).toBe(S(3));
    }
  });

  it('output 7–12 s maps to source 3–8 s (continuity, no repeated motion)', () => {
    expect(mapProjectTime(segs, S(7))!.sourceTime).toBe(S(3));
    expect(mapProjectTime(segs, S(9.5))!.sourceTime).toBe(S(5.5));
    expect(mapProjectTime(segs, S(11.999))!.sourceTime).toBe(S(7.999));
    expect(mapProjectTime(segs, S(7))!.frozen).toBe(false);
  });

  it('every output frame has a source frame (no black frames)', () => {
    const rate = { num: 30, den: 1 };
    const n = frameCount(sequenceDuration(segs), rate);
    expect(n).toBe(360);
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const m = mapProjectTime(segs, frameToFlicks(i, rate));
      expect(m).not.toBeNull();
      expect(m!.sourceTime).toBeGreaterThanOrEqual(prev); // never goes backwards
      prev = m!.sourceTime;
    }
  });

  it('the end of the project holds the final frame', () => {
    const m = mapProjectTime(segs, S(12))!;
    expect(m.sourceTime).toBe(S(8) - 1);
  });

  it('cursor animation evaluates in output time and ripples with the freeze', () => {
    const p = projectWithVideo(8);
    p.cursor.keyframes = [kf('a', 1, 0.1, 0.1), kf('b', 5, 0.5, 0.5)];
    const next = applySegmentEdit(p, insertFreeze(p.video.segments, S(3), S(4)));
    expect(next.cursor.keyframes.find((k) => k.id === 'a')!.time).toBe(S(1));
    expect(next.cursor.keyframes.find((k) => k.id === 'b')!.time).toBe(S(9));
    // At output 8 s the cursor is still moving towards b (independent of the freeze).
    const pos = evaluateCursorPosition(next.cursor.keyframes, S(8.8), 16 / 9)!;
    expect(pos.moving).toBe(true);
  });

  it('audio does not ripple by default (narration keeps playing through the freeze)', () => {
    const p = projectWithVideo(8);
    p.audio = [{ id: 'n', assetId: 'aud', track: 'narration', start: S(5), sourceIn: 0, sourceOut: S(5), volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }];
    const next = applySegmentEdit(p, insertFreeze(p.video.segments, S(3), S(4)));
    expect(next.audio[0].start).toBe(S(5));
    const rippled = applySegmentEdit({ ...p, ripple: { cursor: true, audio: true } }, insertFreeze(p.video.segments, S(3), S(4)));
    expect(rippled.audio[0].start).toBe(S(9));
  });

  it('inserting inside an existing freeze extends it', () => {
    const again = insertFreeze(segs, S(5), S(1));
    expect(again.segments).toHaveLength(3);
    expect(sequenceDuration(again.segments)).toBe(S(13));
  });

  it('freeze at the very end holds the last frame', () => {
    const r2 = insertFreeze(clip8, S(8), S(2));
    expect(r2.segments.map((s) => s.kind)).toEqual(['clip', 'freeze']);
    expect(mapProjectTime(r2.segments, S(9))!.sourceTime).toBe(S(8) - 1);
  });
});

describe('segment editing', () => {
  it('split keeps source continuity', () => {
    const r = splitAt(clip8, S(2.5));
    expect(r.segments).toHaveLength(2);
    expect(mapProjectTime(r.segments, S(2.5))!.sourceTime).toBe(S(2.5));
    expect(mapProjectTime(r.segments, S(2.499))!.segmentIndex).toBe(0);
    expect(splitAt(clip8, 0).segments).toHaveLength(1);
  });

  it('trim end ripples later segments', () => {
    const two = splitAt(clip8, S(4)).segments;
    const r = trimSegment(two, two[0].id, 'end', S(3), S(8));
    expect(sequenceDuration(r.segments)).toBe(S(7));
    expect(placeSegments(r.segments)[1].start).toBe(S(3));
    expect(mapProjectTime(r.segments, S(3))!.sourceTime).toBe(S(4));
    expect(r.shift!.delta).toBe(-S(1));
  });

  it('trim start moves the in-point', () => {
    const r = trimSegment(clip8, 's', 'start', S(6), S(8));
    const s = r.segments[0];
    expect(s.kind === 'clip' && s.sourceIn).toBe(S(2));
    expect(mapProjectTime(r.segments, 0)!.sourceTime).toBe(S(2));
  });

  it('trim cannot exceed the media duration', () => {
    const r = trimSegment(clip8, 's', 'end', S(20), S(8));
    expect(sequenceDuration(r.segments)).toBe(S(8));
  });

  it('delete, duplicate and move reorder segments', () => {
    const three = splitAt(splitAt(clip8, S(2)).segments, S(5)).segments;
    expect(sequenceDuration(deleteSegment(three, three[1].id).segments)).toBe(S(5));
    expect(sequenceDuration(duplicateSegment(three, three[0].id).segments)).toBe(S(10));
    const moved = moveSegment(three, three[2].id, 0).segments;
    expect(mapProjectTime(moved, 0)!.sourceTime).toBe(S(5));
  });

  it('deleting a segment removes cursor events inside it when rippling', () => {
    const p = projectWithVideo(8);
    p.video.segments = splitAt(splitAt(p.video.segments, S(2)).segments, S(5)).segments;
    p.cursor.keyframes = [kf('a', 1, 0, 0), kf('b', 3, 0, 0), kf('c', 6, 0, 0)];
    const next = applySegmentEdit(p, deleteSegment(p.video.segments, p.video.segments[1].id));
    expect(next.cursor.keyframes.map((k) => [k.id, k.time])).toEqual([
      ['a', S(1)],
      ['c', S(3)],
    ]);
  });
});

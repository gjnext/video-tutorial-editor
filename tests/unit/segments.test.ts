import { describe, expect, it } from 'vitest';
import { cursorSegments, evaluateClickEffects, evaluateCursor, hiddenAt, segmentMoves, segmentStarts } from '../../shared/cursor';
import { swapAudioClips, createAudioClip } from '../../shared/audio';
import { DEFAULT_CURSOR_STYLE, type CursorTrack } from '../../shared/schema';
import { secondsToFlicks as S } from '../../shared/time';
import { audioAsset, kf } from './helpers';

const A = 16 / 9;
// Segment 1: shown 0–4 s, moves A→B. Hidden 4–10 s. Segment 2: shown from 10 s, C→D.
const track: CursorTrack = {
  keyframes: [kf('a', 1, 0.1, 0.1), kf('b', 3, 0.3, 0.3), kf('c', 10, 0.8, 0.8), kf('d', 12, 0.6, 0.2)],
  clicks: [{ id: 'k1', time: S(3.2), button: 'left' }, { id: 'k2', time: S(12.2), button: 'left' }],
  visibility: [
    { id: 's1', time: S(0.5), visible: true },
    { id: 'h1', time: S(4), visible: false },
    { id: 's2', time: S(10), visible: true },
  ],
  style: { ...DEFAULT_CURSOR_STYLE },
};

describe('cursor segments (show → hide loops)', () => {
  it('splits at each show that follows a hide', () => {
    expect(segmentStarts(track)).toEqual([S(0.5), S(10)]);
    const segs = cursorSegments(track).filter((s) => s.keyframes.length);
    expect(segs.map((s) => s.keyframes.map((k) => k.id))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('the cursor reappears at the new segment’s first point — no travel across the hidden gap', () => {
    const at = evaluateCursor(track, S(10), A)!;
    expect([at.x, at.y]).toEqual([0.8, 0.8]);
    // Even just before the next point, no blending from segment 1 positions.
    for (const t of [9, 9.5, 9.99]) expect(evaluateCursor(track, S(t), A)!.visibility).toBe(0);
    expect(segmentMoves(track, A).map((m) => `${m.from.id}->${m.to.id}`)).toEqual(['a->b', 'c->d']);
  });

  it('motion within a segment is unchanged', () => {
    const mid = evaluateCursor(track, S(2.8), A)!;
    expect(mid.moving).toBe(true);
    expect(mid.x).toBeGreaterThan(0.1);
    expect(mid.x).toBeLessThan(0.3);
  });

  it('clicks use the position of their own segment', () => {
    const fx = evaluateClickEffects(track, S(12.3), A);
    expect(fx).toHaveLength(1);
    expect([fx[0].x, fx[0].y]).toEqual([0.6, 0.2]);
  });

  it('hiddenAt follows show/hide events', () => {
    expect(hiddenAt(track, S(0.2))).toBe(true);
    expect(hiddenAt(track, S(2))).toBe(false);
    expect(hiddenAt(track, S(6))).toBe(true);
    expect(hiddenAt(track, S(11))).toBe(false);
    expect(hiddenAt({ visibility: [] }, S(5))).toBe(false);
  });

  it('without show/hide events the whole track is one continuous segment', () => {
    const t2 = { ...track, visibility: [] };
    expect(cursorSegments(t2)).toHaveLength(1);
    expect(segmentMoves(t2, A)).toHaveLength(3);
  });
});

describe('audio swap', () => {
  const a = { ...createAudioClip(audioAsset('x', 10), 'narration', S(1)), id: 'A', sourceOut: S(2) }; // 1–3
  const b = { ...createAudioClip(audioAsset('y', 10), 'narration', S(4)), id: 'B', sourceOut: S(3) }; // 4–7
  it('swaps order and keeps the gap and span', () => {
    const r = swapAudioClips([a, b], 'A', 'B')!;
    const A2 = r.find((c) => c.id === 'A')!;
    const B2 = r.find((c) => c.id === 'B')!;
    expect(B2.start).toBe(S(1)); // B now first: 1–4
    expect(A2.start).toBe(S(5)); // gap of 1 s kept: A at 5–7
    expect(swapAudioClips(r, 'A', 'B')!.map((c) => c.start)).toEqual([S(1), S(4)]); // and back
  });
  it('refuses swaps that would overlap a third clip', () => {
    const c = { ...createAudioClip(audioAsset('z', 10), 'narration', S(3.2)), id: 'C', sourceOut: S(0.5) }; // 3.2–3.7
    expect(swapAudioClips([a, b, c], 'A', 'B')).toBeNull();
  });
});

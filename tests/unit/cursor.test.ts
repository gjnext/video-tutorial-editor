import { describe, expect, it } from 'vitest';
import { cursorWarnings, evaluateClickEffects, evaluateCursor, evaluateCursorPosition, evaluatePressScale, evaluateVisibility, resolveMove, suggestedMoveDuration } from '../../shared/cursor';
import { cubicBezier, EASINGS, sanitizeBezier } from '../../shared/easing';
import { DEFAULT_CURSOR_STYLE, type CursorTrack } from '../../shared/schema';
import { secondsToFlicks as S, msToFlicks } from '../../shared/time';
import { kf } from './helpers';

const ASPECT = 16 / 9;

describe('easing', () => {
  it('all presets start at 0, end at 1 and are monotonic (no overshoot)', () => {
    for (const e of Object.values(EASINGS)) {
      expect(cubicBezier(e.bezier, 0)).toBe(0);
      expect(cubicBezier(e.bezier, 1)).toBe(1);
      let prev = 0;
      for (let i = 1; i <= 1000; i++) {
        const v = cubicBezier(e.bezier, i / 1000);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
        prev = v;
      }
    }
  });

  it('smooth is symmetric-ish ease-in-out: slow start, slow end', () => {
    const b = EASINGS.smooth.bezier;
    expect(cubicBezier(b, 0.1)).toBeLessThan(0.1);
    expect(cubicBezier(b, 0.9)).toBeGreaterThan(0.9);
  });

  it('sanitizes custom curves into the overshoot-free domain', () => {
    expect(sanitizeBezier([0.5, -0.5, 0.5, 1.5])).toEqual([0.5, 0, 0.5, 1]);
    const [, y1, , y2] = sanitizeBezier([0.2, 0.9, 0.8, 0.1]);
    expect(y1).toBeLessThanOrEqual(y2);
  });
});

describe('cursor interpolation (Test 1)', () => {
  // Golden case from the spec: (0.1,0.2)@1.0s → (0.7,0.6)@2.0s, Smooth, explicit 1s move.
  const keyframes = [kf('a', 1, 0.1, 0.2), kf('b', 2, 0.7, 0.6, { moveDuration: S(1) })];

  it('is exactly at the start and end keyframes', () => {
    expect(evaluateCursorPosition(keyframes, S(1), ASPECT)).toMatchObject({ x: 0.1, y: 0.2 });
    expect(evaluateCursorPosition(keyframes, S(2), ASPECT)).toMatchObject({ x: 0.7, y: 0.6 });
    expect(evaluateCursorPosition(keyframes, S(0), ASPECT)).toMatchObject({ x: 0.1, y: 0.2 });
    expect(evaluateCursorPosition(keyframes, S(5), ASPECT)).toMatchObject({ x: 0.7, y: 0.6 });
  });

  it('matches golden values within tolerance', () => {
    // Golden vectors (Smooth = cubic-bezier(0.42, 0, 0.18, 1)). Native/other
    // implementations must reproduce these within 1e-6.
    const golden: [number, number, number][] = [
      [1.25, 0.1 + 0.6 * cubicBezier(EASINGS.smooth.bezier, 0.25), 0.2 + 0.4 * cubicBezier(EASINGS.smooth.bezier, 0.25)],
      [1.5, 0.1 + 0.6 * cubicBezier(EASINGS.smooth.bezier, 0.5), 0.2 + 0.4 * cubicBezier(EASINGS.smooth.bezier, 0.5)],
      [1.75, 0.1 + 0.6 * cubicBezier(EASINGS.smooth.bezier, 0.75), 0.2 + 0.4 * cubicBezier(EASINGS.smooth.bezier, 0.75)],
    ];
    for (const [t, x, y] of golden) {
      const p = evaluateCursorPosition(keyframes, S(t), ASPECT)!;
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    }
    // Absolute numbers pinned so accidental curve changes are caught.
    const mid = evaluateCursorPosition(keyframes, S(1.5), ASPECT)!;
    expect(mid.x).toBeCloseTo(0.569085, 5);
    expect(mid.y).toBeCloseTo(0.512723, 5);
  });

  it('stays on the straight segment and never overshoots', () => {
    for (let i = 0; i <= 600; i++) {
      const p = evaluateCursorPosition(keyframes, S(1 + i / 600), ASPECT)!;
      expect(p.x).toBeGreaterThanOrEqual(0.1 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(0.7 + 1e-9);
      // Collinear: (y-0.2)/(x-0.1) == 0.4/0.6
      if (p.x > 0.1001) expect((p.y - 0.2) / (p.x - 0.1)).toBeCloseTo(0.4 / 0.6, 6);
    }
  });

  it('respects the movement duration: rests, then moves, arriving on time', () => {
    const k = [kf('a', 1, 0.1, 0.2), kf('b', 3, 0.7, 0.6, { moveDuration: S(0.5) })];
    expect(evaluateCursorPosition(k, S(2.4), ASPECT)).toMatchObject({ x: 0.1, y: 0.2, moving: false });
    expect(evaluateCursorPosition(k, S(2.6), ASPECT)!.moving).toBe(true);
    expect(evaluateCursorPosition(k, S(3), ASPECT)).toMatchObject({ x: 0.7, y: 0.6 });
  });

  it('is deterministic across repeated evaluation and order of keyframes', () => {
    const shuffled = [keyframes[1], keyframes[0]];
    for (let i = 0; i < 50; i++) {
      const t = S(1 + i / 50);
      expect(evaluateCursorPosition(shuffled, t, ASPECT)).toEqual(evaluateCursorPosition(keyframes, t, ASPECT));
    }
  });

  it('clamps over-long durations to the gap (timestamps win) and reports it', () => {
    const k = [kf('a', 1, 0.1, 0.2), kf('b', 1.5, 0.7, 0.6, { moveDuration: S(3) })];
    const mv = resolveMove(k[0], k[1], ASPECT);
    expect(mv.start).toBe(S(1));
    expect(mv.clamped).toBe(true);
    const track: CursorTrack = { keyframes: k, clicks: [], visibility: [], style: DEFAULT_CURSOR_STYLE };
    expect(cursorWarnings(track, ASPECT, () => true).map((w) => w.kind)).toContain('duration-clamped');
  });

  it('suggests longer durations for longer distances', () => {
    expect(suggestedMoveDuration(0.05, 'smooth')).toBeLessThan(suggestedMoveDuration(0.5, 'smooth'));
    expect(suggestedMoveDuration(0.5, 'quick')).toBeLessThan(suggestedMoveDuration(0.5, 'smooth'));
    expect(suggestedMoveDuration(0.5, 'gentle')).toBeGreaterThan(suggestedMoveDuration(0.5, 'smooth'));
  });

  it('curved paths stay bounded and end exactly at the target', () => {
    const k = [kf('a', 0, 0.2, 0.5), kf('b', 1, 0.8, 0.5, { moveDuration: S(1), curve: 0.3 })];
    let maxDev = 0;
    for (let i = 0; i <= 100; i++) {
      const p = evaluateCursorPosition(k, S(i / 100), ASPECT)!;
      expect(p.x).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(0.8 + 1e-9);
      maxDev = Math.max(maxDev, Math.abs(p.y - 0.5));
    }
    expect(maxDev).toBeGreaterThan(0.05);
    expect(evaluateCursorPosition(k, S(1), ASPECT)).toMatchObject({ x: 0.8, y: 0.5 });
  });

  it('jumps instantly for keyframes sharing a timestamp and warns', () => {
    const k = [kf('a', 1, 0.1, 0.1), kf('b', 1, 0.9, 0.9)];
    const track: CursorTrack = { keyframes: k, clicks: [], visibility: [], style: DEFAULT_CURSOR_STYLE };
    expect(cursorWarnings(track, ASPECT, () => true).map((w) => w.kind)).toContain('same-time');
    expect(evaluateCursorPosition(k, S(1.001), ASPECT)).toMatchObject({ x: 0.9, y: 0.9 });
  });
});

describe('visibility, clicks, press', () => {
  it('visibility: hidden before a first "show", fades in, fades out after hide', () => {
    const ev = [
      { id: 'v1', time: S(1), visible: true },
      { id: 'v2', time: S(3), visible: false },
    ];
    expect(evaluateVisibility(ev, S(0.5))).toBe(0);
    expect(evaluateVisibility(ev, S(1) + msToFlicks(80))).toBeCloseTo(0.5, 5);
    expect(evaluateVisibility(ev, S(2))).toBe(1);
    expect(evaluateVisibility(ev, S(4))).toBe(0);
    expect(evaluateVisibility([], S(4))).toBe(1);
  });

  it('click effects are positioned where the cursor is at click time', () => {
    const track: CursorTrack = {
      keyframes: [kf('a', 0, 0.2, 0.2), kf('b', 1, 0.6, 0.4)],
      clicks: [{ id: 'c1', time: S(1.2), button: 'left' }],
      visibility: [],
      style: DEFAULT_CURSOR_STYLE,
    };
    expect(evaluateClickEffects(track, S(1.1), ASPECT)).toHaveLength(0);
    const fx = evaluateClickEffects(track, S(1.3), ASPECT);
    expect(fx).toHaveLength(1);
    expect(fx[0].x).toBeCloseTo(0.6);
    expect(fx[0].progress).toBeGreaterThan(0);
    expect(evaluateClickEffects(track, S(3), ASPECT)).toHaveLength(0);
  });

  it('double click produces two presses', () => {
    const clicks = [{ id: 'd', time: S(1), button: 'double' as const }];
    expect(evaluatePressScale(clicks, S(1) + msToFlicks(60))).toBeLessThan(0.9);
    expect(evaluatePressScale(clicks, S(1) + msToFlicks(150) + msToFlicks(60))).toBeLessThan(0.9);
    expect(evaluatePressScale(clicks, S(2))).toBe(1);
  });

  it('cursor continues to move independently of video (freeze-agnostic)', () => {
    const track: CursorTrack = { keyframes: [kf('a', 3, 0.1, 0.1), kf('b', 6, 0.9, 0.9)], clicks: [], visibility: [], style: DEFAULT_CURSOR_STYLE };
    const a = evaluateCursor(track, S(5.5), ASPECT)!;
    const b = evaluateCursor(track, S(5.9), ASPECT)!;
    expect(b.x).toBeGreaterThan(a.x);
  });
});

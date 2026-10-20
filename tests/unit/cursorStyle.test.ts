import { describe, expect, it } from 'vitest';
import { AUTO_HIDE_FADE, autoHideWindows, evaluateAutoHide, evaluateCursor } from '../../shared/cursor';
import { composeFrame } from '../../shared/compose';
import { DEFAULT_CURSOR_STYLE, type CursorTrack } from '../../shared/schema';
import { secondsToFlicks as S, msToFlicks } from '../../shared/time';
import { kf, projectWithVideo } from './helpers';

const A = 16 / 9;
const track = (style: Partial<CursorTrack['style']> = {}, extra: Partial<CursorTrack> = {}): CursorTrack => ({
  // Rest at A from 1 s, move to B during [2.5, 3.0], click at 6 s.
  keyframes: [kf('a', 1, 0.2, 0.2), kf('b', 3, 0.7, 0.6, { moveDuration: S(0.5) })],
  clicks: [{ id: 'c', time: S(6), button: 'left' }],
  visibility: [],
  style: { ...DEFAULT_CURSOR_STYLE, autoHide: true, autoHideDelay: 1, ...style },
  ...extra,
});

describe('hide when idle', () => {
  it('is a no-op when disabled: the resting cursor stays visible', () => {
    const t = track({ autoHide: false });
    expect(evaluateCursor(t, S(1.5), A)!.visibility).toBe(1);
    expect(evaluateCursor(t, S(10), A)!.visibility).toBe(1);
  });

  it('hides a resting cursor and shows it just before and during the move', () => {
    const t = track();
    expect(evaluateAutoHide(t, S(1.5), A)).toBe(0); // resting at A, idle
    expect(evaluateAutoHide(t, S(2.35), A)).toBe(1); // fully visible 150 ms before the move
    expect(evaluateAutoHide(t, S(2.2), A)).toBeCloseTo(0.4, 6); // fading in
    expect(evaluateAutoHide(t, S(2.75), A)).toBe(1); // moving
  });

  it('stays visible for the delay after stopping, then fades out', () => {
    const t = track();
    expect(evaluateAutoHide(t, S(3.9), A)).toBe(1); // within 1 s of stopping
    expect(evaluateAutoHide(t, S(4.1), A)).toBeCloseTo(0.6, 6);
    expect(evaluateAutoHide(t, S(4.0) + AUTO_HIDE_FADE, A)).toBe(0);
    expect(evaluateAutoHide(t, S(5), A)).toBe(0);
  });

  it('reappears for a click while resting (and the effect stays visible)', () => {
    const t = track();
    expect(evaluateAutoHide(t, S(6), A)).toBe(1);
    expect(evaluateAutoHide(t, S(6.5), A)).toBe(1);
    const st = evaluateCursor(t, S(6), A)!;
    expect([st.x, st.y]).toEqual([0.7, 0.6]);
  });

  it('a longer delay keeps the cursor visible between close actions (no flicker)', () => {
    const t = track({ autoHideDelay: 3 });
    const w = autoHideWindows(t, A);
    expect(w).toHaveLength(1); // move + click merge into one window
    for (let s = 2.4; s < 7; s += 0.05) expect(evaluateAutoHide(t, S(s), A)).toBe(1);
  });

  it('respects the delay setting exactly', () => {
    const t = track({ autoHideDelay: 0.5 });
    expect(evaluateAutoHide(t, S(3.5), A)).toBe(1);
    expect(evaluateAutoHide(t, S(3.5) + AUTO_HIDE_FADE + msToFlicks(1), A)).toBe(0);
  });

  it('explicit hide markers still win', () => {
    const t = track({}, { visibility: [{ id: 'h', time: S(2), visible: false }] });
    expect(evaluateCursor(t, S(2.75), A)!.visibility).toBe(0);
  });

  it('is deterministic', () => {
    const t = track();
    for (let i = 0; i < 100; i++) expect(evaluateAutoHide(t, S(i / 10), A)).toBe(evaluateAutoHide(t, S(i / 10), A));
  });

  it('a fully hidden cursor emits no cursor op; partially hidden fades alpha', () => {
    const p = projectWithVideo(10);
    p.cursor = track();
    const size = { width: 1920, height: 1080 };
    expect(composeFrame(p, S(1.5), size).overlay.some((o) => o.op === 'cursor')).toBe(false);
    const op = composeFrame(p, S(2.2), size).overlay.find((o) => o.op === 'cursor');
    expect(op?.op === 'cursor' && op.alpha).toBeCloseTo(0.4, 6);
  });
});

describe('custom outline', () => {
  it('passes outline color and width to both renderers via the cursor op', () => {
    const p = projectWithVideo(10);
    p.cursor = track({ autoHide: false, customOutline: true, outlineColor: '#ff0000', outlineWidth: 3.5 });
    const op = composeFrame(p, S(5), { width: 1920, height: 1080 }).overlay.find((o) => o.op === 'cursor')!;
    expect(op).toMatchObject({ stroke: [1, 0, 0, 1], lineWidth: 3.5 });
  });

  it('uses the theme outline when not customized', () => {
    const p = projectWithVideo(10);
    p.cursor = track({ autoHide: false });
    const op = composeFrame(p, S(5), { width: 1920, height: 1080 }).overlay.find((o) => o.op === 'cursor')!;
    expect('stroke' in op).toBe(false);
  });

  it('clamps the width and allows 0 (no outline)', () => {
    const p = projectWithVideo(10);
    p.cursor = track({ autoHide: false, customOutline: true, outlineWidth: 50 });
    expect(composeFrame(p, S(5), { width: 1920, height: 1080 }).overlay.find((o) => o.op === 'cursor')).toMatchObject({ lineWidth: 6 });
    p.cursor = track({ autoHide: false, customOutline: true, outlineWidth: 0 });
    expect(composeFrame(p, S(5), { width: 1920, height: 1080 }).overlay.find((o) => o.op === 'cursor')).toMatchObject({ lineWidth: 0 });
  });
});

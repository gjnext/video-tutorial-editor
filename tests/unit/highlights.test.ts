import { describe, expect, it } from 'vitest';
import { createHighlight, highlightOps, highlightPhase, HIGHLIGHT_STYLES, INTRO_DURATION, SPOT_FEATHER_STEPS, trimPolyline } from '../../shared/highlights';
import { composeFrame, placementFor } from '../../shared/compose';
import { sourceToCanvas } from '../../shared/geometry';
import { applySegmentEdit, deleteSegment, insertFreeze, splitAt } from '../../shared/timeline';
import { migrateProject, type Highlight } from '../../shared/schema';
import { secondsToFlicks as S } from '../../shared/time';
import { projectWithVideo } from './helpers';

const style = (id: string) => HIGHLIGHT_STYLES.find((s) => s.id === id)!;
const polys = (ops: ReturnType<typeof highlightOps>) => ops.filter((o): o is Extract<typeof o, { op: 'poly' }> => o.op === 'poly');

function setup(h: Partial<Highlight> = {}, res = { width: 1920, height: 1080 }) {
  const p = projectWithVideo(10);
  const hl = { ...createHighlight('rect', { x: 0.2, y: 0.3, w: 0.2, h: 0.1 }, S(1), style('outline')), id: 'hl_test', ...h };
  p.highlights = [hl];
  const pl = placementFor(p, p.media[0], res);
  return { p, hl, pl, res };
}

describe('highlights', () => {
  it('is visible only within [start, end) with fade-out at the end', () => {
    const { hl } = setup();
    expect(highlightPhase(hl, S(0.9))).toBeNull();
    expect(highlightPhase(hl, hl.end)).toBeNull();
    expect(highlightPhase(hl, S(2))!.alpha).toBe(1);
    expect(highlightPhase(hl, hl.end - S(0.125))!.alpha).toBeCloseTo(0.5, 6);
  });

  it('draw-on: the outline grows from nothing to the closed shape', () => {
    const { p, hl, pl, res } = setup();
    const early = polys(highlightOps(p.highlights, hl.start + S(0.05), pl, res));
    const done = polys(highlightOps(p.highlights, hl.start + INTRO_DURATION.draw, pl, res));
    expect(early[0].points.length).toBeLessThan(done[0].points.length);
    expect(early[0].closed).toBe(false);
    expect(done[0].closed).toBe(true);
  });

  it('box corners map to the same source location at every resolution', () => {
    for (const res of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }]) {
      const { p, hl, pl } = setup({ cornerRadius: 0 }, res);
      const op = polys(highlightOps(p.highlights, S(2), pl, res))[0];
      const tl = sourceToCanvas({ x: hl.x, y: hl.y }, pl);
      const br = sourceToCanvas({ x: hl.x + hl.w, y: hl.y + hl.h }, pl);
      expect(op.points[0]).toBeCloseTo(tl.x, 6);
      expect(op.points[1]).toBeCloseTo(tl.y, 6);
      expect(op.points[4]).toBeCloseTo(br.x, 6);
      expect(op.points[5]).toBeCloseTo(br.y, 6);
      expect(op.lineWidth).toBeCloseTo((4 / 1000) * res.height, 9);
    }
  });

  it('spotlight dims the video with an even-odd hole over the box', () => {
    const { p, pl, res } = setup({ shape: 'spotlight', thickness: 0, dim: 0.6 });
    const ops = polys(highlightOps(p.highlights, S(2), pl, res));
    expect(ops).toHaveLength(SPOT_FEATHER_STEPS);
    expect(ops.every((o) => o.holes?.length === 1)).toBe(true);
    // Far from the element all feather layers overlap → exactly the requested dim.
    const a = ops[0].fill![3];
    expect(1 - Math.pow(1 - a, ops.length)).toBeCloseTo(0.6, 6);
  });

  it('arrow tip lands exactly on the end point', () => {
    const { p, hl, pl, res } = setup({ shape: 'arrow', x: 0.2, y: 0.6, w: 0.3, h: -0.2, intro: 'none' });
    const ops = polys(highlightOps(p.highlights, S(2), pl, res));
    const head = ops.find((o) => o.closed && o.points.length === 6)!;
    const tip = sourceToCanvas({ x: hl.x + hl.w, y: hl.y + hl.h }, pl);
    expect(head.points[0]).toBeCloseTo(tip.x, 6);
    expect(head.points[1]).toBeCloseTo(tip.y, 6);
  });

  it('hand-drawn jitter is deterministic and resolution independent', () => {
    const a = setup({ line: 'sketch' }, { width: 1920, height: 1080 });
    const b = setup({ line: 'sketch' }, { width: 3840, height: 2160 });
    const pa = polys(highlightOps(a.p.highlights, S(2), a.pl, a.res))[0].points;
    const pb = polys(highlightOps(b.p.highlights, S(2), b.pl, b.res))[0].points;
    expect(polys(highlightOps(a.p.highlights, S(2), a.pl, a.res))[0].points).toEqual(pa);
    expect(pa.length).toBe(pb.length);
    // Equal up to the whole-pixel snapping of the video rect at each resolution.
    for (let i = 0; i < pa.length; i++) expect(Math.abs(pb[i] / 2 - pa[i])).toBeLessThan(0.5);
  });

  it('glow adds a soft halo stroke beneath the line', () => {
    const { p, pl, res } = setup({ glow: true });
    const ops = polys(highlightOps(p.highlights, S(2), pl, res));
    expect(ops).toHaveLength(2);
    expect(ops[0].lineWidth!).toBeGreaterThan(ops[1].lineWidth! * 3);
    expect(ops[0].stroke![3]).toBeLessThan(0.3);
    expect(ops[1].glow).toBeDefined();
  });

  it('line styles: dashed has a dash pattern, marker is wide and translucent', () => {
    const d = setup({ line: 'dashed' });
    expect(polys(highlightOps(d.p.highlights, S(2), d.pl, d.res))[0].dash).toHaveLength(2);
    const m = setup({ shape: 'underline', line: 'marker', x: 0.2, y: 0.5, w: 0.3, h: 0 });
    const op = polys(highlightOps(m.p.highlights, S(2), m.pl, m.res))[0];
    expect(op.stroke![3]).toBeLessThan(0.6);
    expect(op.lineWidth).toBeGreaterThan((m.hl.thickness / 1000) * 1080 * 2);
  });

  it('composeFrame clips highlights to the video and keeps the cursor on top', () => {
    const { p } = setup();
    const f = composeFrame(p, S(2), { width: 1920, height: 1080 });
    expect(f.highlights.length).toBeGreaterThan(0);
    expect(f.highlightClip).not.toBeNull();
    expect(composeFrame(p, S(0.5), { width: 1920, height: 1080 }).highlights).toHaveLength(0);
  });

  it('ripples with freezes like the cursor; removal drops highlights inside the cut', () => {
    const { p } = setup({ start: S(4), end: S(5) });
    const next = applySegmentEdit(p, insertFreeze(p.video.segments, S(3), S(2)));
    expect([next.highlights[0].start, next.highlights[0].end]).toEqual([S(6), S(7)]);
    const q = { ...p, video: { ...p.video, segments: splitAt(splitAt(p.video.segments, S(3.5)).segments, S(6)).segments } };
    const cut = applySegmentEdit(q, deleteSegment(q.video.segments, q.video.segments[1].id));
    expect(cut.highlights).toHaveLength(0);
  });

  it('trimPolyline returns exact partial length', () => {
    const pts: [number, number][] = [[0, 0], [10, 0], [10, 10]];
    expect(trimPolyline(pts, 0.75)).toEqual([[0, 0], [10, 0], [10, 5]]);
  });

  it('older projects without highlights migrate to an empty list', () => {
    const p = projectWithVideo(5) as unknown as Record<string, unknown>;
    delete p.highlights;
    expect(migrateProject(p).highlights).toEqual([]);
  });
});

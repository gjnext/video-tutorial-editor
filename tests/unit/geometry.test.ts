import { describe, expect, it } from 'vitest';
import { canvasToSource, computeVideoPlacement, isInsideCrop, sourceToCanvas, videoRectNormalized } from '../../shared/geometry';
import { composeFrame, placementFor } from '../../shared/compose';
import { DEFAULT_LAYOUT, exportCanvasSize, type Crop, type VideoLayout } from '../../shared/schema';
import { secondsToFlicks as S } from '../../shared/time';
import { kf, projectWithVideo } from './helpers';

const noCrop: Crop = { left: 0, top: 0, right: 0, bottom: 0 };

describe('video placement', () => {
  it('fits the cropped content inside the padded area, centered, aspect preserved', () => {
    const src = { width: 2880, height: 1800 }; // 16:10 retina window
    const canvas = { width: 2560, height: 1440 };
    const pl = computeVideoPlacement(DEFAULT_LAYOUT, noCrop, src, canvas);
    expect(pl.dest.w / pl.dest.h).toBeCloseTo(2880 / 1800, 6);
    const pad = DEFAULT_LAYOUT.padding;
    expect(pl.dest.y).toBeCloseTo(pad.top * 1440, 6); // height-limited
    expect(pl.dest.x + pl.dest.w / 2).toBeCloseTo(1280, 6);
  });

  it('crop changes aspect without distortion', () => {
    const src = { width: 1920, height: 1080 };
    const crop = { left: 0, top: 0.1, right: 0, bottom: 0 };
    const pl = computeVideoPlacement(DEFAULT_LAYOUT, crop, src, { width: 1920, height: 1080 });
    expect(pl.dest.w / pl.dest.h).toBeCloseTo(1920 / (1080 * 0.9), 6);
    expect(pl.srcRect).toEqual({ x: 0, y: 108, w: 1920, h: 972 });
  });

  it('alignment and offsets', () => {
    const layout: VideoLayout = { ...DEFAULT_LAYOUT, scale: 0.5, hAlign: 'left', vAlign: 'bottom', offsetX: 0.01, offsetY: -0.02 };
    const r = videoRectNormalized(layout, noCrop, { width: 1600, height: 900 }, 16 / 9);
    expect(r.x).toBeCloseTo(layout.padding.left + 0.01, 9);
    expect(r.y + r.h).toBeCloseTo(1 - layout.padding.bottom - 0.02, 9);
  });

  it('full-bleed with matching aspect fills the canvas exactly', () => {
    const layout: VideoLayout = { ...DEFAULT_LAYOUT, padding: { left: 0, right: 0, top: 0, bottom: 0 } };
    const pl = computeVideoPlacement(layout, noCrop, { width: 3840, height: 2160 }, { width: 1920, height: 1080 });
    expect(pl.dest).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});

describe('cursor coordinates after cropping (Test 2)', () => {
  const crops: Crop[] = [
    noCrop,
    { left: 0, top: 0.12, right: 0, bottom: 0 },
    { left: 0.05, top: 0.1, right: 0.15, bottom: 0.08 },
    { left: 0.3, top: 0.0, right: 0.0, bottom: 0.25 },
  ];
  const sources = [
    { width: 1920, height: 1080 },
    { width: 3456, height: 2234 }, // MacBook Pro 16 retina
    { width: 1000, height: 1700 }, // portrait / unusual
    { width: 1333, height: 777 }, // odd sizes, non-integer scaling
  ];
  const layouts: VideoLayout[] = [DEFAULT_LAYOUT, { ...DEFAULT_LAYOUT, scale: 0.73, hAlign: 'right', offsetY: 0.031 }, { ...DEFAULT_LAYOUT, padding: { left: 0.2, right: 0.01, top: 0.3, bottom: 0.05 } }];
  const canvases = [exportCanvasSize({ aspectW: 16, aspectH: 9 }, 1080), exportCanvasSize({ aspectW: 16, aspectH: 9 }, 1440), exportCanvasSize({ aspectW: 16, aspectH: 9 }, 2160), { width: 1280, height: 720 }];

  it('a source point maps to the same source pixel of the displayed video at every resolution', () => {
    const target = { x: 0.62, y: 0.47 }; // a "Settings button" in source coordinates
    for (const crop of crops)
      for (const src of sources)
        for (const layout of layouts) {
          const rel: { x: number; y: number }[] = [];
          for (const canvas of canvases) {
            const pl = computeVideoPlacement(layout, crop, src, canvas);
            const c = sourceToCanvas(target, pl);
            // Invert through the drawn video: which source pixel is under canvas point c?
            const sx = pl.srcRect.x + ((c.x - pl.dest.x) / pl.dest.w) * pl.srcRect.w;
            const sy = pl.srcRect.y + ((c.y - pl.dest.y) / pl.dest.h) * pl.srcRect.h;
            expect(sx / src.width).toBeCloseTo(target.x, 9);
            expect(sy / src.height).toBeCloseTo(target.y, 9);
            // Round trip
            const back = canvasToSource(c, pl);
            expect(back.x).toBeCloseTo(target.x, 9);
            expect(back.y).toBeCloseTo(target.y, 9);
            // Resolution independence: relative position inside the canvas is constant.
            rel.push({ x: c.x / canvas.width, y: c.y / canvas.height });
          }
          for (const r of rel) {
            expect(r.x).toBeCloseTo(rel[0].x, 9);
            expect(r.y).toBeCloseTo(rel[0].y, 9);
          }
        }
  });

  it('detects keyframes outside the crop', () => {
    expect(isInsideCrop({ x: 0.5, y: 0.05 }, { left: 0, top: 0.1, right: 0, bottom: 0 })).toBe(false);
    expect(isInsideCrop({ x: 0.5, y: 0.5 }, { left: 0, top: 0.1, right: 0, bottom: 0 })).toBe(true);
  });

  it('composeFrame places the cursor op at the mapped canvas point', () => {
    const p = projectWithVideo(8, 2880, 1800);
    p.video.crop = { left: 0.02, top: 0.11, right: 0.02, bottom: 0 };
    p.cursor.keyframes = [kf('a', 0, 0.62, 0.47)];
    for (const res of [1080, 1440, 2160] as const) {
      const size = exportCanvasSize(p.canvas, res);
      const f = composeFrame(p, S(1), size);
      const op = f.overlay.find((o) => o.op === 'cursor')!;
      const pl = placementFor(p, p.media[0], size);
      const want = sourceToCanvas({ x: 0.62, y: 0.47 }, pl);
      // Snapping moves the rect by < 1 px relative to the exact geometry.
      const exact = sourceToCanvas({ x: 0.62, y: 0.47 }, computeVideoPlacement(p.video.layout, p.video.crop, { width: 2880, height: 1800 }, size));
      expect(Math.abs(exact.x - want.x)).toBeLessThan(1);
      expect(Math.abs(exact.y - want.y)).toBeLessThan(1);
      expect(op.op === 'cursor' && op.x).toBeCloseTo(want.x, 9);
      expect(op.op === 'cursor' && op.y).toBeCloseTo(want.y, 9);
      // Cursor scales with output resolution.
      expect(op.op === 'cursor' && op.scale).toBeCloseTo((0.03 * size.height) / 20, 9);
    }
  });
});

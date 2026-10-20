/**
 * End-to-end export verification (spec Tests 3, 4, 6, 9):
 * build a project with crop, background, rounded corners, shadow, a freeze,
 * cursor motion, a click and narration → export a real 1440p MP4 with the
 * native renderer → verify container, duration, frame mapping (via the
 * frame-index barcode in the fixture), cursor placement, and audio sync.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyProject, newId, type MediaAsset, type Project } from '../../shared/schema';
import { applySegmentEdit, insertFreeze, mapProjectTime } from '../../shared/timeline';
import { buildRenderPlan } from '../../shared/renderPlan';
import { composeFrame, placementFor } from '../../shared/compose';
import { sourceToCanvas } from '../../shared/geometry';
import { frameToFlicks, secondsToFlicks as S, FLICKS_PER_SECOND } from '../../shared/time';
import { ensureFixtures, nativeAvailable, OUT, runHelper } from './native';

const BARCODE_BITS = 16;
const BARCODE_CELL = 24;
const SRC_W = 1920;
const SRC_H = 1200;

function kf(t: number, x: number, y: number) {
  return { id: newId('kf'), time: S(t), x, y, easing: 'smooth' as const, moveDuration: null, curve: 0 };
}

async function buildProject(videoPath: string, audioPath: string): Promise<Project> {
  const pv = await runHelper('studio-render', ['probe', videoPath]);
  const pa = await runHelper('studio-render', ['probe', audioPath]);
  const video: MediaAsset = { id: 'v1', kind: 'video', name: 'saas.mp4', path: videoPath, duration: S(pv.duration), width: pv.width, height: pv.height, frameRate: pv.frameRate, origin: 'recorded' };
  const audio: MediaAsset = { id: 'a1', kind: 'audio', name: 'narration.wav', path: audioPath, duration: S(pa.duration), sampleRate: pa.sampleRate, channels: pa.channels, origin: 'imported' };
  let p = createEmptyProject('Export test');
  p.media = [video, audio];
  p.video.segments = [{ id: 'seg', kind: 'clip', assetId: 'v1', sourceIn: 0, sourceOut: video.duration }];
  p.video.crop = { left: 0, top: 122 / SRC_H, right: 0, bottom: 0 }; // remove browser tabs + address bar
  p.background = { kind: 'preset', id: 'aurora-violet' };
  // Settings item in the sidebar (fixture layout: x≈40..140, y≈402..430 at 1920×1200).
  p.cursor.keyframes = [kf(1.0, 0.45, 0.5), kf(2.5, 90 / SRC_W, 416 / SRC_H), kf(5.0, 0.62, 0.3)];
  p.cursor.clicks = [{ id: 'c1', time: S(2.7), button: 'left' }];
  // Narration starts at 0.5 s → beeps (source 1, 4, 10 s) at 1.5, 4.5, 10.5 s.
  p.audio = [{ id: 'n1', assetId: 'a1', track: 'narration', start: S(0.5), sourceIn: 0, sourceOut: audio.duration, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 }];
  // Freeze 4 s at source 3 s (ripple cursor events after 3 s, not audio).
  p = applySegmentEdit(p, insertFreeze(p.video.segments, S(3), S(4)));
  p.export = { resolution: 1440, fps: { num: 30, den: 1 }, codec: 'h264', quality: 'high' };
  return p;
}

function decodeBarcode(pixels: number[][]): number {
  let v = 0;
  for (const px of pixels) v = (v << 1) | (px[0] + px[1] + px[2] < 384 ? 1 : 0);
  return v;
}

describe.skipIf(!nativeAvailable)('native export (1440p H.264 + AAC)', () => {
  let project: Project;
  const outPath = path.join(OUT, 'export-1440p.mp4');
  const planPath = path.join(OUT, 'export-plan.json');
  let probe: Record<string, any>;

  beforeAll(async () => {
    const fx = await ensureFixtures();
    project = await buildProject(fx.video, fx.audio);
    const plan = buildRenderPlan(project, outPath);
    writeFileSync(planPath, JSON.stringify(plan));
    const res = await runHelper('studio-render', ['export', planPath]);
    expect(res.path).toBe(outPath);
    probe = await runHelper('studio-render', ['probe', outPath]);
  });

  it('produces a playable MP4 with the expected streams, size and duration (Test 6)', () => {
    expect(probe.playable).toBe(true);
    expect(probe.width).toBe(2560);
    expect(probe.height).toBe(1440);
    expect(probe.codec).toBe('avc1');
    expect(probe.hasAudio).toBe(true);
    expect(probe.sampleRate).toBe(48000);
    expect(probe.duration).toBeGreaterThan(11.95);
    expect(probe.duration).toBeLessThan(12.1);
  });

  it('every sampled output frame shows the source frame dictated by the time map (Tests 3 & 9)', async () => {
    const size = { width: 2560, height: 1440 };
    const pl = placementFor(project, project.media[0], size);
    // Barcode cell centers in source pixels → canvas pixels.
    const by = SRC_H - BARCODE_CELL * 2 + BARCODE_CELL / 2;
    const pts = Array.from({ length: BARCODE_BITS }, (_, b) => sourceToCanvas({ x: (308 + b * BARCODE_CELL + BARCODE_CELL / 2) / SRC_W, y: by / SRC_H }, pl));
    const spec = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';');
    const fps = project.export.fps;
    for (const frame of [0, 15, 60, 89, 90, 120, 209, 210, 211, 270, 359]) {
      const t = frameToFlicks(frame, fps);
      const png = path.join(OUT, `frame-${frame}.png`);
      // Sample mid-frame to avoid boundary ambiguity in the decoder.
      await runHelper('studio-render', ['extract-frame', outPath, String((t + FLICKS_PER_SECOND / 60) / FLICKS_PER_SECOND), png]);
      const { pixels } = await runHelper('studio-fixtures', ['pixels', png, spec]);
      const m = mapProjectTime(project.video.segments, t)!;
      const expected = Math.floor((m.sourceTime * 30) / FLICKS_PER_SECOND + 1e-9);
      expect({ frame, source: decodeBarcode(pixels) }).toEqual({ frame, source: expected });
    }
  });

  it('places the cursor hotspot where the composition model says (Test 9)', async () => {
    const plan = buildRenderPlan(project, outPath);
    const noCursor = { ...project, cursor: { ...project.cursor, keyframes: [], clicks: [] } };
    const planNo = buildRenderPlan(noCursor, outPath);
    writeFileSync(path.join(OUT, 'plan-nocursor.json'), JSON.stringify(planNo));
    const size = { width: 2560, height: 1440 };
    for (const sec of [1.0, 2.0, 2.5, 6.0]) {
      const idx = Math.round(sec * 30);
      const a = path.join(OUT, `cursor-${idx}.png`);
      const b = path.join(OUT, `nocursor-${idx}.png`);
      await runHelper('studio-render', ['render-frame', planPath, String(idx), a]);
      await runHelper('studio-render', ['render-frame', path.join(OUT, 'plan-nocursor.json'), String(idx), b]);
      const cmp = await runHelper('studio-fixtures', ['compare', a, b, '40']);
      const op = composeFrame(project, frameToFlicks(idx, project.export.fps), size).overlay.find((o) => o.op === 'cursor');
      expect(op && op.op === 'cursor').toBeTruthy();
      if (!op || op.op !== 'cursor') continue;
      // The arrow tip is the top-left extreme of the drawn cursor (outline ≈ 1.2 units).
      const [minX, minY] = cmp.bbox;
      expect(Math.abs(minX - op.x)).toBeLessThanOrEqual(1.4 * op.scale + 1);
      expect(Math.abs(minY - op.y)).toBeLessThanOrEqual(1.4 * op.scale + 1);
    }
    expect(plan.frames.length).toBe(360);
  });

  it('encoded frames match the renderer output (no encode-path geometry drift)', async () => {
    const idx = 75; // 2.5 s, cursor on Settings
    const rendered = path.join(OUT, `cursor-${idx}.png`);
    const decoded = path.join(OUT, `decoded-${idx}.png`);
    await runHelper('studio-render', ['extract-frame', outPath, String((idx + 0.5) / 30), decoded]);
    // Players apply slightly different BT.709 tone curves, so compare structure:
    // geometry drift would make text/edges differ strongly on many pixels.
    const cmp = await runHelper('studio-fixtures', ['compare', rendered, decoded, '64']);
    expect(cmp.mean).toBeLessThan(8);
    expect(cmp.count / (2560 * 1440)).toBeLessThan(0.002);
  });

  it('narration is in sync and unaffected by the freeze (Test 4)', async () => {
    const res = await runHelper('studio-fixtures', ['beeps', outPath, '0.2']);
    expect(res.onsets).toHaveLength(3);
    const expected = [1.5, 4.5, 10.5];
    res.onsets.forEach((t: number, i: number) => expect(Math.abs(t - expected[i])).toBeLessThan(0.005));
    expect(res.duration).toBeGreaterThan(11.99);
  });
});

describe.skipIf(!nativeAvailable)('native export (4K HEVC 60 fps)', () => {
  it('encodes 3840×2160 HEVC at 60 fps with the correct duration and frame mapping', async () => {
    const fx = await ensureFixtures();
    const p = await buildProject(fx.video, fx.audio);
    p.export = { resolution: 2160, fps: { num: 60, den: 1 }, codec: 'hevc', quality: 'standard' };
    const out = path.join(OUT, 'export-4k-hevc60.mp4');
    const planPath = path.join(OUT, 'plan-4k.json');
    const plan = buildRenderPlan(p, out);
    expect(plan.frameCount).toBe(720);
    writeFileSync(planPath, JSON.stringify(plan));
    const res = await runHelper('studio-render', ['export', planPath]);
    expect(res.frames).toBe(720);
    const pr = await runHelper('studio-render', ['probe', out]);
    expect([pr.width, pr.height, pr.codec]).toEqual([3840, 2160, 'hvc1']);
    expect(Math.round(pr.frameRate)).toBe(60);
    expect(Math.abs(pr.duration - 12)).toBeLessThan(0.05);
  });
});

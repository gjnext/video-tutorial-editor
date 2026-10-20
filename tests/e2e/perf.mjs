// Preview performance benchmark: playback smoothness and scrubbing with a real recording.
// Usage: node tests/e2e/perf.mjs <video.mp4> [--packaged app]
import path from 'node:path';
import { launch, sleep } from './driver.mjs';

const video = path.resolve(process.argv[2] ?? 'tests/fixtures/saas-8s.mp4');
const pkgIdx = process.argv.indexOf('--packaged');
const app = await launch({ appPath: path.resolve(import.meta.dirname, '../..'), executable: pkgIdx > 0 ? path.join(process.argv[pkgIdx + 1], 'Contents/MacOS/Tutorial Studio') : undefined });
const D = 'window.__studioDebug';
const out = {};
try {
  await sleep(1200);
  out.fastSeek = await app.evaluate(`'fastSeek' in HTMLMediaElement.prototype`);
  out.rvfc = await app.evaluate(`'requestVideoFrameCallback' in HTMLVideoElement.prototype`);
  await app.evaluate(`(() => { window.__long = { n: 0, ms: 0, max: 0 }; new PerformanceObserver((l) => { for (const e of l.getEntries()) { __long.n++; __long.ms += e.duration; __long.max = Math.max(__long.max, e.duration); } }).observe({ type: 'longtask', buffered: false }); })()`);
  await app.evaluate(`(async () => { const r = await window.studio.media.importPaths([${JSON.stringify(video)}]); ${D}.actions.addAssets(r.assets.map(a => ({ ...a, origin: 'recorded' }))); })()`);
  await sleep(2500);
  await app.evaluate(`document.querySelectorAll('.toast button').forEach(b => b.click())`);
  // A realistic project: a few cursor moves and a highlight.
  await app.evaluate(`(() => { const S = ${D}.time.secondsToFlicks, a = ${D}.actions;
    a.placeKeyframe(0.3, 0.3, S(0.5)); a.placeKeyframe(0.6, 0.5, S(2)); a.placeKeyframe(0.2, 0.7, S(4)); a.addClick('left', S(4.2));
    ${D}.editor().set({ mode: 'select', showPath: false }); ${D}.editor().select({ kind: null, ids: [] }); })()`);
  await sleep(500);

  const stats = (label, ms) =>
    app.evaluate(`(() => { const p = ${D}.perf; return { label: ${JSON.stringify(label)}, seconds: ${ms / 1000}, drawsPerSec: +(p.draws / ${ms / 1000}).toFixed(1), avgDrawMs: +(p.drawMs / Math.max(1, p.draws)).toFixed(2), maxDrawMs: +p.maxDrawMs.toFixed(1), blankDraws: p.blankDraws, blankPct: +(100 * p.blankDraws / Math.max(1, p.draws)).toFixed(1), seeks: p.seeks, avgSeekMs: +(p.seekMs / Math.max(1, p.seeks)).toFixed(1), maxSeekMs: +p.maxSeekMs.toFixed(0), driftSeeks: p.driftSeeks, longTasks: window.__long.n, longTaskMaxMs: +window.__long.max.toFixed(0) }; })()`);

  // Playback: count distinct presented video frames with requestVideoFrameCallback.
  await app.evaluate(`${D}.player.seek(0)`);
  await sleep(600);
  await app.evaluate(`(() => { window.__vfc = 0; const v = [...document.querySelectorAll('video')][0]; })()`);
  await app.evaluate(`${D}.perf.reset(); window.__long = { n: 0, ms: 0, max: 0 }`);
  await app.evaluate(`${D}.player.play()`);
  await sleep(5000);
  out.playback = await stats('playback 5 s', 5000);
  out.playback.timeReached = await app.evaluate(`+(${D}.playhead.getState().time / 705600000).toFixed(2)`);
  await app.evaluate(`${D}.player.pause()`);
  await sleep(500);

  // Scrubbing: drag the playhead across 0 → 15 s in 3 s at ~60 Hz (what the ruler drag does).
  await app.evaluate(`${D}.perf.reset(); window.__long = { n: 0, ms: 0, max: 0 }`);
  await app.evaluate(`new Promise((res) => { const t0 = performance.now(); const step = () => { const e = performance.now() - t0; if (e > 3000) return res(); ${D}.player.seek(${D}.time.secondsToFlicks(15 * e / 3000)); requestAnimationFrame(step); }; step(); })`);
  out.scrub = await stats('scrub 3 s', 3000);
  await sleep(800);
  // After scrubbing stops, the preview must settle on the FULL-resolution frame at the exact time.
  out.settled = await app.evaluate(`(() => { const p = ${D}.editor().project; const v = p.media.find(m => m.kind === 'video');
    const f = ${D}.player.frameFor(v.id); const el = f && f.image;
    return { fullRes: !!el && el.videoWidth === v.width, scale: f && f.scaleX, time: el && +el.currentTime.toFixed(3), playhead: +(${D}.playhead.getState().time / 705600000).toFixed(3) }; })()`);

  // Frame stepping: 30 single-frame steps.
  await app.evaluate(`${D}.perf.reset(); window.__long = { n: 0, ms: 0, max: 0 }`);
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await app.key('ArrowRight', 'ArrowRight');
    await sleep(33);
  }
  await sleep(400);
  out.step = await stats('30 frame steps', Date.now() - t0);
  out.errors = app.consoleLines.filter((l) => /error|exception/i.test(l));
} finally {
  await app.close();
}
console.log(JSON.stringify(out, null, 1));
const checks = [
  ['no blank frames during playback', out.playback.blankDraws === 0],
  ['no stall seeks during playback', out.playback.driftSeeks === 0],
  ['no blank frames while scrubbing', out.scrub.blankDraws === 0],
  ['scrubbing updates ≥ 30 pictures/s', out.scrub.seeks / 3 >= 30],
  ['no blank frames while frame-stepping', out.step.blankDraws === 0],
  ['settles on the full-resolution frame at the playhead', out.settled.fullRes && Math.abs(out.settled.time - out.settled.playhead) < 0.02],
];
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);

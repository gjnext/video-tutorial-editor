// Full editing scenario against the real built app (spec §18, Tests 5, 6, 9).
// Usage: node tests/e2e/scenario.mjs [--packaged "/path/Tutorial Studio.app"]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './driver.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'tests/.output/e2e');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const BIN = path.join(ROOT, 'native/.build/release');
const VIDEO = path.join(ROOT, 'tests/fixtures/saas-8s.mp4');
const AUDIO = path.join(ROOT, 'tests/fixtures/narration-18s.wav');
const pkgIdx = process.argv.indexOf('--packaged');
const executable = pkgIdx > 0 ? path.join(process.argv[pkgIdx + 1], 'Contents/MacOS/Tutorial Studio') : undefined;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const helper = (bin, args) => {
  const out = execFileSync(path.join(BIN, bin), args, { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
};

const app = await launch({ appPath: ROOT, executable });
const D = 'window.__studioDebug';
try {
  await sleep(1200);
  // ---------------------------------------------------------------- import
  await app.evaluate(`(async () => { const r = await window.studio.media.importPaths(${JSON.stringify([VIDEO, AUDIO])}); ${D}.actions.addAssets(r.assets); return r.errors; })()`);
  await sleep(2500);
  const st = await app.evaluate(`(() => { const s = ${D}.editor(); return { media: s.project.media.length, segs: s.project.video.segments.length, audio: s.project.audio.length, thumbs: Object.keys(s.thumbnails).length, waves: Object.keys(s.waveforms).length }; })()`);
  check('import video + narration', st.media === 2 && st.segs === 1 && st.audio === 1, JSON.stringify(st));
  check('real thumbnails and waveform decoded', st.thumbs === 1 && st.waves === 1);

  // ---------------------------------------------------------------- composition
  await app.evaluate(`(() => { const e = ${D}.editor(); e.commit(p => ({ ...p, background: { kind: 'preset', id: 'blue-violet-soft' }, video: { ...p.video, crop: { left: 0, top: 122/1200, right: 0, bottom: 0 }, layout: { ...p.video.layout, cornerRadius: 0.018 } } })); })()`);
  // Narration at 0.5 s.
  await app.evaluate(`(() => { const e = ${D}.editor(); e.commit(p => ({ ...p, audio: p.audio.map(c => ({ ...c, start: ${D}.time.secondsToFlicks(0.5) })) })); })()`);

  // ---------------------------------------------------------------- cursor via real clicks
  await app.key('k', 'KeyK');
  const mode = await app.evaluate(`${D}.editor().mode`);
  check('K enters cursor mode', mode === 'cursor');
  const clickAtSource = async (sec, u, v, alt = false) => {
    await app.evaluate(`${D}.player.seek(${D}.time.secondsToFlicks(${sec}))`);
    await sleep(150);
    const pt = await app.evaluate(`(() => {
      const cv = document.querySelector('.stage-canvas-wrap canvas'); const r = cv.getBoundingClientRect();
      const p = ${D}.editor().project; const size = { width: cv.width, height: cv.height };
      const pl = ${D}.compose.placementFor(p, p.media.find(m => m.kind === 'video'), size);
      const c = ${D}.geometry.sourceToCanvas({ x: ${u}, y: ${v} }, pl);
      return { x: r.left + c.x / cv.width * r.width, y: r.top + c.y / cv.height * r.height };
    })()`);
    await app.click(pt.x, pt.y, alt ? { modifiers: 1 } : {});
    await sleep(120);
  };
  await clickAtSource(1.0, 0.45, 0.5);
  await clickAtSource(2.5, 90 / 1920, 416 / 1200);
  await clickAtSource(5.0, (1920 - 170) / 1920, 177 / 1200);
  const kfs = await app.evaluate(`${D}.editor().project.cursor.keyframes.map(k => ({ t: k.time / 705600000, x: k.x, y: k.y }))`);
  const kfOk = kfs.length === 3 && Math.abs(kfs[1].x - 90 / 1920) < 0.003 && Math.abs(kfs[1].y - 416 / 1200) < 0.004;
  check('3 keyframes placed by clicking the preview', kfOk, JSON.stringify(kfs.map((k) => [k.t, +k.x.toFixed(4), +k.y.toFixed(4)])));
  // Click synced at 2.7 s via the C shortcut.
  await app.evaluate(`${D}.player.seek(${D}.time.secondsToFlicks(2.7))`);
  await app.key('c', 'KeyC');
  const clicks = await app.evaluate(`${D}.editor().project.cursor.clicks.length`);
  check('C adds a click at the playhead', clicks === 1);
  // Mid-movement the synthetic cursor is between targets (generated motion).
  const mid = await app.evaluate(`(() => { const p = ${D}.editor().project; const f = ${D}.compose.composeFrame(p, ${D}.time.secondsToFlicks(2.3), { width: 2560, height: 1440 }); return f.overlay.find(o => o.op === 'cursor'); })()`);
  check('cursor motion generated between keyframes', !!mid && mid.x > 0, mid ? `x=${mid.x.toFixed(1)} y=${mid.y.toFixed(1)}` : '');
  await app.evaluate(`${D}.player.seek(${D}.time.secondsToFlicks(2.0))`);
  await sleep(400);
  await app.screenshot(path.join(OUT, '1-cursor-mode.png'));

  // ---------------------------------------------------------------- freeze
  await app.key('Escape', 'Escape');
  await app.evaluate(`${D}.player.seek(${D}.time.secondsToFlicks(3.0))`);
  await app.evaluate(`${D}.actions.insertFreeze(4)`);
  const after = await app.evaluate(`(() => { const p = ${D}.editor().project; return { kinds: p.video.segments.map(s => s.kind), dur: p.video.segments.reduce((a, s) => a + (s.kind === 'clip' ? s.sourceOut - s.sourceIn : s.duration), 0) / 705600000, kf3: p.cursor.keyframes.map(k => k.time / 705600000).sort((a,b)=>a-b)[2], audioStart: p.audio[0].start / 705600000 }; })()`);
  check('freeze extends 8 s → 12 s', after.dur === 12 && after.kinds.join() === 'clip,freeze,clip', JSON.stringify(after));
  check('cursor ripples, narration stays', after.kf3 === 9 && after.audioStart === 0.5);
  await app.evaluate(`${D}.editor().set({ pxPerSecond: 110 })`);
  await app.evaluate(`${D}.player.seek(${D}.time.secondsToFlicks(5.0))`);
  await sleep(500);
  await app.screenshot(path.join(OUT, '2-freeze.png'));

  // ---------------------------------------------------------------- playback
  await app.evaluate(`${D}.player.seek(0)`);
  await app.evaluate(`${D}.player.play()`);
  await sleep(1500);
  const playing = await app.evaluate(`({ t: ${D}.playhead.getState().time / 705600000, playing: ${D}.playhead.getState().playing })`);
  await app.evaluate(`${D}.player.pause()`);
  check('playback advances on the audio clock', playing.playing && playing.t > 1.2 && playing.t < 1.9, `t=${playing.t.toFixed(2)}`);

  // ---------------------------------------------------------------- undo/redo
  const n0 = await app.evaluate(`${D}.editor().project.cursor.clicks.length`);
  await app.evaluate(`${D}.editor().undo()`);
  const segAfterUndo = await app.evaluate(`${D}.editor().project.video.segments.length`);
  await app.evaluate(`${D}.editor().redo()`);
  const segAfterRedo = await app.evaluate(`${D}.editor().project.video.segments.length`);
  check('undo/redo of freeze', segAfterUndo === 1 && segAfterRedo === 3 && n0 === 1);

  // ---------------------------------------------------------------- save / reopen (Test 5)
  const pkg = path.join(OUT, 'E2E Tutorial.tvproj');
  const before = await app.evaluate(`JSON.stringify((({ media, ...p }) => ({ ...p, modifiedAt: 0 }))(${D}.editor().project))`);
  const saved = await app.evaluate(`(async () => { const r = await window.studio.project.save({ project: ${D}.editor().project, path: ${JSON.stringify(pkg)}, saveAs: false }); ${D}.editor().markSaved(r.project, r.path); return r.project.media.map(m => m.relPath); })()`);
  check('project saved as self-contained package', existsSync(path.join(pkg, 'project.json')) && saved.every((r) => r && r.startsWith('media/')) && existsSync(path.join(pkg, 'media/saas-8s.mp4')), JSON.stringify(saved));
  await app.evaluate(`${D}.editor().load(${D}.editor().project.constructor === Object ? (await import('data:text/javascript,export default 0')).default && ${D}.editor().project : null, null)`).catch(() => {});
  const reopened = await app.evaluate(`(async () => { const r = await window.studio.project.open(${JSON.stringify(pkg)}); ${D}.editor().load(r.project, r.path); return { missing: r.missing, json: JSON.stringify((({ media, ...p }) => ({ ...p, modifiedAt: 0 }))(r.project)) }; })()`);
  const a = JSON.parse(before);
  const b = JSON.parse(reopened.json);
  delete a.name;
  delete b.name;
  check('reopened project restores every edit', reopened.missing.length === 0 && JSON.stringify(a) === JSON.stringify(b));
  await sleep(1500);

  // ---------------------------------------------------------------- export (Test 6)
  const mp4 = path.join(OUT, 'e2e-1440p.mp4');
  const t0 = Date.now();
  const done = await app.evaluate(`new Promise(async (res) => {
    const off = window.studio.render.onEvent(e => { if (e.type === 'done' || e.type === 'error') { off(); res(e); } });
    await window.studio.render.start({ project: ${D}.editor().project, outputPath: ${JSON.stringify(mp4)} });
  })`);
  check('export through the app pipeline', done.type === 'done', done.type === 'done' ? `${(done.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s` : done.message);
  if (done.type === 'done') {
    const pr = helper('studio-render', ['probe', mp4]);
    check('exported 2560×1440 H.264 + AAC, 12 s', pr.width === 2560 && pr.height === 1440 && pr.codec === 'avc1' && pr.hasAudio && Math.abs(pr.duration - 12) < 0.1, JSON.stringify(pr));
    const beeps = helper('studio-fixtures', ['beeps', mp4, '0.2']);
    check('narration in sync in export', beeps.onsets.length === 3 && Math.abs(beeps.onsets[0] - 1.5) < 0.01 && Math.abs(beeps.onsets[2] - 10.5) < 0.01, JSON.stringify(beeps.onsets.map((x) => +x.toFixed(4))));

    // ---------------------------------------------------------------- preview vs export (Test 9)
    for (const sec of [2.0, 2.8, 5.0, 9.5]) {
      await app.evaluate(`${D}.player.seek(${D}.time.secondsToFlicks(${sec}))`);
      await sleep(700);
      const dataUrl = await app.evaluate(`document.querySelector('.stage-canvas-wrap canvas').toDataURL('image/png')`);
      const pv = path.join(OUT, `preview-${sec}.png`);
      (await import('node:fs')).writeFileSync(pv, Buffer.from(dataUrl.split(',')[1], 'base64'));
      const dims = helper('studio-fixtures', ['pixels', pv, '0,0']);
      // Decode the exported MP4 with Chromium (the YouTube/browser viewing path) at preview size.
      const exUrl = await app.evaluate(`new Promise((res) => {
        const v = document.createElement('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.src = window.studio.media.url(${JSON.stringify(mp4)});
        v.addEventListener('loadeddata', () => { v.currentTime = ${sec} + 1 / 60; }, { once: true });
        v.addEventListener('seeked', () => { const c = document.createElement('canvas'); c.width = ${dims.width}; c.height = ${dims.height};
          const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(v, 0, 0, c.width, c.height); res(c.toDataURL('image/png')); }, { once: true });
      })`);
      (await import('node:fs')).writeFileSync(path.join(OUT, `export-${sec}-scaled.png`), Buffer.from(exUrl.split(',')[1], 'base64'));
      const cmp = helper('studio-fixtures', ['compare', pv, path.join(OUT, `export-${sec}-scaled.png`), '64']);
      check(`preview ≈ export at ${sec}s`, cmp.mean < 6 && cmp.count / (dims.width * dims.height) < 0.01, `mean Δ=${cmp.mean.toFixed(2)}, strong-diff px=${((cmp.count / (dims.width * dims.height)) * 100).toFixed(3)}%`);
    }
  }
  await app.screenshot(path.join(OUT, '3-after-export.png'));
} catch (e) {
  check('scenario completed', false, e.stack);
} finally {
  const errs = app.consoleLines.filter((l) => l.startsWith('[error]') || l.startsWith('[exception]'));
  check('no renderer errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  await app.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

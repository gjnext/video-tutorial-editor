// E2E for: cursor segments, timeline show/hide buttons, merged spotlights,
// theater + full screen, drag-reorder video / swap audio, shortcuts sheet.
// Usage: node tests/e2e/features.mjs [--packaged "/path/Tutorial Studio.app"]
import path from 'node:path';
import { launch, sleep } from './driver.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const pkgIdx = process.argv.indexOf('--packaged');
const app = await launch({ appPath: ROOT, executable: pkgIdx > 0 ? path.join(process.argv[pkgIdx + 1], 'Contents/MacOS/Tutorial Studio') : undefined });
const D = 'window.__studioDebug';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const S = (s) => `${D}.time.secondsToFlicks(${s})`;
const drag = async (from, to, steps = 12) => {
  await app.mouse('mouseMoved', from.x, from.y);
  await app.mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= steps; i++) await app.mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { buttons: 1 });
};
const release = (p) => app.mouse('mouseReleased', p.x, p.y);
const toScreen = (u, v) =>
  app.evaluate(`(() => { const cv = document.querySelector('.stage-canvas-wrap canvas'); const r = cv.getBoundingClientRect();
    const p = ${D}.editor().project; const pl = ${D}.compose.placementFor(p, p.media.find(m => m.kind === 'video'), { width: cv.width, height: cv.height });
    const c = ${D}.geometry.sourceToCanvas({ x: ${u}, y: ${v} }, pl); return { x: r.left + c.x / cv.width * r.width, y: r.top + c.y / cv.height * r.height }; })()`);
const canvasPixel = (u, v) =>
  app.evaluate(`(() => { const cv = document.querySelector('.stage-canvas-wrap canvas');
    const p = ${D}.editor().project; const pl = ${D}.compose.placementFor(p, p.media.find(m => m.kind === 'video'), { width: cv.width, height: cv.height });
    const c = ${D}.geometry.sourceToCanvas({ x: ${u}, y: ${v} }, pl); return [...cv.getContext('2d').getImageData(Math.round(c.x), Math.round(c.y), 1, 1).data].slice(0, 3); })()`);
const click = async (selectorText) => app.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(selectorText)}).click()`);

try {
  await sleep(1200);
  await app.evaluate(`(async () => { const r = await window.studio.media.importPaths(${JSON.stringify([path.join(ROOT, 'tests/fixtures/saas-8s.mp4'), path.join(ROOT, 'tests/fixtures/narration-18s.wav')])}); ${D}.actions.addAssets(r.assets); })()`);
  await sleep(2000);
  await app.evaluate(`document.querySelectorAll('.toast button').forEach(b => b.click()); ${D}.editor().set({ pxPerSecond: 90 })`);

  // ------------------------------------------------ 1. cursor segments
  await app.key('k', 'KeyK');
  for (const [t, u, v] of [[1, 0.3, 0.3], [2, 0.5, 0.4]]) {
    await app.evaluate(`${D}.player.seek(${S(t)})`);
    await sleep(120);
    const p = await toScreen(u, v);
    await app.click(p.x, p.y);
    await sleep(80);
  }
  await app.evaluate(`${D}.player.seek(${S(3)})`);
  await app.key(']', 'BracketRight');
  await app.evaluate(`${D}.player.seek(${S(5)})`);
  await sleep(150);
  const hint = await app.evaluate(`document.querySelector('.mode-hint')?.textContent ?? ''`);
  check('hint explains that clicking starts a new segment', /new cursor segment/.test(hint));
  const p5 = await toScreen(0.8, 0.2);
  await app.click(p5.x, p5.y);
  await sleep(150);
  const seg = await app.evaluate(`(() => { const c = ${D}.editor().project.cursor; const st = ${D}.compose.composeFrame(${D}.editor().project, ${S(5.2)}, { width: 1920, height: 1080 });
    return { vis: c.visibility.map(v => [v.time / 705600000, v.visible]), kfs: c.keyframes.length, dots: document.querySelectorAll('.stage-overlay text').length }; })()`);
  check('clicking while hidden adds a Show and starts a new segment', JSON.stringify(seg.vis) === JSON.stringify([[3, false], [5, true]]) && seg.kfs === 3, JSON.stringify(seg.vis));
  check('path overlay shows only the current segment', seg.dots === 1, `${seg.dots} point(s) drawn`);
  const pos = await app.evaluate(`(() => { const p = ${D}.editor().project; const pl = ${D}.compose.placementFor(p, p.media[0], { width: 1920, height: 1080 }); const op = ${D}.compose.composeFrame(p, ${S(5.2)}, { width: 1920, height: 1080 }).overlay.find(o => o.op === 'cursor'); const src = ${D}.geometry.canvasToSource({ x: op.x, y: op.y }, pl); return [+src.x.toFixed(3), +src.y.toFixed(3)]; })()`);
  check('cursor reappears at the new segment’s point (no travel from the old one)', Math.abs(pos[0] - 0.8) < 0.004 && Math.abs(pos[1] - 0.2) < 0.004, JSON.stringify(pos));

  // ------------------------------------------------ 2. show/hide/pause in the timeline toolbar
  const tb = await app.evaluate(`[...document.querySelectorAll('.timeline-toolbar button')].map(b => b.textContent.trim())`);
  const iClick = tb.indexOf('Click');
  check('Show / Hide / Pause buttons sit right after Click', tb[iClick + 1] === 'Show' && tb[iClick + 2] === 'Hide' && tb[iClick + 3] === 'Pause 1s', tb.slice(iClick, iClick + 4).join(' | '));
  await app.evaluate(`${D}.player.seek(${S(6.5)})`);
  await click('Hide');
  const nVis = await app.evaluate(`${D}.editor().project.cursor.visibility.length`);
  check('toolbar Hide adds a marker', nVis === 3);
  await app.key('Escape', 'Escape');
  await app.key('Escape', 'Escape');

  // ------------------------------------------------ 3. two spotlights merge
  await app.evaluate(`${D}.player.seek(${S(1.5)})`);
  await sleep(400);
  const before = await Promise.all([[0.3, 0.42], [0.42, 0.45], [0.75, 0.8]].map(([u, v]) => canvasPixel(u, v)));
  await app.key('h', 'KeyH');
  await click('Spotlight');
  let a0 = await toScreen(0.2, 0.3), a1 = await toScreen(0.45, 0.55);
  await drag(a0, a1);
  await release(a1);
  await sleep(150);
  await click('Spot circle');
  a0 = await toScreen(0.36, 0.32);
  a1 = await toScreen(0.56, 0.62);
  await drag(a0, a1);
  await release(a1);
  await sleep(400);
  const hls = await app.evaluate(`${D}.editor().project.highlights.map(h => h.shape)`);
  check('two spotlights of different shapes drawn by dragging', JSON.stringify(hls) === '["spotlight","spot-ellipse"]', JSON.stringify(hls));
  await app.evaluate(`${D}.editor().select({ kind: null, ids: [] }); ${D}.editor().set({ mode: 'select' }); ${D}.player.seek(${S(2.2)})`);
  await sleep(500);
  await app.evaluate(`${D}.player.seek(${S(1.5)})`);
  await sleep(500);
  const after = await Promise.all([[0.3, 0.42], [0.42, 0.45], [0.75, 0.8]].map(([u, v]) => canvasPixel(u, v)));
  const same = (x, y) => x.every((c, i) => Math.abs(c - y[i]) <= 3);
  check('box area and overlap stay bright (no seam), outside dims', same(after[0], before[0]) && same(after[1], before[1]) && after[2][0] < before[2][0] * 0.6, JSON.stringify({ before, after }));

  // ------------------------------------------------ 4. theater + full screen
  await app.key('t', 'KeyT');
  await sleep(500);
  const th = await app.evaluate(`(() => { const c = document.querySelector('.presentation.theater canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { w: r.width, h: r.height, W: innerWidth, H: innerHeight }; })()`);
  check('theater view fills ~80 % of the window', !!th && (Math.abs(th.w - th.W * 0.8) < 3 || Math.abs(th.h - (th.H * 0.8 - 52)) < 3), JSON.stringify(th));
  await app.key('Escape', 'Escape');
  await sleep(200);
  check('Esc closes theater', !(await app.evaluate(`!!document.querySelector('.presentation')`)));
  await app.evaluate(`${D}.player.seek(${S(6.6)})`);
  await sleep(200);
  await app.key('F', 'KeyF', { modifiers: 8 });
  await sleep(700);
  const fs = await app.evaluate(`({ fs: !!document.fullscreenElement, playing: ${D}.playhead.getState().playing })`);
  check('⇧F plays in full screen', fs.fs && fs.playing, JSON.stringify(fs));
  await sleep(2200);
  const fsEnd = await app.evaluate(`({ fs: !!document.fullscreenElement, open: !!document.querySelector('.presentation'), t: ${D}.playhead.getState().time / 705600000 })`);
  check('full screen closes automatically when playback ends', !fsEnd.fs && !fsEnd.open, JSON.stringify(fsEnd));
  await sleep(600);

  // ------------------------------------------------ 5. drag to reorder video, swap audio
  await app.evaluate(`${D}.player.seek(${S(3)}); ${D}.editor().select({ kind: null, ids: [] }); ${D}.actions.splitAtPlayhead(); ${D}.editor().select({ kind: null, ids: [] })`);
  await sleep(300);
  const clips = await app.evaluate(`[...document.querySelectorAll('.clip.video')].map(e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left }; })`);
  await drag(clips[1], { x: clips[0].l + 8, y: clips[1].y });
  const live = await app.evaluate(`${D}.editor().project.video.segments.map(s => s.sourceIn / 705600000)`);
  await release({ x: clips[0].l + 8, y: clips[1].y });
  await sleep(200);
  const reordered = await app.evaluate(`${D}.editor().project.video.segments.map(s => s.sourceIn / 705600000)`);
  check('video clips re-flow live while dragging', JSON.stringify(live) === '[3,0]', JSON.stringify(live));
  check('dropping keeps the new order', JSON.stringify(reordered) === '[3,0]');
  await app.evaluate(`${D}.editor().undo()`);
  check('one undo restores the order', JSON.stringify(await app.evaluate(`${D}.editor().project.video.segments.map(s => s.sourceIn / 705600000)`)) === '[0,3]');
  // Audio: split narration into two clips with a gap, then drag the first past the second.
  await app.evaluate(`(() => { const e = ${D}.editor(); const S = ${D}.time.secondsToFlicks; e.commit(p => ({ ...p, audio: [{ ...p.audio[0], id: 'n1', start: S(0.5), sourceIn: 0, sourceOut: S(2) }, { ...p.audio[0], id: 'n2', start: S(3.5), sourceIn: S(4), sourceOut: S(7) }] })); })()`);
  await sleep(300);
  const ac = await app.evaluate(`[...document.querySelectorAll('.clip.narration')].map(e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, r: b.right }; })`);
  await drag(ac[0], { x: ac[1].x + 30, y: ac[0].y });
  await release({ x: ac[1].x + 30, y: ac[0].y });
  await sleep(200);
  const swapped = await app.evaluate(`${D}.editor().project.audio.map(c => [c.id, +(c.start / 705600000).toFixed(3)]).sort((a, b) => a[1] - b[1])`);
  check('dragging an audio clip past its neighbour swaps them (gap kept)', JSON.stringify(swapped) === JSON.stringify([['n2', 0.5], ['n1', 4.5]]), JSON.stringify(swapped));

  // ------------------------------------------------ 6. shortcuts
  await click('Shortcuts');
  await sleep(200);
  const groups = await app.evaluate(`[...document.querySelectorAll('.shortcut-group .section-title')].map(e => e.textContent)`);
  check('Shortcuts button opens the grouped shortcut sheet', groups.length === 5, groups.join(' | '));
  await app.key('Escape', 'Escape');
} catch (e) {
  check('features run completed', false, e.stack);
} finally {
  const errs = app.consoleLines.filter((l) => /\[(error|exception)\]/.test(l));
  check('no renderer errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await app.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);

// Test 7: real ScreenCaptureKit recording through the PACKAGED app.
// Requires Screen Recording permission for "Tutorial Studio" (System Settings).
// Usage: node tests/e2e/record.mjs "release/mac-arm64/Tutorial Studio.app"
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launch, sleep } from './driver.mjs';

const appPath = process.argv[2] ?? 'release/mac-arm64/Tutorial Studio.app';
const app = await launch({ bundle: path.resolve(appPath), port: 9334 });
let code = 0;
try {
  await sleep(1200);
  const perm = await app.evaluate('window.studio.recording.permission()');
  console.log('permission:', perm);
  if (perm !== 'granted') {
    console.log('BLOCKED  Grant Screen Recording to Tutorial Studio in System Settings → Privacy & Security, then rerun.');
    code = 2;
  } else {
    const src = await app.evaluate('window.studio.recording.listSources()');
    console.log(`sources: ${src.displays.length} display(s), ${src.windows.length} window(s)`);
    const d = src.displays[0];
    const ev = await app.evaluate(`new Promise(async (res) => {
      const log = [];
      const off = window.studio.recording.onEvent(e => { log.push(e.type); if (e.type === 'started') setTimeout(() => window.studio.recording.stop(), 2500);
        if (e.type === 'finished' || e.type === 'error') { off(); res({ ...e, log }); } });
      await window.studio.recording.start({ mode: 'display', displayId: ${d.id}, fps: 60, countdown: 1, showCursor: false, selfTest: true });
    })`);
    console.log('events:', ev.log.join(' → '));
    if (ev.type !== 'finished') throw new Error(ev.message);
    const a = ev.asset;
    console.log(`recording: ${a.path}\n  ${a.width}×${a.height}, ${(a.duration / 705600000).toFixed(2)}s, ${a.frameRate?.toFixed(1)} fps, origin=${a.origin}`);
    const okDims = a.width === Math.round(d.width * d.scale) && a.height === Math.round(d.height * d.scale);
    console.log(`${okDims ? 'PASS' : 'FAIL'}  frame dimensions match display pixels (${d.width}×${d.height}pt @${d.scale}x)`);
    const st = ev.selfTest ?? {};
    console.log('self-test:', JSON.stringify(st));
    if (st.conclusive) console.log(`${st.cursorAbsent ? 'PASS' : 'FAIL'}  system cursor absent from recording`);
    else console.log('INCONCLUSIVE  cursor not detected in screenshots (move the pointer onto the main display and rerun)');
    const png = path.resolve('tests/.output/recording-frame.png');
    execFileSync('native/.build/release/studio-render', ['extract-frame', a.path, '1.0', png]);
    console.log(`frame saved: ${png}`);
    if (!okDims || (st.conclusive && !st.cursorAbsent)) code = 1;
  }
} catch (e) {
  console.log('FAIL', e.message);
  code = 1;
} finally {
  await app.close();
}
process.exit(code);

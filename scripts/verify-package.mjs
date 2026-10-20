// Verifies the packaged .app: bundle contents, helper executables, code signatures.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('release');
const sub = readdirSync(dir).find((d) => d.startsWith('mac') && existsSync(path.join(dir, d, 'Tutorial Studio.app')));
if (!sub) throw new Error('No packaged app found in release/');
const app = path.join(dir, sub, 'Tutorial Studio.app');
let failed = 0;
const check = (name, fn) => {
  try {
    const d = fn();
    console.log(`PASS  ${name}${d ? ` — ${d}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name} — ${e.message}`);
  }
};
const run = (bin, args) => JSON.parse(execFileSync(path.join(app, 'Contents/MacOS', bin), args, { encoding: 'utf8' }).trim().split('\n').pop());
check('studio-render bundled, executable, decodes media', () => {
  accessSync(path.join(app, 'Contents/MacOS/studio-render'), constants.X_OK);
  const r = run('studio-render', ['probe', path.resolve('tests/fixtures/saas-8s.mp4')]);
  if (r.width !== 1920) throw new Error(JSON.stringify(r));
  return `probe → ${r.width}×${r.height} ${r.codec}`;
});
check('studio-recorder bundled and executable', () => {
  accessSync(path.join(app, 'Contents/MacOS/studio-recorder'), constants.X_OK);
  return `permission query → ${run('studio-recorder', ['permission']).status}`;
});
check('renderer bundle in app.asar', () => {
  const list = execFileSync('npx', ['asar', 'list', path.join(app, 'Contents/Resources/app.asar')], { encoding: 'utf8' });
  if (!list.includes('/dist/renderer/index.html') || !list.includes('/dist/electron/main.cjs') || !list.includes('/dist/electron/preload.cjs')) throw new Error('missing files');
  return 'index.html, main.cjs, preload.cjs, planWorker.cjs';
});
check('code signature valid (ad-hoc, deep, strict)', () => {
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  return 'ok';
});
check('helpers signed', () => {
  for (const h of ['studio-render', 'studio-recorder']) execFileSync('codesign', ['--verify', path.join(app, 'Contents/MacOS', h)], { stdio: 'pipe' });
  return 'ok';
});
console.log(`\napp: ${app}`);
process.exit(failed ? 1 : 0);

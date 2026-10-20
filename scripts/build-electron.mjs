// Bundles the Electron main process, plan worker and preload with esbuild.
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
  outExtension: { '.js': '.cjs' },
  outdir: 'dist/electron',
};
const configs = [
  { ...common, entryPoints: { main: 'electron/main/main.ts', planWorker: 'electron/main/planWorker.ts' } },
  // Sandboxed preload: single CJS file, only `electron` may be required.
  { ...common, entryPoints: { preload: 'electron/preload/preload.ts' } },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}

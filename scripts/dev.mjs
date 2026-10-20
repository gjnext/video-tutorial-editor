// Development: Vite dev server (HMR) + esbuild watch for main/preload + Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = `http://localhost:${server.config.server.port}/`;
const esb = spawn(process.execPath, ['scripts/build-electron.mjs', '--watch'], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const electronBin = (await import('electron')).default;
const app = spawn(electronBin, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
app.on('exit', async () => {
  esb.kill();
  await server.close();
  process.exit(0);
});

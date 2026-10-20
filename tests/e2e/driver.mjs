// Minimal Chrome DevTools Protocol driver for the real Electron app.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function launch({ appPath, port = 9333, env = {}, executable, bundle } = {}) {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'studio-e2e-'));
  let proc;
  if (bundle) {
    // Launch through LaunchServices (like a Finder double-click) so macOS treats the
    // app itself as the responsible process for privacy permissions (TCC).
    const envArgs = Object.entries({ STUDIO_USER_DATA: userData, ...env }).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    proc = spawn('open', ['-n', '-W', '-a', bundle, ...envArgs, '--args', `--remote-debugging-port=${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const bin = executable ?? (await import('electron')).default;
    const args = executable ? [`--remote-debugging-port=${port}`] : [appPath ?? '.', `--remote-debugging-port=${port}`];
    proc = spawn(bin, args, { env: { ...process.env, STUDIO_USER_DATA: userData, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && !t.url.includes('#hud') && !t.url.startsWith('devtools'));
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error(`App did not start.\n${log}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(`[${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`[exception] ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  const mouse = async (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
  const click = async (x, y, extra = {}) => {
    await mouse('mouseMoved', x, y, extra);
    await mouse('mousePressed', x, y, extra);
    await mouse('mouseReleased', x, y, extra);
  };
  const key = async (key, code, extra = {}) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...extra });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, ...extra });
  };
  const close = async () => {
    try {
      // Quit the whole app via the browser endpoint (needed when launched through `open`).
      const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const bws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise((r) => (bws.onopen = r));
      bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await new Promise((r) => setTimeout(r, 800));
    } catch {}
    try {
      ws.close();
    } catch {}
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };
  return { send, evaluate, screenshot, mouse, click, key, close, proc, consoleLines, log: () => log, userData };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

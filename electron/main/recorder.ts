/**
 * Recording sessions: supervise studio-recorder, run the countdown in a small
 * always-on-top HUD window, and hand the finalized file to the editor.
 */
import { BrowserWindow, globalShortcut, screen, shell } from 'electron';
import path from 'node:path';
import type { CaptureSources, PermissionState, RecordingConfig, RecordingEvent } from '../../shared/ipc';
import { allowDir, mediaUrl, probeToAsset } from './media';
import { runHelper, startHelper, type HelperHandle } from './native';
import { dirs } from './paths';

let session: { helper: HelperHandle; config: RecordingConfig; output: string; stopping: boolean } | null = null;
let hud: BrowserWindow | null = null;

type Emit = (e: RecordingEvent) => void;

export async function permission(): Promise<PermissionState> {
  try {
    const r = await runHelper('studio-recorder', ['permission'], 15_000);
    return r.status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unknown';
  }
}

export async function requestPermission(): Promise<PermissionState> {
  try {
    const r = await runHelper('studio-recorder', ['request-permission'], 120_000);
    return r.status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unknown';
  }
}

export function openPermissionSettings() {
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
}

export async function listSources(): Promise<CaptureSources> {
  const dir = path.join(dirs.cache(), 'capture-thumbs');
  allowDir(dir);
  const r = (await runHelper('studio-recorder', ['list', dir, String(process.pid)], 60_000)) as unknown as CaptureSources;
  const url = (p?: string) => (p ? `${mediaUrl(p)}?t=${Date.now()}` : undefined);
  return {
    displays: r.displays.map((d) => ({ ...d, thumbnail: url(d.thumbnail) })),
    windows: r.windows.map((w) => ({ ...w, thumbnail: url(w.thumbnail) })),
  };
}

function timestampName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.mp4`;
}

function showHud(loadHud: (w: BrowserWindow) => void) {
  const area = screen.getPrimaryDisplay().workArea;
  hud = new BrowserWindow({
    width: 236,
    height: 52,
    x: Math.round(area.x + area.width / 2 - 118),
    y: area.y + 12,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: true,
    focusable: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  hud.setAlwaysOnTop(true, 'floating');
  hud.setVisibleOnAllWorkspaces(true);
  loadHud(hud);
  hud.once('ready-to-show', () => hud?.showInactive());
}

function closeHud() {
  if (hud && !hud.isDestroyed()) hud.close();
  hud = null;
}

export function sendToHud(e: RecordingEvent) {
  if (hud && !hud.isDestroyed()) hud.webContents.send('recording:event', e);
}

export async function startRecording(main: BrowserWindow, config: RecordingConfig, emit: Emit, loadHud: (w: BrowserWindow) => void) {
  if (session) throw new Error('A recording is already in progress.');
  const output = path.join(dirs.recordings(), timestampName());
  const args = { ...config, output, excludePid: process.pid, showCursor: !!config.showCursor, selfTest: !!config.selfTest };
  const both: Emit = (e) => {
    emit(e);
    sendToHud(e);
  };
  let countdownTimer: NodeJS.Timeout | null = null;
  const helper = startHelper('studio-recorder', ['record', JSON.stringify(args)], (m) => {
    if (m.type === 'event' && m.event === 'ready') {
      // Get the editor out of the way, then count down in the HUD.
      main.minimize();
      showHud(loadHud);
      let remaining = Math.max(0, Math.round(config.countdown));
      const tick = () => {
        if (!session || session.stopping) return;
        if (remaining <= 0) {
          helper.send('start');
          return;
        }
        both({ type: 'countdown', remaining });
        remaining -= 1;
        countdownTimer = setTimeout(tick, 1000);
      };
      setTimeout(tick, 350);
    } else if (m.type === 'event' && m.event === 'started') {
      // Global stop shortcut while recording (the editor window is minimized).
      globalShortcut.register('CommandOrControl+Shift+2', stopRecording);
      both({ type: 'started' });
    } else if (m.type === 'progress') {
      both({ type: 'progress', seconds: Number(m.seconds ?? 0), frames: Number(m.frames ?? 0) });
    } else if (m.type === 'event' && m.event === 'finalizing') {
      both({ type: 'finalizing' });
    } else if (m.type === 'event' && m.event === 'cancelled') {
      both({ type: 'cancelled' });
    }
  });
  session = { helper, config, output, stopping: false };
  helper.done
    .then(async (res) => {
      if (countdownTimer) clearTimeout(countdownTimer);
      closeHud();
      restore(main);
      // Only report success once the file is finalized and probes as playable media.
      const asset = await probeToAsset(String(res.path), 'recorded');
      emit({ type: 'finished', asset, selfTest: res.selfTest as Record<string, unknown> | undefined });
    })
    .catch((e: Error & { code?: string }) => {
      if (countdownTimer) clearTimeout(countdownTimer);
      closeHud();
      restore(main);
      if (session?.stopping && /cancel/i.test(e.message)) emit({ type: 'cancelled' });
      else emit({ type: 'error', message: e.message, code: e.code });
    })
    .finally(() => {
      globalShortcut.unregister('CommandOrControl+Shift+2');
      session = null;
    });
}

function restore(main: BrowserWindow) {
  if (main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

export function stopRecording() {
  if (!session) return;
  session.stopping = true;
  session.helper.send('stop');
  // Safety net: kill if finalization hangs.
  const h = session.helper;
  setTimeout(() => h.kill(), 30_000);
}

export function cancelRecording() {
  if (!session) return;
  session.stopping = true;
  session.helper.send('cancel');
  const h = session.helper;
  setTimeout(() => h.kill(), 10_000);
}

export function isRecording() {
  return !!session;
}

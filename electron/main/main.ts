/**
 * Electron main process: window lifecycle, menus, the media protocol, and the
 * privileged IPC surface (validated) used by the sandboxed React renderer.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { migrateProject, PROJECT_EXTENSION, type MediaAsset } from '../../shared/schema';
import type { RecordingConfig, RecordingEvent, SaveProjectRequest } from '../../shared/ipc';
import { buildMenu } from './menu';
import { allowDir, allowFile, AUDIO_EXTS, handleMediaProtocol, IMAGE_EXTS, importPaths, kindForPath, mediaUrl, probeToAsset, proxyFor, registerMediaScheme, thumbnails, VIDEO_EXTS } from './media';
import { clearRecovery, ensurePackagePath, isProjectPackage, openProject, readRecovery, recentProjects, saveProject, writeRecovery } from './project';
import { cancelAllExports, cancelExport, startExport } from './exporter';
import { cancelRecording, isRecording, listSources, openPermissionSettings, permission, requestPermission, startRecording, stopRecording } from './recorder';
import { killAllHelpers } from './native';
import { dirs } from './paths';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
let win: BrowserWindow | null = null;
let dirty = false;
let closeConfirmed = false;
let pendingOpen: string | null = null;

registerMediaScheme();
// Isolated profile for automated tests (never set in normal use).
if (process.env.STUDIO_USER_DATA) app.setPath('userData', process.env.STUDIO_USER_DATA);

// ---------------------------------------------------------------- validation helpers

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096) throw new Error(`Invalid ${name}`);
  return v;
}
function absPath(v: unknown, name: string): string {
  const s = str(v, name);
  if (!path.isAbsolute(s) || s.includes('\0')) throw new Error(`Invalid ${name}`);
  return path.normalize(s);
}
function asset(v: unknown): MediaAsset {
  if (!v || typeof v !== 'object') throw new Error('Invalid media asset');
  const a = v as MediaAsset;
  absPath(a.path, 'asset path');
  str(a.id, 'asset id');
  return a;
}
function fromMainWindow(e: IpcMainInvokeEvent) {
  // Only the editor window may invoke privileged operations.
  if (!win || e.sender !== win.webContents) throw new Error('Unauthorized sender');
}

// ---------------------------------------------------------------- window

function rendererEntry(w: BrowserWindow, hash = '') {
  if (DEV_URL) w.loadURL(DEV_URL + (hash ? `#${hash}` : ''));
  else w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), hash ? { hash } : undefined);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: 'Tutorial Studio',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#141518',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  rendererEntry(win);
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    e.preventDefault();
  });
  win.on('close', (e) => {
    if (!dirty || closeConfirmed) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save the changes to this project?',
      detail: "Your changes will be lost if you don't save them.",
    });
    if (choice === 0) win!.webContents.send('app:before-close');
    else if (choice === 1) {
      closeConfirmed = true;
      clearRecovery();
      win!.close();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  refreshMenu();
}

function refreshMenu() {
  buildMenu(() => win, recentProjects, (p) => win?.webContents.send('project:open-path', p));
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('project:open', async (e, p?: unknown) => {
    fromMainWindow(e);
    let target = typeof p === 'string' ? absPath(p, 'project path') : null;
    if (!target) {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Open Project',
        properties: ['openFile', 'openDirectory', 'treatPackageAsDirectory'],
        filters: [{ name: 'Tutorial Studio Project', extensions: [PROJECT_EXTENSION] }],
        defaultPath: dirs.projects(),
      });
      if (r.canceled || !r.filePaths[0]) return null;
      target = r.filePaths[0];
      // Allow picking project.json inside a package as well.
      if (path.basename(target) === 'project.json') target = path.dirname(target);
    }
    if (!isProjectPackage(target)) throw new Error(`${path.basename(target)} is not a Tutorial Studio project.`);
    const res = openProject(target);
    refreshMenu();
    return res;
  });

  ipcMain.handle('project:save', async (e, req: SaveProjectRequest) => {
    fromMainWindow(e);
    const project = migrateProject(req?.project);
    let target = req.path && !req.saveAs ? absPath(req.path, 'project path') : null;
    if (!target) {
      const r = await dialog.showSaveDialog(win!, {
        title: req.saveAs ? 'Save Project As' : 'Save Project',
        defaultPath: path.join(dirs.projects(), `${project.name || 'Untitled Project'}.${PROJECT_EXTENSION}`),
        filters: [{ name: 'Tutorial Studio Project', extensions: [PROJECT_EXTENSION] }],
        properties: ['createDirectory'],
      });
      if (r.canceled || !r.filePath) return null;
      target = ensurePackagePath(r.filePath);
      project.name = path.basename(target, `.${PROJECT_EXTENSION}`);
    }
    const saved = saveProject(project, target, true);
    clearRecovery();
    refreshMenu();
    return { path: target, project: saved };
  });

  ipcMain.handle('project:autosave', (e, project: unknown, pkg: unknown) => {
    fromMainWindow(e);
    const p = migrateProject(project);
    writeRecovery(p, typeof pkg === 'string' ? absPath(pkg, 'project path') : null);
    // A saved project is also updated in place (metadata only; media are copied on explicit save).
    if (typeof pkg === 'string' && isProjectPackage(pkg)) saveProject(p, pkg, false);
  });
  ipcMain.handle('project:recovery', (e) => {
    fromMainWindow(e);
    return readRecovery();
  });
  ipcMain.handle('project:clear-recovery', (e) => {
    fromMainWindow(e);
    clearRecovery();
  });
  ipcMain.handle('project:recent', (e) => {
    fromMainWindow(e);
    return recentProjects();
  });
  ipcMain.on('project:dirty', (e, d: unknown) => {
    if (win && e.sender === win.webContents) {
      dirty = !!d;
      win.setDocumentEdited(dirty);
    }
  });
  ipcMain.on('project:title', (e, t: unknown) => {
    if (win && e.sender === win.webContents && typeof t === 'string') win.setTitle(t.slice(0, 200));
  });
  ipcMain.on('app:confirm-close', (e) => {
    if (win && e.sender === win.webContents) {
      closeConfirmed = true;
      win.close();
    }
  });

  ipcMain.handle('media:import-dialog', async (e, kind: unknown) => {
    fromMainWindow(e);
    const k = kind === 'video' || kind === 'audio' || kind === 'image' ? kind : 'any';
    const exts = k === 'video' ? VIDEO_EXTS : k === 'audio' ? AUDIO_EXTS : k === 'image' ? IMAGE_EXTS : [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS];
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import Media',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media', extensions: exts }],
    });
    if (r.canceled) return [];
    const res = await importPaths(r.filePaths);
    if (res.errors.length) dialog.showMessageBox(win!, { type: 'warning', message: 'Some files could not be imported', detail: res.errors.join('\n') });
    return res.assets;
  });
  ipcMain.handle('media:import-paths', async (e, paths: unknown) => {
    fromMainWindow(e);
    if (!Array.isArray(paths)) throw new Error('Invalid paths');
    const list = paths.slice(0, 100).map((p) => absPath(p, 'path'));
    // Projects dropped onto the window are opened instead of imported.
    const pkg = list.find((p) => isProjectPackage(p));
    if (pkg) {
      win?.webContents.send('project:open-path', pkg);
      return { assets: [], errors: [] };
    }
    return importPaths(list.filter((p) => kindForPath(p)));
  });
  ipcMain.handle('media:thumbnails', async (e, a: unknown) => {
    fromMainWindow(e);
    return thumbnails(asset(a), mediaUrl);
  });
  ipcMain.handle('media:proxy', async (e, a: unknown) => {
    fromMainWindow(e);
    return proxyFor(asset(a), mediaUrl);
  });
  ipcMain.handle('media:relink', async (e, a: unknown) => {
    fromMainWindow(e);
    const old = asset(a);
    const r = await dialog.showOpenDialog(win!, { title: `Locate “${old.name}”`, properties: ['openFile'], message: `Locate the missing file “${old.name}”.` });
    if (r.canceled || !r.filePaths[0]) return null;
    const fresh = await probeToAsset(r.filePaths[0], old.origin);
    return { ...old, path: fresh.path, originalPath: fresh.path, relPath: undefined, missing: false, duration: fresh.duration, width: fresh.width, height: fresh.height };
  });

  ipcMain.handle('recording:permission', async (e) => {
    fromMainWindow(e);
    const p = await permission();
    // First use: trigger the system prompt so the app appears in Settings.
    return p === 'denied' ? requestPermission() : p;
  });
  ipcMain.handle('recording:open-settings', (e) => {
    fromMainWindow(e);
    return openPermissionSettings();
  });
  ipcMain.handle('recording:sources', (e) => {
    fromMainWindow(e);
    return listSources();
  });
  ipcMain.handle('recording:start', async (e, cfg: RecordingConfig) => {
    fromMainWindow(e);
    if (!cfg || !['display', 'window', 'region'].includes(cfg.mode)) throw new Error('Invalid recording mode');
    const config: RecordingConfig = {
      mode: cfg.mode,
      displayId: Number.isFinite(cfg.displayId) ? Number(cfg.displayId) : undefined,
      windowId: Number.isFinite(cfg.windowId) ? Number(cfg.windowId) : undefined,
      region: cfg.region && [cfg.region.x, cfg.region.y, cfg.region.w, cfg.region.h].every(Number.isFinite) ? cfg.region : undefined,
      fps: cfg.fps === 60 ? 60 : 30,
      countdown: Math.max(0, Math.min(10, Number(cfg.countdown) || 0)),
      showCursor: false, // The real cursor is never recorded; a synthetic one is added in the editor.
      selfTest: cfg.selfTest === true && !!process.env.STUDIO_USER_DATA,
    };
    const emit = (ev: RecordingEvent) => win?.webContents.send('recording:event', ev);
    await startRecording(win!, config, emit, (w) => rendererEntry(w, 'hud'));
  });
  // Stop/cancel may come from the HUD window as well.
  ipcMain.handle('recording:stop', () => stopRecording());
  ipcMain.handle('recording:cancel', () => cancelRecording());

  ipcMain.handle('render:choose-output', async (e, name: unknown) => {
    fromMainWindow(e);
    const base = typeof name === 'string' && name ? name.replace(/[/:]/g, '-') : 'Tutorial';
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export Video',
      defaultPath: path.join(app.getPath('videos'), `${base}.mp4`),
      filters: [{ name: 'MPEG-4 Video', extensions: ['mp4'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return null;
    return r.filePath.endsWith('.mp4') ? r.filePath : `${r.filePath}.mp4`;
  });
  ipcMain.handle('render:start', (e, req: { project: unknown; outputPath: unknown }) => {
    fromMainWindow(e);
    const project = migrateProject(req?.project);
    const out = absPath(req?.outputPath, 'output path');
    if (!out.toLowerCase().endsWith('.mp4')) throw new Error('Output must be an .mp4 file');
    for (const m of project.media) if (!m.missing) allowFile(m.path);
    return { jobId: startExport(win, project, out) };
  });
  ipcMain.handle('render:cancel', (e, id: unknown) => {
    fromMainWindow(e);
    cancelExport(str(id, 'job id'));
  });

  ipcMain.handle('system:reveal', (e, p: unknown) => {
    fromMainWindow(e);
    shell.showItemInFolder(absPath(p, 'path'));
  });
}

// ---------------------------------------------------------------- lifecycle

app.setName('Tutorial Studio');

app.on('open-file', (e, p) => {
  // Finder: double-clicking a .tvproj package or dropping it on the Dock icon.
  e.preventDefault();
  if (win) win.webContents.send('project:open-path', p);
  else pendingOpen = p;
});

app.whenReady().then(() => {
  // Restrictive CSP for production (dev server needs HMR, so it is relaxed there).
  if (!DEV_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: studio-media:; media-src 'self' blob: studio-media:; connect-src 'self' studio-media:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'",
          ],
        },
      });
    });
  }
  // Deny every web permission except HTML full screen (used by the full-screen preview).
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'fullscreen');
  allowDir(dirs.thumbnails());
  handleMediaProtocol();
  registerIpc();
  createWindow();
  if (pendingOpen) {
    const p = pendingOpen;
    win!.webContents.once('did-finish-load', () => win?.webContents.send('project:open-path', p));
    pendingOpen = null;
  }
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('window-all-closed', () => {
  if (!isRecording()) app.quit();
});

app.on('before-quit', () => {
  cancelAllExports();
  cancelRecording();
});
app.on('will-quit', () => killAllHelpers());

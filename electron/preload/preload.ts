/**
 * Preload bridge: the ONLY privileged surface available to the renderer.
 * Exposes a narrow, typed API (shared/ipc.ts StudioAPI); no Node or Electron
 * objects leak into the page.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { StudioAPI } from '../../shared/ipc';

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: StudioAPI = {
  platform: process.platform,
  versions: { app: '0.1.0', electron: process.versions.electron, chrome: process.versions.chrome },
  project: {
    open: (p) => ipcRenderer.invoke('project:open', p),
    save: (req) => ipcRenderer.invoke('project:save', req),
    autosave: (project, p) => ipcRenderer.invoke('project:autosave', project, p),
    getRecovery: () => ipcRenderer.invoke('project:recovery'),
    clearRecovery: () => ipcRenderer.invoke('project:clear-recovery'),
    recent: () => ipcRenderer.invoke('project:recent'),
    setDirty: (d) => ipcRenderer.send('project:dirty', d),
    setTitle: (t) => ipcRenderer.send('project:title', t),
  },
  media: {
    importDialog: (kind) => ipcRenderer.invoke('media:import-dialog', kind),
    importPaths: (paths) => ipcRenderer.invoke('media:import-paths', paths),
    pathForFile: (file) => webUtils.getPathForFile(file),
    url: (p) => `studio-media://local/${encodeURIComponent(p)}`,
    thumbnails: (asset) => ipcRenderer.invoke('media:thumbnails', asset),
    relink: (asset) => ipcRenderer.invoke('media:relink', asset),
  },
  recording: {
    permission: () => ipcRenderer.invoke('recording:permission'),
    openPermissionSettings: () => ipcRenderer.invoke('recording:open-settings'),
    listSources: () => ipcRenderer.invoke('recording:sources'),
    start: (config) => ipcRenderer.invoke('recording:start', config),
    stop: () => ipcRenderer.invoke('recording:stop'),
    cancel: () => ipcRenderer.invoke('recording:cancel'),
    onEvent: (cb) => on('recording:event', cb),
  },
  render: {
    chooseOutput: (name) => ipcRenderer.invoke('render:choose-output', name),
    start: (req) => ipcRenderer.invoke('render:start', req),
    cancel: (id) => ipcRenderer.invoke('render:cancel', id),
    onEvent: (cb) => on('render:event', cb),
  },
  system: {
    revealInFinder: (p) => ipcRenderer.invoke('system:reveal', p),
    onMenu: (cb) => on('menu', cb),
    onBeforeClose: (cb) => on('app:before-close', () => cb()),
    confirmClose: () => ipcRenderer.send('app:confirm-close'),
  },
};

// Project paths pushed from the main process (Finder open, Open Recent, drops).
ipcRenderer.on('project:open-path', (_e, p: string) => window.dispatchEvent(new CustomEvent('studio:open-path', { detail: p })));

contextBridge.exposeInMainWorld('studio', api);

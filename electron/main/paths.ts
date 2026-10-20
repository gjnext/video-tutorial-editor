import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Repository root in development; app.asar root when packaged. */
export function appRoot(): string {
  return app.getAppPath();
}

/** Absolute path of a bundled native helper executable. */
export function helperPath(name: 'studio-render' | 'studio-recorder'): string {
  if (app.isPackaged) {
    // electron-builder `extraFiles` places helpers next to the main executable (Contents/MacOS).
    return path.join(path.dirname(process.execPath), name);
  }
  return path.join(appRoot(), 'native', '.build', 'release', name);
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const dirs = {
  userData: () => ensure(app.getPath('userData')),
  cache: () => ensure(path.join(app.getPath('userData'), 'Cache')),
  thumbnails: () => ensure(path.join(app.getPath('userData'), 'Cache', 'thumbnails')),
  autosave: () => ensure(path.join(app.getPath('userData'), 'Autosave')),
  exportTmp: () => ensure(path.join(app.getPath('temp'), 'tutorial-studio-export')),
  recordings: () => ensure(path.join(app.getPath('videos'), 'Tutorial Studio', 'Recordings')),
  projects: () => ensure(path.join(app.getPath('documents'), 'Tutorial Studio')),
};

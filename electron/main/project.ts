/**
 * Project storage.
 *
 * Format: a `.tvproj` package directory (shown as a single document in Finder):
 *   project.json      versioned metadata (shared/schema.ts) — atomic writes
 *   project.json.bak  previous valid version
 *   media/            copied source media (self-contained, reliable reopening)
 * Regenerable caches (thumbnails, waveforms) live in the app cache, never in
 * the package. Unsaved work is protected by a recovery file in userData.
 */
import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { migrateProject, PROJECT_EXTENSION, PROJECT_FILE_NAME, type MediaAsset, type Project } from '../../shared/schema';
import type { OpenProjectResult, RecoveryInfo } from '../../shared/ipc';
import { allowDir, allowFile } from './media';
import { dirs } from './paths';

/** Write a file atomically: temp file + fsync-less rename (same volume). */
export function atomicWrite(file: string, data: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, file);
}

function uniqueName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 2;
  while (existsSync(path.join(dir, candidate))) candidate = `${base} ${i++}${ext}`;
  return candidate;
}

/** Copy external media into the package and rewrite references. */
function collectMedia(project: Project, pkg: string): Project {
  const mediaDir = path.join(pkg, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const media: MediaAsset[] = project.media.map((m) => {
    if (m.missing || !existsSync(m.path)) return m;
    const abs = path.resolve(m.path);
    if (abs.startsWith(path.resolve(pkg) + path.sep)) {
      return { ...m, relPath: path.relative(pkg, abs) };
    }
    const name = uniqueName(mediaDir, path.basename(abs));
    const dest = path.join(mediaDir, name);
    copyFileSync(abs, dest);
    allowFile(dest);
    return { ...m, path: dest, relPath: path.relative(pkg, dest), originalPath: m.originalPath ?? abs };
  });
  return { ...project, media };
}

function serialize(project: Project): string {
  // Never persist runtime-only flags.
  const clean = { ...project, media: project.media.map(({ missing: _m, ...rest }) => rest) };
  return JSON.stringify(clean, null, 2);
}

export function ensurePackagePath(p: string): string {
  return p.endsWith(`.${PROJECT_EXTENSION}`) ? p : `${p}.${PROJECT_EXTENSION}`;
}

export function saveProject(project: Project, pkg: string, copyMedia = true): Project {
  mkdirSync(pkg, { recursive: true });
  allowDir(pkg);
  const withMedia = copyMedia ? collectMedia(project, pkg) : project;
  const next: Project = { ...withMedia, modifiedAt: new Date().toISOString() };
  const file = path.join(pkg, PROJECT_FILE_NAME);
  if (existsSync(file)) {
    try {
      // Keep the last known-good version as a backup before replacing it.
      JSON.parse(readFileSync(file, 'utf8'));
      copyFileSync(file, `${file}.bak`);
    } catch {
      /* existing file unreadable — don't overwrite the backup with it */
    }
  }
  atomicWrite(file, serialize(next));
  addRecent(pkg);
  return next;
}

export function openProject(pkg: string): OpenProjectResult {
  const file = path.join(pkg, PROJECT_FILE_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const bak = `${file}.bak`;
    if (existsSync(bak)) raw = JSON.parse(readFileSync(bak, 'utf8'));
    else throw new Error(`Could not read ${path.basename(pkg)}: ${(e as Error).message}`);
  }
  const project = migrateProject(raw);
  allowDir(pkg);
  const missing: string[] = [];
  project.media = project.media.map((m) => {
    const candidates = [m.relPath ? path.join(pkg, m.relPath) : null, m.path, m.originalPath].filter(Boolean) as string[];
    const found = candidates.find((c) => path.isAbsolute(c) && existsSync(c));
    if (found) {
      allowFile(found);
      return { ...m, path: found, missing: false };
    }
    missing.push(m.name);
    return { ...m, missing: true };
  });
  addRecent(pkg);
  return { project, path: pkg, missing };
}

// ---------------------------------------------------------------- recovery autosave

const recoveryFile = () => path.join(dirs.autosave(), 'recovery.json');

export function writeRecovery(project: Project, pkg: string | null) {
  const info: RecoveryInfo = { project, path: pkg, savedAt: new Date().toISOString() };
  atomicWrite(recoveryFile(), JSON.stringify(info));
}

export function readRecovery(): RecoveryInfo | null {
  const f = recoveryFile();
  if (!existsSync(f)) return null;
  try {
    const info = JSON.parse(readFileSync(f, 'utf8')) as RecoveryInfo;
    info.project = migrateProject(info.project);
    info.project.media = info.project.media.map((m) => {
      if (existsSync(m.path)) {
        allowFile(m.path);
        return { ...m, missing: false };
      }
      return { ...m, missing: true };
    });
    if (info.path) allowDir(info.path);
    return info;
  } catch {
    return null;
  }
}

export function clearRecovery() {
  rmSync(recoveryFile(), { force: true });
}

// ---------------------------------------------------------------- recent projects

const recentFile = () => path.join(dirs.userData(), 'recent.json');

export function recentProjects(): string[] {
  try {
    const list = JSON.parse(readFileSync(recentFile(), 'utf8')) as string[];
    return list.filter((p) => existsSync(path.join(p, PROJECT_FILE_NAME)));
  } catch {
    return [];
  }
}

function addRecent(pkg: string) {
  const list = [pkg, ...recentProjects().filter((p) => p !== pkg)].slice(0, 10);
  try {
    atomicWrite(recentFile(), JSON.stringify(list));
    app.addRecentDocument(pkg);
  } catch {
    /* non-fatal */
  }
}

export function isProjectPackage(p: string): boolean {
  try {
    return statSync(p).isDirectory() && existsSync(path.join(p, PROJECT_FILE_NAME));
  } catch {
    return false;
  }
}

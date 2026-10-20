/**
 * Media import, probing, thumbnails, and the `studio-media://` protocol that
 * serves local files to the sandboxed renderer (with HTTP Range support for
 * video seeking). Only files the user explicitly imported/opened, the app's
 * cache, and project packages are served.
 */
import { protocol } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { newId, type MediaAsset, type MediaKind } from '../../shared/schema';
import { secondsToFlicks } from '../../shared/time';
import type { ProxyInfo, ThumbnailStrip } from '../../shared/ipc';
import { runHelper } from './native';
import { dirs } from './paths';

export const MEDIA_SCHEME = 'studio-media';

export const VIDEO_EXTS = ['mp4', 'mov', 'm4v'];
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'aif', 'aiff', 'caf'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'heic', 'webp', 'tif', 'tiff'];

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', heic: 'image/heic', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff',
};

const allowedFiles = new Set<string>();
const allowedDirs = new Set<string>();

export function allowFile(p: string) {
  allowedFiles.add(path.resolve(p));
}
export function allowDir(p: string) {
  allowedDirs.add(path.resolve(p) + path.sep);
}

function isAllowed(p: string): boolean {
  const abs = path.resolve(p);
  if (allowedFiles.has(abs)) return true;
  for (const d of allowedDirs) if (abs.startsWith(d)) return true;
  return false;
}

export function kindForPath(p: string): MediaKind | null {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (VIDEO_EXTS.includes(ext)) return 'video';
  if (AUDIO_EXTS.includes(ext)) return 'audio';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  return null;
}

export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

export function handleMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!path.isAbsolute(filePath) || !isAllowed(filePath)) return new Response('Forbidden', { status: 403 });
    if (!existsSync(filePath)) return new Response('Not found', { status: 404 });
    const size = statSync(filePath).size;
    const type = MIME[path.extname(filePath).slice(1).toLowerCase()] ?? 'application/octet-stream';
    const range = request.headers.get('range');
    // CORS so <video crossOrigin> frames can be drawn to the preview canvas without tainting it.
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (m && !m[1] && m[2]) {
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
      return new Response(stream, { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  });
}

/** Probe a file with the native helper and build a MediaAsset. */
export async function probeToAsset(filePath: string, origin: MediaAsset['origin'] = 'imported'): Promise<MediaAsset> {
  const kind = kindForPath(filePath);
  if (!kind) throw new Error(`Unsupported file type: ${path.basename(filePath)}`);
  const r = (await runHelper('studio-render', ['probe', filePath])) as Record<string, any>;
  if (kind === 'video' && !r.hasVideo) throw new Error(`${path.basename(filePath)} has no video track.`);
  const st = statSync(filePath);
  allowFile(filePath);
  return {
    id: newId('media'),
    kind: r.kind === 'image' ? 'image' : r.kind === 'video' ? 'video' : 'audio',
    name: path.basename(filePath),
    path: filePath,
    originalPath: filePath,
    duration: secondsToFlicks(Number(r.duration) || 0),
    width: r.width,
    height: r.height,
    frameRate: r.frameRate,
    hasAudio: !!r.hasAudio,
    sampleRate: r.sampleRate,
    channels: r.channels,
    codec: r.codec,
    origin,
    fileSize: st.size,
  };
}

export async function importPaths(paths: string[]): Promise<{ assets: MediaAsset[]; errors: string[] }> {
  const assets: MediaAsset[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    try {
      if (typeof p !== 'string' || !path.isAbsolute(p) || !existsSync(p) || !statSync(p).isFile()) throw new Error(`Not a file: ${p}`);
      assets.push(await probeToAsset(p));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { assets, errors };
}

const THUMB_INTERVAL = 1; // seconds
const THUMB_HEIGHT = 96;

export async function thumbnails(asset: MediaAsset, toUrl: (p: string) => string): Promise<ThumbnailStrip> {
  if (asset.kind !== 'video') throw new Error('Thumbnails are only generated for video.');
  if (!isAllowed(asset.path)) throw new Error('Access denied.');
  const st = statSync(asset.path);
  const key = createHash('sha1').update(`${asset.path}|${st.size}|${st.mtimeMs}|${THUMB_INTERVAL}|${THUMB_HEIGHT}`).digest('hex').slice(0, 16);
  const dir = path.join(dirs.thumbnails(), key);
  allowDir(dir);
  let files: string[] = [];
  if (existsSync(dir)) files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(dir, f));
  const expected = Math.max(1, Math.ceil(asset.duration / secondsToFlicks(THUMB_INTERVAL)));
  let width = 0;
  let height = THUMB_HEIGHT;
  if (files.length < expected) {
    const r = (await runHelper('studio-render', ['thumbs', asset.path, dir, String(THUMB_INTERVAL), String(THUMB_HEIGHT)], 300_000)) as Record<string, any>;
    files = r.files as string[];
    width = r.width;
    height = r.height;
  } else {
    width = Math.round(((asset.width ?? 16) / (asset.height ?? 9)) * THUMB_HEIGHT);
  }
  return { assetId: asset.id, urls: files.map(toUrl), interval: THUMB_INTERVAL, width, height };
}

export function mediaUrl(p: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(p)}`;
}

// ---------------------------------------------------------------- scrub proxies

const PROXY_WIDTH = 1280;
const proxyJobs = new Map<string, Promise<ProxyInfo>>();

/** Short-GOP downscaled copy for fast preview scrubbing (cached; never used for export). */
export function proxyFor(asset: MediaAsset, toUrl: (p: string) => string): Promise<ProxyInfo> {
  if (asset.kind !== 'video') return Promise.reject(new Error('Proxies are only generated for video.'));
  if (!isAllowed(asset.path)) return Promise.reject(new Error('Access denied.'));
  const st = statSync(asset.path);
  const key = createHash('sha1').update(`proxy|${asset.path}|${st.size}|${st.mtimeMs}|${PROXY_WIDTH}`).digest('hex').slice(0, 20);
  const dir = path.join(dirs.cache(), 'proxies');
  mkdirSync(dir, { recursive: true });
  allowDir(dir);
  const file = path.join(dir, `${key}.mp4`);
  const meta = `${file}.json`;
  let job = proxyJobs.get(key);
  if (!job) {
    job = (async () => {
      if (!existsSync(file) || !existsSync(meta)) {
        const r = (await runHelper('studio-render', ['proxy', asset.path, file, String(PROXY_WIDTH)], 30 * 60_000)) as Record<string, any>;
        writeFileSync(meta, JSON.stringify({ width: r.width, height: r.height }));
      }
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      return { assetId: asset.id, url: toUrl(file), width: m.width, height: m.height };
    })();
    job.catch(() => proxyJobs.delete(key));
    proxyJobs.set(key, job);
  }
  return job.then((j) => ({ ...j, assetId: asset.id }));
}

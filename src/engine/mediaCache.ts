/**
 * Decoded media for the preview: AudioBuffers (for playback and REAL waveform
 * peaks), thumbnail strips, and background images. All derived from the
 * actual files via the studio-media:// protocol.
 */
import type { MediaAsset } from '../../shared/schema';
import { editor, type Waveform } from '../state/store';

let ctx: AudioContext | null = null;
export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

const buffers = new Map<string, Promise<AudioBuffer | null>>();
const decoded = new Map<string, AudioBuffer>();
const images = new Map<string, HTMLImageElement>();
const thumbsPending = new Set<string>();

export const WAVEFORM_BUCKETS_PER_SECOND = 400;

function computePeaks(buf: AudioBuffer): Waveform {
  const bps = WAVEFORM_BUCKETS_PER_SECOND;
  const n = Math.ceil(buf.duration * bps);
  const peaks = new Float32Array(n * 2);
  const samplesPer = buf.sampleRate / bps;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * samplesPer);
    const b = Math.min(buf.length, Math.floor((i + 1) * samplesPer));
    let mn = 0;
    let mx = 0;
    for (const d of chans) {
      for (let k = a; k < b; k++) {
        const v = d[k];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    peaks[i * 2] = mn;
    peaks[i * 2 + 1] = mx;
  }
  return { peaks, bucketsPerSecond: bps, duration: buf.duration };
}

/** Decode an audio asset (or a video's audio track) once; also publishes its waveform. */
export function loadAudio(asset: MediaAsset): Promise<AudioBuffer | null> {
  const key = asset.id + '|' + asset.path;
  let p = buffers.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(window.studio.media.url(asset.path));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        const buf = await audioContext().decodeAudioData(data);
        decoded.set(asset.id, buf);
        const wf = computePeaks(buf);
        editor().set({ waveforms: { ...editor().waveforms, [asset.id]: wf } });
        return buf;
      } catch (e) {
        if (asset.kind === 'audio') editor().toast('error', `Could not decode audio “${asset.name}”: ${(e as Error).message}`);
        return null;
      }
    })();
    buffers.set(key, p);
  }
  return p;
}

export function decodedAudio(assetId: string): AudioBuffer | undefined {
  return decoded.get(assetId);
}

export function loadThumbnails(asset: MediaAsset) {
  if (asset.kind !== 'video' || asset.missing || thumbsPending.has(asset.id) || editor().thumbnails[asset.id]) return;
  thumbsPending.add(asset.id);
  window.studio.media
    .thumbnails(asset)
    .then((strip) => editor().set({ thumbnails: { ...editor().thumbnails, [asset.id]: strip } }))
    .catch(() => {})
    .finally(() => thumbsPending.delete(asset.id));
}

export function imageFor(asset: MediaAsset, onLoad: () => void): HTMLImageElement | null {
  let img = images.get(asset.id);
  if (!img) {
    img = new Image();
    img.onload = onLoad;
    img.src = window.studio.media.url(asset.path);
    images.set(asset.id, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Warm caches for everything in the project. */
export function prefetchProjectMedia(media: MediaAsset[]) {
  for (const m of media) {
    if (m.missing) continue;
    if (m.kind === 'audio') loadAudio(m);
    if (m.kind === 'video') {
      loadThumbnails(m);
      if (m.hasAudio) loadAudio(m);
    }
  }
}

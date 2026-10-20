/**
 * Preview playback engine.
 *
 * Master clock: the Web Audio context (sample-accurate, same device as the
 * narration). Project time t = t0 + (audioCtx.currentTime − c0).
 * Video elements are slaved to the clock through the shared time map:
 *  - clip segment  → play the element at the mapped source time, converging
 *                    small drift by nudging playbackRate (no seeks, no stalls);
 *  - freeze        → pause the element on the frozen source frame.
 * When paused, every playhead change seeks frame-accurately; rapid seeks
 * (scrubbing) use a short-GOP proxy and settle on the full-resolution frame.
 * A held copy of the last decoded frame is shown during every seek.
 * Cursor, clicks and composition are evaluated from project time by the
 * shared code at draw time, so they never depend on video playback.
 */
import { mapProjectTime } from '../../shared/timeline';
import { audioPlacements, gainAt } from '../../shared/audio';
import { assetMap } from '../../shared/compose';
import { FLICKS_PER_SECOND, flicksToSeconds, type Flicks } from '../../shared/time';
import type { MediaAsset, Project } from '../../shared/schema';
import { playhead } from '../state/playhead';
import { editor, useEditor } from '../state/store';
import { audioContext, decodedAudio, loadAudio } from './mediaCache';
import { perf } from './perf';

const SEEK_EPSILON = 0.0005; // seconds; matches the native frame-selection tolerance
/** Seeks closer together than this (while paused) count as scrubbing → proxy. */
const SCRUB_WINDOW_MS = 200;
/** After scrubbing stops, the full-resolution frame is fetched this much later. */
const SETTLE_MS = 140;

/** What the preview draws: an image plus the factor from source pixels to image pixels. */
export interface FrameSource {
  image: CanvasImageSource;
  scaleX: number;
  scaleY: number;
}

/**
 * One <video> element with coalesced seeking (one in flight, latest wins) and a
 * held copy of the last decoded frame, so there is always something to show
 * while the element is seeking (Chromium has no image during a seek).
 */
class Decoder {
  el: HTMLVideoElement;
  ready = false;
  seeking = false;
  private pending: number | null = null;
  private seekStarted = 0;
  private hold: HTMLCanvasElement | null = null;
  private holdTime = -1;
  /** Source time (s) of the most recent request. */
  target = 0;

  constructor(url: string, onFrame: () => void) {
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.preload = 'auto';
    this.el.playsInline = true;
    this.el.crossOrigin = 'anonymous';
    this.el.src = url;
    this.el.addEventListener('loadeddata', () => {
      this.ready = true;
      onFrame();
    });
    this.el.addEventListener('seeked', () => {
      const ms = performance.now() - this.seekStarted;
      perf.seekMs += ms;
      perf.maxSeekMs = Math.max(perf.maxSeekMs, ms);
      this.seeking = false;
      if (this.pending != null) {
        const t = this.pending;
        this.pending = null;
        this.seek(t);
      }
      onFrame();
    });
  }

  get live(): boolean {
    return this.ready && !this.seeking && this.el.readyState >= 2;
  }

  /** Copy the currently decoded frame so it can be shown during the next seek. */
  private snapshot() {
    if (!this.live || !this.el.videoWidth) return;
    if (!this.hold) this.hold = document.createElement('canvas');
    if (this.hold.width !== this.el.videoWidth || this.hold.height !== this.el.videoHeight) {
      this.hold.width = this.el.videoWidth;
      this.hold.height = this.el.videoHeight;
    }
    this.hold.getContext('2d')!.drawImage(this.el, 0, 0);
    this.holdTime = this.el.currentTime;
  }

  seek(seconds: number) {
    this.target = seconds;
    if (this.seeking) {
      this.pending = seconds;
      return;
    }
    if (Math.abs(this.el.currentTime - seconds) < 1e-4 && this.el.readyState >= 2) return;
    this.snapshot();
    this.seeking = true;
    this.seekStarted = performance.now();
    perf.seeks++;
    this.el.currentTime = seconds;
  }

  /** Best image this decoder can show now, with the source time it depicts. */
  current(): { image: CanvasImageSource; time: number } | null {
    if (this.live) return { image: this.el, time: this.el.currentTime };
    if (this.hold && this.holdTime >= 0) return { image: this.hold, time: this.holdTime };
    return null;
  }

  dispose() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.hold = null;
  }
}

/**
 * Per-asset video: the full-resolution decoder (playback, paused frames, and
 * the same pixels the exporter uses) plus an optional short-GOP proxy used only
 * while scrubbing, so dragging the playhead stays fluid on long-GOP recordings.
 */
class VideoSlot {
  full: Decoder;
  proxy: Decoder | null = null;
  private proxyScale = { x: 1, y: 1 };
  private lastPausedSeek = 0;
  private scrubbing = false;
  private settle: ReturnType<typeof setTimeout> | null = null;

  constructor(public asset: MediaAsset, private onFrame: () => void) {
    this.full = new Decoder(window.studio.media.url(asset.path), onFrame);
    window.studio.media
      .proxy(asset)
      .then((info) => {
        if (!this.full.el.src) return; // disposed
        this.proxy = new Decoder(info.url, onFrame);
        this.proxyScale = { x: info.width / (asset.width || info.width), y: info.height / (asset.height || info.height) };
      })
      .catch(() => {});
  }

  get el() {
    return this.full.el;
  }

  /** Seek while paused (scrubbing, stepping, edits). Rapid sequences go to the proxy. */
  seekPaused(seconds: number) {
    const now = performance.now();
    const rapid = now - this.lastPausedSeek < SCRUB_WINDOW_MS;
    this.lastPausedSeek = now;
    if (this.settle) clearTimeout(this.settle);
    if (rapid && this.proxy?.ready) {
      this.scrubbing = true;
      this.proxy.seek(seconds);
      this.full.target = seconds;
      this.settle = setTimeout(() => {
        this.scrubbing = false;
        this.full.seek(seconds);
        this.onFrame();
      }, SETTLE_MS);
      return;
    }
    this.scrubbing = false;
    this.full.seek(seconds);
  }

  /** Seek for playback (always full resolution). */
  seekPlay(seconds: number) {
    if (this.settle) clearTimeout(this.settle);
    this.scrubbing = false;
    this.full.seek(seconds);
  }

  /** The image closest in time to the requested frame, preferring full resolution. */
  frame(): FrameSource | null {
    const target = this.full.target;
    const cands: { src: FrameSource; time: number; full: boolean }[] = [];
    const f = this.full.current();
    if (f) cands.push({ src: { image: f.image, scaleX: 1, scaleY: 1 }, time: f.time, full: true });
    const pr = this.proxy?.current();
    if (pr && (this.scrubbing || !this.full.live)) cands.push({ src: { image: pr.image, scaleX: this.proxyScale.x, scaleY: this.proxyScale.y }, time: pr.time, full: false });
    if (!cands.length) return null;
    const exactFull = cands.find((c) => c.full && this.full.live && Math.abs(c.time - target) < 0.004);
    if (exactFull) return exactFull.src;
    cands.sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target) || (a.full ? -1 : 1));
    return cands[0].src;
  }

  dispose() {
    if (this.settle) clearTimeout(this.settle);
    this.full.dispose();
    this.proxy?.dispose();
  }
}

type Listener = () => void;

class Player {
  private slots = new Map<string, VideoSlot>();
  private sources: AudioBufferSourceNode[] = [];
  private gains: GainNode[] = [];
  private c0 = 0;
  private t0: Flicks = 0;
  private raf = 0;
  private frameListeners = new Set<Listener>();
  private lastProjectRef: Project | null = null;

  constructor() {
    // Reschedule audio when the project changes mid-playback.
    useEditor.subscribe((s) => {
      if (s.project !== this.lastProjectRef) {
        this.lastProjectRef = s.project;
        this.syncSlots(s.project);
        if (playhead.getState().playing) this.restartAudio();
        else this.seekVideo(playhead.getState().time);
        this.emitFrame();
      }
    });
  }

  onFrame(cb: Listener): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }
  private emitFrame() {
    for (const l of this.frameListeners) l();
  }

  private syncSlots(p: Project) {
    const wanted = new Set(p.media.filter((m) => m.kind === 'video' && !m.missing).map((m) => m.id));
    for (const [id, slot] of this.slots) {
      const a = p.media.find((m) => m.id === id);
      if (!wanted.has(id) || !a || a.path !== slot.asset.path) {
        slot.dispose();
        this.slots.delete(id);
      }
    }
    for (const m of p.media) {
      if (m.kind === 'video' && !m.missing && !this.slots.has(m.id)) this.slots.set(m.id, new VideoSlot(m, () => this.emitFrame()));
    }
  }

  /** The image to draw for an asset (never blank once a first frame was decoded). */
  frameFor(assetId: string): FrameSource | null {
    return this.slots.get(assetId)?.frame() ?? null;
  }

  duration(): Flicks {
    const p = editor().project;
    let t = 0;
    for (const s of p.video.segments) t += s.kind === 'clip' ? s.sourceOut - s.sourceIn : s.duration;
    return t;
  }

  // ------------------------------------------------------------ transport

  seek(t: Flicks) {
    const d = this.duration();
    const time = Math.max(0, Math.min(Math.round(t), d));
    if (playhead.getState().playing) {
      this.t0 = time;
      this.c0 = audioContext().currentTime;
      this.restartAudio();
      this.seekVideo(time, true);
    } else {
      this.seekVideo(time);
    }
    playhead.setState({ time });
    this.emitFrame();
  }

  toggle() {
    if (playhead.getState().playing) this.pause();
    else this.play();
  }

  async play() {
    const ctx = audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    let start = playhead.getState().time;
    if (start >= this.duration() - 1000) start = 0;
    this.t0 = start;
    this.c0 = ctx.currentTime;
    playhead.setState({ playing: true, time: start });
    this.restartAudio();
    this.seekVideo(start, true);
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!playhead.getState().playing) return;
      const t = this.currentTime();
      if (t >= this.duration()) {
        this.pause();
        playhead.setState({ time: this.duration() });
        this.emitFrame();
        return;
      }
      playhead.setState({ time: t });
      this.syncVideoPlaying(t);
      this.emitFrame();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    const t = this.currentTime();
    playhead.setState({ playing: false, time: Math.min(t, this.duration()) });
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    for (const s of this.slots.values()) {
      s.el.pause();
      s.el.playbackRate = 1;
    }
    this.seekVideo(playhead.getState().time);
    this.emitFrame();
  }

  currentTime(): Flicks {
    if (!playhead.getState().playing) return playhead.getState().time;
    return Math.round(this.t0 + (audioContext().currentTime - this.c0) * FLICKS_PER_SECOND);
  }

  // ------------------------------------------------------------ video sync

  private seekVideo(t: Flicks, forPlay = false) {
    const p = editor().project;
    const m = mapProjectTime(p.video.segments, t);
    if (!m) return;
    const slot = this.slots.get(m.assetId);
    if (!slot) return;
    for (const [id, s] of this.slots) if (id !== m.assetId) s.el.pause();
    if (!forPlay || m.frozen) slot.el.pause();
    const sec = flicksToSeconds(m.sourceTime) + SEEK_EPSILON;
    if (forPlay) slot.seekPlay(sec);
    else slot.seekPaused(sec);
  }

  private syncVideoPlaying(t: Flicks) {
    const p = editor().project;
    const m = mapProjectTime(p.video.segments, t);
    if (!m) return;
    const slot = this.slots.get(m.assetId);
    if (!slot) return;
    for (const [id, s] of this.slots) if (id !== m.assetId && !s.el.paused) s.el.pause();
    const target = flicksToSeconds(m.sourceTime);
    const el = slot.el;
    if (m.frozen) {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.001 && !slot.full.seeking) slot.seekPlay(target + SEEK_EPSILON);
      return;
    }
    const drift = el.currentTime - target;
    if (el.paused) {
      if (Math.abs(drift) > 0.05) slot.seekPlay(target + 0.01);
      el.playbackRate = 1;
      void el.play().catch(() => {});
    } else if (Math.abs(drift) > 0.25 && !slot.full.seeking) {
      // Far off (e.g. after a segment jump): reposition once; the held frame avoids a blank.
      perf.driftSeeks++;
      el.playbackRate = 1;
      slot.seekPlay(target + 0.03);
    } else if (!slot.full.seeking) {
      // Small drift: converge smoothly by nudging the playback rate (±6 %), no seeks, no stalls.
      const rate = Math.max(0.94, Math.min(1.06, 1 - drift * 1.5));
      if (Math.abs(el.playbackRate - rate) > 0.004) el.playbackRate = rate;
    }
    // Source audio of the recording (optional) plays from the element itself.
    slot.el.muted = !p.video.sourceAudio;
    slot.el.volume = Math.max(0, Math.min(1, p.video.sourceAudioVolume));
  }

  // ------------------------------------------------------------ audio

  private stopAudio() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    for (const g of this.gains) g.disconnect();
    this.sources = [];
    this.gains = [];
  }

  /** Schedule all audible clips relative to the master clock (same placement rules as export). */
  private restartAudio() {
    this.stopAudio();
    const ctx = audioContext();
    const p = editor().project;
    const assets = assetMap(p.media);
    const now = this.currentTime();
    const nowCtx = ctx.currentTime;
    const end = this.duration();
    for (const pl of audioPlacements(p, end, assets)) {
      if (pl.id.startsWith('seg:')) continue; // video source audio plays via the element
      const asset = assets.get(pl.assetId);
      if (!asset) continue;
      const buf = decodedAudio(pl.assetId);
      if (!buf) {
        void loadAudio(asset).then(() => playhead.getState().playing && this.restartAudio());
        continue;
      }
      const clipEnd = pl.start + (pl.sourceOut - pl.sourceIn);
      if (clipEnd <= now) continue;
      const startAt = Math.max(now, pl.start);
      const offset = flicksToSeconds(pl.sourceIn + (startAt - pl.start));
      const dur = flicksToSeconds(clipEnd - startAt);
      const when = nowCtx + flicksToSeconds(startAt - now);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      // Gain envelope sampled at the fade boundaries — linear ramps reproduce gainAt().
      const points = [startAt, pl.start + pl.fadeIn, clipEnd - pl.fadeOut, clipEnd].filter((x) => x >= startAt && x <= clipEnd).sort((a, b) => a - b);
      g.gain.setValueAtTime(gainAt(pl, startAt), when);
      for (const pt of points) g.gain.linearRampToValueAtTime(gainAt(pl, Math.min(pt, clipEnd - 1)), nowCtx + flicksToSeconds(pt - now));
      src.connect(g).connect(ctx.destination);
      src.start(when, offset, dur);
      this.sources.push(src);
      this.gains.push(g);
    }
  }
}

export const player = new Player();

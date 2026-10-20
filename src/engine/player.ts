/**
 * Preview playback engine.
 *
 * Master clock: the Web Audio context (sample-accurate, same device as the
 * narration). Project time t = t0 + (audioCtx.currentTime − c0).
 * Video elements are slaved to the clock through the shared time map:
 *  - clip segment  → play the element at the mapped source time, correcting
 *                    drift > 1.5 frames by seeking;
 *  - freeze        → pause the element on the frozen source frame.
 * When paused, every playhead change seeks frame-accurately.
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

const SEEK_EPSILON = 0.0005; // seconds; matches the native frame-selection tolerance

class VideoSlot {
  el: HTMLVideoElement;
  ready = false;
  pendingSeek: number | null = null;
  seeking = false;
  constructor(public asset: MediaAsset, onFrame: () => void) {
    this.el = document.createElement('video');
    this.el.muted = true;
    this.el.preload = 'auto';
    this.el.playsInline = true;
    this.el.crossOrigin = 'anonymous';
    this.el.src = window.studio.media.url(asset.path);
    this.el.addEventListener('loadeddata', () => {
      this.ready = true;
      onFrame();
    });
    this.el.addEventListener('seeked', () => {
      this.seeking = false;
      if (this.pendingSeek != null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        this.seek(t);
      }
      onFrame();
    });
  }
  /** Coalesced seeking: at most one seek in flight, latest request wins. */
  seek(seconds: number) {
    if (this.seeking) {
      this.pendingSeek = seconds;
      return;
    }
    if (Math.abs(this.el.currentTime - seconds) < 1e-4 && this.el.readyState >= 2) return;
    this.seeking = true;
    this.el.currentTime = seconds;
  }
  dispose() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
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

  /** The element to draw for an asset, or null if it has no decoded frame yet. */
  frameFor(assetId: string): HTMLVideoElement | null {
    const s = this.slots.get(assetId);
    return s && s.ready && s.el.readyState >= 2 ? s.el : null;
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
    for (const s of this.slots.values()) s.el.pause();
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
    slot.seek(flicksToSeconds(m.sourceTime) + SEEK_EPSILON);
  }

  private syncVideoPlaying(t: Flicks) {
    const p = editor().project;
    const m = mapProjectTime(p.video.segments, t);
    if (!m) return;
    const slot = this.slots.get(m.assetId);
    if (!slot) return;
    for (const [id, s] of this.slots) if (id !== m.assetId && !s.el.paused) s.el.pause();
    const target = flicksToSeconds(m.sourceTime);
    if (m.frozen) {
      if (!slot.el.paused) slot.el.pause();
      if (Math.abs(slot.el.currentTime - target) > 0.001) slot.seek(target + SEEK_EPSILON);
      return;
    }
    const fps = slot.asset.frameRate || 30;
    const drift = slot.el.currentTime - target;
    if (slot.el.paused) {
      slot.seek(target + SEEK_EPSILON);
      void slot.el.play().catch(() => {});
    } else if (Math.abs(drift) > 1.5 / fps && !slot.seeking) {
      slot.seek(target + 0.02); // land slightly ahead; the element keeps playing
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

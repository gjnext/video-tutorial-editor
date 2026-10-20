/**
 * High-frequency playback state, kept outside React state so the timeline
 * playhead and preview can update every animation frame without re-rendering
 * the component tree. Components subscribe imperatively.
 */
import { createStore } from 'zustand/vanilla';
import { useSyncExternalStore } from 'react';
import type { Flicks } from '../../shared/time';

interface PlayheadState {
  time: Flicks;
  playing: boolean;
}

export const playhead = createStore<PlayheadState>(() => ({ time: 0, playing: false }));

/** React hook for low-frequency consumers (e.g. inspector) — throttled to ~10 Hz while playing. */
export function usePlayheadTime(throttleMs = 100): Flicks {
  return useSyncExternalStore(
    (cb) => {
      let last = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      return playhead.subscribe((s, prev) => {
        if (s.time === prev.time) return;
        const now = performance.now();
        if (!s.playing || now - last > throttleMs) {
          last = now;
          cb();
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            last = performance.now();
            cb();
          }, throttleMs);
        }
      });
    },
    () => playhead.getState().time,
  );
}

export function usePlaying(): boolean {
  return useSyncExternalStore(
    (cb) => playhead.subscribe((s, p) => s.playing !== p.playing && cb()),
    () => playhead.getState().playing,
  );
}

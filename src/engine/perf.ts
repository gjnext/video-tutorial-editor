/** Lightweight preview performance counters (read by the e2e perf test; negligible cost). */
export const perf = {
  draws: 0,
  drawMs: 0,
  maxDrawMs: 0,
  /** Draws where a video frame was expected but no decoded image was available (blank). */
  blankDraws: 0,
  seeks: 0,
  seekMs: 0,
  maxSeekMs: 0,
  /** Seeks issued during playback to correct drift (each one can cause a visible stall). */
  driftSeeks: 0,
  reset() {
    this.draws = this.drawMs = this.maxDrawMs = this.blankDraws = 0;
    this.seeks = this.seekMs = this.maxSeekMs = this.driftSeeks = 0;
  },
};

/**
 * Draws one composed frame (background, video, highlights, cursor) to a canvas
 * context at any size. Shared by the editor preview and the theater /
 * full-screen presentation, so they always show the same picture.
 */
import { backgroundOps } from '../../shared/backgrounds';
import { assetMap, composeFrame } from '../../shared/compose';
import type { Project } from '../../shared/schema';
import type { Flicks } from '../../shared/time';
import { clipTo, drawHighlightLayer, drawVideo, runOps } from '../engine/canvasOps';
import { imageFor } from '../engine/mediaCache';
import { player } from '../engine/player';

export class CompositionRenderer {
  private bg: { key: string; canvas: HTMLCanvasElement } | null = null;

  constructor(private onAsyncLoad: () => void) {}

  /** Returns false when a video frame was expected but none was available yet. */
  draw(ctx: CanvasRenderingContext2D, W: number, H: number, p: Project, t: Flicks): boolean {
    const assets = assetMap(p.media);
    // Background (static) — cached offscreen per size/background.
    const bgAsset = p.background.kind === 'image' ? assets.get(p.background.assetId) : undefined;
    const bgImg = bgAsset ? imageFor(bgAsset, this.onAsyncLoad) : null;
    const key = `${JSON.stringify(p.background)}|${W}x${H}|${bgImg ? 1 : 0}`;
    if (!this.bg || this.bg.key !== key) {
      const off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      const octx = off.getContext('2d')!;
      octx.fillStyle = '#000';
      octx.fillRect(0, 0, W, H);
      runOps(octx, backgroundOps(p.background, { width: W, height: H }, p.media), W, H, () => bgImg);
      this.bg = { key, canvas: off };
    }
    ctx.drawImage(this.bg.canvas, 0, 0);
    const f = composeFrame(p, t, { width: W, height: H }, assets);
    let ok = true;
    if (f.video) {
      const frame = player.frameFor(f.video.assetId);
      ok = !!frame;
      drawVideo(ctx, f.video, frame);
    }
    if (f.highlights.length) drawHighlightLayer(ctx, f.highlights, f.highlightClip, W, H);
    if (f.overlay.length) {
      ctx.save();
      clipTo(ctx, f.overlayClip);
      runOps(ctx, f.overlay, W, H);
      ctx.restore();
    }
    return ok;
  }
}

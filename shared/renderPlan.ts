/**
 * Export plan: the project fully evaluated at every output frame, handed to
 * the native renderer. The native side never re-implements timing, cursor
 * or layout rules — it executes this plan (docs/COMPOSITION_SPEC.md §6).
 */
import type { ExportSettings, MediaAsset, Project } from './schema';
import { exportCanvasSize } from './schema';
import { assetMap, composeFrame, type FrameDescription } from './compose';
import { backgroundOps } from './backgrounds';
import { audioPlacements, EXPORT_SAMPLE_RATE, type AudioPlacement } from './audio';
import { CURSOR_THEMES, type CursorTheme } from './cursorThemes';
import type { DrawOp } from './drawOps';
import { parseColor, type RGBA } from './color';
import { projectDuration } from './timeline';
import { frameCount, frameToFlicks, FLICKS_PER_SECOND, type Flicks } from './time';

export interface RenderPlanOutput {
  path: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  codec: 'h264' | 'hevc';
  videoBitrate: number;
  audioBitrate: number;
  sampleRate: number;
  keyframeIntervalFrames: number;
}

export interface RenderPlanAsset {
  id: string;
  kind: MediaAsset['kind'];
  path: string;
  width: number;
  height: number;
}

export interface PlanCursorTheme {
  layers: { d: string; fill?: RGBA; stroke?: RGBA; lineWidth?: number }[];
  shadow: { blur: number; offsetX: number; offsetY: number; color: RGBA };
}

/** Cursor themes with colors converted to RGBA floats for the native renderer. */
export function planCursorThemes(): Record<string, PlanCursorTheme> {
  const conv = (t: CursorTheme): PlanCursorTheme => ({
    layers: t.layers.map((l) => ({ d: l.d, fill: l.fill ? parseColor(l.fill) : undefined, stroke: l.stroke ? parseColor(l.stroke) : undefined, lineWidth: l.lineWidth })),
    shadow: { ...t.shadow, color: parseColor(t.shadow.color) },
  });
  return Object.fromEntries(Object.values(CURSOR_THEMES).map((t) => [t.id, conv(t)]));
}

export interface RenderPlan {
  version: 1;
  output: RenderPlanOutput;
  duration: Flicks;
  frameCount: number;
  assets: RenderPlanAsset[];
  background: DrawOp[];
  cursorThemes: Record<string, PlanCursorTheme>;
  audio: (AudioPlacement & { path: string })[];
  frames: FrameDescription[];
}

/** YouTube-oriented H.264 bitrates (bits/s) at 30 fps; 60 fps uses ×1.5. */
const BASE_BITRATE: Record<number, number> = { 1080: 10_000_000, 1440: 20_000_000, 2160: 45_000_000 };
const QUALITY_FACTOR = { standard: 1, high: 1.6, max: 2.6 } as const;

export function videoBitrate(s: ExportSettings): number {
  const fps = s.fps.num / s.fps.den;
  let b = (BASE_BITRATE[s.resolution] ?? 20_000_000) * QUALITY_FACTOR[s.quality];
  if (fps > 40) b *= 1.5;
  if (s.codec === 'hevc') b *= 0.65;
  return Math.round(b);
}

export function audioBitrate(s: ExportSettings): number {
  return s.quality === 'standard' ? 192_000 : 256_000;
}

export function estimateExport(p: Project): { width: number; height: number; duration: Flicks; bytes: number; frames: number } {
  const { width, height } = exportCanvasSize(p.canvas, p.export.resolution);
  const duration = projectDuration(p);
  const secs = duration / FLICKS_PER_SECOND;
  const bytes = ((videoBitrate(p.export) + audioBitrate(p.export)) * secs) / 8;
  return { width, height, duration, bytes, frames: frameCount(duration, p.export.fps) };
}

export function buildRenderPlan(p: Project, outputPath: string): RenderPlan {
  const assets = assetMap(p.media);
  const size = exportCanvasSize(p.canvas, p.export.resolution);
  const duration = projectDuration(p);
  const n = frameCount(duration, p.export.fps);
  const frames: FrameDescription[] = new Array(n);
  for (let i = 0; i < n; i++) frames[i] = composeFrame(p, frameToFlicks(i, p.export.fps), size, assets);

  const used = new Set<string>();
  for (const s of p.video.segments) used.add(s.assetId);
  if (p.background.kind === 'image') used.add(p.background.assetId);
  const audio = audioPlacements(p, duration, assets);
  for (const a of audio) used.add(a.assetId);

  const fps = p.export.fps.num / p.export.fps.den;
  return {
    version: 1,
    output: {
      path: outputPath,
      width: size.width,
      height: size.height,
      fpsNum: p.export.fps.num,
      fpsDen: p.export.fps.den,
      codec: p.export.codec,
      videoBitrate: videoBitrate(p.export),
      audioBitrate: audioBitrate(p.export),
      sampleRate: EXPORT_SAMPLE_RATE,
      keyframeIntervalFrames: Math.round(fps * 2),
    },
    duration,
    frameCount: n,
    assets: [...used].map((id) => {
      const a = assets.get(id)!;
      return { id, kind: a.kind, path: a.path, width: a.width ?? 0, height: a.height ?? 0 };
    }),
    background: backgroundOps(p.background, size, p.media),
    cursorThemes: planCursorThemes(),
    audio: audio.map((a) => ({ ...a, path: assets.get(a.assetId)!.path })),
    frames,
  };
}

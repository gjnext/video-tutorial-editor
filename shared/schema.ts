/**
 * Versioned project schema. This is the single source of truth for what a
 * project contains; preview and export both evaluate exactly this data.
 *
 * Coordinate conventions are documented in docs/COMPOSITION_SPEC.md.
 */
import type { Flicks, FrameRate } from './time';

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_FILE_NAME = 'project.json';
export const PROJECT_EXTENSION = 'tvproj';

// ---------------------------------------------------------------- media

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  name: string;
  /** Absolute path resolved at load time. Not trusted from disk; recomputed. */
  path: string;
  /** Path relative to the project package when the file lives inside it. */
  relPath?: string;
  /** Where the file was originally imported from (informational). */
  originalPath?: string;
  /** Duration in flicks (0 for images). */
  duration: Flicks;
  /** Display dimensions after applying the track's orientation transform. */
  width?: number;
  height?: number;
  /** Nominal frame rate reported by the container. */
  frameRate?: number;
  hasAudio?: boolean;
  /** Audio sample rate and channel count, when the asset contains audio. */
  sampleRate?: number;
  channels?: number;
  codec?: string;
  /** recorded = produced by the built-in recorder with the system cursor hidden. */
  origin: 'recorded' | 'imported';
  fileSize?: number;
  /** Runtime-only flag set when the file could not be found on open. */
  missing?: boolean;
}

// ---------------------------------------------------------------- video track

export interface ClipSegment {
  id: string;
  kind: 'clip';
  assetId: string;
  /** Source media time range [sourceIn, sourceOut). */
  sourceIn: Flicks;
  sourceOut: Flicks;
}

export interface FreezeSegment {
  id: string;
  kind: 'freeze';
  assetId: string;
  /** Source media time of the held frame. */
  sourceTime: Flicks;
  duration: Flicks;
}

export type VideoSegment = ClipSegment | FreezeSegment;

// ---------------------------------------------------------------- cursor

export type EasingPreset = 'smooth' | 'gentle' | 'quick' | 'linear' | 'custom';

/** CSS-style cubic-bezier control points. Constrained to 0 ≤ y1 ≤ y2 ≤ 1 (no overshoot). */
export type BezierControls = [number, number, number, number];

export interface CursorKeyframe {
  id: string;
  /** Project time at which the cursor ARRIVES at this position. */
  time: Flicks;
  /** Position in normalized SOURCE-video coordinates (0..1, origin top-left). */
  x: number;
  y: number;
  /** Easing of the movement that arrives at this keyframe. */
  easing: EasingPreset;
  customBezier?: BezierControls;
  /** Duration of the movement into this keyframe; null = automatic from distance. */
  moveDuration: Flicks | null;
  /**
   * Optional curved path for the movement into this keyframe. Offset of the
   * quadratic control point, perpendicular to the segment, as a fraction of
   * segment length (−0.5..0.5). 0 = straight (default).
   */
  curve: number;
}

export type ClickButton = 'left' | 'right' | 'double';

export interface CursorClick {
  id: string;
  time: Flicks;
  button: ClickButton;
}

export interface CursorVisibilityEvent {
  id: string;
  time: Flicks;
  visible: boolean;
}

export type CursorThemeId = 'macos' | 'white' | 'dark' | 'tutorial';
export type ClickEffect = 'ripple' | 'pulse' | 'none';

export interface CursorStyle {
  theme: CursorThemeId;
  /** Size multiplier; 1 = cursor about 3% of canvas height. */
  size: number;
  opacity: number;
  shadow: boolean;
  /** Soft halo behind the cursor for high visibility. */
  highlight: boolean;
  highlightColor: string;
  clickEffect: ClickEffect;
  clickColor: string;
  /** Cursor briefly shrinks while pressed. */
  pressAnimation: boolean;
  /** Clip the cursor and click effects to the video's rounded rectangle. */
  clipToVideo: boolean;
}

export interface CursorTrack {
  keyframes: CursorKeyframe[];
  clicks: CursorClick[];
  visibility: CursorVisibilityEvent[];
  style: CursorStyle;
}

// ---------------------------------------------------------------- audio

export type AudioTrackId = 'narration' | 'music';

export interface AudioClip {
  id: string;
  assetId: string;
  track: AudioTrackId;
  /** Project time where the clip starts playing. */
  start: Flicks;
  /** Source range [sourceIn, sourceOut) of the audio file. */
  sourceIn: Flicks;
  sourceOut: Flicks;
  /** Linear gain, 1 = unity. */
  volume: number;
  muted: boolean;
  fadeIn: Flicks;
  fadeOut: Flicks;
}

// ---------------------------------------------------------------- composition

/** Fractions of the source frame removed from each edge (0..1). */
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type HAlign = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'center' | 'bottom';

export interface VideoLayout {
  /** Padding as fractions of canvas width (left/right) and height (top/bottom). */
  padding: { left: number; top: number; right: number; bottom: number };
  /** Multiplier applied after fitting the cropped video into the padded area. */
  scale: number;
  hAlign: HAlign;
  vAlign: VAlign;
  /** Extra offset as a fraction of canvas width / height. */
  offsetX: number;
  offsetY: number;
  /** Corner radius as a fraction of canvas height. */
  cornerRadius: number;
  shadow: {
    enabled: boolean;
    /** Gaussian blur, fraction of canvas height (canvas shadowBlur semantics). */
    blur: number;
    opacity: number;
    /** Fractions of canvas height. */
    offsetX: number;
    offsetY: number;
    color: string;
  };
}

export interface GradientStop {
  color: string;
  pos: number;
}

export type Background =
  | { kind: 'preset'; id: string }
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; angle: number; stops: GradientStop[] }
  | { kind: 'image'; assetId: string };

export interface CanvasSettings {
  /** Aspect ratio of the composition (e.g. 16:9). */
  aspectW: number;
  aspectH: number;
}

export type ExportResolution = 1080 | 1440 | 2160;
export type VideoCodec = 'h264' | 'hevc';
export type QualityPreset = 'standard' | 'high' | 'max';

export interface ExportSettings {
  resolution: ExportResolution;
  fps: FrameRate;
  codec: VideoCodec;
  quality: QualityPreset;
}

export interface RippleSettings {
  /** Shift cursor keyframes/clicks when time is inserted or removed in the video track. */
  cursor: boolean;
  /** Shift audio clips when time is inserted or removed in the video track. */
  audio: boolean;
}

export interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  media: MediaAsset[];
  video: {
    segments: VideoSegment[];
    crop: Crop;
    layout: VideoLayout;
    /** Play the recording's own audio track (off by default; screen recordings are silent). */
    sourceAudio: boolean;
    sourceAudioVolume: number;
  };
  cursor: CursorTrack;
  audio: AudioClip[];
  background: Background;
  canvas: CanvasSettings;
  export: ExportSettings;
  ripple: RippleSettings;
}

// ---------------------------------------------------------------- defaults

export const DEFAULT_CURSOR_STYLE: CursorStyle = {
  theme: 'macos',
  size: 1,
  opacity: 1,
  shadow: true,
  highlight: false,
  highlightColor: '#ffd84d',
  clickEffect: 'ripple',
  clickColor: '#ffffff',
  pressAnimation: true,
  clipToVideo: true,
};

export const DEFAULT_LAYOUT: VideoLayout = {
  padding: { left: 0.07, top: 0.08, right: 0.07, bottom: 0.08 },
  scale: 1,
  hAlign: 'center',
  vAlign: 'center',
  offsetX: 0,
  offsetY: 0,
  cornerRadius: 0.014,
  shadow: {
    enabled: true,
    blur: 0.045,
    opacity: 0.38,
    offsetX: 0,
    offsetY: 0.018,
    color: '#0b0d1a',
  },
};

export function newId(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return prefix ? `${prefix}_${rnd}` : rnd;
}

export function createEmptyProject(name = 'Untitled Project'): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newId('prj'),
    name,
    createdAt: now,
    modifiedAt: now,
    media: [],
    video: {
      segments: [],
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      layout: structuredClone(DEFAULT_LAYOUT),
      sourceAudio: false,
      sourceAudioVolume: 1,
    },
    cursor: {
      keyframes: [],
      clicks: [],
      visibility: [],
      style: { ...DEFAULT_CURSOR_STYLE },
    },
    audio: [],
    background: { kind: 'preset', id: 'aurora-violet' },
    canvas: { aspectW: 16, aspectH: 9 },
    export: { resolution: 1440, fps: { num: 30, den: 1 }, codec: 'h264', quality: 'high' },
    ripple: { cursor: true, audio: false },
  };
}

/** Pixel size of the export canvas for a resolution preset (short side = preset). */
export function exportCanvasSize(canvas: CanvasSettings, resolution: ExportResolution): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (canvas.aspectW >= canvas.aspectH) {
    return { width: even((resolution * canvas.aspectW) / canvas.aspectH), height: resolution };
  }
  return { width: resolution, height: even((resolution * canvas.aspectH) / canvas.aspectW) };
}

// ---------------------------------------------------------------- migration / validation

export class ProjectFormatError extends Error {}

/**
 * Upgrade older project JSON to the current schema and fill missing fields
 * with defaults. Throws ProjectFormatError for unreadable data.
 */
export function migrateProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new ProjectFormatError('Project file is not a JSON object.');
  const r = raw as Partial<Project> & { schemaVersion?: number };
  if (typeof r.schemaVersion !== 'number') throw new ProjectFormatError('Missing schemaVersion.');
  if (r.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFormatError(
      `This project was created by a newer version (schema ${r.schemaVersion}). Please update Tutorial Studio.`,
    );
  }
  const base = createEmptyProject(typeof r.name === 'string' ? r.name : 'Untitled Project');
  const p: Project = {
    ...base,
    ...r,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    media: Array.isArray(r.media) ? r.media : [],
    video: {
      ...base.video,
      ...(r.video ?? {}),
      segments: Array.isArray(r.video?.segments) ? r.video!.segments : [],
      crop: { ...base.video.crop, ...(r.video?.crop ?? {}) },
      layout: {
        ...base.video.layout,
        ...(r.video?.layout ?? {}),
        padding: { ...base.video.layout.padding, ...(r.video?.layout?.padding ?? {}) },
        shadow: { ...base.video.layout.shadow, ...(r.video?.layout?.shadow ?? {}) },
      },
    },
    cursor: {
      keyframes: Array.isArray(r.cursor?.keyframes) ? r.cursor!.keyframes : [],
      clicks: Array.isArray(r.cursor?.clicks) ? r.cursor!.clicks : [],
      visibility: Array.isArray(r.cursor?.visibility) ? r.cursor!.visibility : [],
      style: { ...DEFAULT_CURSOR_STYLE, ...(r.cursor?.style ?? {}) },
    },
    audio: Array.isArray(r.audio) ? r.audio : [],
    background: r.background ?? base.background,
    canvas: { ...base.canvas, ...(r.canvas ?? {}) },
    export: { ...base.export, ...(r.export ?? {}) },
    ripple: { ...base.ripple, ...(r.ripple ?? {}) },
  };
  for (const s of p.video.segments) {
    if (!p.media.some((m) => m.id === s.assetId)) {
      throw new ProjectFormatError(`Video segment ${s.id} references unknown media ${s.assetId}.`);
    }
  }
  return p;
}

/**
 * Typed contracts between the React renderer, the Electron main process
 * (exposed through the preload bridge as `window.studio`), and the native
 * helpers (NDJSON over stdio).
 */
import type { MediaAsset, Project } from './schema';

// ---------------------------------------------------------------- renderer ↔ main

export interface OpenProjectResult {
  project: Project;
  path: string;
  missing: string[];
}

export interface SaveProjectRequest {
  project: Project;
  /** Existing package path, or null to ask for one. */
  path: string | null;
  saveAs: boolean;
}

export interface SaveProjectResult {
  path: string;
  project: Project;
}

export interface RecoveryInfo {
  project: Project;
  path: string | null;
  savedAt: string;
}

export interface ThumbnailStrip {
  assetId: string;
  /** studio-media:// URLs, one per `interval`. */
  urls: string[];
  interval: number; // seconds
  width: number;
  height: number;
}

export interface ProxyInfo {
  assetId: string;
  /** studio-media:// URL of the scrub proxy. */
  url: string;
  width: number;
  height: number;
}

export interface CaptureDisplay {
  id: number;
  width: number;
  height: number;
  scale: number;
  name: string;
  thumbnail?: string;
}

export interface CaptureWindow {
  id: number;
  title: string;
  app: string;
  bundleId: string;
  width: number;
  height: number;
  displayId: number;
  thumbnail?: string;
}

export interface CaptureSources {
  displays: CaptureDisplay[];
  windows: CaptureWindow[];
}

export type PermissionState = 'granted' | 'denied' | 'unknown';

export interface RecordingConfig {
  mode: 'display' | 'window' | 'region';
  displayId?: number;
  windowId?: number;
  /** Region in display points, origin top-left (mode = region). */
  region?: { x: number; y: number; w: number; h: number };
  fps: 30 | 60;
  countdown: number;
  showCursor: boolean;
  /** Test-only: verify cursor exclusion after recording (display mode). */
  selfTest?: boolean;
}

export type RecordingEvent =
  | { type: 'countdown'; remaining: number }
  | { type: 'started' }
  | { type: 'progress'; seconds: number; frames: number }
  | { type: 'finalizing' }
  | { type: 'finished'; asset: MediaAsset; selfTest?: Record<string, unknown> }
  | { type: 'error'; message: string; code?: string }
  | { type: 'cancelled' };

export interface ExportRequest {
  project: Project;
  outputPath: string;
}

export type ExportEvent =
  | { type: 'progress'; jobId: string; frame: number; total: number; fps: number; phase: 'video' | 'audio' | 'finalizing' }
  | { type: 'done'; jobId: string; path: string; bytes: number; seconds: number }
  | { type: 'error'; jobId: string; message: string }
  | { type: 'cancelled'; jobId: string };

export type MenuCommand =
  | 'new' | 'open' | 'save' | 'save-as' | 'import' | 'record' | 'export'
  | 'undo' | 'redo' | 'delete' | 'duplicate' | 'split' | 'freeze' | 'select-all'
  | 'play' | 'zoom-in' | 'zoom-out' | 'zoom-fit' | 'cursor-mode' | 'add-click' | 'toggle-path' | 'help';

export interface StudioAPI {
  platform: string;
  versions: { app: string; electron: string; chrome: string };
  project: {
    open(path?: string): Promise<OpenProjectResult | null>;
    save(req: SaveProjectRequest): Promise<SaveProjectResult | null>;
    autosave(project: Project, path: string | null): Promise<void>;
    getRecovery(): Promise<RecoveryInfo | null>;
    clearRecovery(): Promise<void>;
    recent(): Promise<string[]>;
    setDirty(dirty: boolean): void;
    setTitle(title: string): void;
  };
  media: {
    importDialog(kind: 'video' | 'audio' | 'image' | 'any'): Promise<MediaAsset[]>;
    importPaths(paths: string[]): Promise<{ assets: MediaAsset[]; errors: string[] }>;
    pathForFile(file: File): string;
    url(path: string): string;
    thumbnails(asset: MediaAsset): Promise<ThumbnailStrip>;
    proxy(asset: MediaAsset): Promise<ProxyInfo>;
    relink(asset: MediaAsset): Promise<MediaAsset | null>;
  };
  recording: {
    permission(): Promise<PermissionState>;
    openPermissionSettings(): Promise<void>;
    listSources(): Promise<CaptureSources>;
    start(config: RecordingConfig): Promise<void>;
    stop(): Promise<void>;
    cancel(): Promise<void>;
    onEvent(cb: (e: RecordingEvent) => void): () => void;
  };
  render: {
    chooseOutput(defaultName: string): Promise<string | null>;
    start(req: ExportRequest): Promise<{ jobId: string }>;
    cancel(jobId: string): Promise<void>;
    onEvent(cb: (e: ExportEvent) => void): () => void;
  };
  system: {
    revealInFinder(path: string): Promise<void>;
    onMenu(cb: (cmd: MenuCommand) => void): () => void;
    onBeforeClose(cb: () => void): () => void;
    confirmClose(): void;
  };
}

// ---------------------------------------------------------------- main ↔ native helpers (NDJSON)

export interface HelperProbeResult {
  kind: 'video' | 'audio' | 'image';
  duration: number; // seconds
  width?: number;
  height?: number;
  frameRate?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  sampleRate?: number;
  channels?: number;
  codec?: string;
}

export type HelperMessage =
  | { type: 'progress'; frame?: number; total?: number; fps?: number; phase?: string; seconds?: number; frames?: number }
  | { type: 'result'; [key: string]: unknown }
  | { type: 'event'; event: string; [key: string]: unknown }
  | { type: 'error'; message: string; code?: string }
  | { type: 'log'; message: string };

/**
 * Editor state (zustand).
 *  - `project` is the persisted document; every committed change goes through
 *    `commit()` so undo/redo is a simple snapshot history.
 *  - Drags call `beginGesture()` → many `preview()` updates → `endGesture()`,
 *    producing ONE history entry. Gesture updates are computed from the
 *    snapshot taken at gesture start, so dragging back restores exactly.
 *  - High-frequency playback time lives in ./playhead.ts, not here.
 */
import { create } from 'zustand';
import { createEmptyProject, type Project } from '../../shared/schema';
import type { ThumbnailStrip } from '../../shared/ipc';

export type SelectionKind = 'segment' | 'audio' | 'keyframe' | 'click' | 'visibility';
export interface Selection {
  kind: SelectionKind | null;
  ids: string[];
}
export type EditorMode = 'select' | 'cursor' | 'crop';
export type InspectorTab = 'auto' | 'video' | 'cursor' | 'canvas';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  action?: { label: string; run: () => void };
}

export interface Waveform {
  /** Peak pairs (min,max) per bucket, merged channels. */
  peaks: Float32Array;
  bucketsPerSecond: number;
  duration: number;
}

interface EditorState {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  savedVersion: number;
  version: number;
  past: Project[];
  future: Project[];
  gestureBase: Project | null;

  selection: Selection;
  mode: EditorMode;
  inspectorTab: InspectorTab;
  showPath: boolean;
  snapping: boolean;
  pxPerSecond: number;
  timelineHeight: number;
  sidebarTab: 'media' | 'backgrounds' | 'layout' | 'cursor';

  thumbnails: Record<string, ThumbnailStrip>;
  waveforms: Record<string, Waveform>;
  toasts: Toast[];
  dialog: null | 'export' | 'record' | 'freeze' | 'help';

  commit(fn: (p: Project) => Project, opts?: { select?: Selection }): void;
  beginGesture(): void;
  preview(fn: (base: Project) => Project): void;
  endGesture(): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  load(p: Project, path: string | null, opts?: { dirty?: boolean }): void;
  markSaved(p: Project, path: string): void;
  select(sel: Selection): void;
  set(patch: Partial<EditorState>): void;
  toast(kind: Toast['kind'], message: string, action?: Toast['action']): void;
  dismissToast(id: number): void;
}

const HISTORY_LIMIT = 200;
let toastId = 1;

export const useEditor = create<EditorState>((set, get) => ({
  project: createEmptyProject(),
  projectPath: null,
  dirty: false,
  savedVersion: 0,
  version: 0,
  past: [],
  future: [],
  gestureBase: null,

  selection: { kind: null, ids: [] },
  mode: 'select',
  inspectorTab: 'auto',
  showPath: true,
  snapping: true,
  pxPerSecond: 80,
  timelineHeight: 300,
  sidebarTab: 'media',

  thumbnails: {},
  waveforms: {},
  toasts: [],
  dialog: null,

  commit(fn, opts) {
    const s = get();
    const next = fn(s.project);
    if (next === s.project) return;
    const version = s.version + 1;
    set({
      project: next,
      past: [...s.past, s.project].slice(-HISTORY_LIMIT),
      future: [],
      version,
      dirty: true,
      ...(opts?.select ? { selection: opts.select } : {}),
    });
  },

  beginGesture() {
    set({ gestureBase: get().project });
  },
  preview(fn) {
    const base = get().gestureBase ?? get().project;
    set({ project: fn(base) });
  },
  endGesture() {
    const s = get();
    const base = s.gestureBase;
    if (!base) return;
    if (base === s.project) {
      set({ gestureBase: null });
      return;
    }
    set({ gestureBase: null, past: [...s.past, base].slice(-HISTORY_LIMIT), future: [], version: s.version + 1, dirty: true });
  },
  cancelGesture() {
    const base = get().gestureBase;
    if (base) set({ project: base, gestureBase: null });
  },

  undo() {
    const s = get();
    if (!s.past.length) return;
    const prev = s.past[s.past.length - 1];
    const version = s.version + 1;
    set({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], version, dirty: true });
  },
  redo() {
    const s = get();
    if (!s.future.length) return;
    const [next, ...rest] = s.future;
    set({ project: next, past: [...s.past, s.project], future: rest, version: s.version + 1, dirty: true });
  },

  load(p, path, opts) {
    set({ project: p, projectPath: path, past: [], future: [], dirty: !!opts?.dirty, version: 0, savedVersion: 0, selection: { kind: null, ids: [] }, mode: 'select', gestureBase: null });
  },
  markSaved(p, path) {
    // Keep history; only the reference paths/media changed on save.
    set({ project: p, projectPath: path, dirty: false, savedVersion: get().version });
  },
  select(sel) {
    set({ selection: sel });
  },
  set(patch) {
    set(patch as Partial<EditorState>);
  },
  toast(kind, message, action) {
    const id = toastId++;
    set({ toasts: [...get().toasts, { id, kind, message, action }].slice(-4) });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 9000 : 4500);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export const editor = () => useEditor.getState();

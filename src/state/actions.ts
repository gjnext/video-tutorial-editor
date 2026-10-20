/**
 * User-level editing operations shared by menus, shortcuts, context menus,
 * and toolbar buttons. All document changes go through store.commit() (one
 * undo step each) and are pure transformations from shared/.
 */
import { createEmptyProject, newId, type AudioTrackId, type ClickButton, type CursorKeyframe, type Highlight, type MediaAsset, type Project } from '../../shared/schema';
import { appendClip, applySegmentEdit, deleteSegment, duplicateSegment, insertFreeze as insertFreezeEdit, mapProjectTime, placeSegments, projectDuration, splitAt } from '../../shared/timeline';
import { clipEnd, createAudioClip, findFreeStart, splitAudioClip } from '../../shared/audio';
import { evaluateCursorPosition, sortByTime } from '../../shared/cursor';
import { createHighlight, HIGHLIGHT_STYLES } from '../../shared/highlights';
import { frameDuration, flicksToFrame, frameToFlicks, secondsToFlicks, type Flicks } from '../../shared/time';
import { editor } from './store';
import { playhead } from './playhead';
import { player } from '../engine/player';
import { prefetchProjectMedia } from '../engine/mediaCache';

const api = () => window.studio;

export const now = () => playhead.getState().time;
export const fps = () => editor().project.export.fps;

function errMsg(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ------------------------------------------------------------ project lifecycle

export function newProject() {
  if (editor().dirty && !confirm('Discard unsaved changes and start a new project?')) return;
  player.pause();
  editor().load(createEmptyProject(), null);
  player.seek(0);
}

export async function openProject(path?: string) {
  if (editor().dirty && !confirm('Discard unsaved changes and open another project?')) return;
  try {
    const res = await api().project.open(path);
    if (!res) return;
    player.pause();
    editor().load(res.project, res.path);
    prefetchProjectMedia(res.project.media);
    player.seek(0);
    if (res.missing.length) editor().toast('error', `Missing media: ${res.missing.join(', ')}. Select the item in the Media panel to relink it.`);
  } catch (e) {
    editor().toast('error', errMsg(e));
  }
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = editor();
  try {
    const res = await api().project.save({ project: s.project, path: s.projectPath, saveAs });
    if (!res) return false;
    // Media may have been copied into the package; keep the updated references.
    const current = editor().project;
    const merged: Project = { ...current, name: res.project.name, media: res.project.media, modifiedAt: res.project.modifiedAt };
    editor().markSaved(merged, res.path);
    editor().toast('success', `Saved “${res.project.name}”.`);
    return true;
  } catch (e) {
    editor().toast('error', `Save failed: ${errMsg(e)}`);
    return false;
  }
}

let autosaveTimer: ReturnType<typeof setInterval> | null = null;
let lastAutosavedVersion = -1;
export function startAutosave() {
  if (autosaveTimer) return;
  autosaveTimer = setInterval(() => {
    const s = editor();
    if (!s.dirty || s.version === lastAutosavedVersion || s.gestureBase) return;
    lastAutosavedVersion = s.version;
    api().project.autosave(s.project, s.projectPath).catch(() => {});
  }, 15_000);
}

// ------------------------------------------------------------ media

export function addAssets(assets: MediaAsset[], opts: { placeOnTimeline?: boolean } = {}) {
  if (!assets.length) return;
  const place = opts.placeOnTimeline ?? true;
  editor().commit((p) => {
    let next: Project = { ...p, media: [...p.media, ...assets.filter((a) => !p.media.some((m) => m.path === a.path))] };
    for (const a of assets) {
      const asset = next.media.find((m) => m.path === a.path)!;
      if (!place) continue;
      if (asset.kind === 'video' && next.video.segments.length === 0) {
        next = applySegmentEdit(next, appendClip(next.video.segments, asset.id, asset.duration));
      } else if (asset.kind === 'audio') {
        const start = findFreeStart(next.audio, 'narration', next.audio.length ? now() : 0, asset.duration);
        next = { ...next, audio: [...next.audio, { ...createAudioClip(asset, 'narration', start) }] };
      }
    }
    return next;
  });
  prefetchProjectMedia(assets);
  const baked = assets.find((a) => a.kind === 'video' && a.origin === 'imported');
  if (baked) {
    editor().toast(
      'info',
      'Imported footage may already contain the original mouse pointer, which cannot be removed reliably. For the cleanest result, record with Tutorial Studio — the real cursor is excluded automatically.',
    );
  }
}

export async function importMedia(kind: 'video' | 'audio' | 'image' | 'any' = 'any') {
  try {
    const assets = await api().media.importDialog(kind);
    addAssets(assets);
  } catch (e) {
    editor().toast('error', errMsg(e));
  }
}

export async function importFiles(files: File[]) {
  const paths = files.map((f) => api().media.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  try {
    const res = await api().media.importPaths(paths);
    addAssets(res.assets);
    if (res.errors.length) editor().toast('error', res.errors.join(' '));
  } catch (e) {
    editor().toast('error', errMsg(e));
  }
}

export function appendVideo(asset: MediaAsset) {
  editor().commit((p) => applySegmentEdit(p, appendClip(p.video.segments, asset.id, asset.duration)));
}

export function addAudioClip(asset: MediaAsset, track: AudioTrackId = 'narration', at?: Flicks) {
  editor().commit((p) => {
    const start = findFreeStart(p.audio, track, at ?? now(), asset.duration);
    const clip = createAudioClip(asset, track, start);
    return { ...p, audio: [...p.audio, clip] };
  });
}

export function removeAsset(id: string) {
  const p = editor().project;
  const used = p.video.segments.some((s) => s.assetId === id) || p.audio.some((c) => c.assetId === id) || (p.background.kind === 'image' && p.background.assetId === id);
  if (used && !confirm('This media is used in the timeline. Remove it and every clip that uses it?')) return;
  editor().commit((q) => ({
    ...q,
    media: q.media.filter((m) => m.id !== id),
    video: { ...q.video, segments: q.video.segments.filter((s) => s.assetId !== id) },
    audio: q.audio.filter((c) => c.assetId !== id),
    background: q.background.kind === 'image' && q.background.assetId === id ? { kind: 'preset', id: 'aurora-violet' } : q.background,
  }));
}

export async function relinkAsset(asset: MediaAsset) {
  try {
    const fresh = await api().media.relink(asset);
    if (!fresh) return;
    editor().commit((p) => ({ ...p, media: p.media.map((m) => (m.id === asset.id ? fresh : m)) }));
    prefetchProjectMedia([fresh]);
    editor().toast('success', `Relinked “${fresh.name}”.`);
  } catch (e) {
    editor().toast('error', errMsg(e));
  }
}

// ------------------------------------------------------------ transport

export function stepFrames(n: number) {
  const r = fps();
  const f = flicksToFrame(now(), r) + n;
  player.seek(frameToFlicks(Math.max(0, f), r));
}

export function seekToEdge(dir: -1 | 1) {
  const p = editor().project;
  const t = now();
  const edges = new Set<number>([0, projectDuration(p)]);
  for (const s of placeSegments(p.video.segments)) {
    edges.add(s.start);
    edges.add(s.end);
  }
  for (const c of p.audio) {
    edges.add(c.start);
    edges.add(clipEnd(c));
  }
  for (const k of p.cursor.keyframes) edges.add(k.time);
  for (const k of p.cursor.clicks) edges.add(k.time);
  const sorted = [...edges].sort((a, b) => a - b);
  const target = dir > 0 ? sorted.find((e) => e > t + 1) : [...sorted].reverse().find((e) => e < t - 1);
  if (target != null) player.seek(target);
}

// ------------------------------------------------------------ timeline edits

export function splitAtPlayhead() {
  const s = editor();
  const t = now();
  if (s.selection.kind === 'audio' && s.selection.ids.length) {
    let rightId: string | undefined;
    s.commit((p) => {
      let clips = p.audio;
      for (const id of s.selection.ids) {
        const r = splitAudioClip(clips, id, t);
        clips = r.clips;
        rightId = r.rightId ?? rightId;
      }
      return { ...p, audio: clips };
    });
    if (rightId) s.select({ kind: 'audio', ids: [rightId] });
    return;
  }
  const r = splitAt(s.project.video.segments, t);
  if (r.segments === s.project.video.segments) {
    s.toast('info', 'Move the playhead inside a video clip to split it.');
    return;
  }
  s.commit((p) => applySegmentEdit(p, r), { select: r.selectId ? { kind: 'segment', ids: [r.selectId] } : undefined });
}

export function insertFreeze(seconds: number) {
  const s = editor();
  if (!s.project.video.segments.length) {
    s.toast('info', 'Add a video before inserting a freeze frame.');
    return;
  }
  const dur = secondsToFlicks(Math.max(0.05, seconds));
  const t = Math.min(now(), projectDuration(s.project));
  const r = insertFreezeEdit(s.project.video.segments, t, dur);
  s.commit((p) => applySegmentEdit(p, r), { select: r.selectId ? { kind: 'segment', ids: [r.selectId] } : undefined });
}

/** Extend the end of the video with a freeze so narration that runs past it is not cut. */
export function extendToCoverAudio() {
  const p = editor().project;
  const end = projectDuration(p);
  let audioEnd = 0;
  for (const c of p.audio) audioEnd = Math.max(audioEnd, clipEnd(c));
  if (audioEnd <= end || !p.video.segments.length) return;
  const r = insertFreezeEdit(p.video.segments, end, audioEnd - end);
  editor().commit((q) => applySegmentEdit(q, r), { select: r.selectId ? { kind: 'segment', ids: [r.selectId] } : undefined });
}

export function deleteSelection() {
  const s = editor();
  const { kind, ids } = s.selection;
  if (!kind || !ids.length) return;
  const set = new Set(ids);
  s.commit(
    (p) => {
      switch (kind) {
        case 'segment': {
          let next = p;
          for (const id of ids) next = applySegmentEdit(next, deleteSegment(next.video.segments, id));
          return next;
        }
        case 'audio':
          return { ...p, audio: p.audio.filter((c) => !set.has(c.id)) };
        case 'keyframe':
          return { ...p, cursor: { ...p.cursor, keyframes: p.cursor.keyframes.filter((k) => !set.has(k.id)) } };
        case 'click':
          return { ...p, cursor: { ...p.cursor, clicks: p.cursor.clicks.filter((k) => !set.has(k.id)) } };
        case 'visibility':
          return { ...p, cursor: { ...p.cursor, visibility: p.cursor.visibility.filter((k) => !set.has(k.id)) } };
        case 'highlight':
          return { ...p, highlights: p.highlights.filter((h) => !set.has(h.id)) };
      }
      return p;
    },
    { select: { kind: null, ids: [] } },
  );
}

export function duplicateSelection() {
  const s = editor();
  const { kind, ids } = s.selection;
  if (!kind || !ids.length) return;
  const offset = frameDuration(fps()) * 10;
  const newIds: string[] = [];
  s.commit((p) => {
    switch (kind) {
      case 'segment': {
        let next = p;
        for (const id of ids) {
          const r = duplicateSegment(next.video.segments, id);
          if (r.selectId) newIds.push(r.selectId);
          next = applySegmentEdit(next, r);
        }
        return next;
      }
      case 'audio': {
        let clips = p.audio;
        for (const id of ids) {
          const c = clips.find((x) => x.id === id);
          if (!c) continue;
          const dup = { ...c, id: newId('aud') };
          dup.start = findFreeStart(clips, c.track, clipEnd(c), clipEnd(c) - c.start);
          newIds.push(dup.id);
          clips = [...clips, dup];
        }
        return { ...p, audio: clips };
      }
      case 'keyframe': {
        const add = p.cursor.keyframes.filter((k) => ids.includes(k.id)).map((k) => ({ ...k, id: newId('kf'), time: k.time + offset }));
        newIds.push(...add.map((k) => k.id));
        return { ...p, cursor: { ...p.cursor, keyframes: [...p.cursor.keyframes, ...add] } };
      }
      case 'click': {
        const add = p.cursor.clicks.filter((k) => ids.includes(k.id)).map((k) => ({ ...k, id: newId('clk'), time: k.time + offset }));
        newIds.push(...add.map((k) => k.id));
        return { ...p, cursor: { ...p.cursor, clicks: [...p.cursor.clicks, ...add] } };
      }
      case 'highlight': {
        // Duplicates play right after the original.
        const add = p.highlights.filter((h) => ids.includes(h.id)).map((h) => ({ ...h, id: newId('hl'), start: h.end, end: h.end + (h.end - h.start) }));
        newIds.push(...add.map((h) => h.id));
        return { ...p, highlights: [...p.highlights, ...add] };
      }
    }
    return p;
  });
  if (newIds.length) s.select({ kind, ids: newIds });
}

// ------------------------------------------------------------ cursor

const sameFrame = (a: Flicks, b: Flicks) => flicksToFrame(a, fps()) === flicksToFrame(b, fps());

/** Add (or move, if one exists on this frame) a cursor keyframe at the playhead. */
export function placeKeyframe(x: number, y: number, t: Flicks = now()): string {
  const s = editor();
  const existing = s.project.cursor.keyframes.find((k) => sameFrame(k.time, t));
  if (existing) {
    s.commit((p) => ({ ...p, cursor: { ...p.cursor, keyframes: p.cursor.keyframes.map((k) => (k.id === existing.id ? { ...k, x, y } : k)) } }), { select: { kind: 'keyframe', ids: [existing.id] } });
    return existing.id;
  }
  const sorted = sortByTime(s.project.cursor.keyframes);
  const prev = [...sorted].reverse().find((k) => k.time < t);
  const kf: CursorKeyframe = {
    id: newId('kf'),
    time: t,
    x,
    y,
    easing: prev?.easing ?? 'smooth',
    customBezier: prev?.customBezier,
    moveDuration: null,
    curve: 0,
  };
  s.commit((p) => ({ ...p, cursor: { ...p.cursor, keyframes: [...p.cursor.keyframes, kf] } }), { select: { kind: 'keyframe', ids: [kf.id] } });
  return kf.id;
}

export function addClick(button: ClickButton = 'left', t: Flicks = now()) {
  const s = editor();
  if (!s.project.cursor.keyframes.length) {
    s.toast('info', 'Place the cursor first: switch to Cursor mode (K) and click on the video.');
    return;
  }
  const existing = s.project.cursor.clicks.find((c) => sameFrame(c.time, t));
  if (existing) {
    s.commit((p) => ({ ...p, cursor: { ...p.cursor, clicks: p.cursor.clicks.map((c) => (c.id === existing.id ? { ...c, button } : c)) } }), { select: { kind: 'click', ids: [existing.id] } });
    return;
  }
  const c = { id: newId('clk'), time: t, button };
  s.commit((p) => ({ ...p, cursor: { ...p.cursor, clicks: [...p.cursor.clicks, c] } }), { select: { kind: 'click', ids: [c.id] } });
}

export function addVisibility(visible: boolean, t: Flicks = now()) {
  const e = { id: newId('vis'), time: t, visible };
  editor().commit((p) => ({ ...p, cursor: { ...p.cursor, visibility: [...p.cursor.visibility.filter((v) => !sameFrame(v.time, t)), e] } }), { select: { kind: 'visibility', ids: [e.id] } });
}

/** Insert a pause: hold the cursor at its current position until the playhead + `seconds`. */
export function addPause(seconds = 1) {
  const s = editor();
  const p = s.project;
  if (!p.cursor.keyframes.length) return;
  const t = now();
  const sorted = sortByTime(p.cursor.keyframes);
  const at = [...sorted].reverse().find((k) => k.time <= t) ?? sorted[0];
  const hold: CursorKeyframe = { ...at, id: newId('kf'), time: Math.max(t, at.time) + secondsToFlicks(seconds), moveDuration: null, curve: 0 };
  s.commit((q) => {
    // Push later keyframes back by the pause so their relative timing is kept.
    const shift = secondsToFlicks(seconds);
    const later = q.cursor.keyframes.map((k) => (k.time > t ? { ...k, time: k.time + shift } : k));
    return { ...q, cursor: { ...q.cursor, keyframes: [...later, hold] } };
  });
}

export function selectAll() {
  const s = editor();
  const kind = s.selection.kind ?? 'keyframe';
  const p = s.project;
  const ids =
    kind === 'highlight' ? p.highlights.map((x) => x.id) : kind === 'segment' ? p.video.segments.map((x) => x.id) : kind === 'audio' ? p.audio.map((x) => x.id) : kind === 'click' ? p.cursor.clicks.map((x) => x.id) : kind === 'visibility' ? p.cursor.visibility.map((x) => x.id) : p.cursor.keyframes.map((x) => x.id);
  s.select({ kind, ids });
}

export function toggleCursorMode() {
  const s = editor();
  s.set({ mode: s.mode === 'cursor' ? 'select' : 'cursor' });
}

export function sourceAt(t: Flicks) {
  return mapProjectTime(editor().project.video.segments, t);
}

export { errMsg };

// ------------------------------------------------------------ highlights

/** Circle the spot where a click happens, for the length of the click moment. */
export function highlightClick(clickId: string) {
  const s = editor();
  const p = s.project;
  const c = p.cursor.clicks.find((x) => x.id === clickId);
  if (!c) return;
  const aspect = (() => {
    const a = p.media.find((m) => m.id === p.video.segments[0]?.assetId);
    return a?.width && a?.height ? a.width / a.height : 16 / 9;
  })();
  const pos = evaluateCursorPosition(p.cursor.keyframes, c.time, aspect);
  if (!pos) return;
  const ry = 0.045;
  const rx = ry / aspect;
  const style = HIGHLIGHT_STYLES.find((x) => x.id === s.highlightStyle) ?? HIGHLIGHT_STYLES[0];
  const h = createHighlight('ellipse', { x: pos.x - rx, y: pos.y - ry, w: rx * 2, h: ry * 2 }, Math.max(0, c.time - secondsToFlicks(0.4)), style);
  h.end = c.time + secondsToFlicks(1.4);
  s.commit((q) => ({ ...q, highlights: [...q.highlights, h] }), { select: { kind: 'highlight', ids: [h.id] } });
}

export function updateHighlights(ids: string[], patch: (h: Highlight) => Partial<Highlight>, gesture = false) {
  const fn = (p: Project): Project => ({ ...p, highlights: p.highlights.map((h) => (ids.includes(h.id) ? { ...h, ...patch(h) } : h)) });
  if (gesture) editor().preview(fn);
  else editor().commit(fn);
}

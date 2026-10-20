/**
 * Timeline editor. Positions are project time (flicks) ↔ pixels via
 * pxPerSecond. Drags are gestures computed from the snapshot taken at
 * pointer-down (store.beginGesture), so they are exact, reversible and one
 * undo step each. The playhead is updated imperatively (no React re-render).
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Magnet, MousePointerClick, Scissors, Snowflake, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { clipDuration, clipEnd, resolveAudioMove, trimAudioClip } from '../../shared/audio';
import { cursorWarnings, resolveMove, sortByTime, evaluateCursorPosition } from '../../shared/cursor';
import { applySegmentEdit, audioOverhang, moveSegment, placeSegments, projectDuration, snapPoints, trimSegment } from '../../shared/timeline';
import { isInsideCrop } from '../../shared/geometry';
import { assetMap, cursorSpaceAspect } from '../../shared/compose';
import { FLICKS_PER_SECOND, flicksToSeconds, formatClock, frameDuration, secondsToFlicks, snapToFrame, type Flicks } from '../../shared/time';
import { newId, type AudioClip, type AudioTrackId, type ClickButton, type Project, type VideoSegment } from '../../shared/schema';
import { editor, useEditor, type Waveform } from '../state/store';
import { playhead } from '../state/playhead';
import { player } from '../engine/player';
import { Button, NumberField, Slider, Toggle, useContextMenu, useTooltip } from '../components/ui';
import { addClick, addVisibility, deleteSelection, duplicateSelection, extendToCoverAudio, insertFreeze, placeKeyframe, splitAtPlayhead } from '../state/actions';

const RULER_H = 26;
const TRACKS = [
  { id: 'video', label: 'Video', h: 58, color: 'var(--track-video-border)' },
  { id: 'cursor', label: 'Cursor', h: 34, color: 'var(--track-cursor)' },
  { id: 'clicks', label: 'Clicks', h: 28, color: 'var(--track-click)' },
  { id: 'narration', label: 'Narration', h: 54, color: 'var(--track-narration-border)' },
  { id: 'music', label: 'Music', h: 40, color: 'var(--track-music-border)' },
] as const;
const trackTop = (id: string) => RULER_H + TRACKS.slice(0, TRACKS.findIndex((t) => t.id === id)).reduce((a, t) => a + t.h, 0);

const toPx = (t: Flicks, pps: number) => (t / FLICKS_PER_SECOND) * pps;
const toT = (px: number, pps: number) => Math.round((px / pps) * FLICKS_PER_SECOND);

interface DragCtx {
  pps: number;
  snapping: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  setSnap: (x: number | null) => void;
}

/** Generic pointer drag with snapping support; returns handlers for onPointerDown. */
function useGesture(ctx: DragCtx) {
  return useCallback(
    (
      e: React.PointerEvent,
      opts: {
        onStart?: () => void;
        onMove: (dt: Flicks, ev: PointerEvent, snap: (t: Flicks, exclude?: Set<string>) => Flicks) => void;
        onEnd?: (moved: boolean) => void;
        exclude?: Set<string>;
      },
    ) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const x0 = e.clientX;
      let moved = false;
      const base = editor().project;
      const points = snapPoints(base, opts.exclude);
      const tol = toT(7, ctx.pps);
      const snap = (t: Flicks) => {
        if (!ctx.snapping) return t;
        const cands = [...points, playhead.getState().time];
        let best = t;
        let bd = tol;
        for (const p of cands) {
          const d = Math.abs(p - t);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        ctx.setSnap(best !== t ? toPx(best, ctx.pps) : null);
        return best;
      };
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - x0;
        if (!moved && Math.abs(dx) < 3) return;
        if (!moved) {
          moved = true;
          editor().beginGesture();
          opts.onStart?.();
        }
        opts.onMove(toT(dx, ctx.pps), ev, snap);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        ctx.setSnap(null);
        if (moved) editor().endGesture();
        opts.onEnd?.(moved);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [ctx],
  );
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const pps = useEditor((s) => s.pxPerSecond);
  const snapping = useEditor((s) => s.snapping);
  const height = useEditor((s) => s.timelineHeight);
  const selection = useEditor((s) => s.selection);
  const waveforms = useEditor((s) => s.waveforms);
  const thumbnails = useEditor((s) => s.thumbnails);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 800 });
  const [snapX, setSnapX] = useState<number | null>(null);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const menu = useContextMenu();
  const duration = projectDuration(project);
  const overhang = audioOverhang(project);
  const contentW = Math.max(viewport.width, toPx(duration + overhang, pps) + 400);
  const dragCtx = useMemo<DragCtx>(() => ({ pps, snapping, scrollRef, setSnap: setSnapX }), [pps, snapping]);
  const gesture = useGesture(dragCtx);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const update = () => setViewport({ left: el.scrollLeft, width: el.clientWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Zoom anchored at a pixel position (pinch / ctrl+wheel / buttons).
  const zoomTo = useCallback((next: number, anchorClientX?: number) => {
    const el = scrollRef.current!;
    const cur = editor().pxPerSecond;
    const z = Math.max(4, Math.min(1200, next));
    const rect = el.getBoundingClientRect();
    const ax = anchorClientX != null ? anchorClientX - rect.left : toPx(playhead.getState().time, cur) - el.scrollLeft;
    const tAtAnchor = (el.scrollLeft + ax) / cur;
    editor().set({ pxPerSecond: z });
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, tAtAnchor * z - ax);
    });
  }, []);
  const zoomFit = useCallback(() => {
    const el = scrollRef.current!;
    const d = flicksToSeconds(projectDuration(editor().project) + audioOverhang(editor().project)) || 10;
    editor().set({ pxPerSecond: Math.max(4, Math.min(1200, (el.clientWidth - 60) / d)) });
    el.scrollLeft = 0;
  }, []);
  useEffect(() => {
    const onZoom = (e: Event) => {
      const d = (e as CustomEvent<string>).detail;
      if (d === 'in') zoomTo(editor().pxPerSecond * 1.5);
      else if (d === 'out') zoomTo(editor().pxPerSecond / 1.5);
      else zoomFit();
    };
    window.addEventListener('studio:zoom', onZoom);
    return () => window.removeEventListener('studio:zoom', onZoom);
  }, [zoomTo, zoomFit]);

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomTo(editor().pxPerSecond * Math.exp(-e.deltaY * 0.01), e.clientX);
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
      // Vertical wheel scrolls horizontally (mouse users); trackpads send deltaX natively.
      scrollRef.current!.scrollLeft += e.deltaY;
    }
  };

  const timeFromClient = (clientX: number) => {
    const el = scrollRef.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    return Math.max(0, Math.min(duration, toT(x, pps)));
  };

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const seek = (cx: number) => {
      let t = timeFromClient(cx);
      if (editor().snapping) t = snapToFrame(t, editor().project.export.fps);
      player.seek(t);
    };
    if (playhead.getState().playing) player.pause();
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onEmptyDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    editor().select({ kind: null, ids: [] });
    scrub(e);
  };

  // Resize handle
  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = editor().timelineHeight;
    const move = (ev: PointerEvent) => editor().set({ timelineHeight: Math.max(200, Math.min(window.innerHeight - 320, h0 - (ev.clientY - y0))) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const assets = useMemo(() => assetMap(project.media), [project.media]);
  const fpsRate = project.export.fps;

  return (
    <div className="timeline" style={{ height }}>
      <div className="timeline-resizer" onPointerDown={startResize} />
      <div className="timeline-toolbar">
        <Button size="small" tip="Split clip at playhead" shortcut="S" onClick={splitAtPlayhead}>
          <Scissors size={12} /> Split
        </Button>
        <div style={{ position: 'relative' }}>
          <Button size="small" data-freeze-button tip="Hold the current frame to extend the scene" shortcut="F" onClick={() => setFreezeOpen((o) => !o)} active={freezeOpen}>
            <Snowflake size={12} /> Freeze
          </Button>
          {freezeOpen && <FreezePopover onClose={() => setFreezeOpen(false)} />}
        </div>
        <Button size="small" tip="Add a cursor click at the playhead" shortcut="C" onClick={() => addClick('left')}>
          <MousePointerClick size={12} /> Click
        </Button>
        <Button size="small" variant="ghost" icon tip="Delete selection" shortcut="⌫" onClick={deleteSelection} disabled={!selection.ids.length}>
          <Trash2 size={13} />
        </Button>
        <div className="sep" />
        <RippleControls project={project} />
        {overhang > 0 && (
          <Button size="small" tip="Narration runs past the end of the video. Insert a freeze at the end to cover it." onClick={extendToCoverAudio} style={{ color: 'var(--warning)' }}>
            <AlertTriangle size={12} /> Audio +{flicksToSeconds(overhang).toFixed(1)}s past end — extend video
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button size="small" variant="ghost" active={snapping} tip="Snap to playhead and edit points" shortcut="N" onClick={() => editor().set({ snapping: !snapping })}>
          <Magnet size={12} /> Snap
        </Button>
        <div className="sep" />
        <Button size="small" variant="ghost" icon tip="Zoom out" shortcut="⌘−" onClick={() => zoomTo(pps / 1.5)}>
          <ZoomOut size={13} />
        </Button>
        <div className="zoom-slider">
          <Slider value={Math.log(pps)} min={Math.log(4)} max={Math.log(1200)} step={0.01} onChange={(v) => zoomTo(Math.exp(v))} />
        </div>
        <Button size="small" variant="ghost" icon tip="Zoom in" shortcut="⌘=" onClick={() => zoomTo(pps * 1.5)}>
          <ZoomIn size={13} />
        </Button>
        <Button size="small" variant="ghost" tip="Fit the whole project" shortcut="⇧Z" onClick={zoomFit}>
          Fit
        </Button>
      </div>
      <div className="timeline-body">
        <div className="track-headers">
          <div style={{ height: RULER_H, borderBottom: '1px solid var(--border)' }} />
          {TRACKS.map((t) => (
            <div key={t.id} className="track-header" style={{ height: t.h }}>
              <span className="swatch" style={{ background: t.color }} />
              {t.label}
            </div>
          ))}
        </div>
        <div className="timeline-scroll" ref={scrollRef} onWheel={onWheel}>
          <div className="timeline-content" style={{ width: contentW }}>
            <Ruler pps={pps} viewport={viewport} fpsNum={fpsRate.num} fpsDen={fpsRate.den} onPointerDown={scrub} />
            <VideoTrack project={project} pps={pps} selection={selection} thumbnails={thumbnails} gesture={gesture} onEmptyDown={onEmptyDown} menu={menu} />
            <CursorTrack project={project} pps={pps} selection={selection} gesture={gesture} onEmptyDown={onEmptyDown} menu={menu} timeFromClient={timeFromClient} />
            <ClickTrack project={project} pps={pps} selection={selection} gesture={gesture} onEmptyDown={onEmptyDown} menu={menu} timeFromClient={timeFromClient} />
            {(['narration', 'music'] as AudioTrackId[]).map((tr) => (
              <AudioTrack key={tr} track={tr} project={project} pps={pps} selection={selection} waveforms={waveforms} viewport={viewport} gesture={gesture} onEmptyDown={onEmptyDown} menu={menu} assets={assets} />
            ))}
            <div className="end-marker" style={{ left: toPx(duration, pps) }} title="End of video" />
            {overhang > 0 && <div className="overhang" style={{ left: toPx(duration, pps), width: toPx(overhang, pps) }} />}
            {snapX != null && <div className="snap-line" style={{ left: snapX }} />}
            <Playhead pps={pps} scrollRef={scrollRef} onScrub={scrub} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RippleControls({ project }: { project: Project }) {
  const tipC = useTooltip('When inserting or removing video time, shift later cursor keyframes and clicks so they stay aligned with the UI');
  const tipA = useTooltip('When inserting or removing video time, also shift later audio clips (off: narration keeps playing through freezes)');
  const set = (patch: Partial<Project['ripple']>) => editor().commit((p) => ({ ...p, ripple: { ...p.ripple, ...patch } }));
  return (
    <>
      <span className="hint">Ripple</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 5 }} {...tipC}>
        <Toggle checked={project.ripple.cursor} onChange={(v) => set({ cursor: v })} label="Ripple cursor" /> <span className="hint">Cursor</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 5 }} {...tipA}>
        <Toggle checked={project.ripple.audio} onChange={(v) => set({ audio: v })} label="Ripple audio" /> <span className="hint">Audio</span>
      </label>
    </>
  );
}

function FreezePopover({ onClose }: { onClose: () => void }) {
  const [secs, setSecs] = useState(2);
  return (
    <div className="popover" style={{ top: 30, left: 0 }} onPointerDown={(e) => e.stopPropagation()}>
      <div style={{ fontWeight: 600 }}>Insert freeze frame</div>
      <div className="hint">Holds the frame under the playhead. Footage resumes from the same frame afterwards; cursor and narration keep running.</div>
      <div className="field">
        <label>Duration</label>
        <NumberField value={secs} min={0.1} max={600} step={0.1} precision={1} unit="s" onChange={setSecs} />
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button size="small" onClick={onClose}>Cancel</Button>
        <Button
          size="small"
          variant="primary"
          onClick={() => {
            insertFreeze(secs);
            onClose();
          }}
        >
          Insert
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ ruler

const Ruler = memo(function Ruler({ pps, viewport, fpsNum, fpsDen, onPointerDown }: { pps: number; viewport: { left: number; width: number }; fpsNum: number; fpsDen: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = viewport.width;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(RULER_H * dpr);
    cv.style.width = `${w}px`;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, RULER_H);
    const steps = [1 / 30, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const major = steps.find((s) => s * pps >= 80) ?? 600;
    const minorDiv = major <= 0.2 ? 2 : 5;
    const minor = major / minorDiv;
    const frame = fpsDen / fpsNum;
    const t0 = Math.floor(viewport.left / pps / minor) * minor;
    const t1 = (viewport.left + w) / pps;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textBaseline = 'top';
    for (let i = 0, t = t0; t <= t1 + minor; i++, t = t0 + i * minor) {
      const x = Math.round(t * pps - viewport.left) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? '#5a5d66' : '#383a41';
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 12 : 18);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#8b8e97';
        const label = major < 1 ? `${formatClock(secondsToFlicks(t), true)}` : formatClock(secondsToFlicks(t));
        ctx.fillText(label, x + 3, 2);
      }
    }
    // Frame ticks at very high zoom.
    if (frame * pps >= 6) {
      ctx.strokeStyle = '#2c2e34';
      const f0 = Math.floor(viewport.left / pps / frame);
      for (let f = f0; f * frame <= t1; f++) {
        const x = Math.round(f * frame * pps - viewport.left) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 22);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
      }
    }
  }, [pps, viewport, fpsNum, fpsDen]);
  return (
    <div className="ruler" onPointerDown={onPointerDown}>
      <canvas ref={ref} style={{ left: viewport.left }} />
    </div>
  );
});

// ------------------------------------------------------------ playhead

function Playhead({ pps, scrollRef, onScrub }: { pps: number; scrollRef: React.RefObject<HTMLDivElement | null>; onScrub: (e: React.PointerEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const apply = (t: Flicks, playing: boolean) => {
      const x = toPx(t, pps);
      if (ref.current) ref.current.style.transform = `translateX(${x}px)`;
      const el = scrollRef.current;
      if (el && playing) {
        // Page the view while playing so the playhead stays visible.
        if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 80;
        else if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
      }
    };
    apply(playhead.getState().time, false);
    return playhead.subscribe((s) => apply(s.time, s.playing));
  }, [pps, scrollRef]);
  return (
    <div ref={ref} className="playhead" style={{ left: 0 }}>
      <div className="head" onPointerDown={onScrub} />
    </div>
  );
}

// ------------------------------------------------------------ video track

interface TrackProps {
  project: Project;
  pps: number;
  selection: { kind: string | null; ids: string[] };
  gesture: ReturnType<typeof useGesture>;
  onEmptyDown: (e: React.PointerEvent) => void;
  menu: ReturnType<typeof useContextMenu>;
}

function selectWith(kind: 'segment' | 'audio' | 'keyframe' | 'click' | 'visibility', id: string, e: { shiftKey: boolean; metaKey: boolean }) {
  const s = editor().selection;
  if ((e.shiftKey || e.metaKey) && s.kind === kind) {
    const ids = s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id];
    editor().select({ kind, ids });
  } else if (!(s.kind === kind && s.ids.includes(id))) {
    editor().select({ kind, ids: [id] });
  }
  editor().set({ inspectorTab: 'auto' });
}

function VideoTrack({ project, pps, selection, gesture, onEmptyDown, menu, thumbnails }: TrackProps & { thumbnails: ReturnType<typeof useEditor.getState>['thumbnails'] }) {
  const placed = placeSegments(project.video.segments);
  const [dragging, setDragging] = useState<{ id: string; dx: number } | null>(null);
  const assets = assetMap(project.media);

  const startMove = (e: React.PointerEvent, seg: VideoSegment) => {
    selectWith('segment', seg.id, e);
    const x0 = e.clientX;
    gesture(e, {
      onMove: (_dt, ev) => setDragging({ id: seg.id, dx: ev.clientX - x0 }),
      onEnd: (moved) => {
        setDragging(null);
        if (!moved) {
          editor().cancelGesture();
          return;
        }
      },
    });
    // Reorder on release: compute target index from pointer position.
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', up);
      const dx = ev.clientX - x0;
      if (Math.abs(dx) < 3) return;
      const p = editor().project;
      const pl = placeSegments(p.video.segments);
      const me = pl.find((x) => x.segment.id === seg.id)!;
      const center = toPx(me.start, pps) + toPx(me.end - me.start, pps) / 2 + dx;
      let idx = pl.filter((x) => x.segment.id !== seg.id && toPx(x.start, pps) + toPx(x.end - x.start, pps) / 2 < center).length;
      idx = Math.max(0, Math.min(pl.length - 1, idx));
      if (idx !== me.index) editor().commit((q) => applySegmentEdit(q, moveSegment(q.video.segments, seg.id, idx)));
    };
    window.addEventListener('pointerup', up);
  };

  const startTrim = (e: React.PointerEvent, seg: VideoSegment, edge: 'start' | 'end') => {
    editor().select({ kind: 'segment', ids: [seg.id] });
    const base = editor().project;
    const pl = placeSegments(base.video.segments).find((x) => x.segment.id === seg.id)!;
    const dur0 = pl.end - pl.start;
    const assetDur = assets.get(seg.assetId)?.duration ?? Infinity;
    gesture(e, {
      exclude: new Set([seg.id]),
      onMove: (dt, _ev, snap) => {
        let dur = edge === 'end' ? dur0 + dt : dur0 - dt;
        if (edge === 'end') dur = snap(pl.start + dur) - pl.start;
        dur = snapToFrame(Math.max(frameDuration(base.export.fps), dur), base.export.fps);
        editor().preview((p) => applySegmentEdit(p, trimSegment(p.video.segments, seg.id, edge, dur, assetDur)));
      },
    });
  };

  const segMenu = (e: React.MouseEvent, seg: VideoSegment) => {
    e.preventDefault();
    selectWith('segment', seg.id, { shiftKey: false, metaKey: false });
    menu(e, [
      { label: 'Split at Playhead', shortcut: 'S', run: splitAtPlayhead },
      { label: 'Insert Freeze Frame (2 s)', shortcut: 'F', run: () => insertFreeze(2) },
      { separator: true, label: '' },
      { label: 'Duplicate', shortcut: '⌘D', run: duplicateSelection },
      { label: 'Delete', shortcut: '⌫', danger: true, run: deleteSelection },
    ]);
  };

  return (
    <div className="track" style={{ height: TRACKS[0].h }} onPointerDown={onEmptyDown}>
      {placed.map(({ segment: seg, start, end }) => {
        const left = toPx(start, pps);
        const width = Math.max(2, toPx(end - start, pps));
        const sel = selection.kind === 'segment' && selection.ids.includes(seg.id);
        const a = assets.get(seg.assetId);
        const strip = thumbnails[seg.assetId];
        const isDrag = dragging?.id === seg.id;
        return (
          <div
            key={seg.id}
            className={`clip ${seg.kind === 'freeze' ? 'freeze' : 'video'} ${sel ? 'selected' : ''}`}
            style={{ left, width, transform: isDrag ? `translateX(${dragging!.dx}px)` : undefined, zIndex: isDrag ? 5 : undefined, opacity: isDrag ? 0.85 : 1 }}
            onPointerDown={(e) => startMove(e, seg)}
            onContextMenu={(e) => segMenu(e, seg)}
          >
            {seg.kind === 'clip' && strip && <Thumbs strip={strip} seg={seg} width={width} pps={pps} />}
            {seg.kind === 'freeze' && strip && (
              <div className="clip-thumbs" style={{ opacity: 0.35 }}>
                <div style={{ width: Math.min(width, 90), backgroundImage: `url("${strip.urls[Math.min(strip.urls.length - 1, Math.floor(flicksToSeconds(seg.sourceTime) / strip.interval))]}")` }} />
              </div>
            )}
            <div className="clip-label">
              {seg.kind === 'freeze' ? <><Snowflake size={10} /> Freeze</> : <span>{a?.name ?? 'Missing media'}</span>}
              <span className="badge">{flicksToSeconds(end - start).toFixed(2)}s</span>
            </div>
            <div className="trim-handle l" onPointerDown={(e) => startTrim(e, seg, 'start')} />
            <div className="trim-handle r" onPointerDown={(e) => startTrim(e, seg, 'end')} />
          </div>
        );
      })}
      {placed.length === 0 && <div className="hint" style={{ position: 'absolute', left: 10, top: 20 }}>Import or record a video to start.</div>}
    </div>
  );
}

function Thumbs({ strip, seg, width, pps }: { strip: { urls: string[]; interval: number; width: number; height: number }; seg: Extract<VideoSegment, { kind: 'clip' }>; width: number; pps: number }) {
  const h = TRACKS[0].h - 10;
  const tw = Math.max(20, (strip.width / strip.height) * h);
  const n = Math.min(400, Math.ceil(width / tw));
  const items = [];
  for (let i = 0; i < n; i++) {
    const srcT = flicksToSeconds(seg.sourceIn) + (i * tw) / pps;
    const idx = Math.min(strip.urls.length - 1, Math.max(0, Math.floor(srcT / strip.interval)));
    items.push(<div key={i} style={{ width: tw, backgroundImage: `url("${strip.urls[idx]}")` }} />);
  }
  return <div className="clip-thumbs">{items}</div>;
}

// ------------------------------------------------------------ cursor track

function CursorTrack({ project, pps, selection, gesture, onEmptyDown, menu, timeFromClient }: TrackProps & { timeFromClient: (x: number) => Flicks }) {
  const aspect = cursorSpaceAspect(project);
  const kfs = sortByTime(project.cursor.keyframes);
  const warnings = cursorWarnings(project.cursor, aspect, (p) => isInsideCrop(p, project.video.crop));
  const warnIds = new Set(warnings.map((w) => w.id));
  const sel = new Set(selection.kind === 'keyframe' ? selection.ids : []);
  const visSel = new Set(selection.kind === 'visibility' ? selection.ids : []);

  const startKf = (e: React.PointerEvent, id: string) => {
    selectWith('keyframe', id, e);
    const ids = editor().selection.kind === 'keyframe' ? editor().selection.ids : [id];
    const base = editor().project;
    const t0 = new Map(base.cursor.keyframes.map((k) => [k.id, k.time]));
    const anchor = t0.get(id)!;
    gesture(e, {
      exclude: new Set(ids),
      onMove: (dt, _ev, snap) => {
        const target = snapToFrame(Math.max(0, snap(anchor + dt)), base.export.fps);
        const d = target - anchor;
        editor().preview((p) => ({ ...p, cursor: { ...p.cursor, keyframes: p.cursor.keyframes.map((k) => (ids.includes(k.id) ? { ...k, time: Math.max(0, t0.get(k.id)! + d) } : k)) } }));
      },
      onEnd: (moved) => {
        if (!moved) player.seek(anchor);
      },
    });
  };
  const startVis = (e: React.PointerEvent, id: string) => {
    selectWith('visibility', id, e);
    const base = editor().project;
    const v0 = base.cursor.visibility.find((v) => v.id === id)!.time;
    gesture(e, {
      exclude: new Set([id]),
      onMove: (dt, _ev, snap) => {
        const t = snapToFrame(Math.max(0, snap(v0 + dt)), base.export.fps);
        editor().preview((p) => ({ ...p, cursor: { ...p.cursor, visibility: p.cursor.visibility.map((v) => (v.id === id ? { ...v, time: t } : v)) } }));
      },
    });
  };

  const onDouble = (e: React.MouseEvent) => {
    // Add a waypoint on the existing path at this time (keeps motion intact).
    const t = snapToFrame(timeFromClient(e.clientX), project.export.fps);
    const pos = evaluateCursorPosition(project.cursor.keyframes, t, aspect);
    if (pos) placeKeyframe(pos.x, pos.y, t);
    else editor().toast('info', 'Switch to Cursor mode (K) and click the video to place the first cursor position.');
  };
  const onMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const t = snapToFrame(timeFromClient(e.clientX), project.export.fps);
    const pos = evaluateCursorPosition(project.cursor.keyframes, t, aspect);
    menu(e, [
      { label: 'Add Keyframe Here', disabled: !pos, run: () => pos && placeKeyframe(pos.x, pos.y, t) },
      { label: 'Show Cursor Here', run: () => addVisibility(true, t) },
      { label: 'Hide Cursor Here', run: () => addVisibility(false, t) },
      { separator: true, label: '' },
      { label: 'Delete Selected', disabled: !(selection.kind === 'keyframe' || selection.kind === 'visibility') || !selection.ids.length, danger: true, run: deleteSelection },
    ]);
  };

  // Hidden ranges for shading.
  const vis = sortByTime(project.cursor.visibility);
  const hidden: [number, number][] = [];
  if (vis.length) {
    let state = !vis[0].visible;
    let from = 0;
    for (const v of vis) {
      if (state && !v.visible) from = v.time;
      if (!state && v.visible) hidden.push([from, v.time]);
      state = v.visible;
    }
    if (!state) hidden.push([from, Number.MAX_SAFE_INTEGER / 4]);
  }

  return (
    <div className="track lane-alt" style={{ height: TRACKS[1].h }} onPointerDown={onEmptyDown} onDoubleClick={onDouble} onContextMenu={onMenu}>
      {hidden.map(([a, b], i) => (
        <div key={i} style={{ position: 'absolute', top: 3, bottom: 3, left: toPx(a, pps), width: Math.min(toPx(b - a, pps), 1e6), background: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.25) 0 4px, transparent 4px 8px)', pointerEvents: 'none' }} title="Cursor hidden" />
      ))}
      {kfs.slice(1).map((to, i) => {
        const mv = resolveMove(kfs[i], to, aspect);
        return (
          <div key={to.id}>
            <div className="hold-bar" style={{ left: toPx(kfs[i].time, pps), width: Math.max(0, toPx(mv.start - kfs[i].time, pps)) }} />
            <div className="move-bar" style={{ left: toPx(mv.start, pps), width: Math.max(1, toPx(mv.end - mv.start, pps)) }} />
          </div>
        );
      })}
      {kfs.map((k) => (
        <div
          key={k.id}
          className={`kf ${sel.has(k.id) ? 'selected' : ''} ${warnIds.has(k.id) ? 'warn' : ''}`}
          style={{ left: toPx(k.time, pps) }}
          title={warnings.filter((w) => w.id === k.id).map((w) => w.message).join('\n') || `Cursor keyframe at ${flicksToSeconds(k.time).toFixed(2)}s`}
          onPointerDown={(e) => startKf(e, k.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            selectWith('keyframe', k.id, { shiftKey: false, metaKey: false });
            menu(e, [
              { label: 'Duplicate', shortcut: '⌘D', run: duplicateSelection },
              { label: 'Delete', shortcut: '⌫', danger: true, run: deleteSelection },
            ]);
          }}
        />
      ))}
      {vis.map((v) => (
        <div key={v.id} className={`vis-marker ${visSel.has(v.id) ? 'selected' : ''}`} style={{ left: toPx(v.time, pps) }} onPointerDown={(e) => startVis(e, v.id)} title={v.visible ? 'Cursor appears' : 'Cursor disappears'}>
          <span>{v.visible ? 'show' : 'hide'}</span>
        </div>
      ))}
      {kfs.length === 0 && (
        <div className="hint" style={{ position: 'absolute', left: 10, top: 9, pointerEvents: 'none' }}>
          Press <span className="kbd">K</span> and click the preview to place the cursor
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ click track

function ClickTrack({ project, pps, selection, gesture, onEmptyDown, menu, timeFromClient }: TrackProps & { timeFromClient: (x: number) => Flicks }) {
  const aspect = cursorSpaceAspect(project);
  const warnings = cursorWarnings(project.cursor, aspect, () => true);
  const warn = new Map(warnings.map((w) => [w.id, w.message]));
  const sel = new Set(selection.kind === 'click' ? selection.ids : []);
  const start = (e: React.PointerEvent, id: string) => {
    selectWith('click', id, e);
    const ids = editor().selection.kind === 'click' ? editor().selection.ids : [id];
    const base = editor().project;
    const t0 = new Map(base.cursor.clicks.map((c) => [c.id, c.time]));
    const anchor = t0.get(id)!;
    gesture(e, {
      exclude: new Set(ids),
      onMove: (dt, _ev, snap) => {
        const target = snapToFrame(Math.max(0, snap(anchor + dt)), base.export.fps);
        const d = target - anchor;
        editor().preview((p) => ({ ...p, cursor: { ...p.cursor, clicks: p.cursor.clicks.map((c) => (ids.includes(c.id) ? { ...c, time: Math.max(0, t0.get(c.id)! + d) } : c)) } }));
      },
      onEnd: (moved) => {
        if (!moved) player.seek(anchor);
      },
    });
  };
  const setButton = (id: string, button: ClickButton) => editor().commit((p) => ({ ...p, cursor: { ...p.cursor, clicks: p.cursor.clicks.map((c) => (c.id === id ? { ...c, button } : c)) } }));
  return (
    <div
      className="track"
      style={{ height: TRACKS[2].h }}
      onPointerDown={onEmptyDown}
      onDoubleClick={(e) => addClick('left', snapToFrame(timeFromClient(e.clientX), project.export.fps))}
      onContextMenu={(e) => {
        e.preventDefault();
        const t = snapToFrame(timeFromClient(e.clientX), project.export.fps);
        menu(e, [
          { label: 'Add Left Click Here', run: () => addClick('left', t) },
          { label: 'Add Double Click Here', run: () => addClick('double', t) },
          { label: 'Add Right Click Here', run: () => addClick('right', t) },
        ]);
      }}
    >
      {project.cursor.clicks.map((c) => (
        <div
          key={c.id}
          className={`click-marker ${sel.has(c.id) ? 'selected' : ''} ${warn.has(c.id) ? 'warn' : ''}`}
          style={{ left: toPx(c.time, pps) }}
          title={warn.get(c.id) ?? `${c.button} click at ${flicksToSeconds(c.time).toFixed(2)}s — drag to align with the UI change`}
          onPointerDown={(e) => start(e, c.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            selectWith('click', c.id, { shiftKey: false, metaKey: false });
            menu(e, [
              { label: 'Left Click', run: () => setButton(c.id, 'left') },
              { label: 'Double Click', run: () => setButton(c.id, 'double') },
              { label: 'Right Click', run: () => setButton(c.id, 'right') },
              { separator: true, label: '' },
              { label: 'Delete', shortcut: '⌫', danger: true, run: deleteSelection },
            ]);
          }}
        >
          <i>{c.button === 'double' ? '2' : c.button === 'right' ? 'R' : ''}</i>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ audio tracks

function AudioTrack({
  track,
  project,
  pps,
  selection,
  waveforms,
  viewport,
  gesture,
  onEmptyDown,
  menu,
  assets,
}: TrackProps & { track: AudioTrackId; waveforms: Record<string, Waveform>; viewport: { left: number; width: number }; assets: Map<string, import('../../shared/schema').MediaAsset> }) {
  const h = TRACKS.find((t) => t.id === track)!.h;
  const clips = project.audio.filter((c) => c.track === track);
  const [drop, setDrop] = useState(false);

  const startMove = (e: React.PointerEvent, clip: AudioClip) => {
    selectWith('audio', clip.id, e);
    const base = editor().project;
    const start0 = clip.start;
    const narrTop = trackTop('narration');
    gesture(e, {
      exclude: new Set([clip.id]),
      onMove: (dt, ev, snap) => {
        // Vertical position chooses the lane.
        const lane = (ev.target as HTMLElement | null)?.closest('.timeline-content')?.getBoundingClientRect();
        let tr: AudioTrackId = clip.track;
        if (lane) {
          const y = ev.clientY - lane.top;
          tr = y >= trackTop('music') ? 'music' : y >= narrTop - 10 ? 'narration' : clip.track;
        }
        let s = start0 + dt;
        const snappedStart = snap(s);
        const snappedEnd = snap(s + clipDuration(clip)) - clipDuration(clip);
        s = Math.abs(snappedStart - s) <= Math.abs(snappedEnd - s) ? snappedStart : snappedEnd;
        s = snapToFrame(Math.max(0, s), base.export.fps);
        const others = base.audio;
        const resolved = resolveAudioMove(others, clip.id, s, tr);
        editor().preview((p) => ({ ...p, audio: p.audio.map((c) => (c.id === clip.id ? { ...c, start: resolved, track: tr } : c)) }));
      },
    });
  };
  const startTrim = (e: React.PointerEvent, clip: AudioClip, edge: 'start' | 'end') => {
    editor().select({ kind: 'audio', ids: [clip.id] });
    const base = editor().project;
    const edgeT = edge === 'start' ? clip.start : clipEnd(clip);
    gesture(e, {
      exclude: new Set([clip.id]),
      onMove: (dt, _ev, snap) => {
        const t = snap(edgeT + dt);
        editor().preview((p) => ({ ...p, audio: trimAudioClip(base.audio, clip.id, edge, t, assets.get(clip.assetId)) }));
      },
    });
  };
  const clipMenu = (e: React.MouseEvent, clip: AudioClip) => {
    e.preventDefault();
    e.stopPropagation();
    selectWith('audio', clip.id, { shiftKey: false, metaKey: false });
    menu(e, [
      { label: 'Split at Playhead', shortcut: 'S', run: splitAtPlayhead },
      { label: clip.muted ? 'Unmute' : 'Mute', run: () => editor().commit((p) => ({ ...p, audio: p.audio.map((c) => (c.id === clip.id ? { ...c, muted: !c.muted } : c)) })) },
      { label: `Move to ${track === 'narration' ? 'Music' : 'Narration'} Track`, run: () => editor().commit((p) => ({ ...p, audio: p.audio.map((c) => (c.id === clip.id ? { ...c, track: track === 'narration' ? 'music' : 'narration', start: resolveAudioMove(p.audio, c.id, c.start, track === 'narration' ? 'music' : 'narration') } : c)) })) },
      { separator: true, label: '' },
      { label: 'Duplicate', shortcut: '⌘D', run: duplicateSelection },
      { label: 'Delete', shortcut: '⌫', danger: true, run: deleteSelection },
    ]);
  };

  return (
    <div
      className={`track ${track === 'music' ? 'lane-alt' : ''}`}
      style={{ height: h, outline: drop ? '1px dashed var(--accent)' : undefined }}
      onPointerDown={onEmptyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-studio-asset')) {
          e.preventDefault();
          setDrop(true);
        }
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        setDrop(false);
        const id = e.dataTransfer.getData('application/x-studio-asset');
        const a = assets.get(id);
        if (!a || a.kind !== 'audio') return;
        e.preventDefault();
        e.stopPropagation();
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const t = toT(e.clientX - rect.left, pps);
        editor().commit((p) => {
          const clip = { id: newId('aud'), assetId: a.id, track, start: 0, sourceIn: 0, sourceOut: a.duration, volume: 1, muted: false, fadeIn: 0, fadeOut: 0 };
          const all = [...p.audio, clip];
          clip.start = resolveAudioMove(all, clip.id, snapToFrame(t, p.export.fps), track);
          return { ...p, audio: all };
        });
      }}
    >
      {clips.map((c) => {
        const left = toPx(c.start, pps);
        const width = Math.max(2, toPx(clipDuration(c), pps));
        const sel = selection.kind === 'audio' && selection.ids.includes(c.id);
        const a = assets.get(c.assetId);
        return (
          <div key={c.id} className={`clip ${track} ${sel ? 'selected' : ''} ${c.muted ? 'muted' : ''}`} style={{ left, width }} onPointerDown={(e) => startMove(e, c)} onContextMenu={(e) => clipMenu(e, c)}>
            <Wave clip={c} wf={waveforms[c.assetId]} left={left} width={width} pps={pps} viewport={viewport} height={h - 10} color={track === 'music' ? '#b39cff' : '#66d7a3'} />
            <FadeOverlay clip={c} pps={pps} width={width} height={h - 10} />
            <div className="clip-label">
              <span>{a?.name ?? 'Missing audio'}</span>
              {c.volume !== 1 && <span className="badge">{Math.round(c.volume * 100)}%</span>}
              {c.muted && <span className="badge">muted</span>}
            </div>
            <div className="trim-handle l" onPointerDown={(e) => startTrim(e, c, 'start')} />
            <div className="trim-handle r" onPointerDown={(e) => startTrim(e, c, 'end')} />
          </div>
        );
      })}
      {clips.length === 0 && (
        <div className="hint" style={{ position: 'absolute', left: 10, top: h / 2 - 8, pointerEvents: 'none' }}>
          {track === 'narration' ? 'Drop your ElevenLabs voiceover here (MP3, WAV, M4A)' : 'Optional background music'}
        </div>
      )}
    </div>
  );
}

/** Real waveform from decoded audio; only the visible part of the clip is drawn. */
function Wave({ clip, wf, left, width, pps, viewport, height, color }: { clip: AudioClip; wf?: Waveform; left: number; width: number; pps: number; viewport: { left: number; width: number }; height: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const visL = Math.max(0, viewport.left - left - 50);
  const visR = Math.min(width, viewport.left + viewport.width - left + 50);
  const w = Math.max(1, Math.round(visR - visL));
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !wf || visR <= visL) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(height * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = color;
    const mid = height / 2;
    const gain = clip.muted ? 0.4 : Math.min(2, Math.max(0.15, clip.volume));
    const srcStart = flicksToSeconds(clip.sourceIn);
    const n = wf.peaks.length / 2;
    for (let x = 0; x < w; x++) {
      const t0 = srcStart + (visL + x) / pps;
      const t1 = srcStart + (visL + x + 1) / pps;
      let b0 = Math.floor(t0 * wf.bucketsPerSecond);
      let b1 = Math.max(b0 + 1, Math.floor(t1 * wf.bucketsPerSecond));
      if (b0 >= n) break;
      b1 = Math.min(n, b1);
      let mn = 0;
      let mx = 0;
      for (let b = b0; b < b1; b++) {
        mn = Math.min(mn, wf.peaks[b * 2]);
        mx = Math.max(mx, wf.peaks[b * 2 + 1]);
      }
      const top = mid - Math.min(1, mx * gain) * mid * 0.92;
      const bot = mid - Math.max(-1, mn * gain) * mid * 0.92;
      ctx.fillRect(x, top, 1, Math.max(1, bot - top));
      b0 = b1;
    }
  }, [wf, clip.sourceIn, clip.volume, clip.muted, pps, visL, w, height, color, visR]);
  if (!wf) return <div className="hint" style={{ position: 'absolute', left: 8, bottom: 4, fontSize: 10 }}>Decoding…</div>;
  return <canvas ref={ref} className="wave" style={{ left: visL, width: w, height, top: 4 }} />;
}

function FadeOverlay({ clip, pps, width, height }: { clip: AudioClip; pps: number; width: number; height: number }) {
  if (!clip.fadeIn && !clip.fadeOut) return null;
  const fi = Math.min(width, toPx(clip.fadeIn, pps));
  const fo = Math.min(width, toPx(clip.fadeOut, pps));
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width={width} height={height + 8}>
      {fi > 0 && <path d={`M0,${height + 8} L${fi},0 L0,0 Z`} fill="rgba(0,0,0,0.35)" />}
      {fo > 0 && <path d={`M${width},${height + 8} L${width - fo},0 L${width},0 Z`} fill="rgba(0,0,0,0.35)" />}
    </svg>
  );
}


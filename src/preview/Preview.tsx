/**
 * Composition preview. Draws the exact FrameDescription the exporter renders
 * (shared/compose.ts) onto a canvas whose backing store is the on-screen size
 * in device pixels, then layers an SVG editing overlay on top.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crop as CropIcon, Expand, HelpCircle, Highlighter, Maximize, Tv, MousePointer2, Move, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import { assetMap, cursorSpaceAspect, placementFor } from '../../shared/compose';
import { canvasToSource, fitRect, isInsideCrop, sourceToCanvas, type Point, type Rect, type Size } from '../../shared/geometry';
import { curveControl, hiddenAt, pathPoint, segmentKeyframesAt } from '../../shared/cursor';
import { mapProjectTime, projectDuration } from '../../shared/timeline';
import { formatTimecode, type Flicks } from '../../shared/time';
import { newId, type CursorKeyframe, type Project } from '../../shared/schema';
import { useEditor, editor } from '../state/store';
import { playhead, usePlayheadTime, usePlaying } from '../state/playhead';
import { player } from '../engine/player';
import { Button, Segmented } from '../components/ui';
import { stepFrames, seekToEdge, fps } from '../state/actions';
import { Welcome } from './Welcome';
import { CompositionRenderer } from './compositionRenderer';
import { perf } from '../engine/perf';
import { HighlightBar, HighlightLayer } from './HighlightLayer';

type ZoomLevel = 'fit' | 1.5 | 2 | 3;

const MAX_BACKING = 4096;

export function Preview() {
  const project = useEditor((s) => s.project);
  const mode = useEditor((s) => s.mode);
  const showPath = useEditor((s) => s.showPath);
  const selection = useEditor((s) => s.selection);
  const bodyRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<Size>({ width: 800, height: 450 });
  const [zoom, setZoom] = useState<ZoomLevel>('fit');
  const dpr = window.devicePixelRatio || 1;

  useEffect(() => {
    const el = bodyRef.current!;
    const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const aspect = project.canvas.aspectW / project.canvas.aspectH;
  const margin = 28;
  const fit = fitRect({ width: aspect, height: 1 }, { x: margin, y: margin, w: Math.max(50, box.width - margin * 2), h: Math.max(50, box.height - margin * 2) });
  const z = zoom === 'fit' ? 1 : zoom;
  const display = { w: Math.round(fit.w * z), h: Math.round(fit.h * z) };
  const offset = { x: zoom === 'fit' ? Math.round(fit.x) : Math.max(margin, Math.round((box.width - display.w) / 2)), y: zoom === 'fit' ? Math.round(fit.y) : Math.max(margin, Math.round((box.height - display.h) / 2)) };
  const backingScale = Math.min(dpr, MAX_BACKING / display.w);
  const canvasSize: Size = { width: Math.max(2, Math.round(display.w * backingScale)), height: Math.max(2, Math.round(display.h * backingScale)) };
  /** canvas pixel → CSS pixel within the canvas element */
  const k = display.w / canvasSize.width;

  // ------------------------------------------------------------ drawing

  const renderer = useRef<CompositionRenderer | null>(null);
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const t0 = performance.now();
    try {
      drawInner(cv);
    } finally {
      const ms = performance.now() - t0;
      perf.draws++;
      perf.drawMs += ms;
      perf.maxDrawMs = Math.max(perf.maxDrawMs, ms);
    }
  }, [canvasSize.width, canvasSize.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawInner = (cv: HTMLCanvasElement) => {
    const s = editor();
    const p = s.project;
    if (cv.width !== canvasSize.width || cv.height !== canvasSize.height) {
      cv.width = canvasSize.width;
      cv.height = canvasSize.height;
    }
    const ctx = cv.getContext('2d', { alpha: false })!;
    const W = canvasSize.width;
    const H = canvasSize.height;
    const t = playhead.getState().time;

    if (s.mode === 'crop') {
      drawCropMode(ctx, p, t, W, H);
      return;
    }
    if (!renderer.current) renderer.current = new CompositionRenderer(() => requestDraw());
    if (!renderer.current.draw(ctx, W, H, p, t)) perf.blankDraws++;
  };

  const rafRef = useRef(0);
  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => player.onFrame(requestDraw), [requestDraw]);
  useEffect(() => useEditor.subscribe(requestDraw), [requestDraw]);
  useEffect(() => playhead.subscribe(requestDraw), [requestDraw]);
  useEffect(() => requestDraw(), [requestDraw, canvasSize.width, canvasSize.height]);

  // ------------------------------------------------------------ geometry for overlay

  const t = usePlayheadTime(60);
  const assets = useMemo(() => assetMap(project.media), [project.media]);
  const mapping = mapProjectTime(project.video.segments, t);
  const activeAsset = mapping ? assets.get(mapping.assetId) : project.media.find((m) => m.kind === 'video');
  const placement = activeAsset ? placementFor(project, activeAsset, canvasSize) : null;
  const sourceAspect = cursorSpaceAspect(project, assets);
  const toCss = (pt: Point): Point => ({ x: pt.x * k, y: pt.y * k });
  const fromEvent = (e: { clientX: number; clientY: number }): Point => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvasSize.width, y: ((e.clientY - r.top) / r.height) * canvasSize.height };
  };

  const hasVideo = project.video.segments.length > 0;

  return (
    <div className="stage">
      <div className="stage-toolbar">
        <Segmented
          value={mode}
          onChange={(m) => editor().set({ mode: m })}
          options={[
            { value: 'select', label: <><Move size={13} /> Arrange</>, tip: 'Select and position the video (V)' },
            { value: 'cursor', label: <><MousePointer2 size={13} /> Cursor</>, tip: 'Click the video to place the synthetic cursor (K)' },
            { value: 'highlight', label: <><Highlighter size={13} /> Highlight</>, tip: 'Drag on the video to highlight a button, field or area (H)' },
            { value: 'crop', label: <><CropIcon size={13} /> Crop</>, tip: 'Drag handles to crop the recording (R)' },
          ]}
        />
        <div style={{ flex: 1 }} />
        <Button size="small" variant="ghost" tip="Bigger preview (≈80 % of the window)" shortcut="T" onClick={() => editor().set({ presentation: 'theater' })} disabled={!hasVideo}>
          <Tv size={13} /> Theater
        </Button>
        <Button size="small" variant="ghost" tip="Play full screen — closes automatically at the end" shortcut="⇧F" onClick={() => editor().set({ presentation: 'fullscreen' })} disabled={!hasVideo}>
          <Expand size={13} /> Full screen
        </Button>
        <Button size="small" variant="ghost" active={showPath} tip="Show the cursor path overlay (editing only — never exported)" shortcut="P" onClick={() => editor().set({ showPath: !showPath })}>
          Path
        </Button>
        <Segmented
          small
          value={String(zoom) as 'fit'}
          onChange={(v) => setZoom(v === 'fit' ? 'fit' : (Number(v) as ZoomLevel))}
          options={[
            { value: 'fit', label: <Maximize size={11} />, tip: 'Fit to window' },
            { value: '1.5' as 'fit', label: '150%' },
            { value: '2' as 'fit', label: '200%' },
            { value: '3' as 'fit', label: '300%' },
          ]}
        />
      </div>
      {hasVideo && (mode === 'highlight' || selection.kind === 'highlight') && <HighlightBar />}
      <div
        className="stage-body"
        ref={bodyRef}
        style={{ overflow: zoom === 'fit' ? 'hidden' : 'auto' }}
        onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          const order: ZoomLevel[] = ['fit', 1.5, 2, 3];
          const i = order.indexOf(zoom);
          setZoom(order[Math.max(0, Math.min(order.length - 1, i + (e.deltaY < 0 ? 1 : -1)))]);
        }}
      >
        {!hasVideo && <Welcome />}
        <div style={{ position: 'relative', width: Math.max(box.width, display.w + offset.x * 2), height: Math.max(box.height, display.h + offset.y * 2) }}>
          <div className="stage-canvas-wrap" style={{ left: offset.x, top: offset.y, width: display.w, height: display.h, visibility: hasVideo ? 'visible' : 'hidden' }}>
            <canvas ref={canvasRef} />
            {hasVideo && placement && (
              <Overlay
                project={project}
                mode={mode}
                showPath={showPath}
                selection={selection}
                placement={placement}
                canvasSize={canvasSize}
                display={display}
                sourceAspect={sourceAspect}
                toCss={toCss}
                fromEvent={fromEvent}
                time={t}
              />
            )}
            {hasVideo && placement && mode !== 'crop' && (
              <HighlightLayer project={project} mode={mode} placement={placement} canvasSize={canvasSize} display={display} fromEvent={fromEvent} time={t} />
            )}
          </div>
        </div>

        {hasVideo && mode === 'highlight' && selection.kind !== 'highlight' && (
          <div className="mode-hint">
            Drag over a button, field or area to highlight it · a click places a default size · <b>Esc</b> when done
          </div>
        )}
        {hasVideo && mode === 'cursor' && (
          <div className="mode-hint">
            {hiddenAt(project.cursor, t) ? (
              <>Cursor is hidden here — clicking the video <b>starts a new cursor segment</b> at {formatTimecode(t, project.export.fps)}</>
            ) : (
              <>Click the video to place the cursor at <b>{formatTimecode(t, project.export.fps)}</b> · drag points to adjust · <span className="kbd">⌥</span>-click also adds a click</>
            )}
          </div>
        )}
        {hasVideo && mode === 'crop' && <div className="mode-hint">Drag the edges to remove browser tabs, toolbars or margins · <b>Esc</b> when done</div>}
        {hasVideo && mapping?.frozen && mode !== 'crop' && (
          <div className="mode-hint" style={{ top: 'auto', bottom: 10 }}>
            <b style={{ color: 'var(--track-freeze-border)' }}>Freeze frame</b> — video is holding; cursor and narration continue
          </div>
        )}
      </div>
      <Transport />
    </div>
  );

  function drawCropMode(ctx: CanvasRenderingContext2D, p: Project, t: Flicks, W: number, H: number) {
    ctx.fillStyle = '#0d0e10';
    ctx.fillRect(0, 0, W, H);
    const m = mapProjectTime(p.video.segments, t);
    if (!m) return;
    const a = assetMap(p.media).get(m.assetId);
    const frame = player.frameFor(m.assetId);
    const r = cropModeRect(a?.width ?? 1920, a?.height ?? 1080, W, H);
    if (frame) ctx.drawImage(frame.image, r.x, r.y, r.w, r.h);
  }
}

/** Where the full, uncropped source is shown while cropping. */
export function cropModeRect(srcW: number, srcH: number, W: number, H: number): Rect {
  const pad = Math.round(H * 0.06);
  return fitRect({ width: srcW, height: srcH }, { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 });
}

// ------------------------------------------------------------ overlay

interface OverlayProps {
  project: Project;
  mode: string;
  showPath: boolean;
  selection: { kind: string | null; ids: string[] };
  placement: ReturnType<typeof placementFor>;
  canvasSize: Size;
  display: { w: number; h: number };
  sourceAspect: number;
  toCss: (p: Point) => Point;
  fromEvent: (e: { clientX: number; clientY: number }) => Point;
  time: Flicks;
}

function Overlay(props: OverlayProps) {
  const { project, mode, showPath, selection, placement, display, toCss, fromEvent, sourceAspect, canvasSize } = props;
  // Only the cursor segment at the playhead (or of the selected keyframe) is drawn,
  // so earlier/later show→hide loops don't clutter the screen.
  const selKf = selection.kind === 'keyframe' ? project.cursor.keyframes.find((k) => k.id === selection.ids[0]) : undefined;
  const kfs = segmentKeyframesAt(project.cursor, selKf ? selKf.time : props.time);
  const dest = placement.dest;
  const destCss = { ...toCss({ x: dest.x, y: dest.y }), w: dest.w * (display.w / canvasSize.width), h: dest.h * (display.w / canvasSize.width) };
  const drag = useRef<null | { kind: string; id?: string; start: Point; base: Project; moved: boolean }>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });

  const srcPoint = (e: React.PointerEvent): Point => {
    const p = canvasToSource(fromEvent(e), placement);
    return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
  };

  const begin = (e: React.PointerEvent, kind: string, id?: string) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    editor().beginGesture();
    drag.current = { kind, id, start: fromEvent(e), base: editor().project, moved: false };
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (mode === 'cursor') {
      // Upsert a keyframe at the playhead frame and keep dragging it.
      const t = playhead.getState().time;
      const pt = srcPoint(e);
      const r = fps();
      const existing = editor().project.cursor.keyframes.find((k) => Math.floor((k.time * r.num) / (r.den * 705_600_000)) === Math.floor((t * r.num) / (r.den * 705_600_000)));
      const id = existing?.id ?? newId('kf');
      begin(e, 'kf-new', id);
      const alt = e.altKey;
      editor().preview((p) => upsertKeyframe(p, id, t, pt, alt));
      editor().select({ kind: 'keyframe', ids: [id] });
      return;
    }
    if (mode === 'select') {
      const pt = fromEvent(e);
      const inside = pt.x >= dest.x && pt.x <= dest.x + dest.w && pt.y >= dest.y && pt.y <= dest.y + dest.h;
      if (inside) {
        begin(e, 'move-video');
        editor().select({ kind: null, ids: [] });
        editor().set({ inspectorTab: 'video' });
      } else {
        editor().select({ kind: null, ids: [] });
        editor().set({ inspectorTab: 'canvas' });
      }
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const pt = fromEvent(e);
    const dx = pt.x - d.start.x;
    const dy = pt.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 2) return;
    d.moved = true;
    if (d.kind === 'kf' || d.kind === 'kf-new') {
      const sp = srcPoint(e);
      editor().preview((p) => ({ ...p, cursor: { ...p.cursor, keyframes: p.cursor.keyframes.map((k) => (k.id === d.id ? { ...k, x: sp.x, y: sp.y } : k)) } }));
    } else if (d.kind === 'curve') {
      const kf = d.base.cursor.keyframes.find((k) => k.id === d.id)!;
      const prev = segmentKeyframesAt(d.base.cursor, kf.time).filter((k) => k.time < kf.time || (k.time === kf.time && k.id < kf.id)).pop();
      if (!prev) return;
      const sp = canvasToSource(pt, placement);
      // Signed perpendicular offset (aspect-corrected) relative to segment length.
      const ax = prev.x * sourceAspect;
      const bx = kf.x * sourceAspect;
      const vx = bx - ax;
      const vy = kf.y - prev.y;
      const len = Math.hypot(vx, vy) || 1;
      const px = sp.x * sourceAspect - (ax + bx) / 2;
      const py = sp.y - (prev.y + kf.y) / 2;
      // Control point = mid + c·(−vy, vx); the curve's peak is at half the control offset.
      const c = Math.max(-0.5, Math.min(0.5, (2 * (px * -vy + py * vx)) / (len * len)));
      editor().preview((p) => ({ ...p, cursor: { ...p.cursor, keyframes: p.cursor.keyframes.map((k) => (k.id === d.id ? { ...k, curve: Math.round(c * 100) / 100 } : k)) } }));
    } else if (d.kind === 'move-video') {
      const L = d.base.video.layout;
      let ox = L.offsetX + dx / canvasSize.width;
      let oy = L.offsetY + dy / canvasSize.height;
      // Snap to centered alignment.
      const snapV = L.hAlign === 'center' && Math.abs(ox) < 0.008;
      const snapH = L.vAlign === 'center' && Math.abs(oy) < 0.008;
      if (snapV) ox = 0;
      if (snapH) oy = 0;
      setGuides({ v: snapV, h: snapH });
      editor().preview((p) => ({ ...p, video: { ...p.video, layout: { ...p.video.layout, offsetX: ox, offsetY: oy } } }));
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuides({ v: false, h: false });
    if (!d) return;
    if (d.kind === 'kf' && !d.moved) {
      // Plain click on a keyframe: select it and jump to its time.
      editor().cancelGesture();
      const kf = editor().project.cursor.keyframes.find((k) => k.id === d.id);
      editor().select({ kind: 'keyframe', ids: d.id ? [d.id] : [] });
      if (kf) player.seek(kf.time);
      return;
    }
    editor().endGesture();
  };

  const sel = new Set(selection.kind === 'keyframe' ? selection.ids : []);
  const cssScale = display.w / canvasSize.width;

  return (
    <svg
      className="stage-overlay"
      width={display.w}
      height={display.h}
      style={{ cursor: mode === 'cursor' ? 'crosshair' : mode === 'select' ? 'default' : 'default' }}
      onPointerDown={mode === 'crop' || mode === 'highlight' ? undefined : onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {mode === 'crop' && <CropEditor project={project} canvasSize={canvasSize} cssScale={cssScale} />}
      {mode === 'select' && (
        <rect x={destCss.x} y={destCss.y} width={destCss.w} height={destCss.h} fill="none" stroke="rgba(115,128,255,0.55)" strokeDasharray="4 3" pointerEvents="none" style={{ cursor: 'move' }} />
      )}
      {guides.v && <line x1={display.w / 2} x2={display.w / 2} y1={0} y2={display.h} stroke="#ff5ad1" strokeWidth={1} />}
      {guides.h && <line y1={display.h / 2} y2={display.h / 2} x1={0} x2={display.w} stroke="#ff5ad1" strokeWidth={1} />}
      {mode !== 'crop' && (showPath || mode === 'cursor') && kfs.length > 0 && (
        <g>
          {kfs.slice(1).map((to, i) => {
            const from = kfs[i];
            const pts: string[] = [];
            for (let s = 0; s <= 24; s++) {
              const q = toCss(sourceToCanvas(pathPoint(from, to, to.curve, sourceAspect, s / 24), placement));
              pts.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
            }
            const mid = toCss(sourceToCanvas(pathPoint(from, to, to.curve, sourceAspect, 0.5), placement));
            const ahead = toCss(sourceToCanvas(pathPoint(from, to, to.curve, sourceAspect, 0.54), placement));
            const ang = (Math.atan2(ahead.y - mid.y, ahead.x - mid.x) * 180) / Math.PI;
            const selected = sel.has(to.id);
            const ctrl = toCss(sourceToCanvas(curveControl(from, to, to.curve, sourceAspect), placement));
            const handle = toCss(sourceToCanvas(pathPoint(from, to, to.curve, sourceAspect, 0.5), placement));
            return (
              <g key={to.id}>
                <polyline points={pts.join(' ')} fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth={3.5} pointerEvents="none" />
                <polyline points={pts.join(' ')} fill="none" stroke={selected ? '#fff' : 'rgba(58,209,189,0.95)'} strokeWidth={1.6} strokeDasharray={selected ? undefined : '5 3'} pointerEvents="none" />
                <path d="M -5 -4 L 4 0 L -5 4 Z" transform={`translate(${mid.x},${mid.y}) rotate(${ang})`} fill={selected ? '#fff' : '#3ad1bd'} pointerEvents="none" />
                {selected && (
                  <>
                    <line x1={handle.x} y1={handle.y} x2={ctrl.x} y2={ctrl.y} stroke="rgba(255,255,255,0.35)" pointerEvents="none" />
                    <circle cx={handle.x} cy={handle.y} r={5} fill="#16171a" stroke="#fff" strokeWidth={1.5} style={{ cursor: 'grab' }} onPointerDown={(e) => begin(e, 'curve', to.id)}>
                      <title>Drag to curve this movement (straight is the default)</title>
                    </circle>
                  </>
                )}
              </g>
            );
          })}
          {kfs.map((k, i) => {
            const c = toCss(sourceToCanvas(k, placement));
            const inside = isInsideCrop(k, project.video.crop);
            const selected = sel.has(k.id);
            return (
              <g key={k.id} transform={`translate(${c.x},${c.y})`} style={{ cursor: 'grab' }} onPointerDown={(e) => begin(e, 'kf', k.id)}>
                <circle r={9} fill={inside ? (selected ? '#fff' : 'rgba(16,40,37,0.9)') : 'rgba(255,107,107,0.9)'} stroke={selected ? '#3ad1bd' : '#3ad1bd'} strokeWidth={1.6} />
                <text textAnchor="middle" dy={3.5} fontSize={9.5} fontWeight={700} fill={selected ? '#0f2d2a' : '#bff5ec'} pointerEvents="none">
                  {i + 1}
                </text>
                <title>{inside ? `Keyframe ${i + 1} — drag to move, click to select` : `Keyframe ${i + 1} is outside the cropped area`}</title>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}

function upsertKeyframe(p: Project, id: string, t: Flicks, pt: Point, addClickToo: boolean): Project {
  const existing = p.cursor.keyframes.find((k) => k.id === id);
  let keyframes: CursorKeyframe[];
  // Placing the cursor where it is hidden starts a new show→hide segment here.
  const visibility = !existing && hiddenAt(p.cursor, t) ? [...p.cursor.visibility, { id: newId('vis'), time: t, visible: true }] : p.cursor.visibility;
  if (existing) keyframes = p.cursor.keyframes.map((k) => (k.id === id ? { ...k, x: pt.x, y: pt.y } : k));
  else {
    const prev = segmentKeyframesAt({ visibility, keyframes: p.cursor.keyframes }, t).filter((k) => k.time < t).pop();
    keyframes = [...p.cursor.keyframes, { id, time: t, x: pt.x, y: pt.y, easing: prev?.easing ?? 'smooth', customBezier: prev?.customBezier, moveDuration: null, curve: 0 }];
  }
  let clicks = p.cursor.clicks;
  if (addClickToo && !clicks.some((c) => c.time === t)) clicks = [...clicks, { id: newId('clk'), time: t, button: 'left' }];
  return { ...p, cursor: { ...p.cursor, keyframes, clicks, visibility } };
}

// ------------------------------------------------------------ crop editor

function CropEditor({ project, canvasSize, cssScale }: { project: Project; canvasSize: Size; cssScale: number }) {
  const t = playhead.getState().time;
  const m = mapProjectTime(project.video.segments, t);
  const a = project.media.find((x) => x.id === m?.assetId);
  const r = cropModeRect(a?.width ?? 1920, a?.height ?? 1080, canvasSize.width, canvasSize.height);
  const R = { x: r.x * cssScale, y: r.y * cssScale, w: r.w * cssScale, h: r.h * cssScale };
  const c = project.video.crop;
  const inner = { x: R.x + c.left * R.w, y: R.y + c.top * R.h, w: R.w * (1 - c.left - c.right), h: R.h * (1 - c.top - c.bottom) };
  const drag = useRef<{ edge: string; x: number; y: number; base: typeof c } | null>(null);
  const start = (edge: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    editor().beginGesture();
    drag.current = { edge, x: e.clientX, y: e.clientY, base: { ...c } };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / R.w;
    const dy = (e.clientY - d.y) / R.h;
    const n = { ...d.base };
    const lim = (v: number) => Math.max(0, Math.min(0.95, v));
    if (d.edge.includes('l')) n.left = lim(d.base.left + dx);
    if (d.edge.includes('r')) n.right = lim(d.base.right - dx);
    if (d.edge.includes('t')) n.top = lim(d.base.top + dy);
    if (d.edge.includes('b')) n.bottom = lim(d.base.bottom - dy);
    if (d.edge === 'move') {
      const w = 1 - d.base.left - d.base.right;
      const h = 1 - d.base.top - d.base.bottom;
      n.left = Math.max(0, Math.min(1 - w, d.base.left + dx));
      n.right = 1 - w - n.left;
      n.top = Math.max(0, Math.min(1 - h, d.base.top + dy));
      n.bottom = 1 - h - n.top;
    }
    if (n.left + n.right > 0.95) return;
    if (n.top + n.bottom > 0.95) return;
    editor().preview((p) => ({ ...p, video: { ...p.video, crop: n } }));
  };
  const up = () => {
    if (drag.current) editor().endGesture();
    drag.current = null;
  };
  const H = 7;
  const handles: [string, number, number, string][] = [
    ['tl', inner.x, inner.y, 'nwse-resize'],
    ['t', inner.x + inner.w / 2, inner.y, 'ns-resize'],
    ['tr', inner.x + inner.w, inner.y, 'nesw-resize'],
    ['r', inner.x + inner.w, inner.y + inner.h / 2, 'ew-resize'],
    ['br', inner.x + inner.w, inner.y + inner.h, 'nwse-resize'],
    ['b', inner.x + inner.w / 2, inner.y + inner.h, 'ns-resize'],
    ['bl', inner.x, inner.y + inner.h, 'nesw-resize'],
    ['l', inner.x, inner.y + inner.h / 2, 'ew-resize'],
  ];
  return (
    <g onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <path d={`M${R.x},${R.y}h${R.w}v${R.h}h${-R.w}Z M${inner.x},${inner.y}v${inner.h}h${inner.w}v${-inner.h}Z`} fill="rgba(0,0,0,0.62)" fillRule="evenodd" pointerEvents="none" />
      <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} fill="transparent" stroke="#fff" strokeWidth={1.5} style={{ cursor: 'move' }} onPointerDown={start('move')} />
      {[1, 2].map((i) => (
        <g key={i} pointerEvents="none" stroke="rgba(255,255,255,0.25)">
          <line x1={inner.x + (inner.w * i) / 3} x2={inner.x + (inner.w * i) / 3} y1={inner.y} y2={inner.y + inner.h} />
          <line y1={inner.y + (inner.h * i) / 3} y2={inner.y + (inner.h * i) / 3} x1={inner.x} x2={inner.x + inner.w} />
        </g>
      ))}
      {handles.map(([id, x, y, cur]) => (
        <rect key={id} x={x - H} y={y - H} width={H * 2} height={H * 2} rx={2} fill="#fff" stroke="#16171a" style={{ cursor: cur }} onPointerDown={start(id)} />
      ))}
      <text x={inner.x + 6} y={inner.y + 16} fontSize={11} fill="#fff" pointerEvents="none" style={{ paintOrder: 'stroke' }} stroke="rgba(0,0,0,0.6)" strokeWidth={3}>
        {Math.round((a?.width ?? 0) * (1 - c.left - c.right))} × {Math.round((a?.height ?? 0) * (1 - c.top - c.bottom))} px
      </text>
    </g>
  );
}

// ------------------------------------------------------------ transport

function Transport() {
  const playing = usePlaying();
  const t = usePlayheadTime(50);
  const project = useEditor((s) => s.project);
  const dur = projectDuration(project);
  return (
    <div className="stage-footer">
      <Button variant="ghost" icon tip="Previous edit point" shortcut="↑" onClick={() => seekToEdge(-1)}>
        <SkipBack size={14} />
      </Button>
      <Button variant="ghost" icon tip="Previous frame" shortcut="←" onClick={() => stepFrames(-1)}>
        <StepBack size={14} />
      </Button>
      <Button variant="ghost" icon tip={playing ? 'Pause' : 'Play'} shortcut="Space" onClick={() => player.toggle()} disabled={!project.video.segments.length}>
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </Button>
      <Button variant="ghost" icon tip="Next frame" shortcut="→" onClick={() => stepFrames(1)}>
        <StepForward size={14} />
      </Button>
      <Button variant="ghost" icon tip="Next edit point" shortcut="↓" onClick={() => seekToEdge(1)}>
        <SkipForward size={14} />
      </Button>
      <div style={{ flex: 1 }} />
      <span className="timecode">{formatTimecode(t, project.export.fps)}</span>
      <span className="timecode dim">/ {formatTimecode(dur, project.export.fps)}</span>
      <div style={{ flex: 1 }} />
      <span className="hint" style={{ width: 120, textAlign: 'right' }}>
        {project.export.resolution}p · {Math.round(project.export.fps.num / project.export.fps.den)} fps
      </span>
      <Button variant="ghost" icon tip="Keyboard shortcuts" shortcut="?" onClick={() => editor().set({ dialog: 'help' })}>
        <HelpCircle size={15} />
      </Button>
    </div>
  );
}

/**
 * Highlight editing in the preview:
 *  - HighlightBar: floating shape / style / color picker (Highlight mode or a selected highlight)
 *  - HighlightLayer: drag on the video to create; click a highlight to select it;
 *    drag to move; handles to resize (boxes) or move endpoints (underline/arrow).
 * Geometry is edited in source-normalized coordinates, like cursor keyframes.
 */
import { useRef } from 'react';
import { Circle, Focus, MoveUpRight, Square, Underline } from 'lucide-react';
import { applyStyle, createHighlight, HIGHLIGHT_COLORS, HIGHLIGHT_SHAPES, HIGHLIGHT_STYLES, INTRO_DURATION, isLineShape } from '../../shared/highlights';
import { canvasToSource, sourceToCanvas, type Point, type Size, type VideoPlacement } from '../../shared/geometry';
import type { Highlight, HighlightShape, Project } from '../../shared/schema';
import { editor, useEditor } from '../state/store';
import { playhead } from '../state/playhead';
import { useTooltip } from '../components/ui';
import { updateHighlights } from '../state/actions';

const SHAPE_ICONS: Record<HighlightShape, React.ReactNode> = {
  rect: <Square size={13} />,
  ellipse: <Circle size={13} />,
  underline: <Underline size={13} />,
  arrow: <MoveUpRight size={13} />,
  spotlight: <Focus size={13} />,
};

function selectedHighlights(): string[] {
  const s = editor().selection;
  return s.kind === 'highlight' ? s.ids : [];
}

export function HighlightBar() {
  const shape = useEditor((s) => s.highlightShape);
  const styleId = useEditor((s) => s.highlightStyle);
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const sel = selection.kind === 'highlight' ? project.highlights.filter((h) => selection.ids.includes(h.id)) : [];
  const current = sel[0];
  const activeShape = current?.shape ?? shape;
  const activeColor = current?.color ?? HIGHLIGHT_STYLES.find((s) => s.id === styleId)?.color;

  const pickShape = (s: HighlightShape) => {
    editor().set({ highlightShape: s, mode: 'highlight' });
    if (sel.length) updateHighlights(selectedHighlights(), () => ({ shape: s }));
  };
  const pickStyle = (id: string) => {
    editor().set({ highlightStyle: id });
    const st = HIGHLIGHT_STYLES.find((x) => x.id === id)!;
    if (sel.length) updateHighlights(selectedHighlights(), (h) => applyStyle(h, st));
  };
  const pickColor = (c: string) => {
    if (sel.length) updateHighlights(selectedHighlights(), () => ({ color: c }));
  };

  return (
    <div className="highlight-bar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="segmented small">
        {HIGHLIGHT_SHAPES.map((s) => (
          <BarButton key={s.id} pressed={activeShape === s.id} tip={`${s.label} — ${s.hint}`} onClick={() => pickShape(s.id)}>
            {SHAPE_ICONS[s.id]} {s.label}
          </BarButton>
        ))}
      </div>
      <span className="bar-sep" />
      {HIGHLIGHT_STYLES.map((st) => (
        <StyleChip key={st.id} id={st.id} active={(current ? current.line === st.line && current.glow === st.glow && Math.abs(current.fill - (isLineShape(current.shape) ? 0 : st.fill)) < 0.01 : styleId === st.id)} onClick={() => pickStyle(st.id)} />
      ))}
      {sel.length > 0 && (
        <>
          <span className="bar-sep" />
          {HIGHLIGHT_COLORS.map((c) => (
            <button key={c} className="color-dot" aria-pressed={activeColor?.toLowerCase() === c} style={{ background: c }} onClick={() => pickColor(c)} title={c} />
          ))}
        </>
      )}
    </div>
  );
}

function BarButton({ pressed, tip, onClick, children }: { pressed: boolean; tip: string; onClick: () => void; children: React.ReactNode }) {
  const t = useTooltip(tip);
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} {...t}>
      {children}
    </button>
  );
}

/** Small live sample of a style (drawn with SVG approximations of the line styles). */
function StyleChip({ id, active, onClick }: { id: string; active: boolean; onClick: () => void }) {
  const st = HIGHLIGHT_STYLES.find((s) => s.id === id)!;
  const t = useTooltip(`${st.label} style`);
  const dash = st.line === 'dashed' ? '5 3' : st.line === 'dotted' ? '0.1 4' : undefined;
  const w = st.line === 'marker' ? 6 : 2;
  return (
    <button type="button" className="style-chip" aria-pressed={active} onClick={onClick} {...t}>
      <svg width={30} height={18}>
        {st.glow && <rect x={4} y={3} width={22} height={12} rx={3} fill="none" stroke={st.color} strokeWidth={5} opacity={0.25} />}
        {st.line === 'sketch' ? (
          <path d="M5 4 C 12 2, 20 5, 26 3 C 27 8, 25 12, 26 15 C 18 16, 11 14, 4 15 C 3 11, 5 7, 4 3.5" fill="none" stroke={st.color} strokeWidth={1.8} strokeLinecap="round" />
        ) : st.line === 'marker' ? (
          <line x1={5} y1={11} x2={25} y2={11} stroke={st.color} strokeWidth={w} strokeOpacity={0.5} strokeLinecap="round" />
        ) : (
          <rect x={4} y={3} width={22} height={12} rx={3} fill={st.fill ? st.color : 'none'} fillOpacity={st.fill * 1.6} stroke={st.color} strokeWidth={w} strokeDasharray={dash} strokeLinecap={st.line === 'dotted' ? 'round' : undefined} />
        )}
      </svg>
      <span>{st.label}</span>
    </button>
  );
}

// ------------------------------------------------------------ editing layer

interface LayerProps {
  project: Project;
  mode: string;
  placement: VideoPlacement;
  canvasSize: Size;
  display: { w: number; h: number };
  fromEvent: (e: { clientX: number; clientY: number }) => Point;
  time: number;
}

type DragKind = 'create' | 'move' | 'p0' | 'p1' | string;

/**
 * Gesture previews are recomputed from the snapshot taken at pointer-down, which
 * does not contain a highlight being created — so every update upserts it.
 */
function upsert(q: Project, h: Highlight): Project {
  const exists = q.highlights.some((x) => x.id === h.id);
  return { ...q, highlights: exists ? q.highlights.map((x) => (x.id === h.id ? h : x)) : [...q.highlights, h] };
}

export function HighlightLayer({ project, mode, placement, canvasSize, display, fromEvent, time }: LayerProps) {
  const selection = useEditor((s) => s.selection);
  const k = display.w / canvasSize.width;
  const css = (u: number, v: number) => {
    const c = sourceToCanvas({ x: u, y: v }, placement);
    return { x: c.x * k, y: c.y * k };
  };
  const src = (e: { clientX: number; clientY: number }) => canvasToSource(fromEvent(e), placement);
  const drag = useRef<{ kind: DragKind; id: string; start: Point; base: Highlight | null; moved: boolean } | null>(null);
  const selIds = selection.kind === 'highlight' ? selection.ids : [];
  const shown = project.highlights.filter((h) => (time >= h.start && time < h.end) || selIds.includes(h.id));
  const interactive = mode === 'highlight' || mode === 'select';

  const begin = (e: React.PointerEvent, kind: DragKind, h: Highlight | null, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    editor().beginGesture();
    drag.current = { kind, id, start: src(e), base: h, moved: false };
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || mode !== 'highlight') return;
    const s = editor();
    const style = HIGHLIGHT_STYLES.find((x) => x.id === s.highlightStyle) ?? HIGHLIGHT_STYLES[0];
    const p = src(e);
    // Start a little before the playhead so the highlight is fully drawn on the current frame.
    const h0 = createHighlight(s.highlightShape, { x: p.x, y: p.y, w: 0, h: 0 }, Math.max(0, playhead.getState().time - INTRO_DURATION.draw), style);
    begin(e, 'create', h0, h0.id);
    s.preview((q) => upsert(q, h0));
    s.select({ kind: 'highlight', ids: [h0.id] });
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !d.base) return;
    const p = src(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.003) return;
    d.moved = true;
    const b = d.base;
    let next: Partial<Highlight>;
    if (d.kind === 'create') {
      next = isLineShape(b.shape) ? { x: b.x, y: b.y, w: dx, h: dy } : { x: Math.min(b.x, p.x), y: Math.min(b.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
    } else if (d.kind === 'move') {
      next = { x: b.x + dx, y: b.y + dy };
    } else if (d.kind === 'p0') {
      next = { x: b.x + dx, y: b.y + dy, w: b.w - dx, h: b.h - dy };
    } else if (d.kind === 'p1') {
      next = { w: b.w + dx, h: b.h + dy };
    } else {
      // Box handles: any combination of l/r/t/b edges.
      let x0 = b.x;
      let y0 = b.y;
      let x1 = b.x + b.w;
      let y1 = b.y + b.h;
      if (d.kind.includes('l')) x0 += dx;
      if (d.kind.includes('r')) x1 += dx;
      if (d.kind.includes('t')) y0 += dy;
      if (d.kind.includes('b')) y1 += dy;
      next = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
    editor().preview((q) => upsert(q, { ...b, ...next }));
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'create' && !d.moved && d.base) {
      // A plain click places a default-sized highlight centered on the point.
      const b = d.base;
      const aspect = (placement.srcRect.w / placement.srcRect.h) * (placement.cropNorm.h / placement.cropNorm.w);
      const ry = 0.05;
      const rx = (ry * 1.9) / aspect;
      const box = isLineShape(b.shape)
        ? b.shape === 'arrow'
          ? { x: b.x - 0.07, y: b.y + 0.09, w: 0.07, h: -0.09 }
          : { x: b.x - 0.06, y: b.y, w: 0.12, h: 0 }
        : { x: b.x - rx, y: b.y - ry, w: rx * 2, h: ry * 2 };
      editor().preview((q) => upsert(q, { ...b, ...box }));
    } else if (d.kind === 'move' && !d.moved) {
      editor().cancelGesture();
      editor().select({ kind: 'highlight', ids: [d.id] });
      return;
    }
    editor().endGesture();
  };

  return (
    <svg
      className="stage-overlay"
      width={display.w}
      height={display.h}
      style={{ pointerEvents: mode === 'highlight' ? 'auto' : 'none', cursor: mode === 'highlight' ? 'crosshair' : undefined }}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {shown.map((h) => {
        const a = css(h.x, h.y);
        const b = css(h.x + h.w, h.y + h.h);
        const selected = selIds.includes(h.id);
        const line = isLineShape(h.shape);
        const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        const hit = interactive ? 'auto' : 'none';
        return (
          <g key={h.id}>
            {line ? (
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={16} style={{ pointerEvents: hit, cursor: 'move' }} onPointerDown={(e) => begin(e, 'move', h, h.id)} />
            ) : (
              <rect x={box.x} y={box.y} width={Math.max(4, box.w)} height={Math.max(4, box.h)} fill="transparent" stroke="transparent" strokeWidth={10} style={{ pointerEvents: hit, cursor: 'move' }} onPointerDown={(e) => begin(e, 'move', h, h.id)} />
            )}
            {selected && !line && (
              <>
                <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="none" stroke="#fff" strokeOpacity={0.7} strokeDasharray="4 3" pointerEvents="none" />
                {(
                  [
                    ['tl', box.x, box.y, 'nwse-resize'],
                    ['tr', box.x + box.w, box.y, 'nesw-resize'],
                    ['br', box.x + box.w, box.y + box.h, 'nwse-resize'],
                    ['bl', box.x, box.y + box.h, 'nesw-resize'],
                    ['t', box.x + box.w / 2, box.y, 'ns-resize'],
                    ['b', box.x + box.w / 2, box.y + box.h, 'ns-resize'],
                    ['l', box.x, box.y + box.h / 2, 'ew-resize'],
                    ['r', box.x + box.w, box.y + box.h / 2, 'ew-resize'],
                  ] as const
                ).map(([id, x, y, cur]) => (
                  <rect key={id} x={x - 5} y={y - 5} width={10} height={10} rx={2} fill="#fff" stroke="#16171a" style={{ pointerEvents: 'auto', cursor: cur }} onPointerDown={(e) => begin(e, id, h, h.id)} />
                ))}
              </>
            )}
            {selected && line && (
              <>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#fff" strokeOpacity={0.6} strokeDasharray="4 3" pointerEvents="none" />
                {(
                  [
                    ['p0', a],
                    ['p1', b],
                  ] as const
                ).map(([id, p]) => (
                  <circle key={id} cx={p.x} cy={p.y} r={6} fill="#fff" stroke="#16171a" style={{ pointerEvents: 'auto', cursor: 'grab' }} onPointerDown={(e) => begin(e, id, h, h.id)} />
                ))}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

import { useMemo, useRef } from 'react';
import { Crop, Film, MousePointer2, Monitor, Volume2, VolumeX } from 'lucide-react';
import { cursorWarnings, resolveMove, sortByTime, suggestedMoveDuration, cursorDistance } from '../../shared/cursor';
import { bezierFor, cubicBezier, EASINGS, sanitizeBezier } from '../../shared/easing';
import { isInsideCrop } from '../../shared/geometry';
import { cursorSpaceAspect } from '../../shared/compose';
import { applySegmentEdit, placeSegments, setFreezeDuration, trimSegment } from '../../shared/timeline';
import { trimAudioClip, clipEnd } from '../../shared/audio';
import { CURSOR_THEME_LIST } from '../../shared/cursorThemes';
import { flicksToSeconds, secondsToFlicks, snapToFrame, formatTimecode, type Flicks } from '../../shared/time';
import type { BezierControls, CursorKeyframe, CursorStyle, EasingPreset, Project, VideoLayout } from '../../shared/schema';
import { editor, useEditor } from '../state/store';
import { usePlayheadTime } from '../state/playhead';
import { player } from '../engine/player';
import { Button, ColorInput, Field, NumberField, Section, Segmented, SliderField, Toggle, Warning } from '../components/ui';
import { addPause, addVisibility } from '../state/actions';
import { runOp } from '../engine/canvasOps';

const g = () => editor();
const begin = () => g().beginGesture();
const end = () => g().endGesture();
const sec = (f: Flicks) => flicksToSeconds(f);

function TimeField({ value, onChange, min = 0, max = Infinity }: { value: Flicks; onChange: (t: Flicks) => void; min?: number; max?: number }) {
  const rate = useEditor((s) => s.project.export.fps);
  return (
    <NumberField
      value={sec(value)}
      min={min}
      max={max}
      step={rate.den / rate.num}
      precision={3}
      unit="s"
      onBegin={begin}
      onCommit={end}
      onChange={(v) => onChange(snapToFrame(secondsToFlicks(v), rate))}
    />
  );
}

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const tab = useEditor((s) => s.inspectorTab);
  const mode = useEditor((s) => s.mode);

  let body: React.ReactNode = null;
  let title = '';
  if (selection.kind === 'keyframe' && selection.ids.length) {
    title = selection.ids.length > 1 ? `${selection.ids.length} Cursor Keyframes` : 'Cursor Keyframe';
    body = <KeyframeInspector project={project} ids={selection.ids} />;
  } else if (selection.kind === 'click' && selection.ids.length) {
    title = 'Click';
    body = <ClickInspector project={project} id={selection.ids[0]} />;
  } else if (selection.kind === 'visibility' && selection.ids.length) {
    title = 'Cursor Visibility';
    body = <VisibilityInspector project={project} id={selection.ids[0]} />;
  } else if (selection.kind === 'segment' && selection.ids.length) {
    title = 'Video Clip';
    body = (
      <>
        <SegmentInspector project={project} id={selection.ids[0]} />
        <VideoStyleInspector project={project} />
      </>
    );
  } else if (selection.kind === 'audio' && selection.ids.length) {
    title = 'Audio Clip';
    body = <AudioInspector project={project} id={selection.ids[0]} />;
  }

  const effectiveTab = tab === 'auto' ? (mode === 'cursor' ? 'cursor' : 'video') : tab;
  return (
    <aside className="panel inspector">
      {body ? (
        <>
          <div className="tabs" style={{ justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 600, padding: '4px 4px' }}>{title}</span>
            <Button size="small" variant="ghost" onClick={() => g().select({ kind: null, ids: [] })}>
              Done
            </Button>
          </div>
          <div className="panel-scroll">{body}</div>
        </>
      ) : (
        <>
          <div className="tabs" role="tablist">
            {(
              [
                ['video', <Film size={12} key="v" />, 'Video'],
                ['cursor', <MousePointer2 size={12} key="c" />, 'Cursor'],
                ['canvas', <Monitor size={12} key="m" />, 'Canvas'],
              ] as const
            ).map(([id, icon, label]) => (
              <button key={id} role="tab" aria-selected={effectiveTab === id} onClick={() => g().set({ inspectorTab: id })}>
                {icon} {label}
              </button>
            ))}
          </div>
          <div className="panel-scroll">
            {effectiveTab === 'video' && <VideoStyleInspector project={project} />}
            {effectiveTab === 'cursor' && <CursorStyleInspector project={project} />}
            {effectiveTab === 'canvas' && <CanvasInspector project={project} />}
          </div>
        </>
      )}
    </aside>
  );
}

// ------------------------------------------------------------ cursor keyframes

function updateKfs(ids: string[], patch: (k: CursorKeyframe) => Partial<CursorKeyframe>, gesture = false) {
  const fn = (p: Project): Project => ({ ...p, cursor: { ...p.cursor, keyframes: p.cursor.keyframes.map((k) => (ids.includes(k.id) ? { ...k, ...patch(k) } : k)) } });
  if (gesture) g().preview(fn);
  else g().commit(fn);
}

function KeyframeInspector({ project, ids }: { project: Project; ids: string[] }) {
  const sorted = sortByTime(project.cursor.keyframes);
  const kf = sorted.find((k) => k.id === ids[0]);
  const aspect = cursorSpaceAspect(project);
  const src = project.media.find((m) => m.id === project.video.segments[0]?.assetId);
  const sw = src?.width ?? 1920;
  const sh = src?.height ?? 1080;
  if (!kf) return null;
  const idx = sorted.findIndex((k) => k.id === kf.id);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const move = prev ? resolveMove(prev, kf, aspect) : null;
  const suggested = prev ? suggestedMoveDuration(cursorDistance(prev, kf, aspect), kf.easing) : 0;
  const warnings = cursorWarnings(project.cursor, aspect, (p) => isInsideCrop(p, project.video.crop)).filter((w) => ids.includes(w.id));
  const multi = ids.length > 1;
  const setPreset = (e: EasingPreset) => updateKfs(ids, (k) => ({ easing: e, customBezier: e === 'custom' ? (k.customBezier ?? bezierFor(k.easing === 'custom' ? 'smooth' : k.easing)) : k.customBezier }));
  return (
    <>
      {!multi && (
        <Section title={`Keyframe ${idx + 1} of ${sorted.length}`} right={<Button size="small" variant="ghost" onClick={() => player.seek(kf.time)}>Go to</Button>}>
          <Field label="Arrives at">
            <TimeField value={kf.time} onChange={(t) => g().preview((p) => ({ ...p, cursor: { ...p.cursor, keyframes: p.cursor.keyframes.map((k) => (k.id === kf.id ? { ...k, time: t } : k)) } }))} />
          </Field>
          <div className="hint" style={{ marginLeft: 100 }}>{formatTimecode(kf.time, project.export.fps)}</div>
          <Field label="Position">
            <NumberField value={kf.x * sw} min={0} max={sw} step={1} precision={0} unit="x" onBegin={begin} onCommit={end} onChange={(v) => updateKfs(ids, () => ({ x: v / sw }), true)} />
            <NumberField value={kf.y * sh} min={0} max={sh} step={1} precision={0} unit="y" onBegin={begin} onCommit={end} onChange={(v) => updateKfs(ids, () => ({ y: v / sh }), true)} />
          </Field>
          <div className="hint">Source-video pixels. The arrow tip lands exactly here, regardless of crop, layout or export size.</div>
        </Section>
      )}
      <Section title={multi ? 'Movement (all selected)' : prev ? `Movement from keyframe ${idx}` : 'Movement'}>
        {!prev && !multi ? (
          <div className="hint">This is where the cursor starts. Add another keyframe later in time and the motion is generated automatically.</div>
        ) : (
          <>
            <Field label="Easing">
              <select className="select" value={kf.easing} onChange={(e) => setPreset(e.target.value as EasingPreset)}>
                {Object.values(EASINGS).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </Field>
            <div className="hint" style={{ marginLeft: 100 }}>{kf.easing === 'custom' ? 'Drag the handles. Overshoot is prevented automatically.' : EASINGS[kf.easing].description}</div>
            <BezierEditor value={bezierFor(kf.easing, kf.customBezier)} editable={kf.easing === 'custom'} onChange={(b) => updateKfs(ids, () => ({ customBezier: sanitizeBezier(b) }), true)} />
            <Field label="Duration">
              <Segmented
                small
                value={kf.moveDuration == null ? 'auto' : 'manual'}
                onChange={(v) => updateKfs(ids, () => ({ moveDuration: v === 'auto' ? null : (move ? move.end - move.start : suggested) || secondsToFlicks(0.6) }))}
                options={[
                  { value: 'auto', label: 'Auto', tip: 'Duration from distance' },
                  { value: 'manual', label: 'Manual' },
                ]}
              />
              {kf.moveDuration != null ? (
                <NumberField value={sec(kf.moveDuration)} min={0} max={30} step={0.05} precision={2} unit="s" onBegin={begin} onCommit={end} onChange={(v) => updateKfs(ids, () => ({ moveDuration: secondsToFlicks(v) }), true)} />
              ) : (
                <span className="hint">{move ? `${sec(move.end - move.start).toFixed(2)}s` : ''}</span>
              )}
            </Field>
            {move && !multi && (
              <div className="hint" style={{ marginLeft: 100 }}>
                Starts moving at {sec(move.start).toFixed(2)}s{move.start > (prev?.time ?? 0) ? `, rests ${sec(move.start - prev!.time).toFixed(2)}s before` : ''}.
              </div>
            )}
            <SliderField label="Curve" value={kf.curve} min={-0.5} max={0.5} step={0.01} precision={0} scale={200} unit="%" onChange={(v) => updateKfs(ids, () => ({ curve: Math.abs(v) < 0.015 ? 0 : v }), true)} />
            <div className="hint" style={{ marginLeft: 100 }}>0 = straight (recommended). Or drag the white handle on the path.</div>
          </>
        )}
      </Section>
      {warnings.length > 0 && (
        <div className="section">
          {warnings.map((w) => (
            <Warning key={w.id + w.kind}>{w.message}</Warning>
          ))}
        </div>
      )}
    </>
  );
}

/** Interactive cubic-bezier editor; y constrained to [0,1] (no overshoot). */
function BezierEditor({ value, editable, onChange }: { value: BezierControls; editable: boolean; onChange: (b: BezierControls) => void }) {
  const W = 240;
  const H = 120;
  const P = 12;
  const ref = useRef<SVGSVGElement>(null);
  const toX = (x: number) => P + x * (W - 2 * P);
  const toY = (y: number) => H - P - y * (H - 2 * P);
  const curve = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const x = i / 60;
      pts.push(`${toX(x).toFixed(1)},${toY(cubicBezier(value, x)).toFixed(1)}`);
    }
    return pts.join(' ');
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = (i: 0 | 1) => (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    begin();
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left - P) / (W - 2 * P)));
      const y = Math.min(1, Math.max(0, (H - P - (ev.clientY - r.top)) / (H - 2 * P)));
      const b: BezierControls = [...value];
      if (i === 0) {
        b[0] = x;
        b[1] = Math.min(y, b[3]);
      } else {
        b[2] = x;
        b[3] = Math.max(y, b[1]);
      }
      onChange(b);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <svg ref={ref} className="bezier-editor" width={W} height={H} style={{ alignSelf: 'center' }}>
      <line x1={toX(0)} y1={toY(0)} x2={toX(1)} y2={toY(1)} stroke="#33353c" strokeDasharray="3 3" />
      {editable && (
        <>
          <line x1={toX(0)} y1={toY(0)} x2={toX(value[0])} y2={toY(value[1])} stroke="#5a5d66" />
          <line x1={toX(1)} y1={toY(1)} x2={toX(value[2])} y2={toY(value[3])} stroke="#5a5d66" />
        </>
      )}
      <polyline points={curve} fill="none" stroke="var(--track-cursor)" strokeWidth={2} />
      {editable &&
        ([0, 1] as const).map((i) => (
          <circle key={i} cx={toX(value[i * 2])} cy={toY(value[i * 2 + 1])} r={5.5} fill="#fff" stroke="var(--accent)" strokeWidth={2} style={{ cursor: 'grab' }} onPointerDown={drag(i)} />
        ))}
      <text x={toX(0)} y={H - 1} fontSize={9} fill="#6d7079">time →</text>
    </svg>
  );
}

function ClickInspector({ project, id }: { project: Project; id: string }) {
  const c = project.cursor.clicks.find((x) => x.id === id);
  if (!c) return null;
  const set = (patch: Partial<typeof c>, gesture = false) => {
    const fn = (p: Project): Project => ({ ...p, cursor: { ...p.cursor, clicks: p.cursor.clicks.map((x) => (x.id === id ? { ...x, ...patch } : x)) } });
    if (gesture) g().preview(fn);
    else g().commit(fn);
  };
  const warnings = cursorWarnings(project.cursor, cursorSpaceAspect(project), () => true).filter((w) => w.id === id);
  return (
    <>
      <Section title="Click" right={<Button size="small" variant="ghost" onClick={() => player.seek(c.time)}>Go to</Button>}>
        <Field label="Time">
          <TimeField value={c.time} onChange={(t) => set({ time: t }, true)} />
        </Field>
        <Field label="Type">
          <Segmented
            small
            value={c.button}
            onChange={(b) => set({ button: b })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'double', label: 'Double' },
              { value: 'right', label: 'Right' },
            ]}
          />
        </Field>
        <div className="hint">
          Align the click with the moment the recorded UI reacts: step frames with <span className="kbd">←</span> <span className="kbd">→</span> to find the change, then drag the marker
          (or press <span className="kbd">C</span> at the playhead).
        </div>
        {warnings.map((w) => (
          <Warning key={w.kind}>{w.message}</Warning>
        ))}
      </Section>
      <CursorStyleInspector project={project} only="effects" />
    </>
  );
}

function VisibilityInspector({ project, id }: { project: Project; id: string }) {
  const v = project.cursor.visibility.find((x) => x.id === id);
  if (!v) return null;
  return (
    <Section title="Visibility">
      <Field label="Time">
        <TimeField value={v.time} onChange={(t) => g().preview((p) => ({ ...p, cursor: { ...p.cursor, visibility: p.cursor.visibility.map((x) => (x.id === id ? { ...x, time: t } : x)) } }))} />
      </Field>
      <Field label="Cursor">
        <Segmented
          small
          value={v.visible ? 'show' : 'hide'}
          onChange={(s) => g().commit((p) => ({ ...p, cursor: { ...p.cursor, visibility: p.cursor.visibility.map((x) => (x.id === id ? { ...x, visible: s === 'show' } : x)) } }))}
          options={[
            { value: 'show', label: 'Appears' },
            { value: 'hide', label: 'Disappears' },
          ]}
        />
      </Field>
      <div className="hint">The cursor fades in or out over 160 ms.</div>
    </Section>
  );
}

// ------------------------------------------------------------ segments

function SegmentInspector({ project, id }: { project: Project; id: string }) {
  const placed = placeSegments(project.video.segments).find((x) => x.segment.id === id);
  if (!placed) return null;
  const s = placed.segment;
  const asset = project.media.find((m) => m.id === s.assetId);
  const rate = project.export.fps;
  if (s.kind === 'freeze') {
    return (
      <Section title="Freeze frame">
        <Field label="Duration">
          <NumberField
            value={sec(s.duration)}
            min={0.05}
            max={3600}
            step={0.1}
            precision={2}
            unit="s"
            onBegin={begin}
            onCommit={end}
            onChange={(v) => g().preview((p) => applySegmentEdit(p, setFreezeDuration(p.video.segments, id, snapToFrame(secondsToFlicks(v), rate))))}
          />
        </Field>
        <Field label="Holds frame">
          <span className="hint">source {sec(s.sourceTime).toFixed(3)}s of {asset?.name}</span>
        </Field>
        <Field label="Timeline">
          <span className="hint">
            {sec(placed.start).toFixed(2)}s → {sec(placed.end).toFixed(2)}s
          </span>
        </Field>
        <div className="hint">The source image stays fixed while the synthetic cursor and narration continue. Footage resumes from this frame afterwards.</div>
      </Section>
    );
  }
  const assetDur = asset?.duration ?? s.sourceOut;
  return (
    <Section title="Clip timing">
      <Field label="Source in">
        <NumberField value={sec(s.sourceIn)} min={0} max={sec(s.sourceOut) - 0.05} step={rate.den / rate.num} precision={3} unit="s" onBegin={begin} onCommit={end} onChange={(v) => g().preview((p) => applySegmentEdit(p, trimSegment(p.video.segments, id, 'start', s.sourceOut - secondsToFlicks(v), assetDur)))} />
      </Field>
      <Field label="Source out">
        <NumberField value={sec(s.sourceOut)} min={sec(s.sourceIn) + 0.05} max={sec(assetDur)} step={rate.den / rate.num} precision={3} unit="s" onBegin={begin} onCommit={end} onChange={(v) => g().preview((p) => applySegmentEdit(p, trimSegment(p.video.segments, id, 'end', secondsToFlicks(v) - s.sourceIn, assetDur)))} />
      </Field>
      <Field label="Timeline">
        <span className="hint">
          {sec(placed.start).toFixed(2)}s → {sec(placed.end).toFixed(2)}s ({sec(placed.end - placed.start).toFixed(2)}s)
        </span>
      </Field>
      {asset && (
        <Field label="Source">
          <span className="hint">
            {asset.width}×{asset.height} · {asset.frameRate?.toFixed(0)} fps · {asset.origin === 'recorded' ? 'recorded (no cursor)' : 'imported'}
          </span>
        </Field>
      )}
      {asset?.origin === 'imported' && <div className="hint">Imported footage may contain a baked-in mouse pointer; it can't be removed reliably.</div>}
    </Section>
  );
}

// ------------------------------------------------------------ video style

function setLayout(patch: Partial<VideoLayout>, gesture = true) {
  const fn = (p: Project): Project => ({ ...p, video: { ...p.video, layout: { ...p.video.layout, ...patch } } });
  if (gesture) g().preview(fn);
  else g().commit(fn);
}

function VideoStyleInspector({ project }: { project: Project }) {
  const L = project.video.layout;
  const c = project.video.crop;
  const asset = project.media.find((m) => m.id === project.video.segments[0]?.assetId);
  const sw = asset?.width ?? 1920;
  const sh = asset?.height ?? 1080;
  const setCrop = (patch: Partial<typeof c>) => g().preview((p) => ({ ...p, video: { ...p.video, crop: { ...p.video.crop, ...patch } } }));
  const mode = useEditor((s) => s.mode);
  const outW = Math.round(sw * (1 - c.left - c.right));
  const outH = Math.round(sh * (1 - c.top - c.bottom));
  const exportH = project.export.resolution;
  return (
    <>
      <Section
        title="Crop"
        right={
          <div style={{ display: 'flex', gap: 4 }}>
            <Button size="small" active={mode === 'crop'} onClick={() => g().set({ mode: mode === 'crop' ? 'select' : 'crop' })}>
              <Crop size={11} /> {mode === 'crop' ? 'Done' : 'Edit'}
            </Button>
            <Button size="small" variant="ghost" onClick={() => g().commit((p) => ({ ...p, video: { ...p.video, crop: { left: 0, top: 0, right: 0, bottom: 0 } } }))}>
              Reset
            </Button>
          </div>
        }
      >
        <Field label="Top / Bottom">
          <NumberField value={c.top * sh} min={0} max={sh * 0.9} precision={0} unit="px" onBegin={begin} onCommit={end} onChange={(v) => setCrop({ top: v / sh })} />
          <NumberField value={c.bottom * sh} min={0} max={sh * 0.9} precision={0} unit="px" onBegin={begin} onCommit={end} onChange={(v) => setCrop({ bottom: v / sh })} />
        </Field>
        <Field label="Left / Right">
          <NumberField value={c.left * sw} min={0} max={sw * 0.9} precision={0} unit="px" onBegin={begin} onCommit={end} onChange={(v) => setCrop({ left: v / sw })} />
          <NumberField value={c.right * sw} min={0} max={sw * 0.9} precision={0} unit="px" onBegin={begin} onCommit={end} onChange={(v) => setCrop({ right: v / sw })} />
        </Field>
        <div className="hint">
          Visible source: {outW}×{outH}px.
          {outH < exportH * 0.75 && ` The cropped recording is smaller than the ${exportH}p export; it will be upscaled and small text may look soft — record a larger window for crisp results.`}
        </div>
      </Section>
      <Section title="Placement">
        <SliderField label="Scale" value={L.scale} min={0.3} max={1.5} step={0.01} scale={100} unit="%" onChange={(v) => setLayout({ scale: v })} />
        <Field label="Align">
          <Segmented small value={L.hAlign} onChange={(v) => setLayout({ hAlign: v }, false)} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]} />
        </Field>
        <Field label="">
          <Segmented small value={L.vAlign} onChange={(v) => setLayout({ vAlign: v }, false)} options={[{ value: 'top', label: 'Top' }, { value: 'center', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]} />
        </Field>
        <Field label="Offset X / Y">
          <NumberField value={L.offsetX * 100} step={0.1} precision={1} unit="%" onBegin={begin} onCommit={end} onChange={(v) => setLayout({ offsetX: v / 100 })} />
          <NumberField value={L.offsetY * 100} step={0.1} precision={1} unit="%" onBegin={begin} onCommit={end} onChange={(v) => setLayout({ offsetY: v / 100 })} />
        </Field>
        <Button size="small" onClick={() => setLayout({ offsetX: 0, offsetY: 0, hAlign: 'center', vAlign: 'center' }, false)}>
          Center
        </Button>
      </Section>
      <Section title="Padding">
        <Field label="Top / Bottom">
          <NumberField value={L.padding.top * 100} min={0} max={45} step={0.5} precision={1} unit="%" onBegin={begin} onCommit={end} onChange={(v) => setLayout({ padding: { ...L.padding, top: v / 100 } })} />
          <NumberField value={L.padding.bottom * 100} min={0} max={45} step={0.5} precision={1} unit="%" onBegin={begin} onCommit={end} onChange={(v) => setLayout({ padding: { ...L.padding, bottom: v / 100 } })} />
        </Field>
        <Field label="Left / Right">
          <NumberField value={L.padding.left * 100} min={0} max={45} step={0.5} precision={1} unit="%" onBegin={begin} onCommit={end} onChange={(v) => setLayout({ padding: { ...L.padding, left: v / 100 } })} />
          <NumberField value={L.padding.right * 100} min={0} max={45} step={0.5} precision={1} unit="%" onBegin={begin} onCommit={end} onChange={(v) => setLayout({ padding: { ...L.padding, right: v / 100 } })} />
        </Field>
        <SliderField
          label="All sides"
          value={(L.padding.top + L.padding.bottom) / 2}
          min={0}
          max={0.25}
          step={0.0025}
          scale={100}
          precision={1}
          unit="%"
          onChange={(v) => { const k = project.canvas.aspectH / project.canvas.aspectW; setLayout({ padding: { top: v, bottom: v, left: v * k, right: v * k } }); }}
        />
        <div className="hint">Left/right are % of canvas width; top/bottom % of canvas height.</div>
      </Section>
      <Section title="Corners & shadow">
        <SliderField label="Corner radius" value={L.cornerRadius} min={0} max={0.06} step={0.001} scale={1000} precision={0} onChange={(v) => setLayout({ cornerRadius: v })} />
        <Field label="Shadow">
          <Toggle checked={L.shadow.enabled} onChange={(v) => setLayout({ shadow: { ...L.shadow, enabled: v } }, false)} />
          <ColorInput value={L.shadow.color} onChange={(v) => setLayout({ shadow: { ...L.shadow, color: v } }, false)} />
        </Field>
        {L.shadow.enabled && (
          <>
            <SliderField label="Blur" value={L.shadow.blur} min={0} max={0.15} step={0.001} scale={1000} onChange={(v) => setLayout({ shadow: { ...L.shadow, blur: v } })} />
            <SliderField label="Opacity" value={L.shadow.opacity} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(v) => setLayout({ shadow: { ...L.shadow, opacity: v } })} />
            <SliderField label="Offset X" value={L.shadow.offsetX} min={-0.06} max={0.06} step={0.001} scale={1000} onChange={(v) => setLayout({ shadow: { ...L.shadow, offsetX: v } })} />
            <SliderField label="Offset Y" value={L.shadow.offsetY} min={-0.06} max={0.08} step={0.001} scale={1000} onChange={(v) => setLayout({ shadow: { ...L.shadow, offsetY: v } })} />
          </>
        )}
      </Section>
      <Section title="Recording audio">
        <Field label="Play source audio">
          <Toggle checked={project.video.sourceAudio} onChange={(v) => g().commit((p) => ({ ...p, video: { ...p.video, sourceAudio: v } }))} />
          {!project.media.some((m) => m.kind === 'video' && m.hasAudio) && <span className="hint">No audio in footage</span>}
        </Field>
        {project.video.sourceAudio && <SliderField label="Volume" value={project.video.sourceAudioVolume} min={0} max={1} step={0.01} scale={100} unit="%" onChange={(v) => g().preview((p) => ({ ...p, video: { ...p.video, sourceAudioVolume: v } }))} />}
      </Section>
    </>
  );
}

// ------------------------------------------------------------ cursor style

export function CursorStyleInspector({ project, only }: { project: Project; only?: 'effects' }) {
  const st = project.cursor.style;
  const set = (patch: Partial<CursorStyle>, gesture = false) => {
    const fn = (p: Project): Project => ({ ...p, cursor: { ...p.cursor, style: { ...p.cursor.style, ...patch } } });
    if (gesture) g().preview(fn);
    else g().commit(fn);
  };
  const t = usePlayheadTime(200);
  const effects = (
    <Section title="Click effect">
      <Field label="Effect">
        <Segmented small value={st.clickEffect} onChange={(v) => set({ clickEffect: v })} options={[{ value: 'ripple', label: 'Ripple' }, { value: 'pulse', label: 'Pulse' }, { value: 'none', label: 'None' }]} />
      </Field>
      <Field label="Color">
        <ColorInput value={st.clickColor} onChange={(v) => set({ clickColor: v })} />
        <span className="hint">right clicks use amber</span>
      </Field>
      <Field label="Press animation">
        <Toggle checked={st.pressAnimation} onChange={(v) => set({ pressAnimation: v })} />
      </Field>
    </Section>
  );
  if (only === 'effects') return effects;
  return (
    <>
      <Section title="Cursor">
        <div className="cursor-themes">
          {CURSOR_THEME_LIST.map((th) => (
            <button key={th.id} className="cursor-theme" aria-pressed={st.theme === th.id} onClick={() => set({ theme: th.id, highlight: th.highlight || st.highlight })}>
              <CursorThumb theme={th.id} />
              {th.label}
            </button>
          ))}
        </div>
        <SliderField label="Size" value={st.size} min={0.5} max={2.5} step={0.05} scale={100} unit="%" onChange={(v) => set({ size: v }, true)} />
        <SliderField label="Opacity" value={st.opacity} min={0.1} max={1} step={0.01} scale={100} unit="%" onChange={(v) => set({ opacity: v }, true)} />
        <Field label="Shadow">
          <Toggle checked={st.shadow} onChange={(v) => set({ shadow: v })} />
        </Field>
        <Field label="Highlight halo">
          <Toggle checked={st.highlight} onChange={(v) => set({ highlight: v })} />
          {st.highlight && <ColorInput value={st.highlightColor} onChange={(v) => set({ highlightColor: v })} />}
        </Field>
        <Field label="Clip to video">
          <Toggle checked={st.clipToVideo} onChange={(v) => set({ clipToVideo: v })} />
          <span className="hint">hide outside the recording</span>
        </Field>
      </Section>
      {effects}
      <Section title="Quick actions">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Button size="small" onClick={() => addVisibility(true)}>Show here</Button>
          <Button size="small" onClick={() => addVisibility(false)}>Hide here</Button>
          <Button size="small" onClick={() => addPause(1)}>Pause 1s here</Button>
        </div>
        <div className="hint">At {sec(t).toFixed(2)}s. Keyframes: {project.cursor.keyframes.length} · clicks: {project.cursor.clicks.length}</div>
      </Section>
    </>
  );
}

function CursorThumb({ theme }: { theme: CursorStyle['theme'] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = (cv: HTMLCanvasElement | null) => {
    if (!cv) return;
    ref.current = cv;
    const dpr = window.devicePixelRatio || 1;
    cv.width = 30 * dpr;
    cv.height = 30 * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.scale(dpr, dpr);
    runOp(ctx, { op: 'cursor', theme, x: 9, y: 4, scale: 1.1, alpha: 1, shadow: true }, 30, 30);
  };
  return <canvas ref={draw} />;
}

// ------------------------------------------------------------ canvas

function CanvasInspector({ project }: { project: Project }) {
  const ex = project.export;
  const setEx = (patch: Partial<typeof ex>) => g().commit((p) => ({ ...p, export: { ...p.export, ...patch } }));
  return (
    <>
      <Section title="Canvas">
        <Field label="Aspect ratio">
          <select
            className="select"
            value={`${project.canvas.aspectW}:${project.canvas.aspectH}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split(':').map(Number);
              g().commit((p) => ({ ...p, canvas: { aspectW: w, aspectH: h } }));
            }}
          >
            <option value="16:9">16:9 — YouTube</option>
            <option value="16:10">16:10</option>
            <option value="4:3">4:3</option>
            <option value="1:1">1:1 — Square</option>
            <option value="9:16">9:16 — Vertical</option>
          </select>
        </Field>
        <Field label="Background">
          <Button size="small" onClick={() => g().set({ sidebarTab: 'backgrounds' })}>
            Choose…
          </Button>
          <span className="hint">{project.background.kind === 'preset' ? project.background.id : project.background.kind}</span>
        </Field>
      </Section>
      <Section title="Export defaults">
        <Field label="Resolution">
          <Segmented small value={String(ex.resolution) as '1440'} onChange={(v) => setEx({ resolution: Number(v) as 1440 })} options={[{ value: '1080' as '1440', label: '1080p' }, { value: '1440', label: '1440p' }, { value: '2160' as '1440', label: '4K' }]} />
        </Field>
        <Field label="Frame rate">
          <Segmented small value={String(ex.fps.num) as '30'} onChange={(v) => setEx({ fps: { num: Number(v), den: 1 } })} options={[{ value: '30', label: '30 fps' }, { value: '60' as '30', label: '60 fps' }]} />
        </Field>
        <div className="hint">The frame rate also defines frame stepping and snapping in the editor.</div>
      </Section>
      <AudioTotals project={project} />
    </>
  );
}

function AudioTotals({ project }: { project: Project }) {
  if (!project.audio.length) return null;
  const endT = Math.max(...project.audio.map(clipEnd));
  return (
    <Section title="Narration">
      <div className="hint">
        {project.audio.length} clip(s), ending at {sec(endT).toFixed(2)}s.
      </div>
    </Section>
  );
}

// ------------------------------------------------------------ audio clip

function AudioInspector({ project, id }: { project: Project; id: string }) {
  const c = project.audio.find((x) => x.id === id);
  if (!c) return null;
  const asset = project.media.find((m) => m.id === c.assetId);
  const set = (patch: Partial<typeof c>, gesture = true) => {
    const fn = (p: Project): Project => ({ ...p, audio: p.audio.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
    if (gesture) g().preview(fn);
    else g().commit(fn);
  };
  const dur = c.sourceOut - c.sourceIn;
  return (
    <>
      <Section title="Audio clip" right={<Button size="small" variant="ghost" onClick={() => player.seek(c.start)}>Go to</Button>}>
        <Field label="File">
          <span className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{asset?.name}</span>
        </Field>
        <Field label="Starts at">
          <TimeField value={c.start} onChange={(t) => set({ start: t })} />
        </Field>
        <Field label="Trim in / out">
          <NumberField value={sec(c.sourceIn)} min={0} max={sec(c.sourceOut) - 0.02} step={0.01} precision={3} unit="s" onBegin={begin} onCommit={end} onChange={(v) => g().preview((p) => ({ ...p, audio: trimAudioClip(p.audio, id, 'start', c.start + (secondsToFlicks(v) - c.sourceIn), asset) }))} />
          <NumberField value={sec(c.sourceOut)} min={sec(c.sourceIn) + 0.02} max={sec(asset?.duration ?? c.sourceOut)} step={0.01} precision={3} unit="s" onBegin={begin} onCommit={end} onChange={(v) => g().preview((p) => ({ ...p, audio: trimAudioClip(p.audio, id, 'end', c.start + (secondsToFlicks(v) - c.sourceIn), asset) }))} />
        </Field>
        <Field label="Duration">
          <span className="hint">
            {sec(dur).toFixed(3)}s · ends at {sec(c.start + dur).toFixed(2)}s
          </span>
        </Field>
      </Section>
      <Section title="Volume">
        <SliderField label="Volume" value={c.volume} min={0} max={2} step={0.01} scale={100} unit="%" onChange={(v) => set({ volume: v })} />
        <Field label="Mute">
          <Button size="small" active={c.muted} onClick={() => set({ muted: !c.muted }, false)}>
            {c.muted ? <VolumeX size={12} /> : <Volume2 size={12} />} {c.muted ? 'Muted' : 'Audible'}
          </Button>
        </Field>
        <Field label="Fade in / out">
          <NumberField value={sec(c.fadeIn)} min={0} max={sec(dur) / 2} step={0.05} precision={2} unit="s" onBegin={begin} onCommit={end} onChange={(v) => set({ fadeIn: secondsToFlicks(v) })} />
          <NumberField value={sec(c.fadeOut)} min={0} max={sec(dur) / 2} step={0.05} precision={2} unit="s" onBegin={begin} onCommit={end} onChange={(v) => set({ fadeOut: secondsToFlicks(v) })} />
        </Field>
        <div className="hint">Narration plays at normal speed; freezes never stretch or pitch-shift it.</div>
      </Section>
    </>
  );
}


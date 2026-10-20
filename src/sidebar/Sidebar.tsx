import { useEffect, useRef } from 'react';
import { AlertTriangle, AudioLines, Circle, Film, Image as ImageIcon, LayoutTemplate, Link2, MousePointer2, Palette, Plus, Trash2, Upload } from 'lucide-react';
import { BACKGROUND_PRESETS, backgroundOps, linearGradientPoints } from '../../shared/backgrounds';
import { LAYOUT_PRESETS } from '../../shared/layoutPresets';
import { videoRectNormalized } from '../../shared/geometry';
import { flicksToSeconds } from '../../shared/time';
import type { Background, MediaAsset, Project } from '../../shared/schema';
import { editor, useEditor } from '../state/store';
import { runOps } from '../engine/canvasOps';
import { Button, ColorInput, Field, NumberField, Section, Segmented } from '../components/ui';
import { CursorStyleInspector } from '../inspector/Inspector';
import { addAudioClip, appendVideo, importMedia, relinkAsset, removeAsset } from '../state/actions';

export function Sidebar() {
  const tab = useEditor((s) => s.sidebarTab);
  const project = useEditor((s) => s.project);
  return (
    <aside className="panel sidebar">
      <div className="tabs" role="tablist">
        {(
          [
            ['media', <Film size={12} key="m" />, 'Media'],
            ['backgrounds', <Palette size={12} key="b" />, 'Backdrop'],
            ['layout', <LayoutTemplate size={12} key="l" />, 'Layout'],
            ['cursor', <MousePointer2 size={12} key="c" />, 'Cursor'],
          ] as const
        ).map(([id, icon, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => editor().set({ sidebarTab: id })}>
            {icon} {label}
          </button>
        ))}
      </div>
      <div className="panel-scroll">
        {tab === 'media' && <MediaPanel project={project} />}
        {tab === 'backgrounds' && <BackgroundPanel project={project} />}
        {tab === 'layout' && <LayoutPanel project={project} />}
        {tab === 'cursor' && <CursorStyleInspector project={project} />}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------ media

function MediaPanel({ project }: { project: Project }) {
  const videos = project.media.filter((m) => m.kind === 'video');
  const audio = project.media.filter((m) => m.kind === 'audio');
  const images = project.media.filter((m) => m.kind === 'image');
  return (
    <>
      <div className="media-actions">
        <Button variant="record" onClick={() => editor().set({ dialog: 'record' })}>
          <span className="dot" /> Record
        </Button>
        <Button onClick={() => importMedia('any')} tip="Video, audio or images" shortcut="⌘I">
          <Upload size={12} /> Import
        </Button>
      </div>
      {project.media.length === 0 && <div className="dropzone">Drop recordings, ElevenLabs voiceovers (MP3 / WAV / M4A) or background images anywhere in the window.</div>}
      {videos.length > 0 && <div className="media-group-title">Recordings</div>}
      {videos.map((m) => (
        <MediaRow key={m.id} asset={m} />
      ))}
      {audio.length > 0 && <div className="media-group-title">Audio</div>}
      {audio.map((m) => (
        <MediaRow key={m.id} asset={m} />
      ))}
      {images.length > 0 && <div className="media-group-title">Images</div>}
      {images.map((m) => (
        <MediaRow key={m.id} asset={m} />
      ))}
    </>
  );
}

function MediaRow({ asset }: { asset: MediaAsset }) {
  const thumbs = useEditor((s) => s.thumbnails[asset.id]);
  const thumb = asset.kind === 'video' ? thumbs?.urls[Math.min(1, (thumbs?.urls.length ?? 1) - 1)] : asset.kind === 'image' && !asset.missing ? window.studio.media.url(asset.path) : undefined;
  const meta =
    asset.kind === 'image'
      ? `${asset.width}×${asset.height}`
      : asset.kind === 'video'
        ? `${flicksToSeconds(asset.duration).toFixed(1)}s · ${asset.width}×${asset.height}${asset.origin === 'recorded' ? ' · no cursor' : ''}`
        : `${flicksToSeconds(asset.duration).toFixed(1)}s · ${asset.sampleRate ? `${Math.round(asset.sampleRate / 100) / 10} kHz` : ''}`;
  return (
    <div
      className="media-item"
      draggable={!asset.missing}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-studio-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={asset.path}
    >
      <div className="media-thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
        {!thumb && (asset.kind === 'audio' ? <AudioLines size={15} /> : asset.kind === 'image' ? <ImageIcon size={15} /> : <Film size={15} />)}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="media-name">{asset.name}</div>
        {asset.missing ? (
          <div className="media-meta media-missing">
            <AlertTriangle size={10} /> Missing file
          </div>
        ) : (
          <div className="media-meta">{meta}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        {asset.missing ? (
          <Button size="small" icon variant="ghost" tip="Locate the file" onClick={() => relinkAsset(asset)}>
            <Link2 size={12} />
          </Button>
        ) : asset.kind === 'video' ? (
          <Button size="small" icon variant="ghost" tip="Append to the video track" onClick={() => appendVideo(asset)}>
            <Plus size={12} />
          </Button>
        ) : asset.kind === 'audio' ? (
          <Button size="small" icon variant="ghost" tip="Add to narration at the playhead" onClick={() => addAudioClip(asset, 'narration')}>
            <Plus size={12} />
          </Button>
        ) : (
          <Button size="small" icon variant="ghost" tip="Use as background" onClick={() => editor().commit((p) => ({ ...p, background: { kind: 'image', assetId: asset.id } }))}>
            <Plus size={12} />
          </Button>
        )}
        <Button size="small" icon variant="ghost" tip="Remove from project (file is kept)" onClick={() => removeAsset(asset.id)}>
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ backgrounds

function BgSwatch({ bg, media, selected, name, onClick }: { bg: Background; media: MediaAsset[]; selected: boolean; name: string; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(76 * dpr);
    const h = Math.round(47.5 * dpr);
    cv.width = w;
    cv.height = h;
    // Swatches use the same draw ops as the preview/export (at thumbnail size).
    runOps(cv.getContext('2d')!, backgroundOps(bg, { width: w, height: h }, media), w, h);
  }, [bg, media]);
  return (
    <button className="bg-swatch" aria-pressed={selected} onClick={onClick} title={name}>
      <canvas ref={ref} />
      <span className="bg-name">{name}</span>
    </button>
  );
}

function BackgroundPanel({ project }: { project: Project }) {
  const bg = project.background;
  const set = (b: Background) => editor().commit((p) => ({ ...p, background: b }));
  const cats = [...new Set(BACKGROUND_PRESETS.map((b) => b.category))];
  const images = project.media.filter((m) => m.kind === 'image');
  const grad = bg.kind === 'gradient' ? bg : { kind: 'gradient' as const, angle: 135, stops: [{ color: '#5b5bd6', pos: 0 }, { color: '#c86dd7', pos: 1 }] };
  void linearGradientPoints;
  return (
    <>
      {cats.map((c) => (
        <div key={c}>
          <div className="media-group-title">{c}</div>
          <div className="bg-grid">
            {BACKGROUND_PRESETS.filter((b) => b.category === c).map((b) => (
              <BgSwatch key={b.id} bg={{ kind: 'preset', id: b.id }} media={project.media} name={b.name} selected={bg.kind === 'preset' && bg.id === b.id} onClick={() => set({ kind: 'preset', id: b.id })} />
            ))}
          </div>
        </div>
      ))}
      <Section title="Custom">
        <Field label="Type">
          <Segmented
            small
            value={bg.kind === 'solid' || bg.kind === 'gradient' || bg.kind === 'image' ? bg.kind : 'preset'}
            onChange={(k) => {
              if (k === 'solid') set({ kind: 'solid', color: '#1d1f2b' });
              else if (k === 'gradient') set(grad);
              else if (k === 'image') {
                if (images[0]) set({ kind: 'image', assetId: images[0].id });
                else importMedia('image');
              } else set({ kind: 'preset', id: 'aurora-violet' });
            }}
            options={[
              { value: 'preset', label: 'Preset' },
              { value: 'solid', label: 'Solid' },
              { value: 'gradient', label: 'Gradient' },
              { value: 'image', label: 'Image' },
            ]}
          />
        </Field>
        {bg.kind === 'solid' && (
          <Field label="Color">
            <ColorInput value={bg.color} onChange={(c) => set({ kind: 'solid', color: c })} />
            <span className="hint">{bg.color}</span>
          </Field>
        )}
        {bg.kind === 'gradient' && (
          <>
            <Field label="Colors">
              {bg.stops.map((s, i) => (
                <ColorInput key={i} value={s.color} onChange={(c) => set({ ...bg, stops: bg.stops.map((x, j) => (j === i ? { ...x, color: c } : x)) })} />
              ))}
              {bg.stops.length < 4 && (
                <Button size="small" icon onClick={() => set({ ...bg, stops: [...bg.stops.map((s, i) => ({ ...s, pos: i / bg.stops.length })), { color: '#ffffff', pos: 1 }] })}>
                  <Plus size={11} />
                </Button>
              )}
            </Field>
            <Field label="Angle">
              <NumberField value={bg.angle} min={0} max={360} step={1} precision={0} unit="°" onBegin={() => editor().beginGesture()} onCommit={() => editor().endGesture()} onChange={(v) => editor().preview((p) => ({ ...p, background: { ...bg, angle: v } }))} />
            </Field>
          </>
        )}
        {bg.kind === 'image' && (
          <>
            <div className="bg-grid" style={{ padding: 0 }}>
              {images.map((m) => (
                <BgSwatch key={m.id} bg={{ kind: 'image', assetId: m.id }} media={project.media} name={m.name} selected={bg.assetId === m.id} onClick={() => set({ kind: 'image', assetId: m.id })} />
              ))}
            </div>
            <Button size="small" onClick={() => importMedia('image')}>
              <Upload size={11} /> Import image…
            </Button>
            <div className="hint">Images fill the canvas (cover) and are cropped to fit.</div>
          </>
        )}
      </Section>
    </>
  );
}

// ------------------------------------------------------------ layout presets

function LayoutPanel({ project }: { project: Project }) {
  const asset = project.media.find((m) => m.id === project.video.segments[0]?.assetId);
  const src = { width: asset?.width ?? 1920, height: asset?.height ?? 1200 };
  const aspect = project.canvas.aspectW / project.canvas.aspectH;
  const current = JSON.stringify(project.video.layout);
  return (
    <div className="layout-list">
      {LAYOUT_PRESETS.map((lp) => {
        const r = videoRectNormalized(lp.layout, project.video.crop, src, aspect);
        const active = JSON.stringify(lp.layout) === current;
        return (
          <button
            key={lp.id}
            className="layout-card"
            aria-pressed={active}
            onClick={() => editor().commit((p) => ({ ...p, video: { ...p.video, layout: { ...lp.layout } } }))}
          >
            <div className="layout-mini">
              <i style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, borderRadius: lp.layout.cornerRadius > 0 ? 2 : 0 }} />
            </div>
            <div>
              <div>{lp.name}</div>
              <div className="hint">{lp.description}</div>
            </div>
          </button>
        );
      })}
      <div className="hint" style={{ padding: '4px 2px' }}>
        Fine-tune scale, padding, corners and shadow in the inspector (Video tab) or drag the recording in the preview.
      </div>
      <Button size="small" onClick={() => editor().set({ mode: 'crop' })}>
        <Circle size={0} /> Crop the recording…
      </Button>
    </div>
  );
}

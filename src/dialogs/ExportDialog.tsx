import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FolderOpen } from 'lucide-react';
import { estimateExport } from '../../shared/renderPlan';
import { audioOverhang } from '../../shared/timeline';
import { flicksToSeconds } from '../../shared/time';
import type { ExportEvent } from '../../shared/ipc';
import type { ExportSettings } from '../../shared/schema';
import { editor, useEditor } from '../state/store';
import { Button, Field, Modal, Segmented, Warning } from '../components/ui';
import { errMsg } from '../state/actions';

const fmtBytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(0)} MB`);
const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(0)}s`);

export function ExportDialog() {
  const project = useEditor((s) => s.project);
  const ex = project.export;
  const est = estimateExport(project);
  const [job, setJob] = useState<{ id: string; path: string } | null>(null);
  const [progress, setProgress] = useState<Extract<ExportEvent, { type: 'progress' }> | null>(null);
  const [done, setDone] = useState<Extract<ExportEvent, { type: 'done' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);
  const set = (patch: Partial<ExportSettings>) => editor().commit((p) => ({ ...p, export: { ...p.export, ...patch } }));

  useEffect(
    () =>
      window.studio.render.onEvent((e) => {
        if (e.type === 'progress') setProgress(e);
        else if (e.type === 'done') {
          setDone(e);
          setJob(null);
        } else if (e.type === 'error') {
          setError(e.message);
          setJob(null);
        } else if (e.type === 'cancelled') {
          setJob(null);
          setProgress(null);
        }
      }),
    [],
  );

  const start = async () => {
    setError(null);
    setDone(null);
    const out = await window.studio.render.chooseOutput(project.name || 'Tutorial');
    if (!out) return;
    try {
      startedAt.current = performance.now();
      const { jobId } = await window.studio.render.start({ project: editor().project, outputPath: out });
      setJob({ id: jobId, path: out });
      setProgress(null);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const close = () => {
    if (job) return;
    editor().set({ dialog: null });
  };
  const pct = progress && progress.total ? (progress.frame / progress.total) * 100 : 0;
  const elapsed = (performance.now() - startedAt.current) / 1000;
  const eta = progress && progress.fps > 0 ? (progress.total - progress.frame) / progress.fps : null;
  const src = project.media.find((m) => m.id === project.video.segments[0]?.assetId);
  const cropH = src?.height ? src.height * (1 - project.video.crop.top - project.video.crop.bottom) : 0;
  const overhang = audioOverhang(project);
  const noVideo = project.video.segments.length === 0;
  const missing = project.media.filter((m) => m.missing);

  return (
    <Modal
      title="Export video"
      onClose={job ? undefined : close}
      footer={
        <>
          {done && (
            <Button onClick={() => window.studio.system.revealInFinder(done.path)}>
              <FolderOpen size={12} /> Show in Finder
            </Button>
          )}
          <div className="spacer" />
          {job ? (
            <Button variant="danger" onClick={() => window.studio.render.cancel(job.id)}>
              Cancel export
            </Button>
          ) : (
            <>
              <Button onClick={close}>{done ? 'Close' : 'Cancel'}</Button>
              <Button variant="primary" onClick={start} disabled={noVideo || missing.length > 0}>
                {done ? 'Export again…' : 'Export…'}
              </Button>
            </>
          )}
        </>
      }
    >
      <Field label="Resolution">
        <Segmented
          value={String(ex.resolution) as '1440'}
          onChange={(v) => set({ resolution: Number(v) as 1440 })}
          options={[
            { value: '1080' as '1440', label: '1080p' },
            { value: '1440', label: '1440p' },
            { value: '2160' as '1440', label: '4K' },
          ]}
        />
      </Field>
      <Field label="Frame rate">
        <Segmented value={String(ex.fps.num) as '30'} onChange={(v) => set({ fps: { num: Number(v), den: 1 } })} options={[{ value: '30', label: '30 fps' }, { value: '60' as '30', label: '60 fps' }]} />
      </Field>
      <Field label="Codec">
        <Segmented value={ex.codec} onChange={(v) => set({ codec: v })} options={[{ value: 'h264', label: 'H.264', tip: 'Most compatible' }, { value: 'hevc', label: 'HEVC', tip: 'Smaller files, hardware encoded' }]} />
      </Field>
      <Field label="Quality">
        <Segmented value={ex.quality} onChange={(v) => set({ quality: v })} options={[{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Maximum' }]} />
      </Field>
      <div className="summary-grid">
        <div>
          <b>
            {est.width}×{est.height}
          </b>
          <span>MP4 · {ex.codec === 'h264' ? 'H.264' : 'HEVC'}</span>
        </div>
        <div>
          <b>{flicksToSeconds(est.duration).toFixed(2)}s</b>
          <span>{est.frames} frames</span>
        </div>
        <div>
          <b>AAC 48 kHz</b>
          <span>{project.audio.length ? `${project.audio.length} audio clip(s)` : 'no audio'}</span>
        </div>
        <div>
          <b>≈ {fmtBytes(est.bytes)}</b>
          <span>estimated size</span>
        </div>
      </div>
      {cropH > 0 && cropH < est.height * 0.75 && (
        <Warning>
          The visible recording is {Math.round(cropH)}px tall but the export is {est.height}px. It will be upscaled — this does not restore text detail. For crisp text, record a larger window or export at a
          lower resolution.
        </Warning>
      )}
      {overhang > 0 && <Warning>Narration continues {flicksToSeconds(overhang).toFixed(1)}s past the end of the video and will be cut. Use “extend video” in the timeline to add a freeze at the end.</Warning>}
      {missing.length > 0 && <Warning>Missing media: {missing.map((m) => m.name).join(', ')}. Relink it in the Media panel.</Warning>}
      {noVideo && <Warning>Add a video to the timeline first.</Warning>}
      {(job || progress) && !done && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="progress">
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="hint" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>
              {progress?.phase === 'finalizing' ? 'Finalizing file…' : progress?.phase === 'audio' ? 'Encoding audio…' : progress?.total ? `Rendering frame ${progress.frame} of ${progress.total}` : 'Preparing render plan…'}
            </span>
            <span>
              {progress?.fps ? `${progress.fps.toFixed(0)} fps` : ''} {eta != null && progress?.phase === 'video' ? `· ${fmtTime(eta)} left` : ''} · {fmtTime(elapsed)}
            </span>
          </div>
        </div>
      )}
      {done && (
        <div className="warning" style={{ color: 'var(--success)', background: 'rgba(79,209,139,0.08)', borderColor: 'rgba(79,209,139,0.3)' }}>
          <CheckCircle2 size={13} />
          <span>
            Exported {fmtBytes(done.bytes)} in {fmtTime(done.seconds)} — {done.path.split('/').pop()}
          </span>
        </div>
      )}
      {error && <Warning>Export failed: {error}</Warning>}
    </Modal>
  );
}

import { useEffect, useRef, useState } from 'react';
import { AppWindow, Monitor, RefreshCw, Scan, ShieldAlert } from 'lucide-react';
import type { CaptureSources, PermissionState, RecordingConfig } from '../../shared/ipc';
import { editor } from '../state/store';
import { Button, Field, Modal, Segmented, Warning } from '../components/ui';
import { errMsg } from '../state/actions';

export function RecordDialog() {
  const [perm, setPerm] = useState<PermissionState | 'checking'>('checking');
  const [sources, setSources] = useState<CaptureSources | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RecordingConfig['mode']>('window');
  const [windowId, setWindowId] = useState<number | null>(null);
  const [displayId, setDisplayId] = useState<number | null>(null);
  const [region, setRegion] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [fps, setFps] = useState<30 | 60>(60);
  const [countdown, setCountdown] = useState(3);
  const [starting, setStarting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await window.studio.recording.permission();
      setPerm(p);
      if (p !== 'granted') return;
      const s = await window.studio.recording.listSources();
      setSources(s);
      if (s.displays[0] && displayId == null) setDisplayId(s.displays[0].id);
      const browser = s.windows.find((w) => /chrome|safari|firefox|arc|edge|brave/i.test(w.app));
      if (windowId == null) setWindowId((browser ?? s.windows[0])?.id ?? null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => editor().set({ dialog: null });
  const canStart = perm === 'granted' && ((mode === 'window' && windowId != null) || (mode === 'display' && displayId != null) || (mode === 'region' && displayId != null && region && region.w > 20 && region.h > 20));

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await window.studio.recording.start({ mode, windowId: windowId ?? undefined, displayId: displayId ?? undefined, region: region ?? undefined, fps, countdown, showCursor: false });
      editor().set({ dialog: null });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setStarting(false);
    }
  };

  const display = sources?.displays.find((d) => d.id === displayId);

  return (
    <Modal
      wide
      title="Record screen"
      onClose={close}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            The real mouse pointer is never recorded — you'll add a smooth synthetic cursor afterwards. Stop with the floating control or <span className="kbd">⌘⇧2</span>.
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!canStart || starting} onClick={start}>
            {starting ? 'Starting…' : 'Start recording'}
          </Button>
        </>
      }
    >
      {perm === 'checking' && <div className="hint">Checking Screen Recording permission…</div>}
      {(perm === 'denied' || perm === 'unknown') && (
        <div className="section" style={{ border: '1px solid var(--border-strong)', borderRadius: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <ShieldAlert size={22} color="var(--warning)" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <b>Screen Recording permission needed</b>
              <span className="hint">
                macOS requires your approval before any app can record the screen. Open System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording, enable <b>Tutorial Studio</b>, then
                return here. macOS may ask you to quit and reopen the app.
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Button variant="primary" onClick={() => window.studio.recording.openPermissionSettings()}>
                  Open System Settings
                </Button>
                <Button onClick={refresh}>
                  <RefreshCw size={12} /> Check again
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {perm === 'granted' && (
        <>
          <Field label="Capture">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'window', label: <><AppWindow size={13} /> Window</>, tip: 'Recommended: record just your browser window' },
                { value: 'display', label: <><Monitor size={13} /> Display</> },
                { value: 'region', label: <><Scan size={13} /> Region</> },
              ]}
            />
            <Button size="small" variant="ghost" onClick={refresh} disabled={loading}>
              <RefreshCw size={12} /> {loading ? 'Loading…' : 'Refresh'}
            </Button>
          </Field>
          {mode === 'window' && (
            <div className="source-grid">
              {sources?.windows.map((w) => (
                <button key={w.id} className="source-card" aria-pressed={w.id === windowId} onClick={() => setWindowId(w.id)}>
                  <div className="shot" style={w.thumbnail ? { backgroundImage: `url("${w.thumbnail}")` } : undefined} />
                  <div className="name">{w.title || w.app}</div>
                  <div className="sub">
                    {w.app} · {w.width}×{w.height} pt
                  </div>
                </button>
              ))}
              {sources && !sources.windows.length && <div className="hint">No windows found. Open the browser window you want to record.</div>}
            </div>
          )}
          {(mode === 'display' || mode === 'region') && (
            <div className="source-grid">
              {sources?.displays.map((d) => (
                <button key={d.id} className="source-card" aria-pressed={d.id === displayId} onClick={() => setDisplayId(d.id)}>
                  <div className="shot" style={d.thumbnail ? { backgroundImage: `url("${d.thumbnail}")` } : undefined} />
                  <div className="name">{d.name}</div>
                  <div className="sub">
                    {d.width}×{d.height} pt @{d.scale}x
                  </div>
                </button>
              ))}
            </div>
          )}
          {mode === 'region' && display && <RegionPicker display={display} region={region} onChange={setRegion} />}
          <Field label="Frame rate">
            <Segmented value={String(fps) as '60'} onChange={(v) => setFps(Number(v) as 30 | 60)} options={[{ value: '30' as '60', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
          </Field>
          <Field label="Countdown">
            <Segmented value={String(countdown) as '3'} onChange={(v) => setCountdown(Number(v))} options={[{ value: '0' as '3', label: 'None' }, { value: '3', label: '3 s' }, { value: '5' as '3', label: '5 s' }]} />
          </Field>
          <div className="hint">Tip: for crisp UI text, record a large browser window on a Retina display — the recording keeps full pixel resolution.</div>
        </>
      )}
      {error && <Warning>{error}</Warning>}
    </Modal>
  );
}

function RegionPicker({ display, region, onChange }: { display: { width: number; height: number; thumbnail?: string }; region: { x: number; y: number; w: number; h: number } | null; onChange: (r: { x: number; y: number; w: number; h: number }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const W = 520;
  const H = (W * display.height) / display.width;
  const k = W / display.width;
  const down = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x0 = (e.clientX - r.left) / k;
    const y0 = (e.clientY - r.top) / k;
    (e.target as Element).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x1 = Math.max(0, Math.min(display.width, (ev.clientX - r.left) / k));
      const y1 = Math.max(0, Math.min(display.height, (ev.clientY - r.top) / k));
      onChange({ x: Math.round(Math.min(x0, x1)), y: Math.round(Math.min(y0, y1)), w: Math.round(Math.abs(x1 - x0)), h: Math.round(Math.abs(y1 - y0)) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
      <div ref={ref} className="region-picker" style={{ width: W, height: H, backgroundImage: display.thumbnail ? `url("${display.thumbnail}")` : undefined }} onPointerDown={down}>
        {region && <div className="rect" style={{ left: region.x * k, top: region.y * k, width: region.w * k, height: region.h * k }} />}
      </div>
      <span className="hint">{region ? `Region ${region.w}×${region.h} pt at (${region.x}, ${region.y})` : 'Drag on the screenshot to select the area to record.'}</span>
    </div>
  );
}

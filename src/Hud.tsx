import { useEffect, useState } from 'react';
import { Square, X } from 'lucide-react';
import type { RecordingEvent } from '../shared/ipc';

/** Floating recording control (separate always-on-top window, excluded from capture). */
export function Hud() {
  const [state, setState] = useState<RecordingEvent>({ type: 'countdown', remaining: 3 });
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    document.documentElement.classList.add('hud-mode');
    return window.studio.recording.onEvent((e) => {
      setState(e);
      if (e.type === 'progress') setSecs(e.seconds);
    });
  }, []);
  const mm = Math.floor(secs / 60);
  const ss = Math.floor(secs % 60);
  return (
    <div className="hud">
      {state.type === 'countdown' ? (
        <span className="time">Recording in {state.remaining}…</span>
      ) : state.type === 'finalizing' ? (
        <span className="time">Saving…</span>
      ) : (
        <>
          <span className="rec-dot" />
          <span className="time">
            {mm}:{String(ss).padStart(2, '0')}
          </span>
        </>
      )}
      <button className="btn small" onClick={() => window.studio.recording.stop()} disabled={state.type === 'finalizing'} title="Stop recording (⌘⇧2)">
        <Square size={10} fill="currentColor" /> Stop
      </button>
      <button className="btn small ghost icon" onClick={() => window.studio.recording.cancel()} title="Discard recording">
        <X size={12} />
      </button>
    </div>
  );
}

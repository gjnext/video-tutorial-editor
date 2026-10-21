/**
 * Large preview: "theater" (≈80 % of the window, with controls) and
 * "fullscreen" (whole screen; starts playing and closes itself when playback
 * reaches the end, or on Esc). Draws the same composition as the editor.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Expand, Pause, Play, X } from 'lucide-react';
import { fitRect } from '../../shared/geometry';
import { projectDuration } from '../../shared/timeline';
import { formatTimecode, frameDuration } from '../../shared/time';
import { editor, useEditor } from '../state/store';
import { playhead, usePlayheadTime, usePlaying } from '../state/playhead';
import { player } from '../engine/player';
import { CompositionRenderer } from './compositionRenderer';

export function Presentation({ mode }: { mode: 'theater' | 'fullscreen' }) {
  const project = useEditor((s) => s.project);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [controls, setControls] = useState(true);
  const playing = usePlaying();
  const t = usePlayheadTime(50);
  const dur = projectDuration(project);
  const close = useCallback(() => editor().set({ presentation: null }), []);

  useEffect(() => {
    const onResize = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Full screen: enter, play from the playhead (or the start), leave when done.
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const el = rootRef.current!;
    let entered = false;
    el.requestFullscreen()
      .then(() => {
        entered = true;
        const d = projectDuration(editor().project);
        if (playhead.getState().time >= d - frameDuration(editor().project.export.fps)) player.seek(0);
        void player.play();
      })
      .catch(() => close());
    const onChange = () => {
      if (entered && !document.fullscreenElement) {
        player.pause();
        close();
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    // Close automatically when playback reaches the end.
    const off = playhead.subscribe((s, prev) => {
      if (prev.playing && !s.playing && s.time >= projectDuration(editor().project) - frameDuration(editor().project.export.fps)) {
        if (document.fullscreenElement) void document.exitFullscreen();
        else close();
      }
    });
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      off();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [mode, close]);

  // Auto-hide controls in full screen while the mouse is still.
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    let timer: ReturnType<typeof setTimeout>;
    const show = () => {
      setControls(true);
      clearTimeout(timer);
      timer = setTimeout(() => setControls(false), 2200);
    };
    show();
    window.addEventListener('mousemove', show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', show);
    };
  }, [mode]);

  // Layout: theater uses ~80 % of the window; full screen uses the whole screen.
  const aspect = project.canvas.aspectW / project.canvas.aspectH;
  const barH = mode === 'theater' ? 52 : 0;
  const area = mode === 'theater' ? { w: win.w * 0.8, h: win.h * 0.8 - barH } : { w: win.w, h: win.h };
  const fit = fitRect({ width: aspect, height: 1 }, { x: 0, y: 0, w: area.w, h: area.h });
  const css = { w: Math.round(fit.w), h: Math.round(fit.h) };
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(dpr, 5120 / Math.max(1, css.w));
  const size = { w: Math.max(2, Math.round(css.w * scale)), h: Math.max(2, Math.round(css.h * scale)) };

  const renderer = useRef<CompositionRenderer | null>(null);
  const raf = useRef(0);
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    if (cv.width !== size.w || cv.height !== size.h) {
      cv.width = size.w;
      cv.height = size.h;
    }
    if (!renderer.current) renderer.current = new CompositionRenderer(() => request());
    renderer.current.draw(cv.getContext('2d', { alpha: false })!, size.w, size.h, editor().project, playhead.getState().time);
  }, [size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps
  const request = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      draw();
    });
  }, [draw]);
  useEffect(() => player.onFrame(request), [request]);
  useEffect(() => playhead.subscribe(request), [request]);
  useEffect(() => useEditor.subscribe(request), [request]);
  useEffect(() => request(), [request]);

  const seekFromBar = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const go = (cx: number) => player.seek(Math.max(0, Math.min(1, (cx - r.left) / r.width)) * dur);
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={rootRef} className={`presentation ${mode}`} onPointerDown={(e) => mode === 'theater' && e.target === e.currentTarget && close()} style={{ cursor: mode === 'fullscreen' && !controls ? 'none' : undefined }}>
      <div className="presentation-stage" style={{ width: css.w }}>
        <canvas ref={canvasRef} style={{ width: css.w, height: css.h }} onClick={() => player.toggle()} />
        {(mode === 'theater' || controls) && (
          <div className="presentation-bar">
            <button className="btn ghost icon" onClick={() => player.toggle()} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <span className="timecode">{formatTimecode(t, project.export.fps)}</span>
            <div className="presentation-progress" onPointerDown={seekFromBar}>
              <div style={{ width: `${dur > 0 ? (t / dur) * 100 : 0}%` }} />
            </div>
            <span className="timecode dim">{formatTimecode(dur, project.export.fps)}</span>
            {mode === 'theater' && (
              <button className="btn ghost icon" onClick={() => editor().set({ presentation: 'fullscreen' })} title="Play full screen (⇧F)">
                <Expand size={15} />
              </button>
            )}
            <button className="btn ghost icon" onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : close())} title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

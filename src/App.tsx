import { useEffect, useState } from 'react';
import { Download, HelpCircle, Redo2, Undo2, Upload } from 'lucide-react';
import { Preview } from './preview/Preview';
import { Timeline } from './timeline/Timeline';
import { Inspector } from './inspector/Inspector';
import { Sidebar } from './sidebar/Sidebar';
import { ExportDialog } from './dialogs/ExportDialog';
import { RecordDialog } from './dialogs/RecordDialog';
import { HelpDialog } from './dialogs/HelpDialog';
import { Button, ContextMenuProvider, Toasts, TooltipLayer } from './components/ui';
import { editor, useEditor } from './state/store';
import { playhead } from './state/playhead';
import { player } from './engine/player';
import { prefetchProjectMedia } from './engine/mediaCache';
import { projectDuration } from '../shared/timeline';
import { secondsToFlicks } from '../shared/time';
import type { MenuCommand, RecoveryInfo } from '../shared/ipc';
import {
  addAssets,
  addClick,
  deleteSelection,
  duplicateSelection,
  importFiles,
  importMedia,
  newProject,
  openProject,
  saveProject,
  seekToEdge,
  selectAll,
  splitAtPlayhead,
  startAutosave,
  stepFrames,
  toggleCursorMode,
} from './state/actions';

function isTyping() {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function runCommand(cmd: MenuCommand) {
  const s = editor();
  switch (cmd) {
    case 'new':
      return newProject();
    case 'open':
      return openProject();
    case 'save':
      return saveProject(false);
    case 'save-as':
      return saveProject(true);
    case 'import':
      return importMedia('any');
    case 'record':
      return s.set({ dialog: 'record' });
    case 'export':
      player.pause();
      return s.set({ dialog: 'export' });
    case 'undo':
      if (isTyping()) return document.execCommand('undo');
      return s.undo();
    case 'redo':
      if (isTyping()) return document.execCommand('redo');
      return s.redo();
    case 'delete':
      if (isTyping()) return;
      return deleteSelection();
    case 'duplicate':
      return duplicateSelection();
    case 'select-all':
      if (isTyping()) return document.execCommand('selectAll');
      return selectAll();
    case 'split':
      return splitAtPlayhead();
    case 'freeze':
      return window.dispatchEvent(new CustomEvent('studio:freeze'));
    case 'play':
      return player.toggle();
    case 'zoom-in':
      return window.dispatchEvent(new CustomEvent('studio:zoom', { detail: 'in' }));
    case 'zoom-out':
      return window.dispatchEvent(new CustomEvent('studio:zoom', { detail: 'out' }));
    case 'zoom-fit':
      return window.dispatchEvent(new CustomEvent('studio:zoom', { detail: 'fit' }));
    case 'cursor-mode':
      return toggleCursorMode();
    case 'add-click':
      return addClick('left');
    case 'toggle-path':
      return s.set({ showPath: !s.showPath });
    case 'help':
      return s.set({ dialog: 'help' });
  }
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping() || editor().dialog) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod) return; // ⌘ shortcuts come through the native menu
      const k = e.key;
      const s = editor();
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (k === ' ') return handled(), player.toggle();
      if (k === 'ArrowLeft') return handled(), e.shiftKey ? player.seek(playhead.getState().time - secondsToFlicks(1)) : stepFrames(-1);
      if (k === 'ArrowRight') return handled(), e.shiftKey ? player.seek(playhead.getState().time + secondsToFlicks(1)) : stepFrames(1);
      if (k === 'ArrowUp') return handled(), seekToEdge(-1);
      if (k === 'ArrowDown') return handled(), seekToEdge(1);
      if (k === 'Home') return handled(), player.seek(0);
      if (k === 'End') return handled(), player.seek(projectDuration(s.project));
      if (k === 'Backspace' || k === 'Delete') return handled(), deleteSelection();
      if (k === 'Escape') {
        handled();
        if (s.mode !== 'select') s.set({ mode: 'select' });
        else s.select({ kind: null, ids: [] });
        return;
      }
      const lower = k.toLowerCase();
      if (lower === 'k') return handled(), toggleCursorMode();
      if (lower === 'v') return handled(), s.set({ mode: 'select' });
      if (lower === 'h') return handled(), s.set({ mode: s.mode === 'highlight' ? 'select' : 'highlight' });
      if (lower === 'r') return handled(), s.set({ mode: s.mode === 'crop' ? 'select' : 'crop' });
      if (lower === 'c') return handled(), addClick(e.shiftKey ? 'double' : 'left');
      if (lower === 'p') return handled(), s.set({ showPath: !s.showPath });
      if (lower === 's') return handled(), splitAtPlayhead();
      if (lower === 'f') return handled(), window.dispatchEvent(new CustomEvent('studio:freeze'));
      if (lower === 'n') return handled(), s.set({ snapping: !s.snapping });
      if (k === 'Z' && e.shiftKey) return handled(), window.dispatchEvent(new CustomEvent('studio:zoom', { detail: 'fit' }));
      if (k === '?') return handled(), s.set({ dialog: 'help' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const dialog = useEditor((s) => s.dialog);
  const dirty = useEditor((s) => s.dirty);
  const name = useEditor((s) => s.project.name);
  const path = useEditor((s) => s.projectPath);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const hasVideo = useEditor((s) => s.project.video.segments.length > 0);
  const [recovery, setRecovery] = useState<RecoveryInfo | null>(null);
  const [dragOver, setDragOver] = useState(false);
  useShortcuts();

  useEffect(() => window.studio.system.onMenu(runCommand), []);
  useEffect(() => {
    window.studio.project.setDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    window.studio.project.setTitle(`${name}${dirty ? ' — Edited' : ''}`);
  }, [name, dirty]);
  useEffect(() => {
    startAutosave();
    window.studio.project.getRecovery().then((r) => r && setRecovery(r)).catch(() => {});
    const onOpen = (e: Event) => openProject((e as CustomEvent<string>).detail);
    window.addEventListener('studio:open-path', onOpen);
    const offClose = window.studio.system.onBeforeClose(async () => {
      if (await saveProject(false)) window.studio.system.confirmClose();
    });
    const offRec = window.studio.recording.onEvent((e) => {
      if (e.type === 'finished') {
        addAssets([e.asset]);
        editor().toast('success', `Recording saved (${e.asset.width}×${e.asset.height}). Press K and click the preview to add the cursor.`);
      } else if (e.type === 'error') editor().toast('error', e.message);
      else if (e.type === 'cancelled') editor().toast('info', 'Recording discarded.');
    });
    return () => {
      window.removeEventListener('studio:open-path', onOpen);
      offClose();
      offRec();
    };
  }, []);

  // Freeze shortcut opens the timeline freeze popover via a click on its button.
  useEffect(() => {
    const onFreeze = () => (document.querySelector('[data-freeze-button]') as HTMLButtonElement | null)?.click();
    window.addEventListener('studio:freeze', onFreeze);
    return () => window.removeEventListener('studio:freeze', onFreeze);
  }, []);

  return (
    <ContextMenuProvider>
      <div
        className="app"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          importFiles([...e.dataTransfer.files]);
        }}
      >
        <header className="titlebar">
          <Button variant="ghost" icon tip="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => editor().undo()}>
            <Undo2 size={14} />
          </Button>
          <Button variant="ghost" icon tip="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => editor().redo()}>
            <Redo2 size={14} />
          </Button>
          <div className="title">
            <b>{name}</b>
            {dirty ? ' — Edited' : path ? ' — Saved' : ''}
          </div>
          <Button variant="ghost" icon tip="Keyboard shortcuts" shortcut="?" onClick={() => editor().set({ dialog: 'help' })}>
            <HelpCircle size={14} />
          </Button>
          <Button variant="record" onClick={() => editor().set({ dialog: 'record' })} tip="Record a window, display or region without the mouse pointer" shortcut="⇧⌘R">
            <span className="dot" /> Record
          </Button>
          <Button onClick={() => importMedia('any')} tip="Import video, narration or images" shortcut="⌘I">
            <Upload size={13} /> Import
          </Button>
          <Button variant="primary" disabled={!hasVideo} onClick={() => runCommand('export')} tip="Export MP4" shortcut="⌘E">
            <Download size={13} /> Export
          </Button>
        </header>
        <main className="workspace">
          <Sidebar />
          <Preview />
          <Inspector />
        </main>
        <Timeline />
        {dragOver && <div style={{ position: 'fixed', inset: 0, border: '2px dashed var(--accent)', background: 'rgba(115,128,255,0.06)', pointerEvents: 'none', zIndex: 60 }} />}
      </div>
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'record' && <RecordDialog />}
      {dialog === 'help' && <HelpDialog />}
      {recovery && (
        <div className="toasts" style={{ bottom: 'auto', top: 56 }}>
          <div className="toast">
            <span className="msg">
              Recovered unsaved changes to “{recovery.project.name}” from {new Date(recovery.savedAt).toLocaleString()}.
            </span>
            <Button
              size="small"
              variant="primary"
              onClick={() => {
                editor().load(recovery.project, recovery.path, { dirty: true });
                prefetchProjectMedia(recovery.project.media);
                player.seek(0);
                setRecovery(null);
              }}
            >
              Restore
            </Button>
            <Button
              size="small"
              onClick={() => {
                window.studio.project.clearRecovery();
                setRecovery(null);
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
      <Toasts />
      <TooltipLayer />
    </ContextMenuProvider>
  );
}

/**
 * Export jobs: evaluate the project into a render plan (shared composition
 * code — the same functions the preview uses) and run the native renderer.
 * Plan generation happens in a worker thread so the main process event loop
 * never blocks, and encoding runs in the separate studio-render process.
 */
import { BrowserWindow } from 'electron';
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { newId, type Project } from '../../shared/schema';
import type { ExportEvent } from '../../shared/ipc';
import { startHelper, type HelperHandle } from './native';
import { dirs } from './paths';
import { allowFile } from './media';

interface Job {
  id: string;
  helper?: HelperHandle;
  cancelled: boolean;
  planFile: string;
}

const jobs = new Map<string, Job>();

function send(win: BrowserWindow | null, e: ExportEvent) {
  if (win && !win.isDestroyed()) win.webContents.send('render:event', e);
}

function buildPlanInWorker(project: Project, outputPath: string, planFile: string): Promise<{ frames: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'planWorker.cjs'), { workerData: { project, outputPath, planFile } });
    w.once('message', (m: { ok: boolean; frames?: number; error?: string }) => (m.ok ? resolve({ frames: m.frames! }) : reject(new Error(m.error))));
    w.once('error', reject);
  });
}

export function startExport(win: BrowserWindow | null, project: Project, outputPath: string): string {
  const id = newId('job');
  const planFile = path.join(dirs.exportTmp(), `${id}.json`);
  const job: Job = { id, cancelled: false, planFile };
  jobs.set(id, job);
  const started = Date.now();
  (async () => {
    try {
      const missing = project.media.filter((m) => m.missing);
      if (missing.length) throw new Error(`Missing media: ${missing.map((m) => m.name).join(', ')}. Relink before exporting.`);
      if (project.video.segments.length === 0) throw new Error('Add a video to the timeline before exporting.');
      send(win, { type: 'progress', jobId: id, frame: 0, total: 0, fps: 0, phase: 'video' });
      const { frames } = await buildPlanInWorker(project, outputPath, planFile);
      if (job.cancelled) throw new Error('cancelled');
      job.helper = startHelper('studio-render', ['export', planFile], (m) => {
        if (m.type === 'progress') {
          send(win, { type: 'progress', jobId: id, frame: Number(m.frame ?? 0), total: Number(m.total ?? frames), fps: Number(m.fps ?? 0), phase: (m.phase as 'video') ?? 'video' });
        }
      });
      const res = await job.helper.done;
      if (job.cancelled || !res.path) throw new Error('cancelled');
      const bytes = existsSync(outputPath) ? statSync(outputPath).size : 0;
      allowFile(outputPath); // so the editor can play back the result
      send(win, { type: 'done', jobId: id, path: outputPath, bytes, seconds: (Date.now() - started) / 1000 });
    } catch (e) {
      if (job.cancelled) send(win, { type: 'cancelled', jobId: id });
      else send(win, { type: 'error', jobId: id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      rmSync(planFile, { force: true });
      jobs.delete(id);
    }
  })();
  return id;
}

export function cancelExport(id: string) {
  const job = jobs.get(id);
  if (!job) return;
  job.cancelled = true;
  job.helper?.send('cancel');
  setTimeout(() => job.helper?.kill(), 3000);
}

export function cancelAllExports() {
  for (const id of jobs.keys()) cancelExport(id);
}

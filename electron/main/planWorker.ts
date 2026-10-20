import { writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { buildRenderPlan } from '../../shared/renderPlan';

try {
  const { project, outputPath, planFile } = workerData;
  const plan = buildRenderPlan(project, outputPath);
  writeFileSync(planFile, JSON.stringify(plan));
  parentPort!.postMessage({ ok: true, frames: plan.frameCount });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}

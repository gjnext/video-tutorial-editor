import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(__dirname, '../..');
export const BIN = path.join(ROOT, 'native/.build/release');
export const FIXTURES = path.join(ROOT, 'tests/fixtures');
export const OUT = path.join(ROOT, 'tests/.output');
mkdirSync(OUT, { recursive: true });

export const nativeAvailable = existsSync(path.join(BIN, 'studio-render')) && existsSync(path.join(BIN, 'studio-fixtures'));

/** Run a helper and return its final `result` message (NDJSON protocol). */
export function runHelper(bin: string, args: string[], timeoutMs = 600_000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    execFile(path.join(BIN, bin), args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      const lines = stdout.split('\n').filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: 'log', message: l };
        }
      });
      const errMsg = lines.find((l) => l.type === 'error');
      const result = lines.reverse().find((l) => l.type === 'result');
      if (errMsg) return reject(new Error(`${bin} ${args[0]}: ${errMsg.message}\n${stderr}`));
      if (err && !result) return reject(new Error(`${bin} ${args[0]} failed: ${err.message}\n${stderr}`));
      resolve(result ?? {});
    });
  });
}

export async function ensureFixtures() {
  const v = path.join(FIXTURES, 'saas-8s.mp4');
  const a = path.join(FIXTURES, 'narration-18s.wav');
  if (!existsSync(v)) await runHelper('studio-fixtures', ['video', v, '8', '1920', '1200', '30']);
  if (!existsSync(a)) await runHelper('studio-fixtures', ['audio', a, '18', '1,4,10', '44100', '1']);
  return { video: v, audio: a };
}

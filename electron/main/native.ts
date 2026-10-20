/**
 * Supervised native helper processes speaking NDJSON on stdout
 * (shared/ipc.ts HelperMessage). Arguments are passed as an argv array —
 * never through a shell — so file names cannot inject commands.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { helperPath } from './paths';
import type { HelperMessage } from '../../shared/ipc';

export class HelperError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

const running = new Set<ChildProcessWithoutNullStreams>();

export interface HelperHandle {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the `result` message, rejects with HelperError. */
  done: Promise<Record<string, unknown>>;
  send(line: string): void;
  kill(): void;
}

export function startHelper(
  name: 'studio-render' | 'studio-recorder',
  args: string[],
  onMessage?: (m: HelperMessage) => void,
): HelperHandle {
  const bin = helperPath(name);
  if (!existsSync(bin)) {
    throw new HelperError(`Native helper missing: ${bin}. Run "npm run build:native".`, 'helper-missing');
  }
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  let buf = '';
  let result: Record<string, unknown> | null = null;
  let error: HelperError | null = null;
  let stderr = '';
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: HelperMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'result') result = msg as Record<string, unknown>;
        else if (msg.type === 'error') error = new HelperError(String(msg.message), msg.code);
        onMessage?.(msg);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on('error', (e) => reject(new HelperError(`Could not start ${name}: ${e.message}`, 'spawn')));
    child.on('close', (code, signal) => {
      running.delete(child);
      if (error) return reject(error);
      if (result) return resolve(result);
      if (signal) return reject(new HelperError(`${name} was terminated (${signal}).`, 'terminated'));
      reject(new HelperError(`${name} exited unexpectedly (code ${code}). ${stderr.trim().split('\n').pop() ?? ''}`, 'crash'));
    });
  });
  // Avoid unhandled-rejection noise when callers only use events.
  done.catch(() => {});
  return {
    child,
    done,
    send: (line: string) => {
      if (!child.stdin.destroyed) child.stdin.write(line + '\n');
    },
    kill: () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}

export function runHelper(name: 'studio-render' | 'studio-recorder', args: string[], timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const h = startHelper(name, args);
  const timer = setTimeout(() => h.kill(), timeoutMs);
  return h.done.finally(() => clearTimeout(timer));
}

/** Terminate every helper (app quit). */
export function killAllHelpers() {
  for (const c of running) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

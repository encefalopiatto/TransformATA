import { Worker } from 'node:worker_threads';
import type { EvalResult } from '@transformata/shared';

/**
 * JSONata evaluation isolated in a worker thread so a runaway expression can
 * be hard-terminated without blocking the main event loop.
 *
 * The cooperative `Promise.race` timeout used elsewhere does NOT actually
 * interrupt a synchronous/CPU-bound JSONata evaluation — the single event
 * loop stays blocked until the expression returns, which is a denial-of-service
 * vector on the (unauthenticated) admin + pipeline surfaces. Running the
 * evaluation in a worker lets us `worker.terminate()` a stuck evaluation.
 *
 * The worker source is inlined (`eval: true`) so this works identically under
 * `tsx` (no compiled sibling file on disk) and under `node dist/…`. `require`
 * inside the worker resolves `jsonata` from the same module graph as the main
 * process.
 */
const SRC = `const { parentPort, workerData } = require('node:worker_threads');
(async () => { try { const jsonata = require('jsonata');
  const out = await jsonata(workerData.expression).evaluate(workerData.input);
  parentPort.postMessage({ ok: true, output: out === undefined ? null : out });
} catch (e) { parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) }); } })();`;

/**
 * Evaluate a JSONata expression against `input` in an isolated worker thread,
 * hard-terminating it after `timeoutMs`. Never throws; always resolves to a
 * typed EvalResult. `undefined` results are normalized to `null`.
 */
export function evaluateIsolated(
  expression: string,
  input: unknown,
  timeoutMs: number,
): Promise<EvalResult> {
  return new Promise<EvalResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let worker: Worker;

    const settle = (result: EvalResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Always tear the worker down on settle (success, error, or timeout).
      void worker?.terminate();
      resolve(result);
    };

    try {
      worker = new Worker(SRC, { eval: true, workerData: { expression, input } });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    timer = setTimeout(() => {
      settle({ ok: false, error: `evaluation timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    worker.on('message', (msg: EvalResult) => settle(msg));
    worker.on('error', (err: Error) => settle({ ok: false, error: err.message }));
    worker.on('exit', (code) => {
      if (code !== 0) settle({ ok: false, error: `evaluation worker exited with code ${code}` });
    });
  });
}

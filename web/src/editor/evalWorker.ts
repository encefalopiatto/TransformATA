/**
 * Preview evaluation worker.
 *
 * Runs a JSONata expression against a sample input off the main thread so a
 * runaway expression (infinite recursion, huge map) cannot freeze the editor
 * tab. The main thread races the reply against a hard timeout and, on timeout,
 * calls worker.terminate() to kill the runaway and respawns a fresh worker.
 */
import { evaluateExpression, type EvalResult } from '@transformata/shared';

export interface EvalRequest {
  expression: string;
  input: unknown;
}

// The web tsconfig uses the DOM lib (no webworker lib); cast so `onmessage`
// and single-argument `postMessage` typecheck in this module context.
const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<EvalRequest>) => {
  const { expression, input } = event.data;
  void evaluateExpression(expression, input).then((result: EvalResult) => {
    ctx.postMessage(result);
  });
};

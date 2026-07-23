import jsonata from 'jsonata';
import type { EvalResult } from './types.js';

/**
 * Evaluate a JSONata expression against an input document, with a timeout.
 * Never throws; returns a typed result. Used by the web editor for live
 * preview and by the server for test endpoints.
 */
export async function evaluateExpression(
  expression: string,
  input: unknown,
  timeoutMs = 10_000,
): Promise<EvalResult> {
  let expr: ReturnType<typeof jsonata>;
  try {
    expr = jsonata(expression);
  } catch (err) {
    return { ok: false, error: `JSONata syntax error: ${message(err)}` };
  }
  try {
    const output = await Promise.race([
      expr.evaluate(input),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`evaluation timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    // JSONata returns undefined for "no match"; normalize to null so the
    // result is JSON-serializable.
    return { ok: true, output: output === undefined ? null : output };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

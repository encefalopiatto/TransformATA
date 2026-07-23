import { evaluateExpression } from '@transformata/shared';
import type { EvalResult } from '@transformata/shared';
import { getSettings } from './settings.js';

/**
 * Evaluate a JSONata expression with the configured timeout, returning the
 * typed EvalResult (never throws).
 */
export async function evalJsonata(expression: string, input: unknown): Promise<EvalResult> {
  return evaluateExpression(expression, input, getSettings().evaluateTimeoutMs);
}

/**
 * Evaluate a JSONata expression with the configured timeout; throws an Error
 * with the evaluation/syntax problem on failure. `undefined` results are
 * normalized to `null` by the shared helper.
 */
export async function runJsonata(expression: string, input: unknown): Promise<unknown> {
  const result = await evalJsonata(expression, input);
  if (!result.ok) throw new Error(result.error);
  return result.output;
}

import type { EvalResult } from '@transformata/shared';
import { evaluateIsolated } from './jsonata-worker.js';
import { getSettings } from './settings.js';

/**
 * Evaluate a JSONata expression with the configured timeout, returning the
 * typed EvalResult (never throws).
 *
 * Evaluation runs in an isolated worker thread (see `jsonata-worker.ts`) so a
 * runaway expression is hard-terminated at the timeout instead of blocking the
 * main event loop. This is the single choke point for ALL server-side
 * evaluation: the pipeline engine (routing match + normalize/transform/
 * denormalize), the admin `POST /api/admin/evaluate` route, and the admin
 * funnel-test path all go through here.
 */
export async function evalJsonata(expression: string, input: unknown): Promise<EvalResult> {
  return evaluateIsolated(expression, input, getSettings().evaluateTimeoutMs);
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

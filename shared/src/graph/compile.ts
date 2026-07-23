import type { TGraph, CompileResult } from '../types.js';

/**
 * Compile a visual node graph into a JSONata expression.
 *
 * STUB — the real implementation lives here after the editor/compiler module
 * is built. Emit rules for every node type are specified in
 * docs/GRAPH_NODES.md.
 */
export function compileGraph(_graph: TGraph): CompileResult {
  return { ok: false, errors: [{ message: 'graph compiler not implemented yet' }] };
}

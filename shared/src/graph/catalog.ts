/**
 * NODE_CATALOG — data-driven metadata for every visual-editor node type
 * (including one entry per stringOp / numberOp / compare op).
 *
 * Both the graph compiler (`compile.ts`) and the editor UI (palette, node
 * rendering, inspector) are driven by this catalog so they can never
 * disagree about which inputs a node has or which ones are required.
 *
 * Emit rules live in docs/GRAPH_NODES.md (normative).
 */
import type {
  CompareOp,
  GraphNodeType,
  NumberOp,
  StringOp,
} from '../types.js';

export type NodeCategory =
  | 'Source'
  | 'Structure'
  | 'Arrays'
  | 'Text'
  | 'Numbers'
  | 'Logic'
  | 'Advanced';

/** Static description of one input handle of a node. */
export interface HandleSpec {
  /**
   * Handle id as used in edge `targetHandle`. For dynamic handles this is
   * the prefix ('key', 'item', 'in') — concrete ids are `key:<name>` /
   * `item:<i>` / `in:<i>`, resolved by `resolveInputHandles`.
   */
  name: string;
  label: string;
  required: boolean;
  /** True when the concrete handle list depends on node data (keys/count). */
  dynamic?: boolean;
}

/** A concrete input handle resolved against a node's current data. */
export interface ResolvedHandle {
  id: string;
  label: string;
  required: boolean;
}

export interface NodeSpec {
  /** Unique catalog key: the node type, or `<type>:<op>` for op variants. */
  key: string;
  type: GraphNodeType;
  /** Set for stringOp / numberOp / compare variants. */
  op?: StringOp | NumberOp | CompareOp;
  label: string;
  category: NodeCategory;
  /** Short, non-technical explanation shown in the palette / inspector. */
  help: string;
  inputs: HandleSpec[];
  /** Whether the node has an output (source) handle. */
  hasOutput: boolean;
  /** Data payload a freshly created node starts with. */
  defaultData: Record<string, unknown>;
}

const inReq: HandleSpec = { name: 'in', label: 'in', required: true };
const ab: HandleSpec[] = [
  { name: 'a', label: 'a', required: true },
  { name: 'b', label: 'b', required: true },
];

export const NODE_CATALOG: NodeSpec[] = [
  /* ------------------------------ Source ------------------------------ */
  {
    key: 'input',
    type: 'input',
    label: 'Input',
    category: 'Source',
    help: 'The whole input document. Safe to use anywhere, even inside a map or filter.',
    inputs: [],
    hasOutput: true,
    defaultData: {},
  },
  {
    key: 'item',
    type: 'item',
    label: 'Current item',
    category: 'Source',
    help: 'The current element while looping. Only meaningful inside a subtree wired into a Map "each" or Filter "condition" input.',
    inputs: [],
    hasOutput: true,
    defaultData: {},
  },
  {
    key: 'path',
    type: 'path',
    label: 'Field path',
    category: 'Source',
    help: 'Reads a field, e.g. "order.number" or "rows[0].sku". Wire something into "in" to read from it; leave unwired to read from the current context.',
    inputs: [{ name: 'in', label: 'in', required: false }],
    hasOutput: true,
    defaultData: { path: '' },
  },
  {
    key: 'literal',
    type: 'literal',
    label: 'Constant',
    category: 'Source',
    help: 'A fixed value: text, number, true/false, or any JSON.',
    inputs: [],
    hasOutput: true,
    defaultData: { value: '' },
  },

  /* ----------------------------- Structure ---------------------------- */
  {
    key: 'object',
    type: 'object',
    label: 'Build object',
    category: 'Structure',
    help: 'Builds an object. Add a key for every field and wire a value into each. Unwired keys are left out.',
    inputs: [{ name: 'key', label: 'key', required: false, dynamic: true }],
    hasOutput: true,
    defaultData: { keys: ['key1'] },
  },
  {
    key: 'array',
    type: 'array',
    label: 'Build array',
    category: 'Structure',
    help: 'Builds a list from the wired slots, in order. Unwired slots are left out.',
    inputs: [{ name: 'item', label: 'item', required: false, dynamic: true }],
    hasOutput: true,
    defaultData: { count: 2 },
  },

  /* ------------------------------ Arrays ------------------------------ */
  {
    key: 'map',
    type: 'map',
    label: 'Map (for each)',
    category: 'Arrays',
    help: 'Transforms every element of a list. Wire the list into "array" and what each element should become into "each" (use Current item inside).',
    inputs: [
      { name: 'array', label: 'array', required: true },
      { name: 'each', label: 'each', required: true },
    ],
    hasOutput: true,
    defaultData: {},
  },
  {
    key: 'filter',
    type: 'filter',
    label: 'Filter',
    category: 'Arrays',
    help: 'Keeps only the list elements for which the condition is true (use Current item inside the condition).',
    inputs: [
      { name: 'array', label: 'array', required: true },
      { name: 'predicate', label: 'condition', required: true },
    ],
    hasOutput: true,
    defaultData: {},
  },
  {
    key: 'sort',
    type: 'sort',
    label: 'Sort',
    category: 'Arrays',
    help: 'Sorts a list. Set "by" to a field path to sort objects by that field; leave empty to sort plain values.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { by: '', descending: false },
  },
  {
    key: 'distinct',
    type: 'distinct',
    label: 'Distinct',
    category: 'Arrays',
    help: 'Removes duplicate values from a list.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: {},
  },

  /* ------------------------------- Text ------------------------------- */
  {
    key: 'stringOp:concat',
    type: 'stringOp',
    op: 'concat',
    label: 'Concatenate',
    category: 'Text',
    help: 'Joins several texts into one, in slot order.',
    inputs: [{ name: 'in', label: 'in', required: false, dynamic: true }],
    hasOutput: true,
    defaultData: { op: 'concat', count: 2 },
  },
  {
    key: 'stringOp:uppercase',
    type: 'stringOp',
    op: 'uppercase',
    label: 'Uppercase',
    category: 'Text',
    help: 'Converts text to UPPER CASE.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'uppercase' },
  },
  {
    key: 'stringOp:lowercase',
    type: 'stringOp',
    op: 'lowercase',
    label: 'Lowercase',
    category: 'Text',
    help: 'Converts text to lower case.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'lowercase' },
  },
  {
    key: 'stringOp:trim',
    type: 'stringOp',
    op: 'trim',
    label: 'Trim',
    category: 'Text',
    help: 'Removes surrounding whitespace and collapses inner whitespace.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'trim' },
  },
  {
    key: 'stringOp:substring',
    type: 'stringOp',
    op: 'substring',
    label: 'Substring',
    category: 'Text',
    help: 'Takes part of a text: from position "start" (0-based), optionally limited to "length" characters.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'substring', start: 0 },
  },
  {
    key: 'stringOp:replace',
    type: 'stringOp',
    op: 'replace',
    label: 'Replace',
    category: 'Text',
    help: 'Replaces every occurrence of a text with another.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'replace', pattern: '', replacement: '' },
  },
  {
    key: 'stringOp:split',
    type: 'stringOp',
    op: 'split',
    label: 'Split',
    category: 'Text',
    help: 'Splits a text into a list at every separator.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'split', separator: ',' },
  },
  {
    key: 'stringOp:join',
    type: 'stringOp',
    op: 'join',
    label: 'Join',
    category: 'Text',
    help: 'Joins a list of texts into one, with a separator between elements.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'join', separator: ',' },
  },
  {
    key: 'stringOp:toString',
    type: 'stringOp',
    op: 'toString',
    label: 'To text',
    category: 'Text',
    help: 'Converts any value to text.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'toString' },
  },

  /* ------------------------------ Numbers ----------------------------- */
  ...(
    [
      ['add', 'Add', 'a + b'],
      ['subtract', 'Subtract', 'a − b'],
      ['multiply', 'Multiply', 'a × b'],
      ['divide', 'Divide', 'a ÷ b'],
      ['modulo', 'Modulo', 'remainder of a ÷ b'],
    ] as const
  ).map(
    ([op, label, desc]): NodeSpec => ({
      key: `numberOp:${op}`,
      type: 'numberOp',
      op,
      label,
      category: 'Numbers',
      help: `Calculates ${desc}.`,
      inputs: ab,
      hasOutput: true,
      defaultData: { op },
    }),
  ),
  {
    key: 'numberOp:round',
    type: 'numberOp',
    op: 'round',
    label: 'Round',
    category: 'Numbers',
    help: 'Rounds a number, optionally to a set number of decimal places.',
    inputs: [inReq],
    hasOutput: true,
    defaultData: { op: 'round', precision: 2 },
  },
  ...(
    [
      ['floor', 'Floor', 'Rounds a number down to the nearest whole number.'],
      ['ceil', 'Ceiling', 'Rounds a number up to the nearest whole number.'],
      ['abs', 'Absolute', 'Removes the sign of a number (|-5| = 5).'],
      ['sum', 'Sum', 'Adds up all numbers in a list.'],
      ['max', 'Maximum', 'The largest number in a list.'],
      ['min', 'Minimum', 'The smallest number in a list.'],
      ['average', 'Average', 'The average of all numbers in a list.'],
      ['count', 'Count', 'How many elements a list has.'],
      ['toNumber', 'To number', 'Converts text like "12.5" into the number 12.5.'],
    ] as const
  ).map(
    ([op, label, help]): NodeSpec => ({
      key: `numberOp:${op}`,
      type: 'numberOp',
      op,
      label,
      category: 'Numbers',
      help,
      inputs: [inReq],
      hasOutput: true,
      defaultData: { op },
    }),
  ),

  /* ------------------------------- Logic ------------------------------ */
  ...(
    [
      ['eq', 'Equals', 'True when a equals b.'],
      ['ne', 'Not equal', 'True when a differs from b.'],
      ['gt', 'Greater than', 'True when a > b.'],
      ['gte', 'Greater or equal', 'True when a ≥ b.'],
      ['lt', 'Less than', 'True when a < b.'],
      ['lte', 'Less or equal', 'True when a ≤ b.'],
      ['and', 'And', 'True when both a and b are true.'],
      ['or', 'Or', 'True when a or b (or both) are true.'],
      ['in', 'Is in list', 'True when value a appears in list b.'],
    ] as const
  ).map(
    ([op, label, help]): NodeSpec => ({
      key: `compare:${op}`,
      type: 'compare',
      op,
      label,
      category: 'Logic',
      help,
      inputs: ab,
      hasOutput: true,
      defaultData: { op },
    }),
  ),
  {
    key: 'compare:not',
    type: 'compare',
    op: 'not',
    label: 'Not',
    category: 'Logic',
    help: 'Inverts a true/false value.',
    inputs: [{ name: 'a', label: 'a', required: true }],
    hasOutput: true,
    defaultData: { op: 'not' },
  },
  {
    key: 'condition',
    type: 'condition',
    label: 'If / then / else',
    category: 'Logic',
    help: 'Picks "then" when the "if" input is true, otherwise "else" (or nothing when "else" is unwired).',
    inputs: [
      { name: 'if', label: 'if', required: true },
      { name: 'then', label: 'then', required: true },
      { name: 'else', label: 'else', required: false },
    ],
    hasOutput: true,
    defaultData: {},
  },
  {
    key: 'lookup',
    type: 'lookup',
    label: 'Lookup table',
    category: 'Logic',
    help: 'Translates a value using a fixed table (e.g. "DE" → "Germany"). The optional default is used when the key is not found.',
    inputs: [{ name: 'key', label: 'key', required: true }],
    hasOutput: true,
    defaultData: { table: {} },
  },

  /* ------------------------------ Advanced ---------------------------- */
  {
    key: 'raw',
    type: 'raw',
    label: 'JSONata expression',
    category: 'Advanced',
    help: 'Hand-written JSONata for anything the other blocks cannot do. Optionally wire a context in — the expression then runs against the wired context; if the context is a list it runs once per item (JSONata "." semantics).',
    inputs: [{ name: 'context', label: 'context', required: false }],
    hasOutput: true,
    defaultData: { expression: '$' },
  },
  {
    key: 'output',
    type: 'output',
    label: 'Output',
    category: 'Advanced',
    help: 'The result of the mapping. Every graph needs exactly one Output node.',
    inputs: [{ name: 'in', label: 'result', required: true }],
    hasOutput: false,
    defaultData: {},
  },
];

const byKey = new Map(NODE_CATALOG.map((s) => [s.key, s]));

/** Look up a catalog entry by its unique key (e.g. "stringOp:concat"). */
export function specByKey(key: string): NodeSpec | undefined {
  return byKey.get(key);
}

/**
 * Find the catalog entry for a node instance: plain type for most nodes,
 * `<type>:<data.op>` for stringOp / numberOp / compare.
 */
export function specForNode(
  type: GraphNodeType,
  data: Record<string, unknown>,
): NodeSpec | undefined {
  if (type === 'stringOp' || type === 'numberOp' || type === 'compare') {
    const op = typeof data.op === 'string' ? data.op : '';
    return byKey.get(`${type}:${op}`);
  }
  return byKey.get(type);
}

function clampCount(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, Math.min(32, n));
}

/**
 * Resolve the concrete input handles of a node given its current data —
 * expands dynamic handles (object keys, array/concat slots).
 */
export function resolveInputHandles(
  type: GraphNodeType,
  data: Record<string, unknown>,
): ResolvedHandle[] {
  const spec = specForNode(type, data);
  if (!spec) return [];
  const handles: ResolvedHandle[] = [];
  for (const input of spec.inputs) {
    if (!input.dynamic) {
      handles.push({ id: input.name, label: input.label, required: input.required });
      continue;
    }
    if (type === 'object') {
      const keys = Array.isArray(data.keys) ? data.keys : [];
      for (const key of keys) {
        if (typeof key !== 'string') continue;
        handles.push({ id: `key:${key}`, label: key, required: false });
      }
    } else {
      // array ('item:<i>') and stringOp concat ('in:<i>')
      const count = clampCount(data.count, 2);
      for (let i = 0; i < count; i++) {
        handles.push({ id: `${input.name}:${i}`, label: `${input.label} ${i + 1}`, required: false });
      }
    }
  }
  return handles;
}

/** Palette grouping order. */
export const CATEGORY_ORDER: NodeCategory[] = [
  'Source',
  'Structure',
  'Arrays',
  'Text',
  'Numbers',
  'Logic',
  'Advanced',
];

/**
 * Graph → JSONata compiler. Emit rules per node type are specified in
 * docs/GRAPH_NODES.md (normative). Pure TypeScript — no DOM, no React Flow;
 * runs in the browser (live compile in the editor) and under vitest.
 */
import jsonata from 'jsonata';
import type {
  CompileResult,
  GraphIssue,
  TGraph,
  TGraphEdge,
  TGraphNode,
} from '../types.js';
import { resolveInputHandles, specForNode } from './catalog.js';

export * from './catalog.js';

/* ------------------------------ helpers ------------------------------ */

/**
 * Syntax-check a JSONata expression without evaluating it.
 * Returns null when the expression parses, otherwise the parser message.
 * Used by the editor for live feedback on raw nodes / code mode.
 */
export function jsonataSyntaxError(expression: string): string | null {
  try {
    jsonata(expression);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Extract a human-readable message from a thrown value. jsonata throws plain
 * objects (not Error instances) that carry a string `message` (and `code`),
 * so `String(err)` would yield "[object Object]".
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Human-readable node reference for error messages. */
function describe(node: TGraphNode): string {
  const spec = specForNode(node.type, node.data);
  return spec ? `${spec.label} node` : `${node.type} node`;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Compile a stored dot-path (`rows[0].partner`) into JSONata path syntax.
 * Segments that are not plain identifiers are backtick-quoted. Returns null
 * (after pushing an error) when the path is invalid.
 */
function compilePath(
  path: string,
  node: TGraphNode,
  what: string,
  errors: GraphIssue[],
): string | null {
  const fail = (message: string): null => {
    errors.push({ nodeId: node.id, message: `${describe(node)}: ${message}` });
    return null;
  };
  if (path.trim() === '') return fail(`${what} is empty`);
  if (path.startsWith('$')) {
    return fail(`${what} must not start with "$" — wire an Input or Current item node instead`);
  }
  const parts: string[] = [];
  for (const segment of path.split('.')) {
    if (segment === '') return fail(`${what} "${path}" has an empty segment`);
    const m = /^(.*?)((?:\[\d+\])*)$/.exec(segment);
    const base = m ? m[1] : segment;
    const indexes = m ? m[2] : '';
    if (base === '') return fail(`${what} "${path}" has a segment with only an index`);
    // `true`/`false`/`null` match IDENT_RE but are JSONata keyword literals, so
    // a bare segment would read as the boolean/null value, not the field.
    const reserved = base === 'true' || base === 'false' || base === 'null';
    if (IDENT_RE.test(base) && !reserved) {
      parts.push(base + indexes);
    } else if (base.includes('`')) {
      return fail(`${what} "${path}" contains a backtick, which is not allowed`);
    } else {
      parts.push('`' + base + '`' + indexes);
    }
  }
  return parts.join('.');
}

/** Serialize a literal JSON value into a JSONata-safe expression. */
function literalExpr(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value);
  const text = json === undefined ? 'null' : json;
  // Number/boolean/null literals must be parenthesized so they can be wired
  // into a path chain (e.g. `5.foo` is a JSONata parse error but `(5).foo`
  // parses). String/object/array literals (`"..."`, `{...}`, `[...]`) are safe.
  const first = text[0];
  const needsParens = first !== '"' && first !== '{' && first !== '[';
  return needsParens ? `(${text})` : text;
}

/* ------------------------------ compile ------------------------------ */

interface Ctx {
  nodeMap: Map<string, TGraphNode>;
  /** target node id → target handle → source node id */
  incoming: Map<string, Map<string, string>>;
  errors: GraphIssue[];
  warnings: GraphIssue[];
  memo: Map<string, string>;
  visiting: Set<string>;
}

/**
 * Compile a visual node graph into a JSONata expression.
 * Never throws; all problems are reported as issues per docs/GRAPH_NODES.md.
 */
export function compileGraph(graph: TGraph): CompileResult {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];

  const nodeMap = new Map<string, TGraphNode>();
  for (const node of graph.nodes) {
    if (nodeMap.has(node.id)) {
      errors.push({ nodeId: node.id, message: `Duplicate node id "${node.id}"` });
    }
    nodeMap.set(node.id, node);
  }

  // Index incoming edges; enforce at most one edge per (node, targetHandle).
  const incoming: Ctx['incoming'] = new Map();
  for (const edge of graph.edges as TGraphEdge[]) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) {
      warnings.push({ message: `A connection references a deleted node and is ignored` });
      continue;
    }
    const handle = edge.targetHandle;
    if (!handle) {
      warnings.push({
        nodeId: edge.target,
        message: `A connection into ${describe(nodeMap.get(edge.target)!)} names no input and is ignored`,
      });
      continue;
    }
    let handles = incoming.get(edge.target);
    if (!handles) {
      handles = new Map();
      incoming.set(edge.target, handles);
    }
    if (handles.has(handle)) {
      errors.push({
        nodeId: edge.target,
        message: `Input "${handle}" of ${describe(nodeMap.get(edge.target)!)} has more than one incoming connection`,
      });
    } else {
      handles.set(handle, edge.source);
    }
  }

  // Exactly one output node.
  const outputs = graph.nodes.filter((n) => n.type === 'output');
  if (outputs.length === 0) {
    errors.push({ message: 'The graph has no Output node — add one and wire the result into it' });
    return { ok: false, errors };
  }
  if (outputs.length > 1) {
    for (const node of outputs) {
      errors.push({
        nodeId: node.id,
        message: `Found ${outputs.length} Output nodes — a graph must have exactly one`,
      });
    }
    return { ok: false, errors };
  }
  const output = outputs[0];

  // Reachability (walking backwards from the output along incoming edges).
  const reachable = new Set<string>([output.id]);
  const stack = [output.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const handles = incoming.get(id);
    if (!handles) continue;
    for (const sourceId of handles.values()) {
      if (!reachable.has(sourceId)) {
        reachable.add(sourceId);
        stack.push(sourceId);
      }
    }
  }
  const unreached = graph.nodes.filter((n) => !reachable.has(n.id)).length;
  if (unreached > 0) {
    warnings.push({ message: `${unreached} unconnected node(s) are ignored` });
  }

  const ctx: Ctx = { nodeMap, incoming, errors, warnings, memo: new Map(), visiting: new Set() };
  const expression = emitNode(output, ctx);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, expression, warnings };
}

/**
 * Validate a graph and return its issues (errors when invalid, warnings
 * otherwise) without exposing the compiled expression.
 */
export function validateGraph(graph: TGraph): GraphIssue[] {
  const result = compileGraph(graph);
  return result.ok ? result.warnings : result.errors;
}

/** Emit with memoization + cycle detection (DFS from the output node). */
function emitNode(node: TGraphNode, ctx: Ctx): string {
  const memoized = ctx.memo.get(node.id);
  if (memoized !== undefined) return memoized;
  if (ctx.visiting.has(node.id)) {
    ctx.errors.push({
      nodeId: node.id,
      message: `Cycle detected: ${describe(node)} ("${node.id}") feeds into itself`,
    });
    return 'null';
  }
  ctx.visiting.add(node.id);
  const expr = emitInner(node, ctx);
  ctx.visiting.delete(node.id);
  ctx.memo.set(node.id, expr);
  return expr;
}

/** Emitted expression of the node wired into `handle`, or undefined. */
function wired(node: TGraphNode, handle: string, ctx: Ctx): string | undefined {
  const sourceId = ctx.incoming.get(node.id)?.get(handle);
  if (sourceId === undefined) return undefined;
  const source = ctx.nodeMap.get(sourceId);
  return source ? emitNode(source, ctx) : undefined;
}

/** Emitted expression of a required input; error + "null" when unwired. */
function required(node: TGraphNode, handle: string, label: string, ctx: Ctx): string {
  const expr = wired(node, handle, ctx);
  if (expr === undefined) {
    ctx.errors.push({
      nodeId: node.id,
      message: `Required input "${label}" of ${describe(node)} is not connected`,
    });
    return 'null';
  }
  return expr;
}

/** Warn about edges wired into handles the node does not (or no longer) have. */
function warnUnknownHandles(node: TGraphNode, ctx: Ctx): void {
  const handles = ctx.incoming.get(node.id);
  if (!handles) return;
  const known = new Set(resolveInputHandles(node.type, node.data).map((h) => h.id));
  for (const handle of handles.keys()) {
    if (!known.has(handle)) {
      ctx.warnings.push({
        nodeId: node.id,
        message: `A connection into unknown input "${handle}" of ${describe(node)} is ignored`,
      });
    }
  }
}

const NUMBER_BINARY: Record<string, string> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  modulo: '%',
};
const NUMBER_FN: Record<string, string> = {
  floor: '$floor',
  ceil: '$ceil',
  abs: '$abs',
  sum: '$sum',
  max: '$max',
  min: '$min',
  average: '$average',
  count: '$count',
  toNumber: '$number',
};
const COMPARE_BINARY: Record<string, string> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  and: 'and',
  or: 'or',
  in: 'in',
};
const STRING_FN: Record<string, string> = {
  uppercase: '$uppercase',
  lowercase: '$lowercase',
  trim: '$trim',
  toString: '$string',
};

function emitInner(node: TGraphNode, ctx: Ctx): string {
  const { errors, warnings } = ctx;
  const data = node.data ?? {};
  const err = (message: string): string => {
    errors.push({ nodeId: node.id, message });
    return 'null';
  };
  warnUnknownHandles(node, ctx);

  switch (node.type) {
    case 'input':
      return '$$';

    case 'item':
      return '$';

    case 'path': {
      const compiled = compilePath(readString(data, 'path') ?? '', node, 'Path', errors);
      if (compiled === null) return 'null';
      const base = wired(node, 'in', ctx);
      return base === undefined ? compiled : `${base}.${compiled}`;
    }

    case 'literal':
      return literalExpr(data.value);

    case 'object': {
      const keys = Array.isArray(data.keys)
        ? data.keys.filter((k): k is string => typeof k === 'string')
        : [];
      const seen = new Set<string>();
      const entries: string[] = [];
      for (const key of keys) {
        if (key === '') {
          errors.push({ nodeId: node.id, message: 'Build object node has an empty key name' });
          continue;
        }
        if (seen.has(key)) {
          errors.push({ nodeId: node.id, message: `Build object node has duplicate key "${key}"` });
          continue;
        }
        seen.add(key);
        const value = wired(node, `key:${key}`, ctx);
        if (value === undefined) {
          warnings.push({
            nodeId: node.id,
            message: `Key "${key}" has no incoming connection and is omitted`,
          });
          continue;
        }
        entries.push(`${JSON.stringify(key)}: ${value}`);
      }
      return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
    }

    case 'array': {
      const count = typeof data.count === 'number' && Number.isFinite(data.count)
        ? Math.max(0, Math.floor(data.count))
        : 2;
      const items: string[] = [];
      for (let i = 0; i < count; i++) {
        const item = wired(node, `item:${i}`, ctx);
        if (item === undefined) {
          warnings.push({
            nodeId: node.id,
            message: `Slot ${i + 1} of Build array node has no incoming connection and is omitted`,
          });
          continue;
        }
        items.push(item);
      }
      return `[${items.join(', ')}]`;
    }

    case 'map': {
      const array = required(node, 'array', 'array', ctx);
      const each = required(node, 'each', 'each', ctx);
      // $map (not `.`) so that a per-item array result is not flattened across
      // items; `$i.(each)` keeps `$` = the current item for the each subtree.
      // The outer [...] forces an array and prevents single-element collapse.
      return `[$map(${array}, function($i){ $i.(${each}) })]`;
    }

    case 'filter': {
      const array = required(node, 'array', 'array', ctx);
      const predicate = required(node, 'predicate', 'condition', ctx);
      // $boolean() so a non-boolean predicate (e.g. a numeric field) is a truth
      // test, not JSONata positional index selection.
      return `[(${array})[$boolean(${predicate})]]`;
    }

    case 'sort': {
      const input = required(node, 'in', 'in', ctx);
      const by = readString(data, 'by') ?? '';
      const descending = data.descending === true;
      if (by.trim() === '') {
        return descending ? `$reverse($sort(${input}))` : `$sort(${input})`;
      }
      const byPath = compilePath(by, node, 'Sort field', errors);
      if (byPath === null) return 'null';
      const cmp = descending ? '<' : '>';
      return `$sort(${input}, function($l, $r) { $l.${byPath} ${cmp} $r.${byPath} })`;
    }

    case 'distinct':
      return `$distinct(${required(node, 'in', 'in', ctx)})`;

    case 'stringOp': {
      const op = readString(data, 'op') ?? '';
      if (op === 'concat') {
        const count = typeof data.count === 'number' && Number.isFinite(data.count)
          ? Math.max(0, Math.floor(data.count))
          : 2;
        const parts: string[] = [];
        for (let i = 0; i < count; i++) {
          const part = wired(node, `in:${i}`, ctx);
          if (part === undefined) {
            warnings.push({
              nodeId: node.id,
              message: `Slot ${i + 1} of Concatenate node has no incoming connection and is omitted`,
            });
            continue;
          }
          parts.push(part);
        }
        if (parts.length === 0) return '""';
        return `(${parts.join(' & ')})`;
      }
      const fn = STRING_FN[op];
      if (fn) return `${fn}(${required(node, 'in', 'in', ctx)})`;
      if (op === 'substring') {
        const input = required(node, 'in', 'in', ctx);
        const start = readNumber(data, 'start') ?? 0;
        const length = readNumber(data, 'length');
        return length === undefined
          ? `$substring(${input}, ${start})`
          : `$substring(${input}, ${start}, ${length})`;
      }
      if (op === 'replace') {
        const input = required(node, 'in', 'in', ctx);
        const pattern = readString(data, 'pattern');
        if (pattern === undefined || pattern === '') {
          return err('Replace node needs a non-empty "find" text');
        }
        const replacement = readString(data, 'replacement') ?? '';
        return `$replace(${input}, ${JSON.stringify(pattern)}, ${JSON.stringify(replacement)})`;
      }
      if (op === 'split' || op === 'join') {
        const input = required(node, 'in', 'in', ctx);
        const separator = readString(data, 'separator') ?? ',';
        return `$${op}(${input}, ${JSON.stringify(separator)})`;
      }
      return err(`Unknown text operation "${op}"`);
    }

    case 'numberOp': {
      const op = readString(data, 'op') ?? '';
      const binary = NUMBER_BINARY[op];
      if (binary) {
        const a = required(node, 'a', 'a', ctx);
        const b = required(node, 'b', 'b', ctx);
        return `(${a} ${binary} ${b})`;
      }
      if (op === 'round') {
        const input = required(node, 'in', 'in', ctx);
        const precision = readNumber(data, 'precision');
        return precision === undefined
          ? `$round(${input})`
          : `$round(${input}, ${precision})`;
      }
      const fn = NUMBER_FN[op];
      if (fn) return `${fn}(${required(node, 'in', 'in', ctx)})`;
      return err(`Unknown number operation "${op}"`);
    }

    case 'compare': {
      const op = readString(data, 'op') ?? '';
      if (op === 'not') return `$not(${required(node, 'a', 'a', ctx)})`;
      const symbol = COMPARE_BINARY[op];
      if (!symbol) return err(`Unknown comparison "${op}"`);
      const a = required(node, 'a', 'a', ctx);
      const b = required(node, 'b', 'b', ctx);
      return `(${a} ${symbol} ${b})`;
    }

    case 'condition': {
      const cond = required(node, 'if', 'if', ctx);
      const then = required(node, 'then', 'then', ctx);
      const otherwise = wired(node, 'else', ctx) ?? 'null';
      return `(${cond} ? ${then} : ${otherwise})`;
    }

    case 'lookup': {
      const key = required(node, 'key', 'key', ctx);
      const rawTable = data.table;
      if (rawTable === null || typeof rawTable !== 'object' || Array.isArray(rawTable)) {
        return err('Lookup table node has no table — add at least one row');
      }
      const table = JSON.stringify(rawTable);
      const fallback = readString(data, 'default');
      if (fallback === undefined) {
        return `$lookup(${table}, $string(${key}))`;
      }
      return `($lv := $lookup(${table}, $string(${key})); $exists($lv) ? $lv : ${JSON.stringify(fallback)})`;
    }

    case 'raw': {
      const expression = readString(data, 'expression') ?? '';
      if (expression.trim() === '') {
        return err('JSONata expression node is empty');
      }
      const syntax = jsonataSyntaxError(expression);
      if (syntax !== null) {
        return err(`JSONata expression node has a syntax error: ${syntax}`);
      }
      const context = wired(node, 'context', ctx);
      return context === undefined ? `(${expression})` : `((${context}).(${expression}))`;
    }

    case 'output':
      return required(node, 'in', 'result', ctx);

    default:
      return err(`Unknown node type "${String(node.type)}"`);
  }
}

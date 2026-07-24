import { describe, expect, it } from 'vitest';
import type { GraphNodeType, TGraph, TGraphEdge, TGraphNode } from '../types.js';
import { evaluateExpression } from '../evaluate.js';
import { compileGraph, jsonataSyntaxError } from './compile.js';

/* ------------------------------ helpers ------------------------------ */

let edgeSeq = 0;

function n(
  id: string,
  type: GraphNodeType,
  data: Record<string, unknown> = {},
): TGraphNode {
  return { id, type, position: { x: 0, y: 0 }, data };
}

/** e('a -> b.in') — edge from node a into handle "in" of node b. */
function e(spec: string): TGraphEdge {
  const m = /^(\S+) -> (\S+?)\.(.+)$/.exec(spec);
  if (!m) throw new Error(`bad edge spec: ${spec}`);
  return { id: `e${edgeSeq++}`, source: m[1], target: m[2], targetHandle: m[3] };
}

function graph(nodes: TGraphNode[], edges: TGraphEdge[]): TGraph {
  return { nodes, edges };
}

function compileOk(g: TGraph): { expression: string; warnings: { nodeId?: string; message: string }[] } {
  const result = compileGraph(g);
  if (!result.ok) {
    throw new Error(`expected ok compile, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

async function evalOk(expression: string, input: unknown): Promise<unknown> {
  const result = await evaluateExpression(expression, input);
  if (!result.ok) throw new Error(`evaluation failed: ${result.error}`);
  return result.output;
}

function errorsOf(g: TGraph): { nodeId?: string; message: string }[] {
  const result = compileGraph(g);
  if (result.ok) throw new Error(`expected compile errors, got: ${result.expression}`);
  return result.errors;
}

/* ----------------------- docs/GRAPH_NODES.md example ------------------ */

const csvInput = {
  rows: [
    { order_id: 'SO-1042', sku: 'AC-330', qty: '2', unit_price: '149.00', status: 'open' },
    { order_id: 'SO-1042', sku: 'AC-101', qty: '1', unit_price: '79.50', status: 'open' },
    { order_id: 'SO-1042', sku: 'AC-777', qty: '5', unit_price: '12.00', status: 'cancelled' },
  ],
};

describe('compileGraph — full example from docs/GRAPH_NODES.md', () => {
  const g = graph(
    [
      n('in', 'input'),
      n('rows', 'path', { path: 'rows' }),
      n('flt', 'filter'),
      n('status', 'path', { path: 'status' }),
      n('cancelled', 'literal', { value: 'cancelled' }),
      n('ne', 'compare', { op: 'ne' }),
      n('mp', 'map'),
      n('obj', 'object', { keys: ['sku', 'total'] }),
      n('sku', 'path', { path: 'sku' }),
      n('qty', 'path', { path: 'qty' }),
      n('price', 'path', { path: 'unit_price' }),
      n('numQty', 'numberOp', { op: 'toNumber' }),
      n('numPrice', 'numberOp', { op: 'toNumber' }),
      n('mul', 'numberOp', { op: 'multiply' }),
      n('out', 'output'),
    ],
    [
      e('in -> rows.in'),
      e('rows -> flt.array'),
      e('status -> ne.a'),
      e('cancelled -> ne.b'),
      e('ne -> flt.predicate'),
      e('flt -> mp.array'),
      e('obj -> mp.each'),
      e('sku -> obj.key:sku'),
      e('qty -> numQty.in'),
      e('price -> numPrice.in'),
      e('numQty -> mul.a'),
      e('numPrice -> mul.b'),
      e('mul -> obj.key:total'),
      e('mp -> out.in'),
    ],
  );

  it('compiles to the specced expression', () => {
    const { expression, warnings } = compileOk(g);
    expect(expression).toBe(
      '[$map([($$.rows)[$boolean((status != "cancelled"))]], function($i){ $i.({ "sku": sku, "total": ($number(qty) * $number(unit_price)) }) })]',
    );
    expect(warnings).toEqual([]);
  });

  it('evaluates against the CSV sample', async () => {
    const { expression } = compileOk(g);
    await expect(evalOk(expression, csvInput)).resolves.toEqual([
      { sku: 'AC-330', total: 298 },
      { sku: 'AC-101', total: 79.5 },
    ]);
  });
});

/* --------------------------- structure nodes -------------------------- */

describe('object / array building', () => {
  it('omits unwired object keys with a warning', async () => {
    const g = graph(
      [
        n('in', 'input'),
        n('name', 'path', { path: 'name' }),
        n('obj', 'object', { keys: ['who', 'missing'] }),
        n('out', 'output'),
      ],
      [e('in -> name.in'), e('name -> obj.key:who'), e('obj -> out.in')],
    );
    const { expression, warnings } = compileOk(g);
    expect(expression).toBe('{ "who": $$.name }');
    expect(warnings).toEqual([
      { nodeId: 'obj', message: 'Key "missing" has no incoming connection and is omitted' },
    ]);
    await expect(evalOk(expression, { name: 'Ada' })).resolves.toEqual({ who: 'Ada' });
  });

  it('omits unwired array slots with a warning', async () => {
    const g = graph(
      [
        n('a', 'literal', { value: 1 }),
        n('b', 'literal', { value: 'two' }),
        n('arr', 'array', { count: 3 }),
        n('out', 'output'),
      ],
      [e('a -> arr.item:0'), e('b -> arr.item:2'), e('arr -> out.in')],
    );
    const { expression, warnings } = compileOk(g);
    expect(expression).toBe('[(1), "two"]');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ nodeId: 'arr' });
    await expect(evalOk(expression, {})).resolves.toEqual([1, 'two']);
  });

  it('quotes non-identifier path segments with backticks', async () => {
    const g = graph(
      [n('in', 'input'), n('p', 'path', { path: 'weird name.ok' }), n('out', 'output')],
      [e('in -> p.in'), e('p -> out.in')],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe('$$.`weird name`.ok');
    await expect(evalOk(expression, { 'weird name': { ok: 42 } })).resolves.toBe(42);
  });
});

/* ------------------------------ condition ----------------------------- */

describe('condition', () => {
  function conditionGraph(withElse: boolean): TGraph {
    const nodes = [
      n('in', 'input'),
      n('flag', 'path', { path: 'ok' }),
      n('yes', 'literal', { value: 'YES' }),
      n('no', 'literal', { value: 'NO' }),
      n('cond', 'condition'),
      n('out', 'output'),
    ];
    const edges = [
      e('in -> flag.in'),
      e('flag -> cond.if'),
      e('yes -> cond.then'),
      e('cond -> out.in'),
    ];
    if (withElse) edges.push(e('no -> cond.else'));
    return graph(nodes, edges);
  }

  it('with else', async () => {
    const { expression } = compileOk(conditionGraph(true));
    expect(expression).toBe('($$.ok ? "YES" : "NO")');
    await expect(evalOk(expression, { ok: true })).resolves.toBe('YES');
    await expect(evalOk(expression, { ok: false })).resolves.toBe('NO');
  });

  it('without else falls back to null', async () => {
    const g = conditionGraph(false);
    const { expression, warnings } = compileOk(g);
    expect(expression).toBe('($$.ok ? "YES" : null)');
    // "1 unconnected node(s)" for the unused NO literal
    expect(warnings).toEqual([{ message: '1 unconnected node(s) are ignored' }]);
    await expect(evalOk(expression, { ok: false })).resolves.toBe(null);
  });
});

/* ------------------------------- lookup ------------------------------- */

describe('lookup', () => {
  const table = { ACME: 'ACME Industrial Corp.', GLOBEX: 'Globex Corporation' };

  function lookupGraph(withDefault: boolean): TGraph {
    return graph(
      [
        n('in', 'input'),
        n('code', 'path', { path: 'partner' }),
        n('lk', 'lookup', withDefault ? { table, default: 'Unknown partner' } : { table }),
        n('out', 'output'),
      ],
      [e('in -> code.in'), e('code -> lk.key'), e('lk -> out.in')],
    );
  }

  it('without default emits plain $lookup', async () => {
    const { expression } = compileOk(lookupGraph(false));
    expect(expression).toBe(`$lookup(${JSON.stringify(table)}, $string($$.partner))`);
    await expect(evalOk(expression, { partner: 'ACME' })).resolves.toBe('ACME Industrial Corp.');
    await expect(evalOk(expression, { partner: 'NOPE' })).resolves.toBe(null);
  });

  it('with default uses the variable-binding form', async () => {
    const { expression } = compileOk(lookupGraph(true));
    expect(expression).toBe(
      `($lv := $lookup(${JSON.stringify(table)}, $string($$.partner)); $exists($lv) ? $lv : "Unknown partner")`,
    );
    await expect(evalOk(expression, { partner: 'GLOBEX' })).resolves.toBe('Globex Corporation');
    await expect(evalOk(expression, { partner: 'NOPE' })).resolves.toBe('Unknown partner');
  });
});

/* -------------------------------- sort -------------------------------- */

describe('sort', () => {
  const items = [{ sku: 'B', qty: 1 }, { sku: 'A', qty: 5 }, { sku: 'C', qty: 3 }];

  it('by field, descending', async () => {
    const g = graph(
      [
        n('in', 'input'),
        n('lines', 'path', { path: 'lines' }),
        n('srt', 'sort', { by: 'qty', descending: true }),
        n('out', 'output'),
      ],
      [e('in -> lines.in'), e('lines -> srt.in'), e('srt -> out.in')],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe('$sort($$.lines, function($l, $r) { $l.qty < $r.qty })');
    await expect(evalOk(expression, { lines: items })).resolves.toEqual([
      { sku: 'A', qty: 5 },
      { sku: 'C', qty: 3 },
      { sku: 'B', qty: 1 },
    ]);
  });

  it('without by, ascending and descending', async () => {
    const asc = compileOk(
      graph(
        [n('in', 'input'), n('v', 'path', { path: 'values' }), n('s', 'sort', {}), n('out', 'output')],
        [e('in -> v.in'), e('v -> s.in'), e('s -> out.in')],
      ),
    ).expression;
    expect(asc).toBe('$sort($$.values)');
    await expect(evalOk(asc, { values: [3, 1, 2] })).resolves.toEqual([1, 2, 3]);

    const desc = compileOk(
      graph(
        [
          n('in', 'input'),
          n('v', 'path', { path: 'values' }),
          n('s', 'sort', { descending: true }),
          n('out', 'output'),
        ],
        [e('in -> v.in'), e('v -> s.in'), e('s -> out.in')],
      ),
    ).expression;
    expect(desc).toBe('$reverse($sort($$.values))');
    await expect(evalOk(desc, { values: [3, 1, 2] })).resolves.toEqual([3, 2, 1]);
  });
});

/* ----------------------------- string ops ----------------------------- */

describe('string ops', () => {
  it('concat + substring + replace pipeline', async () => {
    // $replace($substring((first & " " & last), 0, 8), " ", "_")
    const g = graph(
      [
        n('in', 'input'),
        n('first', 'path', { path: 'first' }),
        n('space', 'literal', { value: ' ' }),
        n('last', 'path', { path: 'last' }),
        n('cat', 'stringOp', { op: 'concat', count: 3 }),
        n('sub', 'stringOp', { op: 'substring', start: 0, length: 8 }),
        n('rep', 'stringOp', { op: 'replace', pattern: ' ', replacement: '_' }),
        n('out', 'output'),
      ],
      [
        e('in -> first.in'),
        e('in -> last.in'),
        e('first -> cat.in:0'),
        e('space -> cat.in:1'),
        e('last -> cat.in:2'),
        e('cat -> sub.in'),
        e('sub -> rep.in'),
        e('rep -> out.in'),
      ],
    );
    const { expression, warnings } = compileOk(g);
    expect(expression).toBe(
      '$replace($substring(($$.first & " " & $$.last), 0, 8), " ", "_")',
    );
    expect(warnings).toEqual([]);
    await expect(evalOk(expression, { first: 'Grace', last: 'Hopper' })).resolves.toBe('Grace_Ho');
  });

  it('concat warns about unwired slots', async () => {
    const g = graph(
      [n('a', 'literal', { value: 'x' }), n('cat', 'stringOp', { op: 'concat', count: 2 }), n('out', 'output')],
      [e('a -> cat.in:0'), e('cat -> out.in')],
    );
    const { expression, warnings } = compileOk(g);
    expect(expression).toBe('("x")');
    expect(warnings).toEqual([
      { nodeId: 'cat', message: 'Slot 2 of Concatenate node has no incoming connection and is omitted' },
    ]);
    await expect(evalOk(expression, {})).resolves.toBe('x');
  });
});

/* ----------------------------- number ops ----------------------------- */

describe('number aggregation', () => {
  it('rounds the sum of a mapped amount', async () => {
    // $round($sum([$map($$.lines, function($i){ $i.((qty * price)) })]), 2)
    const g = graph(
      [
        n('in', 'input'),
        n('lines', 'path', { path: 'lines' }),
        n('mp', 'map'),
        n('qty', 'path', { path: 'qty' }),
        n('price', 'path', { path: 'price' }),
        n('mul', 'numberOp', { op: 'multiply' }),
        n('sum', 'numberOp', { op: 'sum' }),
        n('rnd', 'numberOp', { op: 'round', precision: 2 }),
        n('out', 'output'),
      ],
      [
        e('in -> lines.in'),
        e('lines -> mp.array'),
        e('qty -> mul.a'),
        e('price -> mul.b'),
        e('mul -> mp.each'),
        e('mp -> sum.in'),
        e('sum -> rnd.in'),
        e('rnd -> out.in'),
      ],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe(
      '$round($sum([$map($$.lines, function($i){ $i.((qty * price)) })]), 2)',
    );
    await expect(
      evalOk(expression, { lines: [{ qty: 3, price: 0.5 }, { qty: 2, price: 0.407 }] }),
    ).resolves.toBe(2.31);
  });
});

/* -------------------------------- raw --------------------------------- */

describe('raw node', () => {
  it('without context wraps the expression verbatim', async () => {
    const g = graph(
      [n('r', 'raw', { expression: '$sum(lines.qty)' }), n('out', 'output')],
      [e('r -> out.in')],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe('($sum(lines.qty))');
    await expect(evalOk(expression, { lines: [{ qty: 2 }, { qty: 3 }] })).resolves.toBe(5);
  });

  it('with context evaluates against the wired context', async () => {
    const g = graph(
      [
        n('in', 'input'),
        n('order', 'path', { path: 'order' }),
        n('r', 'raw', { expression: '$uppercase(number)' }),
        n('out', 'output'),
      ],
      [e('in -> order.in'), e('order -> r.context'), e('r -> out.in')],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe('(($$.order).($uppercase(number)))');
    await expect(evalOk(expression, { order: { number: 'po-1' } })).resolves.toBe('PO-1');
  });
});

/* ---------------- regression: compiler/eval defect fixes -------------- */

describe('map does not flatten per-item array results', () => {
  it('nested map preserves nesting', async () => {
    // groups -> map(each = items -> map(each = name))  ==>  [["a","b"],["c"]]
    const g = graph(
      [
        n('in', 'input'),
        n('groups', 'path', { path: 'groups' }),
        n('outer', 'map'),
        n('items', 'path', { path: 'items' }),
        n('inner', 'map'),
        n('name', 'path', { path: 'name' }),
        n('out', 'output'),
      ],
      [
        e('in -> groups.in'),
        e('groups -> outer.array'),
        e('items -> inner.array'),
        e('name -> inner.each'),
        e('inner -> outer.each'),
        e('outer -> out.in'),
      ],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe(
      '[$map($$.groups, function($i){ $i.([$map(items, function($i){ $i.(name) })]) })]',
    );
    await expect(
      evalOk(expression, {
        groups: [{ items: [{ name: 'a' }, { name: 'b' }] }, { items: [{ name: 'c' }] }],
      }),
    ).resolves.toEqual([['a', 'b'], ['c']]);
  });

  it('map -> object yields one object per element', async () => {
    const g = graph(
      [
        n('in', 'input'),
        n('rows', 'path', { path: 'rows' }),
        n('mp', 'map'),
        n('obj', 'object', { keys: ['sku'] }),
        n('sku', 'path', { path: 'sku' }),
        n('out', 'output'),
      ],
      [
        e('in -> rows.in'),
        e('rows -> mp.array'),
        e('sku -> obj.key:sku'),
        e('obj -> mp.each'),
        e('mp -> out.in'),
      ],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe(
      '[$map($$.rows, function($i){ $i.({ "sku": sku }) })]',
    );
    await expect(
      evalOk(expression, { rows: [{ sku: 'A' }, { sku: 'B' }] }),
    ).resolves.toEqual([{ sku: 'A' }, { sku: 'B' }]);
  });
});

describe('filter uses $boolean, not positional indexing', () => {
  it('keeps rows whose numeric field is truthy', async () => {
    const g = graph(
      [
        n('in', 'input'),
        n('rows', 'path', { path: 'rows' }),
        n('flt', 'filter'),
        n('qty', 'path', { path: 'qty' }),
        n('out', 'output'),
      ],
      [
        e('in -> rows.in'),
        e('rows -> flt.array'),
        e('qty -> flt.predicate'),
        e('flt -> out.in'),
      ],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe('[($$.rows)[$boolean(qty)]]');
    await expect(
      evalOk(expression, {
        rows: [{ qty: 0, n: 'a' }, { qty: 5, n: 'b' }, { qty: 2, n: 'c' }],
      }),
    ).resolves.toEqual([{ qty: 5, n: 'b' }, { qty: 2, n: 'c' }]);
  });
});

describe('reserved-word path segment', () => {
  it('reads a field literally named "true"', async () => {
    const g = graph(
      [n('in', 'input'), n('p', 'path', { path: 'true' }), n('out', 'output')],
      [e('in -> p.in'), e('p -> out.in')],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe('$$.`true`');
    await expect(evalOk(expression, { true: 42 })).resolves.toBe(42);
  });
});

describe('number-literal wired into a path', () => {
  it('parenthesizes so the path chain parses', async () => {
    const g = graph(
      [n('five', 'literal', { value: 5 }), n('p', 'path', { path: 'foo' }), n('out', 'output')],
      [e('five -> p.in'), e('p -> out.in')],
    );
    const { expression } = compileOk(g);
    expect(expression).toBe('(5).foo');
    // A number has no field "foo"; the point is it PARSES and evaluates (to
    // null) rather than being the `5.foo` parse error the old emit produced.
    expect(jsonataSyntaxError('5.foo')).not.toBeNull();
    expect(jsonataSyntaxError('(5).foo')).toBeNull();
    await expect(evalOk(expression, {})).resolves.toBe(null);
  });
});

/* ---------------------------- error cases ----------------------------- */

describe('error cases', () => {
  it('no output node', () => {
    const errors = errorsOf(graph([n('a', 'input')], []));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/no Output node/i);
  });

  it('two output nodes', () => {
    const errors = errorsOf(
      graph(
        [n('a', 'literal', { value: 1 }), n('o1', 'output'), n('o2', 'output')],
        [e('a -> o1.in'), e('a -> o2.in')],
      ),
    );
    expect(errors).toHaveLength(2);
    expect(errors.map((err) => err.nodeId).sort()).toEqual(['o1', 'o2']);
    expect(errors[0].message).toMatch(/exactly one/);
  });

  it('cycle reachable from the output', () => {
    const errors = errorsOf(
      graph(
        [
          n('u', 'stringOp', { op: 'uppercase' }),
          n('l', 'stringOp', { op: 'lowercase' }),
          n('out', 'output'),
        ],
        [e('u -> l.in'), e('l -> u.in'), e('l -> out.in')],
      ),
    );
    expect(errors.some((err) => /cycle/i.test(err.message))).toBe(true);
    const cycleError = errors.find((err) => /cycle/i.test(err.message))!;
    expect(['u', 'l']).toContain(cycleError.nodeId);
  });

  it('missing required input carries the nodeId', () => {
    const errors = errorsOf(
      graph([n('mp', 'map'), n('out', 'output')], [e('mp -> out.in')]),
    );
    expect(errors).toHaveLength(2); // both "array" and "each" unwired
    for (const error of errors) {
      expect(error.nodeId).toBe('mp');
      expect(error.message).toMatch(/Required input/);
    }
  });

  it('invalid raw expression is a node error', () => {
    const errors = errorsOf(
      graph(
        [n('r', 'raw', { expression: 'this is (not valid' }), n('out', 'output')],
        [e('r -> out.in')],
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].nodeId).toBe('r');
    expect(errors[0].message).toMatch(/syntax error/i);
  });

  it('raw syntax error reports a real message, not [object Object]', () => {
    // jsonata throws a plain object (not an Error) carrying a string message.
    const errors = errorsOf(
      graph(
        [n('r', 'raw', { expression: '$x := ' }), n('out', 'output')],
        [e('r -> out.in')],
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].nodeId).toBe('r');
    expect(errors[0].message).not.toContain('[object Object]');
    expect(errors[0].message).toContain('Unexpected end of expression');
    // The exported syntax-check helper must extract the message too.
    expect(jsonataSyntaxError('$x := ')).toBe('Unexpected end of expression');
  });

  it('output with nothing wired in', () => {
    const errors = errorsOf(graph([n('out', 'output')], []));
    expect(errors).toEqual([
      { nodeId: 'out', message: 'Required input "result" of Output node is not connected' },
    ]);
  });
});

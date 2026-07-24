# Visual graph → JSONata: node catalog and emit rules

The visual editor produces a `TGraph` (nodes + edges, shapes in
`shared/src/types.ts`). `compileGraph(graph)` in `shared/src/graph/compile.ts`
turns it into a JSONata expression string. This document is the normative
spec for both the compiler and the editor UI.

## General rules

- Exactly **one `output` node** is required; compilation starts there and
  walks backwards along edges. Zero or multiple output nodes ⇒ error.
- The graph must be a DAG; a cycle reachable from the output ⇒ error
  naming one node on the cycle.
- Every edge's `targetHandle` names the input it feeds (handles listed per
  node below). At most one edge per (node, targetHandle) — the editor must
  enforce this by replacing the existing edge on reconnect.
- A required input with no incoming edge ⇒ error `{ nodeId, message }`.
  Optional inputs are noted per node.
- Nodes not reachable from the output node are ignored, but produce a
  warning ("N unconnected node(s) are ignored").
- **Emission**: `emit(node)` returns an expression string. Sub-expressions
  are wrapped in parentheses wherever ambiguity is possible (the rules below
  show the exact templates; `E(x)` means the emitted, already-parenthesized
  expression of the node wired to input `x`). Prefer correctness over pretty
  output; a `format` helper may insert newlines for readability but must not
  change semantics.
- String values embedded into expressions (paths excepted) are serialized
  with `JSON.stringify` (JSONata string literals are JSON-compatible).
- **Paths** (`path`, `sort.by`): a dot-separated field path, each segment
  matching `/^[A-Za-z_][A-Za-z0-9_]*$/` or a numeric array index like `[0]`
  appended to a segment (e.g. `rows[0].partner`). Segments that don't match
  the identifier pattern must be emitted backtick-quoted (`` `weird name` ``).
  The segments `true`, `false` and `null` match the identifier pattern but are
  JSONata keyword literals, so they too must be backtick-quoted (`` `true` ``)
  to read a field of that name rather than the boolean/null value.
  A leading `$` is not allowed in the stored path (context is expressed by
  wiring, not by the path text).

## Evaluation context

At the top level of a mapping, JSONata's context `$` is the input document.
Inside `map`/`filter` sub-expressions, `$` is the current array item. The
graph mirrors this:

- `input` always refers to the **document root** (`$$`) — safe at any depth.
- `item` refers to the **current item** (`$`) and is only meaningful in a
  subtree wired (possibly transitively) into a `map.each` or
  `filter.predicate` input. The compiler does not fully validate scoping in
  v1; the editor palette explains this, and a misplaced `item` simply
  evaluates like `$` at that point.

## Node catalog

### Source

| type | inputs | data | emit |
|---|---|---|---|
| `input` | — | — | `$$` |
| `item` | — | — | `$` |
| `path` | `in` (optional) | `{ path }` | wired: `E(in).<path>` · unwired: `<path>` (context-relative) |
| `literal` | — | `{ value }` | `JSON.stringify(value)` for string/object/array literals; number, boolean and `null` literals are parenthesized (`(5)`, `(true)`, `(null)`) so they can be safely wired into a path chain (`5.foo` is a parse error, `(5).foo` parses) |

### Structure

| type | inputs | data | emit |
|---|---|---|---|
| `object` | one handle per key: `key:<name>` | `{ keys: string[] }` | `{ "k1": E(key:k1), ... }` — **unwired keys are omitted** with a warning |
| `array` | `item:0` … `item:<count-1>` | `{ count }` | `[E(item:0), E(item:1), ...]` — unwired slots omitted with a warning |

### Arrays

| type | inputs | data | emit |
|---|---|---|---|
| `map` | `array` (req), `each` (req) | — | array-valued `each` (map/filter/array/sort/distinct/split): `[$map(E(array), function($i){ $i.(E(each)) })]`; otherwise `[(E(array)).(E(each))]` |
| `filter` | `array` (req), `predicate` (req) | — | `[(E(array))[$boolean(E(predicate))]]` |
| `sort` | `in` (req) | `{ by?, descending? }` | with `by`, asc: `$sort(E(in), function($l, $r) { $l.<by> > $r.<by> })`; desc: `<` instead of `>`. Without `by`, asc: `$sort(E(in))`; desc: `$reverse($sort(E(in)))` |
| `distinct` | `in` (req) | — | `$distinct(E(in))` |

Notes: the outer `[...]` wrapper on map/filter keeps the result an array even
for single-element results (JSONata sequence flattening). `map` chooses its
step by whether `each` yields an array:

- **array-valued `each`** (its source node is a map/filter/array/sort/distinct
  or a split string op) uses `$map(E(array), function($i){ $i.(E(each)) })` so
  each per-item array stays a distinct element — nested maps preserve nesting
  (`[["a","b"],["c"]]`) instead of `.` flattening them together.
- **every other `each`** (scalar, object, aggregation, path, …) uses
  `(E(array)).(E(each))`, whose `.` binds `$` to the whole element — correct
  even when the element is itself an array (e.g. summing an array-valued item),
  which the `$map`/`$i.(each)` form would wrongly descend into.

Both keep `$` = the current item for the `each` subtree, so `item` nodes emit
`$` and relative paths stay bare. `filter` wraps the predicate in
`$boolean(...)` so a non-boolean predicate (e.g. a numeric field) is evaluated
as a truth test rather than as JSONata positional index selection. Inside
`each` / `predicate` subtrees, `item` = the current element and relative `path`
nodes (unwired `in`) resolve against it.

### Text (`stringOp`, data `{ op, ... }`)

| op | inputs | data | emit |
|---|---|---|---|
| `concat` | `in:0` … `in:<count-1>` (default count 2) | `{ count? }` | `(E(in:0) & E(in:1) & ...)` — unwired slots omitted with warning |
| `uppercase` / `lowercase` / `trim` | `in` | — | `$uppercase(E(in))` / `$lowercase(E(in))` / `$trim(E(in))` |
| `substring` | `in` | `{ start, length? }` | `$substring(E(in), <start>[, <length>])` |
| `replace` | `in` | `{ pattern, replacement }` | `$replace(E(in), <pattern>, <replacement>)` (both JSON-stringified) |
| `split` | `in` | `{ separator }` | `$split(E(in), <separator>)` |
| `join` | `in` | `{ separator }` | `$join(E(in), <separator>)` |
| `toString` | `in` | — | `$string(E(in))` |

### Numbers (`numberOp`, data `{ op, ... }`)

| op | inputs | emit |
|---|---|---|
| `add` / `subtract` / `multiply` / `divide` / `modulo` | `a`, `b` | `(E(a) + E(b))` with `- * / %` |
| `round` | `in` | `$round(E(in)[, <precision>])` |
| `floor` / `ceil` / `abs` | `in` | `$floor(E(in))` / `$ceil(E(in))` / `$abs(E(in))` |
| `sum` / `max` / `min` / `average` / `count` | `in` (array) | `$sum(E(in))` etc. / `$count(E(in))` |
| `toNumber` | `in` | `$number(E(in))` |

### Logic

| type | inputs | data | emit |
|---|---|---|---|
| `compare` `eq/ne/gt/gte/lt/lte` | `a`, `b` | `{ op }` | `(E(a) = E(b))` with `!= > >= < <=` |
| `compare` `and` / `or` | `a`, `b` | | `(E(a) and E(b))` / `(E(a) or E(b))` |
| `compare` `not` | `a` | | `$not(E(a))` |
| `compare` `in` | `a`, `b` | | `(E(a) in E(b))` |
| `condition` | `if` (req), `then` (req), `else` (opt) | — | `(E(if) ? E(then) : E(else))`; no else: `(E(if) ? E(then) : null)` |
| `lookup` | `key` (req) | `{ table, default? }` | with default: `($lv := $lookup(<table>, $string(E(key))); $exists($lv) ? $lv : <default>)`; without: `$lookup(<table>, $string(E(key)))` — `<table>` is the JSON-stringified object |

### Advanced

| type | inputs | data | emit |
|---|---|---|---|
| `raw` | `context` (optional) | `{ expression }` | wired: `((E(context)).(<expression>))` · unwired: `(<expression>)` — expression inserted verbatim; compiler validates it parses with `jsonata()` and reports syntax errors as node errors. When wired, the expression runs against the wired context; if that context is a list it runs once per item (JSONata `.` semantics) |
| `output` | `in` (req) | — | `E(in)` — the graph's result |

## Example

"For each CSV row that isn't cancelled, emit `{sku, total}`; result is the
array" — nodes:

```
input ─(in)─ path[rows] ─(array)─ filter ─(array)─ map ─(in)─ output
   literal["cancelled"] ─(b)─ compare[ne] ─(predicate)─ filter
   path[status] (unwired in) ─(a)─ compare[ne]
   map.each ◄─ object{sku, total}
     path[sku] (unwired) ─(key:sku)─ object
     path[qty]→toNumber ─(a)─ multiply; path[unit_price]→toNumber ─(b)─ multiply ─(key:total)─ object
```

compiles to (whitespace aside):

```jsonata
[$map([($$.rows)[$boolean((status != "cancelled"))]], function($i){ $i.({ "sku": sku, "total": ($number(qty) * $number(unit_price)) }) })]
```

## Compiler API

```ts
compileGraph(graph: TGraph): CompileResult
// { ok: true, expression, warnings: GraphIssue[] }
// { ok: false, errors: GraphIssue[] }   // every error carries nodeId when attributable
```

The compiler must be pure (no DOM, no React Flow imports) — it runs in the
browser and under vitest in `shared`.

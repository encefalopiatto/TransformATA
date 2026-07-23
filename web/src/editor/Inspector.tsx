/** Right-hand inspector: edits the selected node's data, driven by NODE_CATALOG. */
import { useMemo, useState } from 'react';
import type { CompareOp, NumberOp, StringOp } from '@transformata/shared';
import {
  NODE_CATALOG,
  jsonataSyntaxError,
  specForNode,
  type NodeSpec,
} from '@transformata/shared';
import type { TfaFlowNode } from './graphFlow';

export interface InspectorProps {
  node: TfaFlowNode | null;
  /** Merge a patch into the node's data. */
  onSetCfg: (id: string, patch: Record<string, unknown>) => void;
  /** Replace the node's data entirely (used when switching ops). */
  onReplaceCfg: (id: string, cfg: Record<string, unknown>) => void;
  /** Rename an object key, rewiring its edge to the new handle. */
  onRenameKey: (id: string, oldKey: string, newKey: string) => void;
  onDelete: (id: string) => void;
}

const PATH_HINT =
  'Dot-separated fields, e.g. order.number or rows[0].sku. No leading $ — wire an Input node instead.';

export function Inspector({ node, onSetCfg, onReplaceCfg, onRenameKey, onDelete }: InspectorProps) {
  if (!node) {
    return (
      <aside className="tfa-ed-inspector">
        <div className="tfa-ed-inspector-empty">
          Select a node on the canvas to edit its settings.
        </div>
      </aside>
    );
  }
  const spec = specForNode(node.data.kind, node.data.cfg);
  return (
    <aside className="tfa-ed-inspector" key={node.id}>
      <div className="tfa-ed-inspector-head">
        <div className="tfa-ed-inspector-title">{spec?.label ?? node.data.kind}</div>
        {spec && <p className="tfa-ed-inspector-help">{spec.help}</p>}
      </div>
      <NodeFields
        node={node}
        onSetCfg={onSetCfg}
        onReplaceCfg={onReplaceCfg}
        onRenameKey={onRenameKey}
      />
      <div className="tfa-ed-inspector-footer">
        <button type="button" className="btn danger sm" onClick={() => onDelete(node.id)}>
          Delete node
        </button>
      </div>
    </aside>
  );
}

function NodeFields({
  node,
  onSetCfg,
  onReplaceCfg,
  onRenameKey,
}: Omit<InspectorProps, 'onDelete' | 'node'> & { node: TfaFlowNode }) {
  const { kind } = node.data;
  const cfg = node.data.cfg;
  const set = (patch: Record<string, unknown>) => onSetCfg(node.id, patch);

  switch (kind) {
    case 'path':
      return (
        <Field label="Path" hint={PATH_HINT}>
          <input
            type="text"
            value={typeof cfg.path === 'string' ? cfg.path : ''}
            placeholder="e.g. order.number"
            onChange={(e) => set({ path: e.target.value })}
          />
        </Field>
      );

    case 'literal':
      return <LiteralEditor value={cfg.value} onChange={(value) => set({ value })} />;

    case 'object':
      return (
        <ObjectKeysEditor
          keys={Array.isArray(cfg.keys) ? cfg.keys.filter((k): k is string => typeof k === 'string') : []}
          onSetKeys={(keys) => set({ keys })}
          onRename={(oldKey, newKey) => onRenameKey(node.id, oldKey, newKey)}
        />
      );

    case 'array':
      return (
        <CountStepper
          label="Slots"
          count={typeof cfg.count === 'number' ? cfg.count : 2}
          onChange={(count) => set({ count })}
          hint="Wire one value into each slot. Unwired slots are left out of the list."
        />
      );

    case 'stringOp':
      return (
        <>
          <OpSelect
            kind="stringOp"
            current={typeof cfg.op === 'string' ? cfg.op : ''}
            onPick={(picked) => onReplaceCfg(node.id, structuredClone(picked.defaultData))}
          />
          <StringOpFields op={cfg.op as StringOp} cfg={cfg} set={set} />
        </>
      );

    case 'numberOp':
      return (
        <>
          <OpSelect
            kind="numberOp"
            current={typeof cfg.op === 'string' ? cfg.op : ''}
            onPick={(picked) => onReplaceCfg(node.id, structuredClone(picked.defaultData))}
          />
          {(cfg.op as NumberOp) === 'round' && (
            <Field label="Decimal places" hint="Leave empty to round to a whole number.">
              <OptionalNumberInput
                value={typeof cfg.precision === 'number' ? cfg.precision : undefined}
                onChange={(precision) => set({ precision })}
              />
            </Field>
          )}
        </>
      );

    case 'compare':
      return (
        <OpSelect
          kind="compare"
          current={typeof cfg.op === 'string' ? cfg.op : ''}
          onPick={(picked) => onReplaceCfg(node.id, structuredClone(picked.defaultData))}
        />
      );

    case 'lookup':
      return (
        <LookupEditor
          table={
            cfg.table && typeof cfg.table === 'object' && !Array.isArray(cfg.table)
              ? (cfg.table as Record<string, string>)
              : {}
          }
          fallback={typeof cfg.default === 'string' ? cfg.default : undefined}
          onChange={(table, fallback) =>
            onReplaceCfg(node.id, fallback === undefined ? { table } : { table, default: fallback })
          }
        />
      );

    case 'sort':
      return (
        <>
          <Field label="Sort by (field path)" hint="Leave empty to sort plain values directly.">
            <input
              type="text"
              value={typeof cfg.by === 'string' ? cfg.by : ''}
              placeholder="e.g. qty"
              onChange={(e) => set({ by: e.target.value })}
            />
          </Field>
          <label className="tfa-ed-check">
            <input
              type="checkbox"
              checked={cfg.descending === true}
              onChange={(e) => set({ descending: e.target.checked })}
            />
            Descending (largest first)
          </label>
        </>
      );

    case 'raw':
      return (
        <RawEditor
          expression={typeof cfg.expression === 'string' ? cfg.expression : ''}
          onChange={(expression) => set({ expression })}
        />
      );

    default:
      // input / item / map / filter / distinct / condition / output need no data.
      return <p className="tfa-ed-inspector-note">This node has no settings — just wire it up.</p>;
  }
}

/* ------------------------------ primitives ---------------------------- */

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="tfa-ed-field">
      <label>{label}</label>
      {children}
      {error ? (
        <span className="tfa-ed-field-error">{error}</span>
      ) : hint ? (
        <span className="tfa-ed-field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

function OpSelect({
  kind,
  current,
  onPick,
}: {
  kind: 'stringOp' | 'numberOp' | 'compare';
  current: string;
  onPick: (spec: NodeSpec) => void;
}) {
  const options = useMemo(() => NODE_CATALOG.filter((s) => s.type === kind), [kind]);
  return (
    <Field label="Operation">
      <select
        value={current}
        onChange={(e) => {
          const picked = options.find((o) => o.op === e.target.value);
          if (picked) onPick(picked);
        }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.op as string}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function OptionalNumberInput({
  value,
  onChange,
  integer = true,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  integer?: boolean;
}) {
  return (
    <input
      type="number"
      step={integer ? 1 : 'any'}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(undefined);
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : undefined);
      }}
    />
  );
}

function CountStepper({
  label,
  count,
  onChange,
  hint,
}: {
  label: string;
  count: number;
  onChange: (count: number) => void;
  hint?: string;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(32, Math.floor(n)));
  return (
    <Field label={label} hint={hint}>
      <div className="tfa-ed-stepper">
        <button type="button" className="btn sm" onClick={() => onChange(clamp(count - 1))}>
          −
        </button>
        <input
          type="number"
          min={0}
          max={32}
          value={count}
          onChange={(e) => onChange(clamp(Number(e.target.value) || 0))}
        />
        <button type="button" className="btn sm" onClick={() => onChange(clamp(count + 1))}>
          +
        </button>
      </div>
    </Field>
  );
}

/* ------------------------------- literal ------------------------------ */

function LiteralEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2) ?? 'null');
  const [error, setError] = useState<string | null>(null);
  return (
    <Field
      label="Value (JSON)"
      hint='Text needs quotes: "hello". Numbers, true/false, arrays and objects work too.'
      error={error}
    >
      <textarea
        rows={4}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            onChange(JSON.parse(next));
            setError(null);
          } catch {
            setError('Not valid JSON — the last valid value is kept.');
          }
        }}
      />
    </Field>
  );
}

/* ---------------------------- object keys ----------------------------- */

function ObjectKeysEditor({
  keys,
  onSetKeys,
  onRename,
}: {
  keys: string[];
  onSetKeys: (keys: string[]) => void;
  onRename: (oldKey: string, newKey: string) => void;
}) {
  const addKey = () => {
    let i = keys.length + 1;
    while (keys.includes(`key${i}`)) i += 1;
    onSetKeys([...keys, `key${i}`]);
  };
  return (
    <div className="tfa-ed-field">
      <label>Keys</label>
      <div className="tfa-ed-rows">
        {keys.map((key) => (
          <KeyRow
            key={key}
            name={key}
            existing={keys}
            onRename={(next) => onRename(key, next)}
            onRemove={() => onSetKeys(keys.filter((k) => k !== key))}
          />
        ))}
      </div>
      <button type="button" className="btn sm" onClick={addKey}>
        + Add key
      </button>
      <span className="tfa-ed-field-hint">
        Renaming a key keeps its wired connection. Unwired keys are left out of the object.
      </span>
    </div>
  );
}

function KeyRow({
  name,
  existing,
  onRename,
  onRemove,
}: {
  name: string;
  existing: string[];
  onRename: (next: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const invalid = draft.trim() === '' || (draft !== name && existing.includes(draft));
  const commit = () => {
    if (draft === name) return;
    if (invalid) {
      setDraft(name); // revert
      return;
    }
    onRename(draft);
  };
  return (
    <div className="tfa-ed-row">
      <input
        type="text"
        className={invalid ? 'is-invalid' : ''}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(name);
        }}
      />
      <button type="button" className="btn ghost sm" title="Remove key" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

/* ---------------------------- string ops ------------------------------ */

function StringOpFields({
  op,
  cfg,
  set,
}: {
  op: StringOp | CompareOp | string;
  cfg: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
}) {
  switch (op) {
    case 'concat':
      return (
        <CountStepper
          label="Parts"
          count={typeof cfg.count === 'number' ? cfg.count : 2}
          onChange={(count) => set({ count })}
          hint="Texts are joined in slot order."
        />
      );
    case 'substring':
      return (
        <>
          <Field label="Start position" hint="0 = the first character.">
            <OptionalNumberInput
              value={typeof cfg.start === 'number' ? cfg.start : 0}
              onChange={(start) => set({ start: start ?? 0 })}
            />
          </Field>
          <Field label="Length" hint="Leave empty to take everything from the start position.">
            <OptionalNumberInput
              value={typeof cfg.length === 'number' ? cfg.length : undefined}
              onChange={(length) => set({ length })}
            />
          </Field>
        </>
      );
    case 'replace':
      return (
        <>
          <Field label="Find">
            <input
              type="text"
              value={typeof cfg.pattern === 'string' ? cfg.pattern : ''}
              onChange={(e) => set({ pattern: e.target.value })}
            />
          </Field>
          <Field label="Replace with">
            <input
              type="text"
              value={typeof cfg.replacement === 'string' ? cfg.replacement : ''}
              onChange={(e) => set({ replacement: e.target.value })}
            />
          </Field>
        </>
      );
    case 'split':
    case 'join':
      return (
        <Field label="Separator">
          <input
            type="text"
            value={typeof cfg.separator === 'string' ? cfg.separator : ','}
            onChange={(e) => set({ separator: e.target.value })}
          />
        </Field>
      );
    default:
      return null;
  }
}

/* ------------------------------- lookup ------------------------------- */

interface LookupRow {
  id: number;
  k: string;
  v: string;
}

function LookupEditor({
  table,
  fallback,
  onChange,
}: {
  table: Record<string, string>;
  fallback: string | undefined;
  onChange: (table: Record<string, string>, fallback: string | undefined) => void;
}) {
  const [rows, setRows] = useState<LookupRow[]>(() =>
    Object.entries(table).map(([k, v], i) => ({ id: i, k, v: String(v) })),
  );
  const [nextId, setNextId] = useState(rows.length);
  const [useDefault, setUseDefault] = useState(fallback !== undefined);
  const [fallbackText, setFallbackText] = useState(fallback ?? '');

  const commit = (nextRows: LookupRow[], nextUseDefault: boolean, nextFallback: string) => {
    const nextTable: Record<string, string> = {};
    for (const row of nextRows) {
      if (row.k !== '') nextTable[row.k] = row.v;
    }
    onChange(nextTable, nextUseDefault ? nextFallback : undefined);
  };

  const updateRow = (id: number, patch: Partial<LookupRow>) => {
    const nextRows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRows(nextRows);
    commit(nextRows, useDefault, fallbackText);
  };

  return (
    <>
      <div className="tfa-ed-field">
        <label>Table (key → value)</label>
        <div className="tfa-ed-rows">
          {rows.map((row) => (
            <div key={row.id} className="tfa-ed-row">
              <input
                type="text"
                placeholder="key"
                value={row.k}
                onChange={(e) => updateRow(row.id, { k: e.target.value })}
              />
              <span className="tfa-ed-row-arrow">→</span>
              <input
                type="text"
                placeholder="value"
                value={row.v}
                onChange={(e) => updateRow(row.id, { v: e.target.value })}
              />
              <button
                type="button"
                className="btn ghost sm"
                title="Remove row"
                onClick={() => {
                  const nextRows = rows.filter((r) => r.id !== row.id);
                  setRows(nextRows);
                  commit(nextRows, useDefault, fallbackText);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            const nextRows = [...rows, { id: nextId, k: '', v: '' }];
            setNextId(nextId + 1);
            setRows(nextRows);
            commit(nextRows, useDefault, fallbackText);
          }}
        >
          + Add row
        </button>
      </div>
      <label className="tfa-ed-check">
        <input
          type="checkbox"
          checked={useDefault}
          onChange={(e) => {
            setUseDefault(e.target.checked);
            commit(rows, e.target.checked, fallbackText);
          }}
        />
        Use a default when the key is not found
      </label>
      {useDefault && (
        <Field label="Default value">
          <input
            type="text"
            value={fallbackText}
            onChange={(e) => {
              setFallbackText(e.target.value);
              commit(rows, true, e.target.value);
            }}
          />
        </Field>
      )}
    </>
  );
}

/* -------------------------------- raw --------------------------------- */

function RawEditor({
  expression,
  onChange,
}: {
  expression: string;
  onChange: (expression: string) => void;
}) {
  const syntaxError = useMemo(
    () => (expression.trim() === '' ? 'Expression is empty' : jsonataSyntaxError(expression)),
    [expression],
  );
  return (
    <Field
      label="JSONata expression"
      hint="Runs against the wired context, or the whole document when unwired."
      error={syntaxError}
    >
      <textarea
        rows={6}
        className="tfa-ed-mono"
        value={expression}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {syntaxError === null && <span className="tfa-ed-field-ok">Syntax OK</span>}
    </Field>
  );
}

/** Custom React Flow node used for every graph node type. */
import { createContext, memo, useContext, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { GraphNodeType } from '@transformata/shared';
import { resolveInputHandles, specForNode } from '@transformata/shared';
import type { TfaFlowNode } from './graphFlow';

/** nodeId → error messages, provided by EditorScreen from the compile result. */
export const NodeErrorsContext = createContext<Record<string, string[]>>({});

function truncate(text: string, max = 36): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-line summary of the node's data, shown under the title. */
export function nodeSummary(kind: GraphNodeType, cfg: Record<string, unknown>): string | null {
  switch (kind) {
    case 'path': {
      const path = typeof cfg.path === 'string' ? cfg.path : '';
      return path ? truncate(path) : '(no path set)';
    }
    case 'literal': {
      const json = JSON.stringify(cfg.value ?? null);
      return truncate(json ?? 'null');
    }
    case 'object': {
      const keys = Array.isArray(cfg.keys) ? cfg.keys : [];
      return keys.length === 0 ? 'no keys' : truncate(`{ ${keys.join(', ')} }`, 40);
    }
    case 'array':
      return `${typeof cfg.count === 'number' ? cfg.count : 2} slot(s)`;
    case 'stringOp': {
      switch (cfg.op) {
        case 'substring':
          return `from ${Number(cfg.start ?? 0)}${cfg.length !== undefined ? `, len ${Number(cfg.length)}` : ''}`;
        case 'replace':
          return truncate(`${JSON.stringify(cfg.pattern ?? '')} → ${JSON.stringify(cfg.replacement ?? '')}`);
        case 'split':
        case 'join':
          return `separator ${JSON.stringify(cfg.separator ?? ',')}`;
        default:
          return null;
      }
    }
    case 'numberOp':
      return cfg.op === 'round' && cfg.precision !== undefined
        ? `${Number(cfg.precision)} decimals`
        : null;
    case 'lookup': {
      const table = cfg.table && typeof cfg.table === 'object' ? cfg.table : {};
      const size = Object.keys(table as object).length;
      const fallback = typeof cfg.default === 'string' ? `, default ${JSON.stringify(cfg.default)}` : '';
      return `${size} entr${size === 1 ? 'y' : 'ies'}${fallback}`;
    }
    case 'sort': {
      const by = typeof cfg.by === 'string' && cfg.by.trim() !== '' ? `by ${cfg.by}` : 'values';
      return `${by} ${cfg.descending === true ? '↓ desc' : '↑ asc'}`;
    }
    case 'raw': {
      const expr = typeof cfg.expression === 'string' ? cfg.expression : '';
      return truncate(expr.replace(/\s+/g, ' ')) || '(empty)';
    }
    default:
      return null;
  }
}

const CATEGORY_CLASS: Record<string, string> = {
  Source: 'src',
  Structure: 'struct',
  Arrays: 'arr',
  Text: 'text',
  Numbers: 'num',
  Logic: 'logic',
  Advanced: 'adv',
};

export const TfaNode = memo(function TfaNode({ id, data, selected }: NodeProps<TfaFlowNode>) {
  const errors = useContext(NodeErrorsContext)[id];
  const spec = specForNode(data.kind, data.cfg);
  const handles = resolveInputHandles(data.kind, data.cfg);
  const updateNodeInternals = useUpdateNodeInternals();

  // Re-measure handle positions whenever the handle set changes
  // (object keys renamed, array/concat count changed, op switched).
  const handleSignature = handles.map((h) => h.id).join('|');
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, handleSignature, updateNodeInternals]);

  const summary = nodeSummary(data.kind, data.cfg);
  const category = spec ? CATEGORY_CLASS[spec.category] : 'adv';
  const className = [
    'tfa-ed-node',
    `tfa-ed-node-${category}`,
    selected ? 'is-selected' : '',
    errors && errors.length > 0 ? 'has-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} title={errors?.join('\n')}>
      <div className="tfa-ed-node-head">
        <span className="tfa-ed-node-title">{spec?.label ?? data.kind}</span>
        {spec?.hasOutput !== false && (
          <Handle type="source" position={Position.Right} id="out" className="tfa-ed-handle-out" />
        )}
      </div>
      {summary !== null && <div className="tfa-ed-node-summary">{summary}</div>}
      {handles.length > 0 && (
        <div className="tfa-ed-ports">
          {handles.map((h) => (
            <div key={h.id} className="tfa-ed-port">
              <Handle type="target" position={Position.Left} id={h.id} className="tfa-ed-handle-in" />
              <span className={`tfa-ed-port-label${h.required ? ' is-required' : ''}`}>
                {h.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

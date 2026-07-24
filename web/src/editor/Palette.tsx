/** Left-hand node palette, driven entirely by NODE_CATALOG. */
import { CATEGORY_ORDER, NODE_CATALOG, type NodeSpec } from '@transformata/shared';

export const DRAG_MIME = 'application/x-tfa-node';

export function Palette({ onAdd }: { onAdd: (spec: NodeSpec) => void }) {
  return (
    <aside className="tfa-ed-palette">
      {CATEGORY_ORDER.map((category) => {
        const specs = NODE_CATALOG.filter((s) => s.category === category);
        if (specs.length === 0) return null;
        return (
          <div key={category} className="tfa-ed-palette-group">
            <div className="tfa-ed-palette-cat">{category}</div>
            {specs.map((spec) => (
              <button
                key={spec.key}
                type="button"
                className="tfa-ed-palette-item"
                title={spec.help}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, spec.key);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => onAdd(spec)}
              >
                <span className="tfa-ed-palette-label">{spec.label}</span>
                <span className="tfa-ed-palette-help">{spec.help}</span>
              </button>
            ))}
          </div>
        );
      })}
      <div className="tfa-ed-palette-hint">Click or drag a block onto the canvas.</div>
    </aside>
  );
}

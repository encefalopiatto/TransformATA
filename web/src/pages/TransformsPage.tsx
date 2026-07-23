import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TransformConfig, TransformKind } from '@transformata/shared';
import { api } from '../api';
import { EmptyState, ErrorBanner, Loading, Modal, formatDateTime } from '../components/ui';
import { useToast } from '../components/Toasts';

const KIND_TABS: { kind: TransformKind; label: string; blurb: string }[] = [
  {
    kind: 'normalization',
    label: 'Normalizations',
    blurb: 'Turn an incoming file into your standard (canonical) shape.',
  },
  {
    kind: 'transformation',
    label: 'Transformations',
    blurb: 'Apply business rules — the data stays in your standard shape.',
  },
  {
    kind: 'denormalization',
    label: 'Denormalizations',
    blurb: 'Turn your standard shape into the format a partner expects.',
  },
];

export default function TransformsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [all, setAll] = useState<TransformConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TransformKind>('normalization');
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<TransformKind>('normalization');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAll(await api.listTransforms());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mappings');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNewModal = () => {
    setNewName('');
    setNewDesc('');
    setNewKind(tab);
    setShowNew(true);
  };

  const create = async () => {
    if (!newName.trim()) {
      toast('Please give the mapping a name.', 'error');
      return;
    }
    setCreating(true);
    try {
      const created = await api.createTransform({
        name: newName.trim(),
        kind: newKind,
        description: newDesc.trim() || undefined,
      });
      toast('Mapping created — opening the editor.', 'success');
      setShowNew(false);
      navigate(`/admin/transforms/${created.id}/edit`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the mapping', 'error');
    } finally {
      setCreating(false);
    }
  };

  const duplicate = async (t: TransformConfig) => {
    setBusyId(t.id);
    try {
      await api.createTransform({
        name: `${t.name} (copy)`,
        kind: t.kind,
        description: t.description,
        jsonata: t.jsonata,
        graph: t.graph,
        sampleInput: t.sampleInput,
      });
      toast(`Duplicated "${t.name}".`, 'success');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not duplicate the mapping', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (t: TransformConfig) => {
    if (!window.confirm(`Delete mapping "${t.name}"? This cannot be undone.`)) return;
    setBusyId(t.id);
    try {
      await api.deleteTransform(t.id);
      toast(`Deleted "${t.name}".`, 'success');
      await load();
    } catch (err) {
      // 409 when a funnel still references the mapping — surface the server message.
      toast(err instanceof Error ? err.message : 'Could not delete the mapping', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const activeTab = KIND_TABS.find((t) => t.kind === tab)!;
  const items = all?.filter((t) => t.kind === tab) ?? null;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Mappings</h1>
        <button type="button" className="btn primary" onClick={openNewModal}>
          + New mapping
        </button>
      </div>
      <p className="page-sub">
        Mappings describe how data is reshaped. Build them visually on a canvas, or write JSONata
        by hand in code mode.
      </p>

      {error && <ErrorBanner message={error} />}

      <div className="tabs">
        {KIND_TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            className={tab === t.kind ? 'active' : undefined}
            onClick={() => setTab(t.kind)}
          >
            {t.label}
            {all && <span className="count">{all.filter((x) => x.kind === t.kind).length}</span>}
          </button>
        ))}
      </div>
      <p className="page-sub" style={{ marginTop: -6 }}>
        {activeTab.blurb}
      </p>

      {items === null ? (
        <Loading label="Loading mappings…" />
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState icon="🗺️" title={`No ${activeTab.label.toLowerCase()} yet`}>
            Click "New mapping" to create one.
          </EmptyState>
        </div>
      ) : (
        <div className="card-grid">
          {items.map((t) => (
            <div key={t.id} className="card mapping-card">
              <div className="mc-head">
                <span className="mc-name">{t.name}</span>
                <span className={`badge ${t.graph ? 'visual' : 'code'}`}>
                  {t.graph ? 'visual' : 'code'}
                </span>
              </div>
              <div className="mc-desc">{t.description || <span className="cell-muted">No description</span>}</div>
              <div className="mc-meta">Updated {formatDateTime(t.updatedAt)}</div>
              <div className="mc-actions">
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => navigate(`/admin/transforms/${t.id}/edit`)}
                >
                  Open in editor
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busyId === t.id}
                  onClick={() => void duplicate(t)}
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  className="btn sm ghost danger"
                  disabled={busyId === t.id}
                  onClick={() => void remove(t)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <Modal title="New mapping" onClose={() => setShowNew(false)}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
            <div className="field">
              <label>Name</label>
              <input
                type="text"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. ACME orders → standard order"
              />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={newKind} onChange={(e) => setNewKind(e.target.value as TransformKind)}>
                <option value="normalization">Normalization — incoming file → standard shape</option>
                <option value="transformation">Transformation — business rules on the standard shape</option>
                <option value="denormalization">Denormalization — standard shape → partner format</option>
              </select>
              <span className="help">The type decides where the mapping can be used in a funnel and cannot be changed later.</span>
            </div>
            <div className="field">
              <label>Description (optional)</label>
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What does this mapping do?"
              />
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => setShowNew(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={create} disabled={creating}>
              {creating ? 'Creating…' : 'Create & open editor'}
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

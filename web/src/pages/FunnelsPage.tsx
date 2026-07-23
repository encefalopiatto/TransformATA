import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Endpoint, FunnelConfig } from '@transformata/shared';
import { api } from '../api';
import { EmptyState, ErrorBanner, Loading, Toggle } from '../components/ui';
import { useToast } from '../components/Toasts';

function matchSummary(f: FunnelConfig): string {
  if (f.match.equals !== undefined) return `${f.match.expression} = "${f.match.equals}"`;
  return `${f.match.expression} (is truthy)`;
}

export default function FunnelsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [funnels, setFunnels] = useState<FunnelConfig[] | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [f, e] = await Promise.all([api.listFunnels(), api.listEndpoints()]);
        setFunnels([...f].sort((a, b) => a.priority - b.priority));
        setEndpoints(e);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load funnels');
      }
    })();
  }, []);

  const endpointName = (id: string) => endpoints.find((e) => e.id === id)?.name ?? id;

  const toggleEnabled = async (funnel: FunnelConfig, enabled: boolean) => {
    setSavingId(funnel.id);
    // Optimistic update; roll back on failure.
    setFunnels((prev) =>
      prev ? prev.map((f) => (f.id === funnel.id ? { ...f, enabled } : f)) : prev,
    );
    try {
      await api.updateFunnel(funnel.id, { ...funnel, enabled });
      toast(`Funnel "${funnel.name}" ${enabled ? 'enabled' : 'disabled'}.`, 'success');
    } catch (err) {
      setFunnels((prev) =>
        prev ? prev.map((f) => (f.id === funnel.id ? { ...f, enabled: !enabled } : f)) : prev,
      );
      toast(err instanceof Error ? err.message : 'Could not save the change', 'error');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <h1>Funnels</h1>
        <Link to="/admin/funnels/new" className="btn primary">
          + New funnel
        </Link>
      </div>
      <p className="page-sub">
        A funnel decides which incoming files it handles (by looking for an identifier inside the
        file), runs them through your mappings, and delivers the result. Funnels are checked in
        priority order — the first match wins.
      </p>

      {error && <ErrorBanner message={error} />}

      <div className="card">
        {funnels === null ? (
          <Loading label="Loading funnels…" />
        ) : funnels.length === 0 ? (
          <EmptyState icon="🫙" title="No funnels yet">
            Create your first funnel to start routing incoming files.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Name</th>
                  <th>Matches when</th>
                  <th>Formats</th>
                  <th>Delivers to</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {funnels.map((f) => (
                  <tr
                    key={f.id}
                    className="clickable"
                    onClick={() => navigate(`/admin/funnels/${f.id}`)}
                  >
                    <td className="cell-muted">{f.priority}</td>
                    <td style={{ fontWeight: 600 }}>{f.name}</td>
                    <td className="cell-mono">{matchSummary(f)}</td>
                    <td className="cell-nowrap">
                      {f.inputFormat.toUpperCase()} → {f.outputFormat.toUpperCase()}
                    </td>
                    <td>{endpointName(f.outputEndpointId)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Toggle
                        checked={f.enabled}
                        disabled={savingId === f.id}
                        onChange={(next) => void toggleEnabled(f, next)}
                        label={`Enable funnel ${f.name}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

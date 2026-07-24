import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Endpoint, TestEndpointResponse } from '@transformata/shared';
import { api } from '../api';
import { EmptyState, EnabledChip, ErrorBanner, Loading } from '../components/ui';
import { useToast } from '../components/Toasts';

export function endpointKindLabel(e: Endpoint): string {
  if (e.direction === 'inbound') {
    if (e.kind === 'api') return 'HTTP push (API)';
    if (e.kind === 'sftp') return 'SFTP server (embedded)';
    return 'SFTP polling';
  }
  if (e.kind === 'api') return 'HTTP webhook';
  if (e.kind === 'sftp') return 'SFTP upload';
  return 'Local folder';
}

function endpointTarget(e: Endpoint): string {
  if (e.direction === 'inbound') {
    if (e.kind === 'api') return `/api/inbound/${e.id}`;
    if (e.kind === 'sftp') return `user: ${e.username}`;
    return `${e.host}:${e.port ?? 22}${e.remoteDir}`;
  }
  if (e.kind === 'api') return e.url;
  if (e.kind === 'sftp') return `${e.host}:${e.port ?? 22}${e.remoteDir}`;
  return e.path;
}

function canTest(e: Endpoint): boolean {
  return e.direction === 'outbound' || e.kind === 'sftp-poll';
}

function EndpointTable({
  endpoints,
  results,
  testingId,
  onTest,
}: {
  endpoints: Endpoint[];
  results: Record<string, TestEndpointResponse>;
  testingId: string | null;
  onTest: (e: Endpoint) => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Where</th>
            <th>Status</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => (
            <tr key={e.id} className="clickable" onClick={() => navigate(`/admin/endpoints/${e.id}`)}>
              <td style={{ fontWeight: 600 }}>{e.name}</td>
              <td className="cell-nowrap">{endpointKindLabel(e)}</td>
              <td className="cell-mono" style={{ wordBreak: 'break-all' }}>
                {endpointTarget(e)}
                {results[e.id] && (
                  <div
                    className={`inline-test-result banner ${results[e.id].ok ? 'success' : 'error'}`}
                    style={{ marginBottom: 0, marginTop: 8, fontFamily: 'var(--font)' }}
                  >
                    {results[e.id].detail}
                  </div>
                )}
              </td>
              <td>
                <EnabledChip enabled={e.enabled !== false} />
              </td>
              <td onClick={(ev) => ev.stopPropagation()}>
                {canTest(e) && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={testingId === e.id}
                    onClick={() => onTest(e)}
                  >
                    {testingId === e.id ? 'Testing…' : 'Test'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EndpointsPage() {
  const { toast } = useToast();
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestEndpointResponse>>({});

  useEffect(() => {
    (async () => {
      try {
        setEndpoints(await api.listEndpoints());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load endpoints');
      }
    })();
  }, []);

  const test = async (e: Endpoint) => {
    setTestingId(e.id);
    try {
      const res = await api.testEndpoint(e.id);
      setResults((prev) => ({ ...prev, [e.id]: res }));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test failed', 'error');
    } finally {
      setTestingId(null);
    }
  };

  const inbound = endpoints?.filter((e) => e.direction === 'inbound') ?? [];
  const outbound = endpoints?.filter((e) => e.direction === 'outbound') ?? [];

  return (
    <main className="page">
      <div className="page-head">
        <h1>Endpoints</h1>
        <Link to="/admin/endpoints/new" className="btn primary">
          + New endpoint
        </Link>
      </div>
      <p className="page-sub">
        Endpoints are the doors files come in through (inbound) and go out of (outbound). Funnels
        connect the two.
      </p>

      {error && <ErrorBanner message={error} />}

      {endpoints === null ? (
        <Loading label="Loading endpoints…" />
      ) : (
        <>
          <div className="section">
            <h2>
              <span className="badge dir" style={{ marginRight: 8 }}>
                Inbound
              </span>
              Where files come from
            </h2>
            <div className="card">
              {inbound.length === 0 ? (
                <EmptyState icon="📮" title="No inbound endpoints yet">
                  Create one to start receiving files via API or SFTP.
                </EmptyState>
              ) : (
                <EndpointTable
                  endpoints={inbound}
                  results={results}
                  testingId={testingId}
                  onTest={(e) => void test(e)}
                />
              )}
            </div>
          </div>

          <div className="section">
            <h2>
              <span className="badge dir" style={{ marginRight: 8 }}>
                Outbound
              </span>
              Where results are delivered
            </h2>
            <div className="card">
              {outbound.length === 0 ? (
                <EmptyState icon="📤" title="No outbound endpoints yet">
                  Create one so funnels have somewhere to deliver results.
                </EmptyState>
              ) : (
                <EndpointTable
                  endpoints={outbound}
                  results={results}
                  testingId={testingId}
                  onTest={(e) => void test(e)}
                />
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Endpoint, EndpointDirection, TestEndpointResponse } from '@transformata/shared';
import { api } from '../api';
import type { EndpointBody } from '../api';
import { ErrorBanner, Loading } from '../components/ui';
import { useToast } from '../components/Toasts';

type InboundKind = 'api' | 'sftp' | 'sftp-poll';
type OutboundKind = 'api' | 'sftp' | 'directory';

/** Flat draft covering every kind; only the relevant fields are shown/used. */
interface Draft {
  direction: EndpointDirection;
  kind: InboundKind | OutboundKind;
  name: string;
  description: string;
  enabled: boolean;
  // inbound api
  apiKey: string;
  // sftp (all flavors)
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey: string;
  remoteDir: string;
  // sftp-poll
  filePattern: string;
  pollIntervalSec: string;
  afterFetch: 'move' | 'delete';
  moveToDir: string;
  // outbound api
  url: string;
  method: 'POST' | 'PUT';
  headersText: string;
  // outbound directory
  path: string;
}

const EMPTY: Draft = {
  direction: 'inbound',
  kind: 'api',
  name: '',
  description: '',
  enabled: true,
  apiKey: '',
  host: '',
  port: '',
  username: '',
  password: '',
  privateKey: '',
  remoteDir: '',
  filePattern: '',
  pollIntervalSec: '',
  afterFetch: 'move',
  moveToDir: '',
  url: '',
  method: 'POST',
  headersText: '',
  path: '',
};

function randomKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function draftFromEndpoint(e: Endpoint): Draft {
  const d: Draft = { ...EMPTY, direction: e.direction, kind: e.kind, name: e.name };
  d.description = e.description ?? '';
  d.enabled = e.enabled !== false;
  if (e.direction === 'inbound') {
    if (e.kind === 'api') d.apiKey = e.apiKey;
    if (e.kind === 'sftp') {
      d.username = e.username;
      d.password = e.password;
    }
    if (e.kind === 'sftp-poll') {
      d.host = e.host;
      d.port = e.port !== undefined ? String(e.port) : '';
      d.username = e.username;
      d.password = e.password ?? '';
      d.privateKey = e.privateKey ?? '';
      d.remoteDir = e.remoteDir;
      d.filePattern = e.filePattern ?? '';
      d.pollIntervalSec = e.pollIntervalSec !== undefined ? String(e.pollIntervalSec) : '';
      d.afterFetch = e.afterFetch ?? 'move';
      d.moveToDir = e.moveToDir ?? '';
    }
  } else {
    if (e.kind === 'api') {
      d.url = e.url;
      d.method = e.method ?? 'POST';
      d.headersText = e.headers
        ? Object.entries(e.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')
        : '';
    }
    if (e.kind === 'sftp') {
      d.host = e.host;
      d.port = e.port !== undefined ? String(e.port) : '';
      d.username = e.username;
      d.password = e.password ?? '';
      d.privateKey = e.privateKey ?? '';
      d.remoteDir = e.remoteDir;
    }
    if (e.kind === 'directory') d.path = e.path;
  }
  return d;
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) throw new Error(`Header line "${trimmed}" must look like "Name: value".`);
    headers[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return Object.keys(headers).length ? headers : undefined;
}

/** Build the typed Endpoint body from the flat draft. Throws with a friendly message. */
function buildEndpoint(d: Draft): EndpointBody {
  const name = d.name.trim();
  if (!name) throw new Error('Please give the endpoint a name.');
  const base = {
    name,
    description: d.description.trim() || undefined,
    enabled: d.enabled,
  };
  const num = (v: string, label: string): number | undefined => {
    if (!v.trim()) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number.`);
    return n;
  };
  if (d.direction === 'inbound') {
    if (d.kind === 'api') {
      if (!d.apiKey.trim()) throw new Error('Please set an API key (or generate one).');
      return { ...base, direction: 'inbound', kind: 'api', apiKey: d.apiKey.trim() };
    }
    if (d.kind === 'sftp') {
      if (!d.username.trim() || !d.password) {
        throw new Error('SFTP server endpoints need a username and password.');
      }
      return {
        ...base,
        direction: 'inbound',
        kind: 'sftp',
        username: d.username.trim(),
        password: d.password,
      };
    }
    if (!d.host.trim() || !d.username.trim() || !d.remoteDir.trim()) {
      throw new Error('SFTP polling needs a host, username and remote folder.');
    }
    return {
      ...base,
      direction: 'inbound',
      kind: 'sftp-poll',
      host: d.host.trim(),
      port: num(d.port, 'Port'),
      username: d.username.trim(),
      password: d.password || undefined,
      privateKey: d.privateKey.trim() || undefined,
      remoteDir: d.remoteDir.trim(),
      filePattern: d.filePattern.trim() || undefined,
      pollIntervalSec: num(d.pollIntervalSec, 'Poll interval'),
      afterFetch: d.afterFetch,
      moveToDir: d.moveToDir.trim() || undefined,
    };
  }
  if (d.kind === 'api') {
    if (!d.url.trim()) throw new Error('Please enter the URL to deliver to.');
    return {
      ...base,
      direction: 'outbound',
      kind: 'api',
      url: d.url.trim(),
      method: d.method,
      headers: parseHeaders(d.headersText),
    };
  }
  if (d.kind === 'sftp') {
    if (!d.host.trim() || !d.username.trim() || !d.remoteDir.trim()) {
      throw new Error('SFTP upload needs a host, username and remote folder.');
    }
    return {
      ...base,
      direction: 'outbound',
      kind: 'sftp',
      host: d.host.trim(),
      port: num(d.port, 'Port'),
      username: d.username.trim(),
      password: d.password || undefined,
      privateKey: d.privateKey.trim() || undefined,
      remoteDir: d.remoteDir.trim(),
    };
  }
  if (!d.path.trim()) throw new Error('Please enter the folder path to write files into.');
  return { ...base, direction: 'outbound', kind: 'directory', path: d.path.trim() };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      className="btn sm"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => toast(`${label} copied to clipboard.`, 'success'))
          .catch(() => toast('Could not copy — please select and copy manually.', 'error'));
      }}
    >
      Copy
    </button>
  );
}

const INBOUND_KINDS: { kind: InboundKind; label: string; help: string }[] = [
  { kind: 'api', label: 'HTTP push (API)', help: 'Partners POST files to a URL with an API key.' },
  {
    kind: 'sftp-poll',
    label: 'SFTP polling',
    help: 'TransformATA connects to a remote SFTP server on a schedule and picks up new files.',
  },
  {
    kind: 'sftp',
    label: 'SFTP server (embedded)',
    help: 'Partners upload to the built-in SFTP server (self-hosted deployments only).',
  },
];

const OUTBOUND_KINDS: { kind: OutboundKind; label: string; help: string }[] = [
  { kind: 'api', label: 'HTTP webhook', help: 'Deliver the result with an HTTP POST/PUT.' },
  { kind: 'sftp', label: 'SFTP upload', help: 'Upload the result to a remote SFTP server.' },
  { kind: 'directory', label: 'Local folder', help: 'Write the result to a folder on the server (good for testing).' },
];

export default function EndpointEditPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const { toast } = useToast();

  const [draft, setDraft] = useState<Draft | null>(
    isNew ? { ...EMPTY, apiKey: randomKey() } : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestEndpointResponse | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        setDraft(draftFromEndpoint(await api.getEndpoint(id)));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load the endpoint');
      }
    })();
  }, [id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    if (!draft) return;
    let body: EndpointBody;
    try {
      body = buildEndpoint(draft);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Please check the form', 'error');
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await api.createEndpoint(body);
        toast('Endpoint created.', 'success');
        navigate(`/admin/endpoints/${created.id}`, { replace: true });
      } else {
        await api.updateEndpoint(id, { ...body, id } as Endpoint);
        toast('Endpoint saved.', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the endpoint', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id || !draft) return;
    if (!window.confirm(`Delete endpoint "${draft.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteEndpoint(id);
      toast('Endpoint deleted.', 'success');
      navigate('/admin/endpoints');
    } catch (err) {
      // 409 when a funnel still references this endpoint.
      toast(err instanceof Error ? err.message : 'Could not delete the endpoint', 'error');
    }
  };

  const runTest = async () => {
    if (!id) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testEndpoint(id));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test failed', 'error');
    } finally {
      setTesting(false);
    }
  };

  if (loadError) {
    return (
      <main className="page">
        <ErrorBanner message={loadError} />
        <Link to="/admin/endpoints">← Back to endpoints</Link>
      </main>
    );
  }
  if (!draft) {
    return (
      <main className="page">
        <Loading label="Loading endpoint…" />
      </main>
    );
  }

  const kinds = draft.direction === 'inbound' ? INBOUND_KINDS : OUTBOUND_KINDS;
  const kindHelp = kinds.find((k) => k.kind === draft.kind)?.help;
  const isSftpish =
    (draft.direction === 'inbound' && draft.kind === 'sftp-poll') ||
    (draft.direction === 'outbound' && draft.kind === 'sftp');
  const curl = id
    ? `curl -X POST '${window.location.origin}/api/inbound/${id}' \\\n  -H 'X-Api-Key: ${draft.apiKey}' \\\n  -H 'X-File-Name: orders.csv' \\\n  --data-binary @orders.csv`
    : '';

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/admin/endpoints" style={{ fontSize: 13 }}>
            ← Back to endpoints
          </Link>
          <h1 style={{ marginTop: 6 }}>{isNew ? 'New endpoint' : `Edit: ${draft.name}`}</h1>
        </div>
        <div className="btn-row">
          {!isNew && (
            <button type="button" className="btn danger" onClick={remove}>
              Delete
            </button>
          )}
          <button type="button" className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create endpoint' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="card card-pad section">
        <h2>Basics</h2>
        <div className="form-grid">
          <div className="field">
            <label>Direction</label>
            <select
              value={draft.direction}
              disabled={!isNew}
              onChange={(e) => {
                const direction = e.target.value as EndpointDirection;
                set('direction', direction);
                set('kind', 'api');
              }}
            >
              <option value="inbound">Inbound — files come in</option>
              <option value="outbound">Outbound — results go out</option>
            </select>
            {!isNew && <span className="help">Direction cannot be changed after creation.</span>}
          </div>
          <div className="field">
            <label>Type</label>
            <select
              value={draft.kind}
              disabled={!isNew}
              onChange={(e) => set('kind', e.target.value as Draft['kind'])}
            >
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {kindHelp && <span className="help">{kindHelp}</span>}
          </div>
          <div className="field">
            <label>Name</label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. ACME order drop"
            />
          </div>
          <div className="field">
            <label>Enabled</label>
            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              <span>Endpoint is active</span>
            </div>
          </div>
          <div className="field span2">
            <label>Description (optional)</label>
            <input
              type="text"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card card-pad section">
        <h2>Connection details</h2>
        <div className="form-grid">
          {draft.direction === 'inbound' && draft.kind === 'api' && (
            <>
              <div className="field span2">
                <label>API key</label>
                <div className="copy-row">
                  <input
                    type="text"
                    value={draft.apiKey}
                    onChange={(e) => set('apiKey', e.target.value)}
                    style={{ fontFamily: 'var(--mono)', flex: 1 }}
                  />
                  <CopyButton text={draft.apiKey} label="API key" />
                  <button type="button" className="btn sm" onClick={() => set('apiKey', randomKey())}>
                    Generate new
                  </button>
                </div>
                <span className="help">
                  The sender must include this key in the <code>X-Api-Key</code> header. Treat it
                  like a password.
                </span>
              </div>
              {!isNew && (
                <>
                  <div className="field span2">
                    <label>Upload URL</label>
                    <div className="copy-row">
                      <code>{`/api/inbound/${id}`}</code>
                      <CopyButton text={`${window.location.origin}/api/inbound/${id}`} label="URL" />
                    </div>
                    <span className="help">Partners POST their files to this address.</span>
                  </div>
                  <div className="field span2">
                    <label>Example (curl)</label>
                    <pre>{curl}</pre>
                  </div>
                </>
              )}
              {isNew && (
                <div className="field span2">
                  <span className="help">
                    Save the endpoint to get its upload URL and a ready-to-copy example request.
                  </span>
                </div>
              )}
            </>
          )}

          {draft.direction === 'inbound' && draft.kind === 'sftp' && (
            <>
              <div className="field span2">
                <div className="banner warn" style={{ marginBottom: 0 }}>
                  The embedded SFTP server needs a raw TCP port, so it only works on self-hosted
                  deployments (not on Render free tier) and must be switched on with{' '}
                  <code>SFTP_SERVER_ENABLED=true</code>.
                </div>
              </div>
              <div className="field">
                <label>Username</label>
                <input
                  type="text"
                  value={draft.username}
                  onChange={(e) => set('username', e.target.value)}
                />
                <span className="help">Each endpoint is one SFTP login. Files this user uploads become jobs.</span>
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={draft.password}
                  onChange={(e) => set('password', e.target.value)}
                />
              </div>
            </>
          )}

          {isSftpish && (
            <>
              <div className="field">
                <label>Host</label>
                <input
                  type="text"
                  value={draft.host}
                  onChange={(e) => set('host', e.target.value)}
                  placeholder="sftp.partner.com"
                />
              </div>
              <div className="field">
                <label>Port</label>
                <input
                  type="number"
                  value={draft.port}
                  onChange={(e) => set('port', e.target.value)}
                  placeholder="22"
                />
              </div>
              <div className="field">
                <label>Username</label>
                <input
                  type="text"
                  value={draft.username}
                  onChange={(e) => set('username', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={draft.password}
                  onChange={(e) => set('password', e.target.value)}
                />
                <span className="help">Leave empty if you use a private key instead.</span>
              </div>
              <div className="field span2">
                <label>Private key (optional, PEM)</label>
                <textarea
                  value={draft.privateKey}
                  onChange={(e) => set('privateKey', e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={4}
                />
              </div>
              <div className="field">
                <label>{draft.direction === 'inbound' ? 'Remote folder to watch' : 'Remote folder to upload into'}</label>
                <input
                  type="text"
                  value={draft.remoteDir}
                  onChange={(e) => set('remoteDir', e.target.value)}
                  placeholder="/outbox"
                />
              </div>
            </>
          )}

          {draft.direction === 'inbound' && draft.kind === 'sftp-poll' && (
            <>
              <div className="field">
                <label>File pattern (optional)</label>
                <input
                  type="text"
                  value={draft.filePattern}
                  onChange={(e) => set('filePattern', e.target.value)}
                  placeholder="*.csv"
                />
                <span className="help">Only pick up files whose name matches, e.g. *.csv. Empty = all files.</span>
              </div>
              <div className="field">
                <label>Check every (seconds)</label>
                <input
                  type="number"
                  value={draft.pollIntervalSec}
                  onChange={(e) => set('pollIntervalSec', e.target.value)}
                  placeholder="60"
                />
              </div>
              <div className="field">
                <label>After a file is picked up</label>
                <select
                  value={draft.afterFetch}
                  onChange={(e) => set('afterFetch', e.target.value as 'move' | 'delete')}
                >
                  <option value="move">Move it to a processed folder</option>
                  <option value="delete">Delete it from the server</option>
                </select>
              </div>
              {draft.afterFetch === 'move' && (
                <div className="field">
                  <label>Move to folder (optional)</label>
                  <input
                    type="text"
                    value={draft.moveToDir}
                    onChange={(e) => set('moveToDir', e.target.value)}
                    placeholder="<remote folder>/processed"
                  />
                </div>
              )}
            </>
          )}

          {draft.direction === 'outbound' && draft.kind === 'api' && (
            <>
              <div className="field span2">
                <label>URL</label>
                <input
                  type="url"
                  value={draft.url}
                  onChange={(e) => set('url', e.target.value)}
                  placeholder="https://partner.example.com/webhook"
                />
              </div>
              <div className="field">
                <label>Method</label>
                <select value={draft.method} onChange={(e) => set('method', e.target.value as 'POST' | 'PUT')}>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
              <div className="field span2">
                <label>Extra headers (optional)</label>
                <textarea
                  value={draft.headersText}
                  onChange={(e) => set('headersText', e.target.value)}
                  placeholder={'Authorization: Bearer …\nX-Custom: value'}
                  rows={3}
                />
                <span className="help">One per line, like "Name: value".</span>
              </div>
            </>
          )}

          {draft.direction === 'outbound' && draft.kind === 'directory' && (
            <div className="field span2">
              <label>Folder path</label>
              <input
                type="text"
                value={draft.path}
                onChange={(e) => set('path', e.target.value)}
                placeholder="data/outbox/acme"
              />
              <span className="help">
                A folder on the TransformATA server. Handy for demos and testing — note that on
                Render's free tier this folder is wiped on every restart.
              </span>
            </div>
          )}
        </div>
      </div>

      {!isNew && canShowTest(draft) && (
        <div className="card card-pad section">
          <h2>Test connection</h2>
          <p className="help" style={{ color: 'var(--text-muted)', marginTop: 0 }}>
            {draft.direction === 'outbound'
              ? 'Sends a small test file through this endpoint and reports the result.'
              : 'Connects to the SFTP server and lists the watched folder.'}
          </p>
          <div className="btn-row">
            <button type="button" className="btn" onClick={runTest} disabled={testing}>
              {testing ? 'Testing…' : 'Run test'}
            </button>
          </div>
          {testResult && (
            <div className={`banner ${testResult.ok ? 'success' : 'error'}`} style={{ marginTop: 14, marginBottom: 0 }}>
              {testResult.detail}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function canShowTest(d: Draft): boolean {
  return d.direction === 'outbound' || d.kind === 'sftp-poll';
}

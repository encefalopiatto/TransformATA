import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  CsvOptions,
  DataFormat,
  Endpoint,
  FormatOptions,
  FunnelConfig,
  TestFunnelResponse,
  TransformConfig,
  TransformKind,
  XmlOptions,
} from '@transformata/shared';
import { api } from '../api';
import StageTimeline from '../components/StageTimeline';
import { ErrorBanner, Loading } from '../components/ui';
import { useToast } from '../components/Toasts';

type Draft = Omit<FunnelConfig, 'id'>;

/**
 * Sanitize format options for a given format before sending. The server now
 * REPLACES the funnel on PUT, so we must send exactly the intended fields:
 * options that don't belong to `format` are dropped, and an empty CSV
 * delimiter is omitted (never sent as "") so the server falls back to its
 * default instead of failing every job with an empty separator.
 */
function cleanOptions(format: DataFormat, opts: FormatOptions | undefined): FormatOptions | undefined {
  if (format === 'csv') {
    const csv: CsvOptions = {};
    const delimiter = opts?.csv?.delimiter;
    if (delimiter !== undefined && delimiter !== '') csv.delimiter = delimiter;
    if (opts?.csv?.hasHeaders !== undefined) csv.hasHeaders = opts.csv.hasHeaders;
    return Object.keys(csv).length ? { csv } : undefined;
  }
  if (format === 'xml') {
    const xml: XmlOptions = {};
    if (opts?.xml?.rootName) xml.rootName = opts.xml.rootName;
    if (opts?.xml?.attributePrefix) xml.attributePrefix = opts.xml.attributePrefix;
    return Object.keys(xml).length ? { xml } : undefined;
  }
  // JSON takes no options.
  return undefined;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  description: '',
  enabled: true,
  priority: 100,
  match: { expression: '', equals: '' },
  inputFormat: 'json',
  outputFormat: 'json',
  outputEndpointId: '',
  normalizationId: null,
  transformationId: null,
  denormalizationId: null,
  inboundEndpointIds: [],
  outputFileName: '',
};

const TEST_PLACEHOLDER = `Paste a real sample file here, then press "Run test".

Example CSV:
order_id,partner,order_date,sku,qty
SO-1042,ACME,2026-07-18,AC-330,2

Example JSON:
{ "meta": { "partner": "GLOBEX" }, "order": { "number": "PO-1" } }`;

function FormatOptionsFields({
  format,
  options,
  onChange,
  legend,
}: {
  format: DataFormat;
  options: FormatOptions | undefined;
  onChange: (next: FormatOptions | undefined) => void;
  legend: string;
}) {
  if (format === 'json') return null;
  if (format === 'csv') {
    const csv = options?.csv ?? {};
    return (
      <fieldset className="opt-group">
        <legend>{legend} — CSV options</legend>
        <div className="form-grid">
          <div className="field">
            <label>Column separator</label>
            <input
              type="text"
              value={csv.delimiter ?? ','}
              maxLength={3}
              onChange={(e) => onChange({ ...options, csv: { ...csv, delimiter: e.target.value } })}
            />
            <span className="help">Usually a comma (,) or semicolon (;).</span>
          </div>
          <div className="field">
            <label>First row contains column names</label>
            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={csv.hasHeaders ?? true}
                onChange={(e) =>
                  onChange({ ...options, csv: { ...csv, hasHeaders: e.target.checked } })
                }
              />
              <span>Yes, the first row is a header</span>
            </div>
          </div>
        </div>
      </fieldset>
    );
  }
  const xml = options?.xml ?? {};
  return (
    <fieldset className="opt-group">
      <legend>{legend} — XML options</legend>
      <div className="form-grid">
        <div className="field">
          <label>Root element name</label>
          <input
            type="text"
            value={xml.rootName ?? ''}
            placeholder="root"
            onChange={(e) =>
              onChange({ ...options, xml: { ...xml, rootName: e.target.value || undefined } })
            }
          />
          <span className="help">The outer tag that wraps the whole document.</span>
        </div>
        <div className="field">
          <label>Attribute prefix</label>
          <input
            type="text"
            value={xml.attributePrefix ?? ''}
            placeholder="@_"
            onChange={(e) =>
              onChange({
                ...options,
                xml: { ...xml, attributePrefix: e.target.value || undefined },
              })
            }
          />
          <span className="help">How XML attributes are marked in the data. Leave as @_ unless told otherwise.</span>
        </div>
      </div>
    </fieldset>
  );
}

export default function FunnelEditPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const { toast } = useToast();

  const [draft, setDraft] = useState<Draft | null>(isNew ? EMPTY_DRAFT : null);
  const [transforms, setTransforms] = useState<TransformConfig[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [testContent, setTestContent] = useState('');
  const [testFileName, setTestFileName] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestFunnelResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, e] = await Promise.all([api.listTransforms(), api.listEndpoints()]);
        setTransforms(t);
        setEndpoints(e);
        if (id) setDraft(await api.getFunnel(id));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load');
      }
    })();
  }, [id]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDirty(true);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const transformsOf = (kind: TransformKind) => transforms.filter((t) => t.kind === kind);
  const outbound = endpoints.filter((e) => e.direction === 'outbound');
  const inbound = endpoints.filter((e) => e.direction === 'inbound');

  /** Returns true when the funnel was saved successfully. */
  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    if (!draft.name.trim()) {
      toast('Please give the funnel a name.', 'error');
      return false;
    }
    if (!draft.match.expression.trim()) {
      toast('Please fill in the match expression — it tells the funnel which files are for it.', 'error');
      return false;
    }
    if (!draft.outputEndpointId) {
      toast('Please choose where the result should be delivered.', 'error');
      return false;
    }
    // The server REPLACES the funnel on PUT, so build a COMPLETE object with
    // exactly the intended fields: cleared optionals are omitted (never sent
    // empty) so the replace drops them.
    const body: Draft = {
      ...draft,
      description: draft.description?.trim() || undefined,
      match: {
        expression: draft.match.expression.trim(),
        equals: draft.match.equals?.trim() ? draft.match.equals.trim() : undefined,
      },
      inputOptions: cleanOptions(draft.inputFormat, draft.inputOptions),
      outputOptions: cleanOptions(draft.outputFormat, draft.outputOptions),
      inboundEndpointIds: draft.inboundEndpointIds?.length ? draft.inboundEndpointIds : undefined,
      outputFileName: draft.outputFileName?.trim() || undefined,
      normalizationId: draft.normalizationId || null,
      transformationId: draft.transformationId || null,
      denormalizationId: draft.denormalizationId || null,
    };
    setSaving(true);
    try {
      if (isNew) {
        const created = await api.createFunnel(body);
        setDirty(false);
        toast('Funnel created.', 'success');
        navigate(`/admin/funnels/${created.id}`, { replace: true });
      } else {
        const updated = await api.updateFunnel(id, { ...body, id });
        setDraft(updated);
        setDirty(false);
        toast('Funnel saved.', 'success');
      }
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the funnel', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id || !draft) return;
    if (!window.confirm(`Delete funnel "${draft.name}"? Incoming files will no longer be routed to it. This cannot be undone.`)) {
      return;
    }
    try {
      await api.deleteFunnel(id);
      toast('Funnel deleted.', 'success');
      navigate('/admin/funnels');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the funnel', 'error');
    }
  };

  const runTest = async () => {
    if (!id) return;
    if (!testContent.trim()) {
      setTestError('Paste some file content first.');
      return;
    }
    // The test endpoint loads the STORED funnel by id, so on-screen edits are
    // ignored unless we persist them first. Save the pending changes so the
    // test actually reflects what's on screen; abort if the save fails.
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await api.testFunnel(id, {
        content: testContent,
        fileName: testFileName.trim() || undefined,
      });
      setTestResult(res);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  if (loadError) {
    return (
      <main className="page">
        <ErrorBanner message={loadError} />
        <Link to="/admin/funnels">← Back to funnels</Link>
      </main>
    );
  }
  if (!draft) {
    return (
      <main className="page">
        <Loading label="Loading funnel…" />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <Link to="/admin/funnels" style={{ fontSize: 13 }}>
            ← Back to funnels
          </Link>
          <h1 style={{ marginTop: 6 }}>{isNew ? 'New funnel' : `Edit: ${draft.name}`}</h1>
        </div>
        <div className="btn-row">
          {!isNew && (
            <button type="button" className="btn danger" onClick={remove}>
              Delete
            </button>
          )}
          <button type="button" className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create funnel' : 'Save changes'}
          </button>
        </div>
      </div>
      <p className="page-sub">
        A funnel picks up matching files, runs them through up to three mappings, and delivers the
        result to an outbound endpoint.
      </p>

      <div className="card card-pad section">
        <h2>Basics</h2>
        <div className="form-grid">
          <div className="field">
            <label>Name</label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. ACME orders (CSV → XML)"
            />
          </div>
          <div className="field">
            <label>Priority</label>
            <input
              type="number"
              value={draft.priority}
              onChange={(e) => set('priority', Number(e.target.value))}
            />
            <span className="help">
              Lower number = checked first. If two funnels could match the same file, the one with
              the lower priority number wins.
            </span>
          </div>
          <div className="field span2">
            <label>Description</label>
            <input
              type="text"
              value={draft.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
              placeholder="What kind of files does this funnel handle?"
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
              <span>Funnel is active and picks up files</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card card-pad section">
        <h2>Which files belong to this funnel?</h2>
        <div className="form-grid">
          <div className="field">
            <label>Look at (match expression)</label>
            <input
              type="text"
              value={draft.match.expression}
              onChange={(e) => set('match', { ...draft.match, expression: e.target.value })}
              placeholder='e.g. rows[0].partner'
            />
            <span className="help">
              A JSONata path into the parsed file. For CSV files the data looks like{' '}
              <code>rows[0].partner</code> (first row, column "partner"); for JSON like{' '}
              <code>meta.partner</code>.
            </span>
          </div>
          <div className="field">
            <label>Must equal (optional)</label>
            <input
              type="text"
              value={draft.match.equals ?? ''}
              onChange={(e) => set('match', { ...draft.match, equals: e.target.value })}
              placeholder='e.g. ACME'
            />
            <span className="help">
              If filled in, the funnel matches only when the value above equals this text exactly.
              If left empty, any non-empty result counts as a match.
            </span>
          </div>
          <div className="field span2">
            <label>Only accept files from (optional)</label>
            {inbound.length === 0 ? (
              <span className="help">No inbound endpoints configured yet — the funnel will accept files from anywhere.</span>
            ) : (
              <div className="check-list">
                {inbound.map((e) => (
                  <label key={e.id} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={draft.inboundEndpointIds?.includes(e.id) ?? false}
                      onChange={(ev) => {
                        const current = draft.inboundEndpointIds ?? [];
                        set(
                          'inboundEndpointIds',
                          ev.target.checked
                            ? [...current, e.id]
                            : current.filter((x) => x !== e.id),
                        );
                      }}
                    />
                    <span>{e.name}</span>
                  </label>
                ))}
              </div>
            )}
            <span className="help">
              Leave everything unchecked to accept matching files from any inbound endpoint.
            </span>
          </div>
        </div>
      </div>

      <div className="card card-pad section">
        <h2>Input</h2>
        <div className="form-grid">
          <div className="field">
            <label>Incoming file format</label>
            <select
              value={draft.inputFormat}
              onChange={(e) => set('inputFormat', e.target.value as DataFormat)}
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="xml">XML</option>
            </select>
          </div>
          <div className="field span2">
            <FormatOptionsFields
              format={draft.inputFormat}
              options={draft.inputOptions}
              onChange={(next) => set('inputOptions', next)}
              legend="Input"
            />
          </div>
        </div>
      </div>

      <div className="card card-pad section">
        <h2>Mappings</h2>
        <p className="help" style={{ color: 'var(--text-faint)', marginTop: -6 }}>
          Each step is optional — when set to "pass through" the data flows to the next step
          unchanged. Manage mappings on the Mappings page.
        </p>
        <div className="form-grid">
          {(
            [
              ['normalizationId', 'normalization', '1. Normalize (file → your standard shape)'],
              ['transformationId', 'transformation', '2. Transform (business rules)'],
              ['denormalizationId', 'denormalization', '3. Denormalize (standard shape → output)'],
            ] as const
          ).map(([key, kind, label]) => (
            <div className="field" key={key}>
              <label>{label}</label>
              <select
                value={draft[key] ?? ''}
                onChange={(e) => set(key, e.target.value || null)}
              >
                <option value="">— Pass through (no change) —</option>
                {transformsOf(kind).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="card card-pad section">
        <h2>Output & delivery</h2>
        <div className="form-grid">
          <div className="field">
            <label>Outgoing file format</label>
            <select
              value={draft.outputFormat}
              onChange={(e) => set('outputFormat', e.target.value as DataFormat)}
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="xml">XML</option>
            </select>
          </div>
          <div className="field">
            <label>Deliver to</label>
            <select
              value={draft.outputEndpointId}
              onChange={(e) => set('outputEndpointId', e.target.value)}
            >
              <option value="">— Choose an outbound endpoint —</option>
              {outbound.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <span className="help">Manage delivery destinations on the Endpoints page.</span>
          </div>
          <div className="field span2">
            <FormatOptionsFields
              format={draft.outputFormat}
              options={draft.outputOptions}
              onChange={(next) => set('outputOptions', next)}
              legend="Output"
            />
          </div>
          <div className="field span2">
            <label>Output file name (optional)</label>
            <input
              type="text"
              value={draft.outputFileName ?? ''}
              onChange={(e) => set('outputFileName', e.target.value)}
              placeholder="e.g. acme-order-{jobId}.xml"
            />
            <span className="help">
              You can use {'{jobId}'}, {'{date}'}, {'{time}'} and {'{funnelId}'} as placeholders.
            </span>
          </div>
        </div>
      </div>

      <div className="card card-pad section">
        <h2>Test this funnel</h2>
        {isNew ? (
          <p className="help" style={{ color: 'var(--text-muted)' }}>
            Create the funnel first, then you can paste a sample file here and see each step run —
            without creating a real job or delivering anything.
          </p>
        ) : (
          <>
            <p className="help" style={{ color: 'var(--text-muted)', marginTop: 0 }}>
              Paste the content of a sample file (for example the contents of{' '}
              <code>samples/acme-orders.csv</code> or <code>samples/globex-order.json</code> from
              the repository) and run it through the whole pipeline. Nothing is delivered and no
              job is created.
            </p>
            <div className="form-grid">
              <div className="field span2">
                <label>Sample file content</label>
                <textarea
                  value={testContent}
                  onChange={(e) => setTestContent(e.target.value)}
                  placeholder={TEST_PLACEHOLDER}
                  rows={9}
                />
              </div>
              <div className="field">
                <label>File name (optional)</label>
                <input
                  type="text"
                  value={testFileName}
                  onChange={(e) => setTestFileName(e.target.value)}
                  placeholder="e.g. orders.csv"
                />
              </div>
            </div>
            <div className="btn-row" style={{ marginTop: 14, alignItems: 'center', gap: 10 }}>
              <button type="button" className="btn primary" onClick={runTest} disabled={testing || saving}>
                {testing ? 'Running…' : 'Run test'}
              </button>
              {dirty && (
                <span className="help" style={{ color: 'var(--text-muted)' }}>
                  Your unsaved changes will be saved before the test runs.
                </span>
              )}
            </div>
            {testError && (
              <div className="test-result">
                <ErrorBanner message={testError} />
              </div>
            )}
            {testResult && (
              <div className="test-result">
                <div className={`banner ${testResult.ok ? 'success' : 'error'}`}>
                  {testResult.ok
                    ? 'Test run succeeded — every step completed.'
                    : 'Test run failed — see the step that went wrong below.'}
                </div>
                <StageTimeline stages={testResult.stages} />
                {testResult.outputText !== undefined && (
                  <>
                    <h2 style={{ marginTop: 18 }}>Final output</h2>
                    <pre>{testResult.outputText}</pre>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

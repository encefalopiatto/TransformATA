/**
 * Visual mapping editor (FigJam-style node canvas + JSONata code mode).
 *
 * Contract (mounted by App.tsx):
 * - default export, props { transformId: string }
 * - loads GET /api/admin/transforms/:id, saves PUT /api/admin/transforms/:id
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './editor.css';
import type { CompileResult, TransformConfig } from '@transformata/shared';
import {
  compileGraph,
  evaluateExpression,
  jsonataSyntaxError,
  specByKey,
  type NodeSpec,
} from '@transformata/shared';
import { api, ApiRequestError } from '../api';
import { ErrorBanner, Loading } from '../components/ui';
import { DRAG_MIME, Palette } from './Palette';
import { Inspector } from './Inspector';
import { NodeErrorsContext, TfaNode } from './TfaNode';
import {
  freshFlow,
  freshNodeId,
  nodeFromSpec,
  pruneEdges,
  toFlow,
  toTGraph,
  type TfaFlowNode,
} from './graphFlow';

const nodeTypes: NodeTypes = { tfa: TfaNode };

type Mode = 'visual' | 'code';
type BottomTab = 'sample' | 'jsonata' | 'preview';

interface PreviewState {
  state: 'idle' | 'running' | 'ok' | 'error';
  text: string;
}

type SampleParse =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function parseSample(text: string): SampleParse {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export default function EditorScreen({ transformId }: { transformId: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner transformId={transformId} />
    </ReactFlowProvider>
  );
}

function EditorInner({ transformId }: { transformId: string }) {
  const [transform, setTransform] = useState<TransformConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('visual');
  const [nodes, setNodes] = useState<TfaFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  /** True when a graph exists for this mapping (loaded or started this session). */
  const [hasGraph, setHasGraph] = useState(false);
  const [code, setCode] = useState('');
  const [codeEdited, setCodeEdited] = useState(false);

  const [sampleText, setSampleText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  const [tab, setTab] = useState<BottomTab>('preview');
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle', text: '' });
  const [errorsDismissed, setErrorsDismissed] = useState(false);

  const reactFlow = useReactFlow<TfaFlowNode>();
  const canvasRef = useRef<HTMLDivElement>(null);
  const addCascade = useRef(0);

  /* ------------------------------- load ------------------------------- */

  useEffect(() => {
    let cancelled = false;
    setTransform(null);
    setLoadError(null);
    api
      .getTransform(transformId)
      .then((t) => {
        if (cancelled) return;
        setTransform(t);
        setSampleText(
          t.sampleInput === undefined || t.sampleInput === null
            ? ''
            : JSON.stringify(t.sampleInput, null, 2),
        );
        setCode(t.jsonata);
        const trimmed = t.jsonata.trim();
        if (t.graph && t.graph.nodes.length > 0) {
          const flow = toFlow(t.graph);
          setNodes(flow.nodes);
          setEdges(flow.edges);
          setHasGraph(true);
          setMode('visual');
        } else if (trimmed === '' || trimmed === '$') {
          // Brand-new mapping: start in visual mode with input → output.
          const flow = freshFlow();
          setNodes(flow.nodes);
          setEdges(flow.edges);
          setHasGraph(true);
          setMode('visual');
        } else {
          // Hand-written JSONata without a graph: open in code mode.
          setHasGraph(false);
          setMode('code');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [transformId]);

  /* ----------------------------- compile ------------------------------ */

  const compiled: CompileResult | null = useMemo(() => {
    if (mode !== 'visual' || !hasGraph) return null;
    return compileGraph(toTGraph(nodes, edges));
  }, [mode, hasGraph, nodes, edges]);

  const compileErrors = compiled && !compiled.ok ? compiled.errors : [];
  const compileWarnings = compiled && compiled.ok ? compiled.warnings : [];

  const nodeErrors = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const issue of compileErrors) {
      if (!issue.nodeId) continue;
      (map[issue.nodeId] ??= []).push(issue.message);
    }
    return map;
  }, [compileErrors]);

  const errorSignature = compileErrors
    .map((issue) => `${issue.nodeId ?? ''}:${issue.message}`)
    .join('|');
  useEffect(() => {
    setErrorsDismissed(false);
  }, [errorSignature]);

  const codeSyntaxError = useMemo(
    () => (mode === 'code' && code.trim() !== '' ? jsonataSyntaxError(code) : null),
    [mode, code],
  );

  /** The expression currently being authored (null while the graph has errors). */
  const expression: string | null =
    mode === 'code' ? code : compiled && compiled.ok ? compiled.expression : null;

  /* ------------------------------ preview ----------------------------- */

  const sample = useMemo(() => parseSample(sampleText), [sampleText]);

  useEffect(() => {
    if (expression === null) {
      setPreview({ state: 'error', text: 'Fix the graph errors to see a preview.' });
      return;
    }
    if (expression.trim() === '') {
      setPreview({ state: 'idle', text: '' });
      return;
    }
    if (!sample.ok) {
      setPreview({ state: 'error', text: `Sample input is not valid JSON:\n${sample.error}` });
      return;
    }
    let cancelled = false;
    setPreview((p) => ({ ...p, state: 'running' }));
    const timer = setTimeout(() => {
      void evaluateExpression(expression, sample.value, 5000).then((result) => {
        if (cancelled) return;
        setPreview(
          result.ok
            ? { state: 'ok', text: JSON.stringify(result.output, null, 2) ?? 'null' }
            : { state: 'error', text: result.error },
        );
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [expression, sample]);

  /* --------------------------- graph editing -------------------------- */

  const onNodesChange = useCallback((changes: NodeChange<TfaFlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    if (changes.some((c) => c.type === 'position' || c.type === 'remove' || c.type === 'add')) {
      setDirty(true);
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
    if (changes.some((c) => c.type === 'remove' || c.type === 'add')) setDirty(true);
  }, []);

  // Max ONE incoming edge per (node, targetHandle): replace on reconnect.
  const onConnect = useCallback((conn: Connection) => {
    setEdges((es) => [
      ...es.filter((e) => !(e.target === conn.target && e.targetHandle === conn.targetHandle)),
      {
        id: freshNodeId('edge'),
        source: conn.source,
        sourceHandle: conn.sourceHandle ?? 'out',
        target: conn.target,
        targetHandle: conn.targetHandle,
        animated: true,
      },
    ]);
    setDirty(true);
  }, []);

  const setCfg = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      const next = nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, cfg: { ...n.data.cfg, ...patch } } } : n,
      );
      setNodes(next);
      setEdges((es) => pruneEdges(next, es));
      setDirty(true);
    },
    [nodes],
  );

  const replaceCfg = useCallback(
    (id: string, cfg: Record<string, unknown>) => {
      const next = nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, cfg } } : n));
      setNodes(next);
      setEdges((es) => pruneEdges(next, es));
      setDirty(true);
    },
    [nodes],
  );

  const renameKey = useCallback(
    (id: string, oldKey: string, newKey: string) => {
      const next = nodes.map((n) => {
        if (n.id !== id) return n;
        const keys = Array.isArray(n.data.cfg.keys) ? (n.data.cfg.keys as unknown[]) : [];
        return {
          ...n,
          data: {
            ...n.data,
            cfg: { ...n.data.cfg, keys: keys.map((k) => (k === oldKey ? newKey : k)) },
          },
        };
      });
      setNodes(next);
      // Rewire the renamed key's edge to the new handle, then prune leftovers.
      setEdges((es) =>
        pruneEdges(
          next,
          es.map((e) =>
            e.target === id && e.targetHandle === `key:${oldKey}`
              ? { ...e, targetHandle: `key:${newKey}` }
              : e,
          ),
        ),
      );
      setDirty(true);
    },
    [nodes],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setDirty(true);
    },
    [],
  );

  const addNode = useCallback(
    (spec: NodeSpec, screenPosition?: { x: number; y: number }) => {
      let position: { x: number; y: number };
      if (screenPosition) {
        position = reactFlow.screenToFlowPosition(screenPosition);
      } else {
        const bounds = canvasRef.current?.getBoundingClientRect();
        const cascade = (addCascade.current++ % 8) * 28;
        position = reactFlow.screenToFlowPosition({
          x: (bounds ? bounds.left + bounds.width / 2 : 400) - 60 + cascade,
          y: (bounds ? bounds.top + bounds.height / 3 : 200) + cascade,
        });
      }
      const node = nodeFromSpec(spec, position);
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...node, selected: true }]);
      setDirty(true);
    },
    [reactFlow],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer.types.includes(DRAG_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const key = event.dataTransfer.getData(DRAG_MIME);
      if (!key) return;
      event.preventDefault();
      const spec = specByKey(key);
      if (spec) addNode(spec, { x: event.clientX, y: event.clientY });
    },
    [addNode],
  );

  const focusNode = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      const w = (node.measured?.width ?? 170) / 2;
      const h = (node.measured?.height ?? 70) / 2;
      reactFlow.setCenter(node.position.x + w, node.position.y + h, {
        zoom: Math.max(reactFlow.getZoom(), 1),
        duration: 350,
      });
    },
    [nodes, reactFlow],
  );

  const selectedNode = useMemo(() => nodes.find((n) => n.selected) ?? null, [nodes]);

  /* ---------------------------- mode toggle --------------------------- */

  const switchToCode = useCallback(() => {
    if (mode === 'code' || !transform) return;
    if (hasGraph) {
      const ok = window.confirm(
        'Switch to Code mode?\n\nThe graph is kept, but code edits will be LOST if you later switch back to Visual mode — the code is then recompiled from the graph.',
      );
      if (!ok) return;
    }
    setCode(compiled && compiled.ok ? compiled.expression : transform.jsonata);
    setCodeEdited(false);
    setMode('code');
  }, [mode, transform, hasGraph, compiled]);

  const switchToVisual = useCallback(() => {
    if (mode === 'visual' || !transform) return;
    if (hasGraph) {
      if (
        codeEdited &&
        !window.confirm(
          'Switch to Visual mode?\n\nYour code edits are discarded — the code is recompiled from the graph.',
        )
      ) {
        return;
      }
      setCodeEdited(false);
      setMode('visual');
    } else {
      const ok = window.confirm(
        'Start a visual graph?\n\nA fresh Input → Output graph is created. It replaces the hand-written code the next time you save.',
      );
      if (!ok) return;
      const flow = freshFlow();
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setHasGraph(true);
      setMode('visual');
      setDirty(true);
    }
  }, [mode, transform, hasGraph, codeEdited]);

  /* -------------------------------- save ------------------------------ */

  const save = useCallback(async () => {
    if (!transform || saving) return;
    setSaving(true);
    setSaveError(null);
    const body: TransformConfig = { ...transform };
    // Only update the sample when its text is valid JSON (empty clears it).
    if (sample.ok) {
      body.sampleInput = sampleText.trim() === '' ? null : sample.value;
    }
    if (mode === 'visual') {
      body.graph = toTGraph(nodes, edges);
      body.jsonata = compiled && compiled.ok ? compiled.expression : transform.jsonata;
    } else {
      body.jsonata = code;
      body.graph = null;
    }
    try {
      const saved = await api.updateTransform(transformId, body);
      setTransform(saved);
      setDirty(false);
      setSavedOnce(true);
      if (mode === 'code') {
        // The graph is now detached server-side.
        setHasGraph(false);
        setNodes([]);
        setEdges([]);
      }
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [transform, saving, sample, sampleText, mode, nodes, edges, compiled, code, transformId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  /* ------------------------------- render ----------------------------- */

  if (loadError) {
    return (
      <div className="tfa-ed">
        <div className="tfa-ed-banner" style={{ marginTop: 16 }}>
          <ErrorBanner message={`Could not load the mapping: ${loadError}`} />
        </div>
      </div>
    );
  }
  if (!transform) {
    return (
      <div className="tfa-ed">
        <Loading label="Loading mapping…" />
      </div>
    );
  }

  const showErrorsPanel = mode === 'visual' && compileErrors.length > 0 && !errorsDismissed;

  return (
    <div className="tfa-ed">
      <header className="tfa-ed-header">
        <div className="tfa-ed-title">
          <span className="tfa-ed-name" title={transform.name}>
            {transform.name}
          </span>
          <span className={`tfa-ed-kind tfa-ed-kind-${transform.kind}`}>{transform.kind}</span>
        </div>
        <div className="tfa-ed-mode" role="group" aria-label="Editor mode">
          <button
            type="button"
            className={mode === 'visual' ? 'active' : ''}
            onClick={switchToVisual}
          >
            Visual
          </button>
          <button type="button" className={mode === 'code' ? 'active' : ''} onClick={switchToCode}>
            Code
          </button>
        </div>
        <div className="tfa-ed-actions">
          {dirty ? (
            <span className="tfa-ed-dirty">● Unsaved changes</span>
          ) : savedOnce ? (
            <span className="tfa-ed-saved">✓ Saved</span>
          ) : null}
          <button
            type="button"
            className="btn primary"
            disabled={saving}
            onClick={() => void save()}
            title="Save (Ctrl/Cmd+S)"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {saveError && (
        <div className="tfa-ed-banner">
          <ErrorBanner message={`Save failed: ${saveError}`} />
        </div>
      )}

      <div className="tfa-ed-main">
        {mode === 'visual' ? (
          <>
            <Palette onAdd={(spec) => addNode(spec)} />
            <div className="tfa-ed-canvas" ref={canvasRef} onDrop={onDrop} onDragOver={onDragOver}>
              <NodeErrorsContext.Provider value={nodeErrors}>
                <ReactFlow<TfaFlowNode>
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  deleteKeyCode={['Backspace', 'Delete']}
                  defaultEdgeOptions={{ animated: true }}
                  fitView
                  fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
                  minZoom={0.2}
                >
                  <Background gap={18} />
                  <Controls />
                  <MiniMap pannable zoomable />
                </ReactFlow>
              </NodeErrorsContext.Provider>
              {showErrorsPanel && (
                <div className="tfa-ed-errors" role="alert">
                  <div className="tfa-ed-errors-head">
                    <span>
                      {compileErrors.length} problem{compileErrors.length === 1 ? '' : 's'} in the
                      graph
                    </span>
                    <button
                      type="button"
                      className="tfa-ed-errors-close"
                      aria-label="Dismiss"
                      onClick={() => setErrorsDismissed(true)}
                    >
                      ✕
                    </button>
                  </div>
                  {compileErrors.map((issue, i) => (
                    <button
                      key={`${issue.nodeId ?? ''}-${i}`}
                      type="button"
                      className={`tfa-ed-error-item${issue.nodeId ? ' is-clickable' : ''}`}
                      onClick={issue.nodeId ? () => focusNode(issue.nodeId!) : undefined}
                    >
                      {issue.message}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Inspector
              node={selectedNode}
              onSetCfg={setCfg}
              onReplaceCfg={replaceCfg}
              onRenameKey={renameKey}
              onDelete={deleteNode}
            />
          </>
        ) : (
          <div className="tfa-ed-code">
            <textarea
              value={code}
              spellCheck={false}
              placeholder="Write your JSONata mapping here…"
              onChange={(e) => {
                setCode(e.target.value);
                setCodeEdited(true);
                setDirty(true);
              }}
            />
            {codeSyntaxError !== null && (
              <div className="tfa-ed-inline-error">JSONata syntax error: {codeSyntaxError}</div>
            )}
          </div>
        )}
      </div>

      <div className="tfa-ed-bottom">
        <div className="tfa-ed-bottom-tabs" role="tablist">
          <button
            type="button"
            className={tab === 'sample' ? 'active' : ''}
            onClick={() => setTab('sample')}
          >
            Sample input
            {!sample.ok && <span className="tfa-ed-tab-flag">●</span>}
          </button>
          <button
            type="button"
            className={tab === 'jsonata' ? 'active' : ''}
            onClick={() => setTab('jsonata')}
          >
            {mode === 'visual' ? 'Compiled JSONata' : 'JSONata'}
            {mode === 'visual' && compileErrors.length > 0 && (
              <span className="tfa-ed-tab-flag">●</span>
            )}
          </button>
          <button
            type="button"
            className={tab === 'preview' ? 'active' : ''}
            onClick={() => setTab('preview')}
          >
            Preview
            {preview.state === 'error' && <span className="tfa-ed-tab-flag">●</span>}
          </button>
        </div>
        <div className="tfa-ed-bottom-body">
          {tab === 'sample' && (
            <>
              <textarea
                className="tfa-ed-sample"
                value={sampleText}
                spellCheck={false}
                placeholder='Paste a sample input document (JSON), e.g. { "rows": [ … ] }'
                onChange={(e) => {
                  setSampleText(e.target.value);
                  setDirty(true);
                }}
              />
              {!sample.ok && (
                <div className="tfa-ed-inline-error">Not valid JSON: {sample.error}</div>
              )}
            </>
          )}
          {tab === 'jsonata' &&
            (expression !== null ? (
              <>
                <pre className="tfa-ed-pre">{expression || '(empty expression)'}</pre>
                {compileWarnings.length > 0 && (
                  <ul className="tfa-ed-warnings">
                    {compileWarnings.map((w, i) => (
                      <li key={i}>{w.message}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="tfa-ed-inline-error">
                The graph has errors — fix them to see the compiled JSONata.
              </div>
            ))}
          {tab === 'preview' &&
            (preview.state === 'error' ? (
              <div className="tfa-ed-preview-error">{preview.text}</div>
            ) : (
              <>
                <pre className="tfa-ed-pre">
                  {preview.state === 'idle' ? '(nothing to preview yet)' : preview.text}
                </pre>
                <div className="tfa-ed-preview-hint">
                  {preview.state === 'running'
                    ? 'Evaluating…'
                    : 'Live result of the expression against the sample input.'}
                </div>
              </>
            ))}
        </div>
      </div>
    </div>
  );
}

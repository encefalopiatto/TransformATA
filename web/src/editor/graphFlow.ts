/**
 * Conversion between the persisted TGraph format (shared contract) and
 * React Flow's node/edge state, plus small graph-editing helpers.
 */
import type { Edge, Node } from '@xyflow/react';
import type { GraphNodeType, TGraph } from '@transformata/shared';
import { resolveInputHandles, specByKey, type NodeSpec } from '@transformata/shared';

export interface TfaNodeData extends Record<string, unknown> {
  kind: GraphNodeType;
  cfg: Record<string, unknown>;
}

export type TfaFlowNode = Node<TfaNodeData, 'tfa'>;

let seq = 0;

export function freshNodeId(kind: string): string {
  seq += 1;
  return `${kind}-${Date.now().toString(36)}-${seq}`;
}

export function toFlow(graph: TGraph): { nodes: TfaFlowNode[]; edges: Edge[] } {
  const nodes: TfaFlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'tfa',
    position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
    data: { kind: n.type, cfg: { ...(n.data ?? {}) } },
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? 'out',
    target: e.target,
    targetHandle: e.targetHandle ?? null,
    animated: true,
  }));
  return { nodes, edges };
}

export function toTGraph(nodes: TfaFlowNode[], edges: Edge[]): TGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.kind,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: { ...n.data.cfg },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? 'out',
      target: e.target,
      targetHandle: e.targetHandle ?? null,
    })),
  };
}

/** A fresh starter graph: an Input node wired straight into an Output node. */
export function freshFlow(): { nodes: TfaFlowNode[]; edges: Edge[] } {
  const inputId = freshNodeId('input');
  const outputId = freshNodeId('output');
  return {
    nodes: [
      {
        id: inputId,
        type: 'tfa',
        position: { x: 80, y: 160 },
        data: { kind: 'input', cfg: {} },
      },
      {
        id: outputId,
        type: 'tfa',
        position: { x: 420, y: 160 },
        data: { kind: 'output', cfg: {} },
      },
    ],
    edges: [
      {
        id: freshNodeId('edge'),
        source: inputId,
        sourceHandle: 'out',
        target: outputId,
        targetHandle: 'in',
        animated: true,
      },
    ],
  };
}

/** Create a new flow node from a catalog entry. */
export function nodeFromSpec(spec: NodeSpec, position: { x: number; y: number }): TfaFlowNode {
  return {
    id: freshNodeId(spec.type),
    type: 'tfa',
    position,
    data: {
      kind: spec.type,
      // structuredClone keeps nested defaults (lookup table, keys array) unshared
      cfg: structuredClone(spec.defaultData),
    },
  };
}

export function specFromKey(key: string): NodeSpec | undefined {
  return specByKey(key);
}

/**
 * Drop edges whose target handle no longer exists on the target node
 * (after key removal/rename or count decrease) or whose nodes are gone.
 */
export function pruneEdges(nodes: TfaFlowNode[], edges: Edge[]): Edge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = edges.filter((e) => {
    const target = byId.get(e.target);
    if (!target || !byId.has(e.source)) return false;
    if (!e.targetHandle) return false;
    const handles = resolveInputHandles(target.data.kind, target.data.cfg);
    return handles.some((h) => h.id === e.targetHandle);
  });
  return kept.length === edges.length ? edges : kept;
}

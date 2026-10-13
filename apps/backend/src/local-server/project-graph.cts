import * as crypto from 'node:crypto';

type DynamicNodeGraphSettings = Record<string, unknown>;
type DynamicNodeGraphExtra = Record<string, unknown>;

interface NodeGraphBase {
  id: string;
  name: string;
  nodes: unknown[];
  settings: DynamicNodeGraphSettings;
}

type NodeGraph = NodeGraphBase & DynamicNodeGraphExtra;

interface RawNodeGraph {
  id: unknown | undefined;
  name: unknown | undefined;
  nodes: unknown | undefined;
  settings: unknown | undefined;
}

const normalizeNodeGraph = (raw: unknown): NodeGraph | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as RawNodeGraph;
  const id =
    typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : crypto.randomUUID();
  const name = typeof obj.name === 'string' ? obj.name : '';
  const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const settings = obj.settings && typeof obj.settings === 'object' ? (obj.settings as DynamicNodeGraphSettings) : ({} as DynamicNodeGraphSettings);
  return { ...(raw as DynamicNodeGraphExtra), id, name, nodes, settings };
};

const buildGraphPayload = (nodeGraph: unknown): DynamicNodeGraphExtra | null => {
  if (!nodeGraph || typeof nodeGraph !== 'object') return null;
  const { nodes: _nodes, ...rest } = nodeGraph as NodeGraphBase & DynamicNodeGraphExtra;
  return { ...rest };
};

const buildNodeGraphFromPayload = (payload: unknown, nodes: unknown) => {
  const base = payload && typeof payload === 'object' ? (payload as RawNodeGraph) : ({} as RawNodeGraph);
  return {
    ...base,
    nodes: Array.isArray(nodes) ? nodes : [],
  };
};

export {
  normalizeNodeGraph,
  buildGraphPayload,
  buildNodeGraphFromPayload,
};

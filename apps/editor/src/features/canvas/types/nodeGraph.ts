/**
 * 画板类型定义
 * - 定义画板的整体结构
 * - 包含节点、元数据等
 */

import type { GraphNode } from './node';
import type { CanvasAnnotation } from './annotation';

/** 画板状态 */
export type NodeGraphStatus =
  | 'draft'       // 草稿
  | 'published'   // 已发布
  | 'archived';   // 已归档

/** 画板元数据 */
export interface NodeGraphMeta {
  /** 画板版本 */
  version: string;
  /** 当前持久化结构版本，用于跳过重复的打开期整图修复 */
  schemaVersion: number | undefined;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 创建者 */
  createdBy: string | undefined;
  /** 标签 */
  tags: string[] | undefined;
  /** 分类 */
  category: string | undefined;
  /** 当前项目已选角色 ID 列表 */
  selectedCharacterIds: string[] | undefined;
}

/** 画板变量定义 */
export interface NodeGraphVariable {
  /** 变量名 */
  name: string;
  /** 变量类型 */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  /** 默认值 */
  defaultValue: unknown | undefined;
  /** 变量描述 */
  description: string | undefined;
  /** 是否必需 */
  required: boolean | undefined;
}

/** 画板设置 */
export interface NodeGraphSettings {
  /** 自动保存 */
  autoSave: boolean | undefined;
  /** 执行超时（毫秒） */
  executionTimeout: number | undefined;
  /** 最大并发节点数 */
  maxConcurrentNodes: number | undefined;
  /** 失败时是否继续 */
  continueOnFailure: boolean | undefined;
  /** 是否记录执行日志 */
  enableLogging: boolean | undefined;
  /** 是否吸附到网格 */
  snapToGrid: boolean | undefined;
  /** 网格尺寸，默认为 15px */
  snapGrid: [number, number] | undefined;
}

/** 画板视图设置 */
export interface NodeGraphViewport {
  /** 缩放级别 */
  zoom: number;
  /** X 偏移 */
  x: number;
  /** Y 偏移 */
  y: number;
}

/** 画布容器屏幕像素尺寸（React Flow 容器实测，仅会话态，不持久化） */
export interface CanvasContainerSize {
  width: number;
  height: number;
}

export const DEFAULT_SNAP_GRID: [number, number] = [15, 15];
export const CURRENT_NODE_GRAPH_SCHEMA_VERSION = 3;

export const DEFAULT_NODEGRAPH_SETTINGS: Required<NodeGraphSettings> = {
  autoSave: true,
  // 0 表示不超时：长耗时任务由 Hub Task 持续执行，前端仅负责展示
  executionTimeout: 0,
  maxConcurrentNodes: 3,
  continueOnFailure: false,
  enableLogging: true,
  snapToGrid: false,
  snapGrid: DEFAULT_SNAP_GRID,
};

const isValidSnapValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export const normalizeSnapGrid = (snapGrid: NodeGraphSettings['snapGrid'] | undefined): [number, number] => {
  if (Array.isArray(snapGrid) && snapGrid.length === 2) {
    const [x, y] = snapGrid;
    if (isValidSnapValue(x) && isValidSnapValue(y)) {
      return [x, y];
    }
  }
  return [...DEFAULT_SNAP_GRID];
};

export const normalizeNodeGraphSettings = (settings: NodeGraphSettings | null | undefined): Required<NodeGraphSettings> => {
  const snapGrid = normalizeSnapGrid((settings !== null && settings !== undefined ? settings.snapGrid : undefined));
  return {
    autoSave: (settings !== null && settings !== undefined ? settings.autoSave : undefined) ?? DEFAULT_NODEGRAPH_SETTINGS.autoSave,
    executionTimeout: (settings !== null && settings !== undefined ? settings.executionTimeout : undefined) ?? DEFAULT_NODEGRAPH_SETTINGS.executionTimeout,
    maxConcurrentNodes: (settings !== null && settings !== undefined ? settings.maxConcurrentNodes : undefined) ?? DEFAULT_NODEGRAPH_SETTINGS.maxConcurrentNodes,
    continueOnFailure: (settings !== null && settings !== undefined ? settings.continueOnFailure : undefined) ?? DEFAULT_NODEGRAPH_SETTINGS.continueOnFailure,
    enableLogging: (settings !== null && settings !== undefined ? settings.enableLogging : undefined) ?? DEFAULT_NODEGRAPH_SETTINGS.enableLogging,
    snapToGrid: (settings !== null && settings !== undefined ? settings.snapToGrid : undefined) ?? DEFAULT_NODEGRAPH_SETTINGS.snapToGrid,
    snapGrid,
  };
};

export const normalizeNodeGraphSchemaVersion = (schemaVersion: unknown | undefined): number => {
  const nextValue = Number(schemaVersion);
  return Number.isInteger(nextValue) && nextValue > 0 ? nextValue : 0;
};

export const isNodeGraphOnCurrentSchema = (meta: Pick<NodeGraphMeta, 'schemaVersion'> | null | undefined): boolean =>
  normalizeNodeGraphSchemaVersion((meta !== null && meta !== undefined ? meta.schemaVersion : undefined)) >= CURRENT_NODE_GRAPH_SCHEMA_VERSION;

/** 画板定义 */
export interface NodeGraph {
  /** 画板唯一标识 */
  id: string;
  /** 画板名称 */
  name: string;
  /** 画板描述 */
  description: string | undefined;
  /** 画板状态 */
  status: NodeGraphStatus;
  /** 画板节点 */
  nodes: GraphNode[];
  /** 画板注释 */
  annotations: CanvasAnnotation[] | undefined;
  /** 画板变量 */
  variables: NodeGraphVariable[] | undefined;
  /** 画板设置 */
  settings: NodeGraphSettings | undefined;
  /** 视图设置 */
  viewport: NodeGraphViewport | undefined;
  /** 元数据 */
  meta: NodeGraphMeta;
}

/** 画板摘要（用于列表展示） */
export interface NodeGraphSummary {
  id: string;
  name: string;
  description: string | undefined;
  status: NodeGraphStatus;
  nodeCount: number;
  tags: string[] | undefined;
  category: string | undefined;
  updatedAt: string;
}

/** 创建画板参数 */
export interface CreateNodeGraphParams {
  name: string;
  description: string | undefined;
  tags: string[] | undefined;
  category: string | undefined;
}

/** 生成唯一画板 ID */
export function generateNodeGraphId(): string {
  return `ng_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** 创建新画板 */
export function createNodeGraph(params: CreateNodeGraphParams): NodeGraph {
  const now = new Date().toISOString();
  const meta: NodeGraphMeta = {
    version: '1.0.0',
    schemaVersion: CURRENT_NODE_GRAPH_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    createdBy: undefined,
    tags: params.tags ?? undefined,
    category: params.category ?? undefined,
    selectedCharacterIds: undefined,
  };
  return {
    id: generateNodeGraphId(),
    name: params.name,
    description: params.description ?? undefined,
    status: 'draft',
    nodes: [],
    annotations: [],
    variables: [],
    settings: {
      ...DEFAULT_NODEGRAPH_SETTINGS,
      snapGrid: DEFAULT_SNAP_GRID,
    },
    viewport: {
      zoom: 1,
      x: 0,
      y: 0,
    },
    meta,
  };
}

/** 从画板生成摘要 */
export function toNodeGraphSummary(nodeGraph: NodeGraph): NodeGraphSummary {
  return {
    id: nodeGraph.id,
    name: nodeGraph.name,
    description: nodeGraph.description,
    status: nodeGraph.status,
    nodeCount: nodeGraph.nodes.length,
    tags: nodeGraph.meta.tags,
    category: nodeGraph.meta.category,
    updatedAt: nodeGraph.meta.updatedAt,
  };
}

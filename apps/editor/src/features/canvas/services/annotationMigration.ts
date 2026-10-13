import type { CanvasAnnotation, GraphNode, NodeGraph, NodePosition, NodeSize } from '../types';
import {
  DEFAULT_ANNOTATION_SIZE,
  DEFAULT_ANNOTATION_STYLE,
  generateAnnotationId,
  type AnnotationBinding,
} from '../types/annotation';
import { clampAnnotationSize } from '../utils/annotationLayout';

interface AnnotationStyleRecord {
  color: unknown | undefined;
  fontSize: unknown | undefined;
}

interface AnnotationRawRecord {
  id: unknown | undefined;
  binding: unknown | undefined;
  content: unknown | undefined;
  position: unknown | undefined;
  size: unknown | undefined;
  style: unknown | undefined;
}

interface LegacyNoteData {
  content: unknown | undefined;
  color: unknown | undefined;
}

const EMPTY_ANNOTATION_STYLE_RECORD: AnnotationStyleRecord = {
  color: undefined,
  fontSize: undefined,
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const coercePosition = (value: unknown, fallback: NodePosition): NodePosition => {
  if (!value || typeof value !== 'object') return fallback;
  const record = value as { x: unknown | undefined; y: unknown | undefined };
  return {
    x: isFiniteNumber(record.x) ? record.x : fallback.x,
    y: isFiniteNumber(record.y) ? record.y : fallback.y,
  };
};

const coerceSize = (value: unknown, fallback: NodeSize): NodeSize => {
  if (!value || typeof value !== 'object') return fallback;
  const record = value as { width: unknown | undefined; height: unknown | undefined };
  return clampAnnotationSize({
    width: isFiniteNumber(record.width) ? record.width : fallback.width,
    height: isFiniteNumber(record.height) ? record.height : fallback.height,
  });
};

const normalizeBinding = (
  value: unknown,
  refs: { nodeIdSet: Set<string> }
): AnnotationBinding | null => {
  if (!value || typeof value !== 'object') return { type: 'free' };
  const record = value as { type: unknown | undefined; nodeId: unknown | undefined; edgeId: unknown | undefined; groupId: unknown | undefined };
  const type = record.type;
  if (type === 'free') return { type: 'free' };
  if (type === 'node') {
    const nodeId = typeof record.nodeId === 'string' ? record.nodeId : '';
    if (!nodeId || !refs.nodeIdSet.has(nodeId)) return null;
    return { type: 'node', nodeId };
  }
  // 旧连线/组绑定注释降级为自由注释（连线与组绑定已退场）
  return { type: 'free' };
};

const normalizeAnnotationStyle = (value: unknown): CanvasAnnotation['style'] => {
  const record = value && typeof value === 'object' ? (value as AnnotationStyleRecord) : EMPTY_ANNOTATION_STYLE_RECORD;
  const colorCandidate = record.color;
  const color = typeof colorCandidate === 'string' && colorCandidate.trim() ? colorCandidate.trim() : DEFAULT_ANNOTATION_STYLE.color;
  const fontSizeCandidate = record.fontSize;
  const fontSize = isFiniteNumber(fontSizeCandidate) ? Math.min(Math.max(Math.round(fontSizeCandidate), 10), 64) : DEFAULT_ANNOTATION_STYLE.fontSize;
  return { color, fontSize };
};

export type AnnotationMigrationResult = {
  nodeGraph: NodeGraph;
  migratedLegacyNoteCount: number;
  droppedAnnotationCount: number;
};

/**
 * 迁移/规范化 NodeGraph.annotations
 * - 将旧版 note 节点转换为自由注释
 * - 修剪绑定到不存在对象的注释
 * - 同一对象最多绑定 1 条注释（多余的会被丢弃）
 */
export function migrateNodeGraphAnnotations(nodeGraph: NodeGraph): AnnotationMigrationResult {
  const legacyNotes: GraphNode[] = [];
  const retainedNodes: GraphNode[] = [];
  for (const node of nodeGraph.nodes ?? []) {
    const isNoteType = (node as { type: unknown | undefined }).type === 'note';
    if (!isNoteType) {
      retainedNodes.push(node);
      continue;
    }
    legacyNotes.push(node);
  }

  const baseAnnotationsRaw = (nodeGraph as { annotations: unknown | undefined }).annotations;
  const baseAnnotations: CanvasAnnotation[] = Array.isArray(baseAnnotationsRaw)
    ? (baseAnnotationsRaw as CanvasAnnotation[])
    : [];

  const migratedFromNotes: CanvasAnnotation[] = legacyNotes.map((node) => {
    const data = (node as { data: unknown | undefined }).data as LegacyNoteData | undefined;
    const contentCandidate = data !== undefined ? data.content : undefined;
    const colorCandidate = data !== undefined ? data.color : undefined;
    const content = typeof contentCandidate === 'string' ? contentCandidate : '';
    const color = typeof colorCandidate === 'string' && colorCandidate.trim() ? colorCandidate.trim() : DEFAULT_ANNOTATION_STYLE.color;
    const position = coercePosition(node.position, { x: 0, y: 0 });
    const size = clampAnnotationSize(node.size ?? DEFAULT_ANNOTATION_SIZE);
    return {
      id: generateAnnotationId(),
      content,
      position,
      size,
      binding: { type: 'free' },
      style: { ...DEFAULT_ANNOTATION_STYLE, color },
    };
  });

  const mergedAnnotations = [...baseAnnotations, ...migratedFromNotes];

  const nodeIdSet = new Set(retainedNodes.map((n) => n.id));

  const refs = { nodeIdSet };

  const usedIds = new Set<string>();
  const usedBindings = new Set<string>();
  const normalizedAnnotations: CanvasAnnotation[] = [];
  let droppedAnnotationCount = 0;

  for (const raw of mergedAnnotations) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as AnnotationRawRecord;

    let id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : generateAnnotationId();
    while (usedIds.has(id)) {
      id = generateAnnotationId();
    }

    const binding = normalizeBinding(record.binding, refs);
    if (binding === null) {
      // 绑定对象不存在：按设计应随对象删除，这里直接丢弃
      droppedAnnotationCount += 1;
      continue;
    }

    if (binding.type !== 'free') {
      const key = `node:${binding.nodeId}`;
      if (usedBindings.has(key)) {
        droppedAnnotationCount += 1;
        continue;
      }
      usedBindings.add(key);
    }

    const content = typeof record.content === 'string' ? record.content : '';
    const position = coercePosition(record.position, { x: 0, y: 0 });
    const size = coerceSize(record.size, DEFAULT_ANNOTATION_SIZE);
    const style = normalizeAnnotationStyle(record.style);

    usedIds.add(id);
    normalizedAnnotations.push({
      id,
      content,
      position,
      size,
      binding,
      style,
    });
  }

  const nextNodeGraph: NodeGraph = {
    ...nodeGraph,
    nodes: retainedNodes,
    annotations: normalizedAnnotations,
  };

  return {
    nodeGraph: nextNodeGraph,
    migratedLegacyNoteCount: legacyNotes.length,
    droppedAnnotationCount,
  };
}

import { describe, expect, it } from 'vitest';

import { migrateNodeGraphAnnotations } from '../annotationMigration';
import type { CanvasAnnotation, GraphNode, NodeGraph } from '../../types';
import {
  createTestNodeGraph,
  createTextInputNodeFixture,
} from '../../components/__tests__/fixtures/canvasTestBuilders';

/**
 * 旧 note 节点（type === 'note'）的数据形状。
 * 迁移目标：转为自由注释，保留 content 与位置。
 *
 * note 类型已从 GraphNodeType 移除，这里用 JSON 构造旧持久化数据，绕过类型系统
 * （旧数据载入边界本就允许 type 字段超出当前联合，由 migrateNodeGraphAnnotations
 * 的宽松解析路径处理）。
 */
const makeLegacyNoteNode = (
  overrides: Partial<{
    id: string;
    content: string;
    color: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = {},
): GraphNode => {
  const id = overrides.id ?? 'legacy-note-1';
  return JSON.parse(JSON.stringify({
    id,
    type: 'note',
    position: {
      x: overrides.x ?? 100,
      y: overrides.y ?? 50,
    },
    data: {
      label: undefined,
      description: undefined,
      runtimeRef: undefined,
      content: overrides.content ?? '旧 note 内容',
      color: overrides.color,
    },
    draggable: undefined,
    size:
      overrides.width !== undefined && overrides.height !== undefined
        ? { width: overrides.width, height: overrides.height }
        : undefined,
    style: undefined,
    groupId: undefined,
  })) as GraphNode;
};

const findAnnotationByContent = (
  annotations: CanvasAnnotation[] | undefined,
  content: string,
): CanvasAnnotation | undefined =>
  (annotations ?? []).find((ann) => ann.content === content);

describe('migrateNodeGraphAnnotations', () => {
  it('把旧 note 节点迁移为自由注释（保留 content、位置、尺寸）', () => {
    const graph: NodeGraph = createTestNodeGraph();
    graph.nodes = [
      makeLegacyNoteNode({
        id: 'note-a',
        content: '旧 note 文本',
        x: 120,
        y: 80,
        width: 200,
        height: 100,
      }),
    ];

    const result = migrateNodeGraphAnnotations(graph);

    expect(result.migratedLegacyNoteCount).toBe(1);
    expect(result.droppedAnnotationCount).toBe(0);
    expect(result.nodeGraph.nodes).toHaveLength(0);

    const migrated = findAnnotationByContent(result.nodeGraph.annotations, '旧 note 文本');
    expect(migrated).toBeDefined();
    expect(migrated?.binding).toEqual({ type: 'free' });
    expect(migrated?.position).toEqual({ x: 120, y: 80 });
    expect(migrated?.size).toEqual({ width: 200, height: 100 });
    // 旧 note 的 color 没有显式提供时，注释样式回退默认色
    expect(migrated?.style.color).toBeTruthy();
  });

  it('丢弃绑定到不存在对象的注释（绑定失效）', () => {
    const graph: NodeGraph = createTestGraphWithAnnotations([
      {
        id: 'ann-orphan-node-1',
        content: '绑定到消失节点 1',
        binding: { type: 'node', nodeId: 'missing-node-1' },
        position: { x: 0, y: 0 },
        size: { width: 100, height: 50 },
        style: { color: '#fff', fontSize: 14 },
      },
      {
        id: 'ann-orphan-node-2',
        content: '绑定到消失节点 2',
        binding: { type: 'node', nodeId: 'missing-node-2' },
        position: { x: 0, y: 0 },
        size: { width: 100, height: 50 },
        style: { color: '#fff', fontSize: 14 },
      },
    ]);

    const result = migrateNodeGraphAnnotations(graph);

    expect(result.droppedAnnotationCount).toBe(2);
    expect(result.nodeGraph.annotations).toHaveLength(0);
  });

  it('同一对象最多保留 1 条绑定注释（多余的丢弃）', () => {
    const graph: NodeGraph = createTestGraphWithAnnotations([
      {
        id: 'ann-1',
        content: '第一条',
        binding: { type: 'node', nodeId: 'n1' },
        position: { x: 0, y: 0 },
        size: { width: 100, height: 50 },
        style: { color: '#fff', fontSize: 14 },
      },
      {
        id: 'ann-2',
        content: '第二条（冲突）',
        binding: { type: 'node', nodeId: 'n1' },
        position: { x: 0, y: 0 },
        size: { width: 100, height: 50 },
        style: { color: '#fff', fontSize: 14 },
      },
    ]);
    // n1 存在，绑定才有效
    graph.nodes = [createTextInputNodeFixture({ id: 'n1' })];

    const result = migrateNodeGraphAnnotations(graph);

    expect(result.nodeGraph.annotations).toHaveLength(1);
    const kept = result.nodeGraph.annotations?.[0];
    expect(kept?.content).toBe('第一条');
    expect(result.droppedAnnotationCount).toBe(1);
  });

  it('旧 group 绑定注释降级为自由注释（不丢弃内容）', () => {
    // group 已废弃，AnnotationBinding 不再含 group 变体；这里用 JSON 构造旧持久化数据
    // 中残留的 group 绑定注释，绕过类型检查
    const annotationRecord = {
      id: 'ann-group',
      content: '曾绑定到 group',
      binding: { type: 'group', groupId: 'g1' },
      position: { x: 30, y: 40 },
      size: { width: 100, height: 50 },
      style: { color: '#abc', fontSize: 14 },
    };
    const graph: NodeGraph = createTestGraphWithAnnotations([
      JSON.parse(JSON.stringify(annotationRecord)) as CanvasAnnotation,
    ]);

    const result = migrateNodeGraphAnnotations(graph);

    expect(result.nodeGraph.annotations).toHaveLength(1);
    const ann = result.nodeGraph.annotations?.[0];
    expect(ann?.binding).toEqual({ type: 'free' });
    expect(ann?.content).toBe('曾绑定到 group');
    expect(ann?.position).toEqual({ x: 30, y: 40 });
  });

  it('旧 edge 绑定注释降级为自由注释（不丢弃内容）', () => {
    // edge 绑定已退场，AnnotationBinding 不再含 edge 变体；这里用 JSON 构造旧持久化数据
    // 中残留的 edge 绑定注释，绕过类型检查
    const annotationRecord = {
      id: 'ann-edge',
      content: '曾绑定到 edge',
      binding: { type: 'edge', edgeId: 'e1' },
      position: { x: 10, y: 20 },
      size: { width: 100, height: 50 },
      style: { color: '#abc', fontSize: 14 },
    };
    const graph: NodeGraph = createTestGraphWithAnnotations([
      JSON.parse(JSON.stringify(annotationRecord)) as CanvasAnnotation,
    ]);

    const result = migrateNodeGraphAnnotations(graph);

    expect(result.nodeGraph.annotations).toHaveLength(1);
    const ann = result.nodeGraph.annotations?.[0];
    expect(ann?.binding).toEqual({ type: 'free' });
    expect(ann?.content).toBe('曾绑定到 edge');
    expect(ann?.position).toEqual({ x: 10, y: 20 });
  });
});

/**
 * 构造一个含给定 annotations 列表、空 nodes 的 NodeGraph。
 */
function createTestGraphWithAnnotations(
  annotations: CanvasAnnotation[],
): NodeGraph {
  const graph = createTestNodeGraph();
  graph.nodes = [];
  graph.annotations = annotations;
  return graph;
}

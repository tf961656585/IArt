import { describe, expect, it } from 'vitest';
import { collectFailedTaskNodeIds, isFailedTaskNode } from '../failedTaskNodes';
import { cast } from '@/lib/utils';
import type { GraphNode, GraphNodeData, GraphNodeType, NodeGraph } from '../../types';

const makeNode = (id: string, type: GraphNodeType, data: unknown): GraphNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: cast<GraphNodeData>(data),
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const makeTaskNode = (id: string, status: string): GraphNode =>
  makeNode(id, 'task', { status });

const makeGraph = (nodes: GraphNode[]): NodeGraph => cast<NodeGraph>({ nodes });

describe('collectFailedTaskNodeIds', () => {
  // @spec: CM-023
  it('只收失败终态的任务节点，按画布顺序返回其 id', () => {
    const graph = makeGraph([
      makeTaskNode('task-failed-1', 'failed'),
      makeTaskNode('task-running', 'generating'),
      makeTaskNode('task-failed-2', 'failed'),
      makeTaskNode('task-succeeded', 'succeeded'),
      makeTaskNode('task-cancelled', 'cancelled'),
    ]);

    expect(collectFailedTaskNodeIds(graph)).toEqual(['task-failed-1', 'task-failed-2']);
  });

  it('非任务节点即便带 taskInfo.status=failed 也不计入（失败节点只认任务节点形态）', () => {
    const graph = makeGraph([
      makeNode('asset-1', 'imageInput', { taskInfo: { status: 'failed' } }),
      makeNode('group-1', 'group', { status: 'failed' }),
      makeNode('asset-2', 'asset', { status: 'failed' }),
    ]);

    expect(collectFailedTaskNodeIds(graph)).toEqual([]);
  });

  it('画板未就绪（null / undefined）时返回空集合', () => {
    expect(collectFailedTaskNodeIds(null)).toEqual([]);
    expect(collectFailedTaskNodeIds(undefined)).toEqual([]);
  });

  it('没有失败节点时返回空集合', () => {
    expect(collectFailedTaskNodeIds(makeGraph([makeTaskNode('task-1', 'generating')]))).toEqual([]);
  });
});

describe('isFailedTaskNode', () => {
  it('任务节点且状态为 failed 时为真', () => {
    expect(isFailedTaskNode(makeTaskNode('task-1', 'failed'))).toBe(true);
  });

  it('任务节点但状态非 failed 时为假', () => {
    expect(isFailedTaskNode(makeTaskNode('task-1', 'polling'))).toBe(false);
  });

  it('非任务节点为假', () => {
    expect(isFailedTaskNode(makeNode('asset-1', 'asset', { status: 'failed' }))).toBe(false);
  });
});

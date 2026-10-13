import { describe, expect, it } from 'vitest';
import { cast } from '@/lib/utils';
import { stripNodeRuntimeLayoutFromNode } from '../nodeSize';
import type { GraphNode, TextInputNodeData } from '@/features/canvas/types';
import type { NodeSize } from '@/features/canvas/types/node';

type RuntimeLayoutGraphNode = GraphNode<TextInputNodeData & {
  sizeMode?: string;
  foo?: string;
}> & {
  measuredSize?: NodeSize;
};

const createNode = (): GraphNode => ({
  id: 'node-1',
  type: 'textInput',
  position: { x: 0, y: 0 },
  data: {
    segments: [],
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
    separator: undefined,
    customSeparator: undefined,
    promptPresetSnapshots: undefined,
    taskInfo: undefined,
    promptInterview: undefined,
    label: undefined,
    description: undefined,
    runtimeRef: undefined,
  },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

describe('nodeSize utils', () => {
  it('stripNodeRuntimeLayoutFromNode 清理 runtime 字段', () => {
    const node: RuntimeLayoutGraphNode = {
      ...createNode(),
      size: { width: 220, height: 120 },
      measuredSize: { width: 999, height: 888 },
      data: {
        segments: [],
        lastExecutionId: undefined,
        lastSourceNodeId: undefined,
        lastSourcePortId: undefined,
        separator: undefined,
        customSeparator: undefined,
        promptPresetSnapshots: undefined,
        taskInfo: undefined,
        promptInterview: undefined,
        label: undefined,
        description: undefined,
        runtimeRef: undefined,
        sizeMode: 'auto',
        foo: 'bar',
      },
    };

    const stripped = stripNodeRuntimeLayoutFromNode(node);
    expect(stripped.size).toBeUndefined();
    expect('measuredSize' in stripped).toBe(false);
    expect('sizeMode' in stripped.data).toBe(false);
    expect(cast<{ foo?: string }>(stripped.data).foo).toBe('bar');
  });
});

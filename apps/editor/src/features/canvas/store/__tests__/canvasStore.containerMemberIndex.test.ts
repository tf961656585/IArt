import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import {
  selectContainerMemberCount,
  selectContainerMemberCountIndex,
} from '../internal/containerMemberIndex';
import type { AgentNodeData, GraphNode, TextInputNodeData } from '../../types';

const createTestGraph = () =>
  createNodeGraph({
    name: 'container-member-index-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = async () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
  });
  await useCanvasStore.getState().loadNodeGraph(createTestGraph());
};

const addTextInputNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): GraphNode<TextInputNodeData> => {
  const node: GraphNode<TextInputNodeData> = {
    id,
    type: 'textInput',
    position: { x, y },
    data: {
      label: undefined,
      description: undefined,
      runtimeRef: undefined,
      segments: [],
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      separator: undefined,
      customSeparator: undefined,
      promptPresetSnapshots: undefined,
      taskInfo: undefined,
      promptInterview: undefined,
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
  return node;
};

const addAgentNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): GraphNode<AgentNodeData> => {
  const node: GraphNode<AgentNodeData> = {
    id,
    type: 'agent',
    position: { x, y },
    data: { label: 'Agent', agentSessionId: `session-${id}` },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
  return node;
};

describe('容器成员计数增量索引（AG-CN-014 / AG-CT-007）', () => {
  beforeEach(async () => {
    await resetStore();
  });

  // @spec: AG-CN-014, AG-CT-007
  it('索引由变更驱动维护：成员数随建立/迁移/解散正确更新', () => {
    addAgentNode('a1', 0, 0);
    addTextInputNode('m1', 5, 5);
    const groupId = useCanvasStore.getState().createGroup(['m1'], undefined);
    expect(groupId).not.toBeNull();
    addTextInputNode('n1', 10, 10);
    addTextInputNode('n2', 20, 20);

    expect(selectContainerMemberCount(useCanvasStore.getState(), groupId as string)).toBe(1);

    useCanvasStore.getState().addNodesToGroup(['n1', 'n2'], 'a1');
    expect(selectContainerMemberCount(useCanvasStore.getState(), 'a1')).toBe(2);

    // 迁移：a1 成员迁入组
    useCanvasStore.getState().moveNodesBetweenGroups(['n1'], groupId as string);
    expect(selectContainerMemberCount(useCanvasStore.getState(), 'a1')).toBe(1);
    expect(selectContainerMemberCount(useCanvasStore.getState(), groupId as string)).toBe(2);

    // 解散：计数清零
    useCanvasStore.getState().removeNodes(['a1'], undefined);
    expect(selectContainerMemberCount(useCanvasStore.getState(), 'a1')).toBe(0);
  });

  // @spec: AG-CN-014
  it('selector 等值比较：同一状态下重复读取返回同一引用（不逐容器扫描全图）', () => {
    addAgentNode('a1', 0, 0);
    addTextInputNode('n1', 10, 10, 'a1');

    const state = useCanvasStore.getState();
    const first = selectContainerMemberCountIndex(state);
    const second = selectContainerMemberCountIndex(state);
    expect(Object.is(first, second)).toBe(true);
    expect(first.get('a1')).toBe(1);
  });

  // @spec: AG-CN-014
  it('无关状态变更不换索引引用；成员关系变更后产出新索引', () => {
    addAgentNode('a1', 0, 0);
    addTextInputNode('n1', 10, 10);

    const before = selectContainerMemberCountIndex(useCanvasStore.getState());
    expect(before.has('a1')).toBe(false);

    useCanvasStore.getState().addNodesToGroup(['n1'], 'a1');

    const after = selectContainerMemberCountIndex(useCanvasStore.getState());
    expect(Object.is(before, after)).toBe(false);
    expect(after.get('a1')).toBe(1);
  });
});


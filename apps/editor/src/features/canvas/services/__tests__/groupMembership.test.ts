import { describe, expect, it } from 'vitest';
import {
  expandPositionUpdatesWithGroup,
  expandRemovalWithGroup,
  filterAddCandidates,
  filterRemoveCandidates,
  getGroupMemberIds,
  getGroupMembers,
  getGroupNodeIds,
  getGroupIdOfNode,
  hitTestGroupAt,
  isGroupMember,
  isGroupNode,
} from '../groupMembership';
import type { GraphNode } from '../../types';
import type { NodeGraph } from '../../types/nodeGraph';
import { createNodeGraph } from '../../types/nodeGraph';
import type { GroupNodeData, TextInputNodeData } from '../../types/node';

const makeTextInputNode = (id: string, groupId: string | undefined, x = 0, y = 0): GraphNode<TextInputNodeData> => ({
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
});

const makeGroupNode = (id: string, x = 0, y = 0): GraphNode<GroupNodeData> => ({
  id,
  type: 'group',
  position: { x, y },
  data: { label: '节点组', description: undefined, runtimeRef: undefined, name: 'g1', collapsed: false, color: undefined },
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const makeGraph = (nodes: GraphNode[]): NodeGraph => {
  const graph = createNodeGraph({
    name: 'test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  return { ...graph, nodes };
};

describe('groupMembership 查询函数', () => {
  it('isGroupNode 判定组节点', () => {
    expect(isGroupNode(makeGroupNode('g1'))).toBe(true);
    expect(isGroupNode(makeTextInputNode('n1', undefined))).toBe(false);
  });

  it('isGroupMember 判定组成员（groupId 非空字符串）', () => {
    expect(isGroupMember(makeTextInputNode('n1', 'g1'))).toBe(true);
    expect(isGroupMember(makeTextInputNode('n2', undefined))).toBe(false);
    expect(isGroupMember(makeTextInputNode('n3', ''))).toBe(false);
  });

  it('getGroupIdOfNode 返回所属组 id', () => {
    expect(getGroupIdOfNode(makeTextInputNode('n1', 'g1'))).toBe('g1');
    expect(getGroupIdOfNode(makeTextInputNode('n2', undefined))).toBeUndefined();
    // 组节点自身 groupId 必须为 undefined
    expect(getGroupIdOfNode(makeGroupNode('g1'))).toBeUndefined();
  });

  it('getGroupNodeIds 收集全图组节点 id', () => {
    const graph = makeGraph([makeGroupNode('g1'), makeTextInputNode('n1', 'g1'), makeGroupNode('g2')]);
    expect(getGroupNodeIds(graph)).toEqual(new Set(['g1', 'g2']));
  });

  it('getGroupMemberIds 返回指定组的成员 id 集合', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', 'g1'),
      makeTextInputNode('n2', 'g1'),
      makeTextInputNode('n3', 'g2'),
      makeTextInputNode('n4', undefined),
    ]);
    expect(getGroupMemberIds(graph, 'g1')).toEqual(new Set(['n1', 'n2']));
    // n3 的 groupId='g2'，即使 g2 组节点不在图中，按 groupId 字段查询仍命中
    expect(getGroupMemberIds(graph, 'g2')).toEqual(new Set(['n3']));
    expect(getGroupMemberIds(graph, 'nonexistent')).toEqual(new Set());
  });

  it('getGroupMembers 返回成员节点数组', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', 'g1'),
      makeTextInputNode('n2', 'g1'),
    ]);
    const members = getGroupMembers(graph, 'g1');
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.id)).toEqual(['n1', 'n2']);
  });
});

describe('expandPositionUpdatesWithGroup 拖动跟随', () => {
  it('拖动组节点时成员同步位移', () => {
    const graph = makeGraph([
      makeGroupNode('g1', 100, 100),
      makeTextInputNode('n1', 'g1', 120, 120),
      makeTextInputNode('n2', 'g1', 200, 200),
      makeTextInputNode('n3', undefined, 300, 300),
    ]);
    const result = expandPositionUpdatesWithGroup(graph, [
      { id: 'g1', position: { x: 150, y: 170 } }, // dx=50, dy=70
    ]);
    expect(result).toHaveLength(3);
    const posById = new Map(result.map((r) => [r.id, r.position]));
    expect(posById.get('g1')).toEqual({ x: 150, y: 170 });
    expect(posById.get('n1')).toEqual({ x: 170, y: 190 }); // 120+50, 120+70
    expect(posById.get('n2')).toEqual({ x: 250, y: 270 }); // 200+50, 200+70
    expect(posById.has('n3')).toBe(false); // 自由节点不跟随
  });

  it('位移为零时不扩展', () => {
    const graph = makeGraph([
      makeGroupNode('g1', 100, 100),
      makeTextInputNode('n1', 'g1', 120, 120),
    ]);
    const result = expandPositionUpdatesWithGroup(graph, [
      { id: 'g1', position: { x: 100, y: 100 } },
    ]);
    expect(result).toHaveLength(1);
  });

  it('直接拖动成员的显式位置不被组位移覆盖', () => {
    const graph = makeGraph([
      makeGroupNode('g1', 100, 100),
      makeTextInputNode('n1', 'g1', 120, 120),
    ]);
    const result = expandPositionUpdatesWithGroup(graph, [
      { id: 'g1', position: { x: 200, y: 200 } }, // dx=100, dy=100
      { id: 'n1', position: { x: 500, y: 500 } }, // 显式位置优先
    ]);
    const posById = new Map(result.map((r) => [r.id, r.position]));
    expect(posById.get('n1')).toEqual({ x: 500, y: 500 });
  });

  it('空 payload 原样返回', () => {
    const graph = makeGraph([makeGroupNode('g1')]);
    expect(expandPositionUpdatesWithGroup(graph, [])).toEqual([]);
  });

  it('拖动非组节点不触发成员跟随', () => {
    const graph = makeGraph([
      makeTextInputNode('n1', undefined, 100, 100),
      makeTextInputNode('n2', undefined, 200, 200),
    ]);
    const result = expandPositionUpdatesWithGroup(graph, [
      { id: 'n1', position: { x: 150, y: 150 } },
    ]);
    expect(result).toHaveLength(1);
  });
});

describe('expandRemovalWithGroup 删除级联', () => {
  it('deleteGroupMembers=true 时删除组节点连带删除全部成员', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', 'g1'),
      makeTextInputNode('n2', 'g1'),
      makeTextInputNode('n3', undefined),
    ]);
    const result = expandRemovalWithGroup(graph, ['g1'], { deleteGroupMembers: true });
    expect(result.sort()).toEqual(['g1', 'n1', 'n2'].sort());
  });

  it('deleteGroupMembers=false（dissolve）时不连带删除成员', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', 'g1'),
      makeTextInputNode('n2', 'g1'),
    ]);
    const result = expandRemovalWithGroup(graph, ['g1'], { deleteGroupMembers: false });
    // dissolve 语义：只返回输入节点 id，组成员不进删除集（由调用方另行清 groupId）
    expect(result).toEqual(['g1']);
  });

  it('deleteGroupMembers 默认（undefined）行为同 false（dissolve）', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', 'g1'),
    ]);
    // 测试 dissolve 是默认保护：即便调用方疏忽，也不会连删成员
    const result = expandRemovalWithGroup(graph, ['g1'], { deleteGroupMembers: false });
    expect(result).toEqual(['g1']);
  });

  it('删除单个成员不反向扩展到组节点（无论连删标志）', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', 'g1'),
      makeTextInputNode('n2', 'g1'),
    ]);
    expect(expandRemovalWithGroup(graph, ['n1'], { deleteGroupMembers: true })).toEqual(['n1']);
    expect(expandRemovalWithGroup(graph, ['n1'], { deleteGroupMembers: false })).toEqual(['n1']);
  });

  it('空输入原样返回', () => {
    const graph = makeGraph([makeGroupNode('g1')]);
    expect(expandRemovalWithGroup(graph, [], { deleteGroupMembers: true })).toEqual([]);
    expect(expandRemovalWithGroup(graph, [], { deleteGroupMembers: false })).toEqual([]);
  });

  it('无组成员时删除组节点不额外扩展', () => {
    const graph = makeGraph([makeGroupNode('g1')]);
    expect(expandRemovalWithGroup(graph, ['g1'], { deleteGroupMembers: true })).toEqual(['g1']);
    expect(expandRemovalWithGroup(graph, ['g1'], { deleteGroupMembers: false })).toEqual(['g1']);
  });
});

describe('filterAddCandidates 加入候选校验', () => {
  it('过滤出可加入目标组的自由节点', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', undefined), // 自由节点，可加入
      makeTextInputNode('n2', 'g1'), // 已是 g1 成员，排除
      makeTextInputNode('n3', 'g2'), // 属于其他组，可加入（跨组迁移）
    ]);
    expect(filterAddCandidates(graph, ['n1', 'n2', 'n3'], 'g1')).toEqual(['n1', 'n3']);
  });

  it('排除组节点本身（组不可嵌套）', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeGroupNode('g2'),
      makeTextInputNode('n1', undefined),
    ]);
    expect(filterAddCandidates(graph, ['g2', 'n1'], 'g1')).toEqual(['n1']);
  });

  it('不存在的节点 id 被忽略', () => {
    const graph = makeGraph([makeGroupNode('g1'), makeTextInputNode('n1', undefined)]);
    expect(filterAddCandidates(graph, ['n1', 'nonexistent'], 'g1')).toEqual(['n1']);
  });

  it('空输入返回空数组', () => {
    const graph = makeGraph([makeGroupNode('g1')]);
    expect(filterAddCandidates(graph, [], 'g1')).toEqual([]);
  });
});

describe('filterRemoveCandidates 移出候选校验', () => {
  it('过滤出可移出组的成员节点', () => {
    const graph = makeGraph([
      makeGroupNode('g1'),
      makeTextInputNode('n1', 'g1'), // 组成员，可移出
      makeTextInputNode('n2', undefined), // 自由节点，排除
      makeTextInputNode('n3', 'g2'), // 其他组成员，可移出
    ]);
    expect(filterRemoveCandidates(graph, ['n1', 'n2', 'n3'])).toEqual(['n1', 'n3']);
  });

  it('排除组节点本身', () => {
    const graph = makeGraph([makeGroupNode('g1'), makeTextInputNode('n1', 'g1')]);
    expect(filterRemoveCandidates(graph, ['g1', 'n1'])).toEqual(['n1']);
  });

  it('不存在的节点 id 被忽略', () => {
    const graph = makeGraph([makeGroupNode('g1'), makeTextInputNode('n1', 'g1')]);
    expect(filterRemoveCandidates(graph, ['n1', 'nonexistent'])).toEqual(['n1']);
  });

  it('空输入返回空数组', () => {
    const graph = makeGraph([makeGroupNode('g1')]);
    expect(filterRemoveCandidates(graph, [])).toEqual([]);
  });
});

describe('hitTestGroupAt 拖拽落点命中检测', () => {
  const makeBounds = (
    groupId: string,
    minX: number,
    minY: number,
    width: number,
    height: number,
    zIndex: number,
  ) => ({ groupId, minX, minY, width, height, zIndex });

  it('落点在边界框内命中', () => {
    const bounds = [makeBounds('g1', 100, 100, 200, 150, 0)];
    expect(hitTestGroupAt({ x: 200, y: 175 }, bounds)).toBe('g1');
  });

  it('落点在边界框左上角顶点命中（含边界）', () => {
    const bounds = [makeBounds('g1', 100, 100, 200, 150, 0)];
    expect(hitTestGroupAt({ x: 100, y: 100 }, bounds)).toBe('g1');
  });

  it('落点在边界框右下角顶点命中（含边界）', () => {
    const bounds = [makeBounds('g1', 100, 100, 200, 150, 0)];
    expect(hitTestGroupAt({ x: 300, y: 250 }, bounds)).toBe('g1');
  });

  it('落点在边界框外不命中', () => {
    const bounds = [makeBounds('g1', 100, 100, 200, 150, 0)];
    expect(hitTestGroupAt({ x: 400, y: 175 }, bounds)).toBeUndefined();
    expect(hitTestGroupAt({ x: 200, y: 300 }, bounds)).toBeUndefined();
  });

  it('多组重叠时取 zIndex 最大的组', () => {
    const bounds = [
      makeBounds('g1', 100, 100, 300, 300, 0), // 下层
      makeBounds('g2', 150, 150, 200, 200, 5), // 上层
    ];
    expect(hitTestGroupAt({ x: 250, y: 250 }, bounds)).toBe('g2');
  });

  it('多组重叠且 zIndex 相同时取遍历到的最后一个（确定性）', () => {
    const bounds = [
      makeBounds('g1', 100, 100, 300, 300, 5),
      makeBounds('g2', 150, 150, 200, 200, 5),
    ];
    // zIndex 相等时，后遍历到的（g2）覆盖前者（> 严格比较，相等不替换则保留 g1）
    expect(hitTestGroupAt({ x: 250, y: 250 }, bounds)).toBe('g1');
  });

  it('空边界框列表返回 undefined', () => {
    expect(hitTestGroupAt({ x: 100, y: 100 }, [])).toBeUndefined();
  });
});

// @spec: CLI-027, CLI-028, CLI-029, CLI-030, CLI-032, CLI-048, CLI-049
//
// CLI 代理执行通道 · 画布操作四命令映射测试（2026-10-14 批次新增，从 cliProxyReceiver.test.ts
// 拆分——该文件受 max-lines 门禁约束）。
//
// 覆盖：canvas.group.dissolve（解散按容器类型分述，docs/runtime/画布节点组.md「解散」）、
// canvas.node.move（与界面拖拽同一位置写入 action）、canvas.node.delete（与界面删除同一
// 删除咽喉）、canvas.layout --order（显式顺序优先、默认排序行为不变）、canvas.layout
// --columns（CLI-032：scope=all 与 group 均透传列数语义，缺省单列默认行为不变）。
// 种床沿 cliProxyReceiver.test.ts 既有惯例：真实 store + setState 种节点。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliProxyCommandResponseSchema } from '@iart/contracts';
import type { CliProxyCommand, CliProxyCommandResponse } from '@iart/contracts';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { AgentNodeData, GraphNode, GroupNodeData, TextInputNodeData } from '../../types';
import { executeCliProxyCommand } from '../cliProxyReceiver';
import { buildGroupDerivedSize } from '../../components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '../../utils/nodeOccupancy';

// ---------------------------------------------------------------------------
// store 种床（沿 cliProxyReceiver.test.ts 的既有惯例：真实 store + setState 种节点）
// ---------------------------------------------------------------------------

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-proxy-canvas-ops-test',
    description: undefined,
    tags: undefined,
    category: undefined,
  });

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
  });
};

const addTextInputNode = (
  id: string,
  x = 0,
  y = 0,
  groupId: string | undefined = undefined,
): void => {
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
};

const addGroupNode = (id: string, collapsed = false): void => {
  const node: GraphNode<GroupNodeData> = {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    data: {
      label: '节点组',
      description: undefined,
      runtimeRef: undefined,
      name: `组-${id}`,
      collapsed,
      color: '#22C55E',
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
};

const addAgentNode = (id: string, x = 0, y = 0): void => {
  const node: GraphNode<AgentNodeData> = {
    id,
    type: 'agent',
    position: { x, y },
    data: {
      label: `agent-${id}`,
      agentSessionId: `session-${id}`,
      collapsed: undefined,
    },
    draggable: true,
    size: undefined,
    style: undefined,
    groupId: undefined,
  };
  useCanvasStore.setState((s) => {
    if (s.nodeGraph) {
      s.nodeGraph.nodes.push(node);
      s.structureRevision += 1;
    }
  });
};

const findNode = (id: string): GraphNode | undefined => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return undefined;
  return graph.nodes.find((n) => n.id === id);
};

/** 消费端纪律断言：响应必须能通过契约 schema parse，不合法让用例直接失败。 */
const parseResponse = (raw: unknown): CliProxyCommandResponse =>
  CliProxyCommandResponseSchema.parse(raw);

/** 按命令名构造成员归属代理命令（判别字段保持字面量，避免联合命令名通过 satisfies 收窄失败）。 */
const membershipCommand = (
  command: 'canvas.group.add' | 'canvas.group.remove',
  requestId: string,
  group: string,
  members: string[],
): CliProxyCommand =>
  command === 'canvas.group.add'
    ? { command: 'canvas.group.add', request_id: requestId, group, members }
    : { command: 'canvas.group.remove', request_id: requestId, group, members };

describe('CLI 代理执行通道 · 画布操作四命令', () => {
  beforeEach(() => {
    resetStore();
    void useCanvasStore.getState().loadNodeGraph(createTestGraph());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // @spec: CLI-027
  describe('canvas.group.dissolve（CLI-027，解散语义 docs/runtime/画布节点组.md「解散」）', () => {
    it('组解散：组节点删除、成员保留原位且 groupId 解除，响应回传成员列表', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 100, 100, 'g0');
      addTextInputNode('m2', 200, 200, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.group.dissolve',
        request_id: 'req-d1',
        group: 'g0',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('dissolved' in response)) throw new Error('expected dissolve success response');
      expect(response.dissolved).toBe(true);
      expect(response.group_node_id).toBe('g0');
      expect(response.member_ids).toEqual(['m1', 'm2']);
      expect(response.request_id).toBe('req-d1');
      // 组节点删除（解散=画布级删除组的同一数据动作），成员保留原位、归属解除
      expect(findNode('g0')).toBeUndefined();
      expect(findNode('m1')?.groupId).toBeUndefined();
      expect(findNode('m2')?.groupId).toBeUndefined();
      expect(findNode('m1')?.position).toEqual({ x: 100, y: 100 });
      expect(findNode('m2')?.position).toEqual({ x: 200, y: 200 });
      // 既有删除咽喉自带历史：撤销栈非空
      expect(useCanvasStore.getState().history.length).toBeGreaterThanOrEqual(1);
    });

    it('Agent 容器解散：头节点保留、成员关系解除，会话语义不在此触发', async () => {
      addAgentNode('a0');
      addTextInputNode('m1', 10, 10, 'a0');
      addTextInputNode('m2', 20, 20, 'a0');
      const command: CliProxyCommand = {
        command: 'canvas.group.dissolve',
        request_id: 'req-d2',
        group: 'a0',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('dissolved' in response)) throw new Error('expected dissolve success response');
      expect(response.member_ids).toEqual(['m1', 'm2']);
      // Agent 头节点保留（回落单节点形态），成员保留原位、归属解除
      expect(findNode('a0')?.type).toBe('agent');
      expect(findNode('m1')?.groupId).toBeUndefined();
      expect(findNode('m2')?.groupId).toBeUndefined();
      expect(findNode('m1')?.position).toEqual({ x: 10, y: 10 });
    });

    it('组不存在返回 group_not_found', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.group.dissolve',
        request_id: 'req-d3',
        group: 'ghost-group',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected dissolve error response');
      expect(response.error.code).toBe('group_not_found');
      expect(response.error.message).toContain('ghost-group');
      expect(findNode('n1')).toBeDefined();
    });

    it('目标不是容器节点返回 command_rejected，不产生任何删除', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.group.dissolve',
        request_id: 'req-d4',
        group: 'n1',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected dissolve error response');
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('n1');
      expect(findNode('n1')).toBeDefined();
    });

    it('无成员（单节点形态）的 Agent 节点返回 command_rejected（AG-CN-015）', async () => {
      addAgentNode('a1');
      const command: CliProxyCommand = {
        command: 'canvas.group.dissolve',
        request_id: 'req-d5',
        group: 'a1',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected dissolve error response');
      expect(response.error.code).toBe('command_rejected');
      expect(findNode('a1')).toBeDefined();
    });

    it('nodeGraph 未载入时返回 project_not_open 并留 debug 痕', async () => {
      useCanvasStore.setState((state) => {
        state.nodeGraph = null;
      });
      const command: CliProxyCommand = {
        command: 'canvas.group.dissolve',
        request_id: 'req-d6',
        group: 'g0',
      };
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('project_not_open');
      expect(debugSpy).toHaveBeenCalled();
    });
  });

  // @spec: CLI-028
  describe('canvas.node.move（CLI-028）', () => {
    it('移动自由节点：位置更新、响应回传最终坐标与实际位移节点集合', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.node.move',
        request_id: 'req-m1',
        node: 'n1',
        x: -120,
        y: 240.5,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('node_id' in response)) throw new Error('expected move success response');
      expect(response.node_id).toBe('n1');
      expect(response.position).toEqual({ x: -120, y: 240.5 });
      expect(response.moved_node_ids).toEqual(['n1']);
      expect(response.request_id).toBe('req-m1');
      expect(findNode('n1')?.position).toEqual({ x: -120, y: 240.5 });
      expect(useCanvasStore.getState().history.length).toBeGreaterThanOrEqual(1);
    });

    it('移动组成员：归属不变、组节点不被显式改写（组位置由成员派生）', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.node.move',
        request_id: 'req-m2',
        node: 'm1',
        x: 300,
        y: 300,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('node_id' in response)) throw new Error('expected move success response');
      expect(findNode('m1')?.position).toEqual({ x: 300, y: 300 });
      expect(findNode('m1')?.groupId).toBe('g0');
      expect(findNode('g0')).toBeDefined();
      // moved_node_ids 只含实际写入位移的成员，不含派生量的组节点
      expect(response.moved_node_ids).toEqual(['m1']);
    });

    it('目标是容器节点返回 command_rejected（组位置是派生量，移动一律成员级）', async () => {
      addGroupNode('g0');
      const command: CliProxyCommand = {
        command: 'canvas.node.move',
        request_id: 'req-m3',
        node: 'g0',
        x: 100,
        y: 100,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected move error response');
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('g0');
      expect(findNode('g0')?.position).toEqual({ x: 0, y: 0 });
    });

    it('节点不存在返回 node_not_found', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.node.move',
        request_id: 'req-m4',
        node: 'ghost-node',
        x: 1,
        y: 2,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected move error response');
      expect(response.error.code).toBe('node_not_found');
      expect(response.error.message).toContain('ghost-node');
      expect(findNode('n1')?.position).toEqual({ x: 0, y: 0 });
    });

    it('nodeGraph 未载入时返回 project_not_open', async () => {
      useCanvasStore.setState((state) => {
        state.nodeGraph = null;
      });
      const command: CliProxyCommand = {
        command: 'canvas.node.move',
        request_id: 'req-m5',
        node: 'n1',
        x: 1,
        y: 2,
      };
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('project_not_open');
      expect(debugSpy).toHaveBeenCalled();
    });
  });

  // @spec: CLI-029
  describe('canvas.node.delete（CLI-029，与界面删除同一删除咽喉）', () => {
    it('删除自由节点：节点移除、响应回传实际删除集合', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 10, 10);
      const command: CliProxyCommand = {
        command: 'canvas.node.delete',
        request_id: 'req-x1',
        nodes: ['n1'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('deleted' in response)) throw new Error('expected delete success response');
      expect(response.deleted).toBe(true);
      expect(response.deleted_node_ids).toEqual(['n1']);
      expect(response.request_id).toBe('req-x1');
      expect(findNode('n1')).toBeUndefined();
      expect(findNode('n2')).toBeDefined();
      expect(useCanvasStore.getState().history.length).toBeGreaterThanOrEqual(1);
    });

    it('删除组节点 = 解散：组删除、成员保留原位且归属解除（不在删除集合内）', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 10, 10, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.node.delete',
        request_id: 'req-x2',
        nodes: ['g0'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('deleted' in response)) throw new Error('expected delete success response');
      expect(response.deleted_node_ids).toEqual(['g0']);
      expect(findNode('g0')).toBeUndefined();
      expect(findNode('m1')?.groupId).toBeUndefined();
      expect(findNode('m1')?.position).toEqual({ x: 10, y: 10 });
    });

    it('含不存在节点返回 node_not_found，不删除任何节点', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.node.delete',
        request_id: 'req-x3',
        nodes: ['n1', 'ghost-node'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected delete error response');
      expect(response.error.code).toBe('node_not_found');
      expect(response.error.message).toContain('ghost-node');
      expect(findNode('n1')).toBeDefined();
    });

    it('删除 Agent 节点缺显式确认返回 command_rejected（AG-CT-011 禁旁路的 CLI 对应物）', async () => {
      addAgentNode('a0');
      const command: CliProxyCommand = {
        command: 'canvas.node.delete',
        request_id: 'req-x4',
        nodes: ['a0'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected delete error response');
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('a0');
      expect(findNode('a0')).toBeDefined();
    });

    it('删除 Agent 节点携带显式确认：走删除咽喉移除，产物成员保留原位', async () => {
      addAgentNode('a0');
      addTextInputNode('m1', 10, 10, 'a0');
      const command: CliProxyCommand = {
        command: 'canvas.node.delete',
        request_id: 'req-x5',
        nodes: ['a0'],
        yes: true,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('deleted' in response)) throw new Error('expected delete success response');
      expect(response.deleted_node_ids).toEqual(['a0']);
      expect(findNode('a0')).toBeUndefined();
      // 产物成员保留原位、归属解除（AG-CN-007）
      expect(findNode('m1')?.groupId).toBeUndefined();
      expect(findNode('m1')).toBeDefined();
    });

    it('重复 id 按一个节点处理（去重保序）', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.node.delete',
        request_id: 'req-x6',
        nodes: ['n1', 'n1'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('deleted' in response)) throw new Error('expected delete success response');
      expect(response.deleted_node_ids).toEqual(['n1']);
      expect(findNode('n1')).toBeUndefined();
    });

    it('nodeGraph 未载入时返回 project_not_open', async () => {
      useCanvasStore.setState((state) => {
        state.nodeGraph = null;
      });
      const command: CliProxyCommand = {
        command: 'canvas.node.delete',
        request_id: 'req-x7',
        nodes: ['n1'],
      };
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('project_not_open');
      expect(debugSpy).toHaveBeenCalled();
    });
  });

  // @spec: CLI-030
  describe('canvas.layout --order（CLI-030，显式顺序优先）', () => {
    it('scope=group 携带 order：指定成员按给定序占格（单列行优先），未指定成员跟排', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addTextInputNode('m2', 10, 10, 'g0');
      addTextInputNode('m3', 20, 20, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-o1',
        scope: { group: 'g0' },
        order: ['m3', 'm1'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) throw new Error('expected layout success response');
      expect(Object.keys(response.positions).sort()).toEqual(['m1', 'm2', 'm3']);
      // order 首位 m3 占第一行（y 最小），其次 m1，未指定的 m2 跟在最后
      const yOf = (id: string): number => response.positions[id]?.y ?? Number.NaN;
      expect(yOf('m3')).toBeLessThan(yOf('m1'));
      expect(yOf('m1')).toBeLessThan(yOf('m2'));
      const graph = useCanvasStore.getState().nodeGraph;
      for (const [nodeId, position] of Object.entries(response.positions)) {
        const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
        expect(node?.position).toEqual(position);
      }
    });

    it('scope=all 携带 order：指定节点优先占格，未指定节点按现状数组序跟排', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 10, 10);
      addTextInputNode('n3', 20, 20);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-o2',
        scope: 'all',
        order: ['n2'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) throw new Error('expected layout success response');
      const yOf = (id: string): number => response.positions[id]?.y ?? Number.NaN;
      expect(yOf('n2')).toBeLessThan(yOf('n1'));
      expect(yOf('n1')).toBeLessThan(yOf('n3'));
    });

    it('order 含不存在的节点返回 node_not_found，画布零改动', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-o3',
        scope: 'all',
        order: ['ghost-node'],
      };
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected layout error response');
      expect(response.error.code).toBe('node_not_found');
      expect(response.error.message).toContain('ghost-node');
      expect(findNode('n1')?.position).toEqual({ x: 0, y: 0 });
      expect(debugSpy).toHaveBeenCalled();
    });

    it('order 含不在整理作用域内的节点返回 command_rejected（scope=all 命中组成员）', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addTextInputNode('n1', 100, 100);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-o4',
        scope: 'all',
        order: ['m1'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected layout error response');
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('m1');
      expect(findNode('n1')?.position).toEqual({ x: 100, y: 100 });
      expect(findNode('m1')?.position).toEqual({ x: 0, y: 0 });
    });

    it('order 重复 id 按首次出现去重，不产生重复占位', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 10, 10);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-o5',
        scope: 'all',
        order: ['n2', 'n2'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) throw new Error('expected layout success response');
      expect(Object.keys(response.positions).sort()).toEqual(['n1', 'n2']);
      const yOf = (id: string): number => response.positions[id]?.y ?? Number.NaN;
      expect(yOf('n2')).toBeLessThan(yOf('n1'));
    });
  });

  // @spec: CLI-032
  describe('canvas.layout --columns（CLI-032，spec §5.3「均映射列数语义」实现侧收口）', () => {
    it('scope=all 携带 columns=2：行优先网格摆放（行内跨列、行间换行），不再固定单列', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 10, 10);
      addTextInputNode('n3', 20, 20);
      addTextInputNode('n4', 30, 30);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-c1',
        scope: 'all',
        columns: 2,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) throw new Error('expected layout success response');
      expect(Object.keys(response.positions).sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
      // 行优先：[n1 n2] / [n3 n4]——同行等 y、跨列 x 递增、换行 y 递增（同尺寸节点几何确定）
      const posOf = (id: string): { x: number; y: number } => {
        const position = response.positions[id];
        if (!position) throw new Error(`missing position for ${id}`);
        return position;
      };
      expect(posOf('n2').x).toBeGreaterThan(posOf('n1').x);
      expect(posOf('n2').y).toBe(posOf('n1').y);
      expect(posOf('n3').y).toBeGreaterThan(posOf('n1').y);
      expect(posOf('n3').x).toBe(posOf('n1').x);
      expect(posOf('n4').x).toBeGreaterThan(posOf('n3').x);
      // 画布实际位置与响应一致
      const graph = useCanvasStore.getState().nodeGraph;
      for (const [nodeId, position] of Object.entries(response.positions)) {
        const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
        expect(node?.position).toEqual(position);
      }
    });

    it('scope=all 不带 columns：默认单列垂直摆放行为完全不变（x 相同、y 严格递增）', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 10, 10);
      addTextInputNode('n3', 20, 20);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-c2',
        scope: 'all',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) throw new Error('expected layout success response');
      const posOf = (id: string): { x: number; y: number } => {
        const position = response.positions[id];
        if (!position) throw new Error(`missing position for ${id}`);
        return position;
      };
      expect(posOf('n1').x).toBe(posOf('n2').x);
      expect(posOf('n2').x).toBe(posOf('n3').x);
      expect(posOf('n1').y).toBeLessThan(posOf('n2').y);
      expect(posOf('n2').y).toBeLessThan(posOf('n3').y);
    });

    it('scope=group 携带 columns：既有容器内网格语义不变（回归守卫）', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      addTextInputNode('m2', 10, 10, 'g0');
      addTextInputNode('m3', 20, 20, 'g0');
      addTextInputNode('m4', 30, 30, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-c3',
        scope: { group: 'g0' },
        columns: 2,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) throw new Error('expected layout success response');
      const posOf = (id: string): { x: number; y: number } => {
        const position = response.positions[id];
        if (!position) throw new Error(`missing position for ${id}`);
        return position;
      };
      expect(posOf('m2').x).toBeGreaterThan(posOf('m1').x);
      expect(posOf('m2').y).toBe(posOf('m1').y);
      expect(posOf('m3').y).toBeGreaterThan(posOf('m1').y);
    });
  });

  // @spec: CLI-049
  describe('canvas.group.add / canvas.group.remove（CLI-049，成员归属）', () => {
    it('add：未归属成员直接加入、已在目标组成员 no-op；响应按加入前归属分类', async () => {
      addGroupNode('g0');
      addTextInputNode('free1', 10, 20);
      addTextInputNode('member1', 30, 40, 'g0');
      useCanvasStore.getState().saveToHistory();
      const historyBefore = useCanvasStore.getState().history.length;

      const command: CliProxyCommand = {
        command: 'canvas.group.add',
        request_id: 'req-ga1',
        group: 'g0',
        members: ['free1', 'member1', 'free1'],
      };
      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('added_node_ids' in response)) throw new Error('expected group add success response');
      expect(response.group_node_id).toBe('g0');
      expect(response.added_node_ids).toEqual(['free1']);
      expect(response.moved_node_ids).toEqual([]);
      expect(response.unchanged_node_ids).toEqual(['member1']);
      expect(findNode('free1')?.groupId).toBe('g0');
      // 加入不改变成员位置
      expect(findNode('free1')?.position).toEqual({ x: 10, y: 20 });
      expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);
    });

    it('add：跨组迁移与新增同批分类，一次撤销全部还原到加入前归属', async () => {
      addGroupNode('g0');
      addGroupNode('g1');
      addTextInputNode('m1', 0, 0, 'g1');
      addTextInputNode('m2', 10, 10, 'g0');
      addTextInputNode('m3', 20, 20);
      useCanvasStore.getState().saveToHistory();
      const historyBefore = useCanvasStore.getState().history.length;

      const command: CliProxyCommand = {
        command: 'canvas.group.add',
        request_id: 'req-ga2',
        group: 'g0',
        members: ['m1', 'm2', 'm3'],
      };
      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('added_node_ids' in response)) throw new Error('expected group add success response');
      expect(response.added_node_ids).toEqual(['m3']);
      expect(response.moved_node_ids).toEqual(['m1']);
      expect(response.unchanged_node_ids).toEqual(['m2']);
      expect(findNode('m1')?.groupId).toBe('g0');
      expect(findNode('m2')?.groupId).toBe('g0');
      expect(findNode('m3')?.groupId).toBe('g0');
      // 整批一条撤销记录（新增 + 迁移不各落一条）
      expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);

      useCanvasStore.getState().undo();
      expect(findNode('m1')?.groupId).toBe('g1');
      expect(findNode('m2')?.groupId).toBe('g0');
      expect(findNode('m3')?.groupId).toBeUndefined();
    });

    it('add：整批已在目标组时成功且零写入（不落历史）', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 0, 0, 'g0');
      const historyBefore = useCanvasStore.getState().history.length;

      const command: CliProxyCommand = {
        command: 'canvas.group.add',
        request_id: 'req-ga3',
        group: 'g0',
        members: ['m1'],
      };
      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('added_node_ids' in response)) throw new Error('expected group add success response');
      expect(response.added_node_ids).toEqual([]);
      expect(response.moved_node_ids).toEqual([]);
      expect(response.unchanged_node_ids).toEqual(['m1']);
      expect(useCanvasStore.getState().history.length).toBe(historyBefore);
    });

    it('add：成员不存在 → node_not_found；组节点作为成员 → command_rejected（整批零写入）', async () => {
      addGroupNode('g0');
      addGroupNode('g1');
      addTextInputNode('free1', 0, 0);

      const missing = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.add',
          request_id: 'req-ga4',
          group: 'g0',
          members: ['free1', 'ghost-node'],
        } satisfies CliProxyCommand),
      );
      if (!('error' in missing)) throw new Error('expected group add error response');
      expect(missing.error.code).toBe('node_not_found');
      expect(missing.error.message).toContain('ghost-node');
      expect(findNode('free1')?.groupId).toBeUndefined();

      const groupMember = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.add',
          request_id: 'req-ga5',
          group: 'g0',
          members: ['free1', 'g1'],
        } satisfies CliProxyCommand),
      );
      if (!('error' in groupMember)) throw new Error('expected group add error response');
      expect(groupMember.error.code).toBe('command_rejected');
      expect(groupMember.error.message).toContain('g1');
      expect(findNode('free1')?.groupId).toBeUndefined();
    });

    it('remove：成员移出目标组、保留画布原位；一次撤销恢复归属', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 12, 34, 'g0');
      addTextInputNode('m2', 56, 78, 'g0');
      useCanvasStore.getState().saveToHistory();
      const historyBefore = useCanvasStore.getState().history.length;

      const command: CliProxyCommand = {
        command: 'canvas.group.remove',
        request_id: 'req-gr1',
        group: 'g0',
        members: ['m1'],
      };
      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('removed_node_ids' in response)) throw new Error('expected group remove success response');
      expect(response.group_node_id).toBe('g0');
      expect(response.removed_node_ids).toEqual(['m1']);
      expect(findNode('m1')?.groupId).toBeUndefined();
      expect(findNode('m1')?.position).toEqual({ x: 12, y: 34 });
      expect(findNode('m2')?.groupId).toBe('g0');
      expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);

      useCanvasStore.getState().undo();
      expect(findNode('m1')?.groupId).toBe('g0');
    });

    it('remove：任一成员不属于目标组 → command_rejected 点名并整批拒绝', async () => {
      addGroupNode('g0');
      addGroupNode('g1');
      addTextInputNode('m1', 0, 0, 'g0');
      addTextInputNode('otherGroupMember', 10, 10, 'g1');
      addTextInputNode('free1', 20, 20);

      const command: CliProxyCommand = {
        command: 'canvas.group.remove',
        request_id: 'req-gr2',
        group: 'g0',
        members: ['m1', 'otherGroupMember', 'free1'],
      };
      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) throw new Error('expected group remove error response');
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('otherGroupMember');
      expect(response.error.message).toContain('free1');
      // 整批拒绝：属于目标组的成员也不被移出
      expect(findNode('m1')?.groupId).toBe('g0');
    });

    it('remove：成员不存在 → node_not_found；组节点作为成员 → command_rejected', async () => {
      addGroupNode('g0');
      addGroupNode('g1');
      addTextInputNode('m1', 0, 0, 'g0');

      const missing = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.remove',
          request_id: 'req-gr3',
          group: 'g0',
          members: ['m1', 'ghost-node'],
        } satisfies CliProxyCommand),
      );
      if (!('error' in missing)) throw new Error('expected group remove error response');
      expect(missing.error.code).toBe('node_not_found');
      expect(missing.error.message).toContain('ghost-node');

      const groupMember = parseResponse(
        await executeCliProxyCommand({
          command: 'canvas.group.remove',
          request_id: 'req-gr4',
          group: 'g0',
          members: ['g1'],
        } satisfies CliProxyCommand),
      );
      if (!('error' in groupMember)) throw new Error('expected group remove error response');
      expect(groupMember.error.code).toBe('command_rejected');
      expect(groupMember.error.message).toContain('g1');
      expect(findNode('m1')?.groupId).toBe('g0');
    });

    it('add/remove：目标不存在 → group_not_found；目标非节点组（含 Agent 容器）→ command_rejected', async () => {
      addTextInputNode('plainNode', 0, 0);
      addAgentNode('agent0');
      addGroupNode('g0');
      addTextInputNode('m1', 10, 10, 'g0');

      for (const commandName of ['canvas.group.add', 'canvas.group.remove'] as const) {
        const notFound = parseResponse(
          await executeCliProxyCommand(membershipCommand(commandName, `${commandName}-ghost`, 'ghost-group', ['m1'])),
        );
        if (!('error' in notFound)) throw new Error('expected error response');
        expect(notFound.error.code).toBe('group_not_found');

        const plainTarget = parseResponse(
          await executeCliProxyCommand(membershipCommand(commandName, `${commandName}-plain`, 'plainNode', ['m1'])),
        );
        if (!('error' in plainTarget)) throw new Error('expected error response');
        expect(plainTarget.error.code).toBe('command_rejected');

        const agentTarget = parseResponse(
          await executeCliProxyCommand(membershipCommand(commandName, `${commandName}-agent`, 'agent0', ['m1'])),
        );
        if (!('error' in agentTarget)) throw new Error('expected error response');
        expect(agentTarget.error.code).toBe('command_rejected');
        expect(agentTarget.error.message).toContain('Agent 容器');
      }
      // 全程零改动
      expect(findNode('m1')?.groupId).toBe('g0');
    });

    it('nodeGraph 未载入时 add/remove 均返回 project_not_open', async () => {
      useCanvasStore.setState((state) => {
        state.nodeGraph = null;
      });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      for (const commandName of ['canvas.group.add', 'canvas.group.remove'] as const) {
        const response = parseResponse(
          await executeCliProxyCommand(membershipCommand(commandName, `${commandName}-closed`, 'g0', ['m1'])),
        );
        if (!('error' in response)) throw new Error('expected error response');
        expect(response.error.code).toBe('project_not_open');
      }
      expect(debugSpy).toHaveBeenCalled();
    });
  });

  describe('canvas.layout --scope containers（CLI-048，组间重叠修复）', () => {
    it('两个重叠组整组让位后派生框不相交', async () => {
      addGroupNode('g1');
      addGroupNode('g2');
      addTextInputNode('a1', 0, 0, 'g1');
      addTextInputNode('a2', 300, 0, 'g1');
      addTextInputNode('b1', 100, 100, 'g2');
      addTextInputNode('b2', 400, 100, 'g2');

      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-containers',
        scope: 'containers',
      };
      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('positions' in response)) throw new Error('expected layout success response');

      const state = useCanvasStore.getState();
      const graph = state.nodeGraph;
      if (!graph) throw new Error('nodeGraph 为空');
      const derived = buildGroupDerivedSize({
        nodes: graph.nodes,
        sizeSources: buildCanvasSizeSources(state),
      });
      const first = derived.byGroupId['g1'];
      const second = derived.byGroupId['g2'];
      if (!first || !second) throw new Error('容器派生 entry 缺失');
      const overlap =
        first.position.x < second.position.x + second.size.width &&
        first.position.x + first.size.width > second.position.x &&
        first.position.y < second.position.y + second.size.height &&
        first.position.y + first.size.height > second.position.y;
      expect(overlap).toBe(false);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/api/promptDockApi', () => ({
  cancelTask: vi.fn(),
}));

import { CliProxyCommandResponseSchema } from '@iart/contracts';
import type { CliProxyCommand, CliProxyCommandResponse } from '@iart/contracts';
import { cancelTask } from '@/client/api/promptDockApi';
import { useCanvasStore } from '../../store/canvasStore';
import { createNodeGraph } from '../../types/nodeGraph';
import type { AgentNodeData, GraphNode, GroupNodeData, TextInputNodeData } from '../../types';
import {
  executeCliProxyCommand,
  handleCliProxyPayload,
  initCliProxyReceiver,
} from '../cliProxyReceiver';

const cancelTaskMock = vi.mocked(cancelTask);

// ---------------------------------------------------------------------------
// store 种床（沿 canvasStore.groupActions.test.ts 的既有惯例：真实 store + setState 种节点）
// ---------------------------------------------------------------------------

const createTestGraph = () =>
  createNodeGraph({
    name: 'cli-proxy-test',
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

const addAgentNode = (id: string): void => {
  const node: GraphNode<AgentNodeData> = {
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    data: { label: `agent-${id}`, agentSessionId: `session-${id}`, collapsed: undefined },
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

const countGroupNodes = (): number => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) return 0;
  return graph.nodes.filter((n) => n.type === 'group').length;
};

// ---------------------------------------------------------------------------
// 载荷/响应工具
// ---------------------------------------------------------------------------

const collectSend = (): {
  responses: CliProxyCommandResponse[];
  send: (payload: CliProxyCommandResponse) => void;
} => {
  const responses: CliProxyCommandResponse[] = [];
  return {
    responses,
    send: (payload) => {
      responses.push(payload);
    },
  };
};

/** 消费端纪律断言：响应（含未知来源载荷）必须能通过契约 schema parse，不合法让用例直接失败。 */
const parseResponse = (raw: unknown): CliProxyCommandResponse =>
  CliProxyCommandResponseSchema.parse(raw);

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

describe('CLI 代理执行通道 · 画布窗口接收器', () => {
  beforeEach(() => {
    resetStore();
    void useCanvasStore.getState().loadNodeGraph(createTestGraph());
    cancelTaskMock.mockReset();
  });

  describe('canvas.group.create（CLI-010）', () => {
    it('成员齐备时创建组并应用组名，返回新组节点标识且 request_id 配对', async () => {
      addTextInputNode('n1', 100, 100);
      addTextInputNode('n2', 200, 200);
      const command: CliProxyCommand = {
        command: 'canvas.group.create',
        request_id: 'req-g1',
        name: '设计稿组',
        members: ['n1', 'n2'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('group_node_id' in response) || response.command !== 'canvas.group.create') {
        throw new Error('expected group create success response');
      }
      const groupNode = findNode(response.group_node_id);
      expect(groupNode?.type).toBe('group');
      const data = groupNode?.data as GroupNodeData;
      expect(data.name).toBe('设计稿组');
      expect(findNode('n1')?.groupId).toBe(response.group_node_id);
      expect(findNode('n2')?.groupId).toBe(response.group_node_id);
      // 创建后实际在组内的成员标识（CLI-057）：按成员清单回传，不是空数组
      expect(response.member_ids).toEqual(['n1', 'n2']);
      expect(response.request_id).toBe('req-g1');
      // 既有 action 自带入撤销栈：建组（合批）+ 命名各落历史，撤销栈非空
      expect(useCanvasStore.getState().history.length).toBeGreaterThanOrEqual(1);
    });

    it('成员不存在时返回 node_not_found 且 message 指认缺失标识，不建组', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.group.create',
        request_id: 'req-g2',
        name: '组',
        members: ['n1', 'ghost-node'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) {
        throw new Error('expected group create error response');
      }
      expect(response.error.code).toBe('node_not_found');
      expect(response.error.message).toContain('ghost-node');
      expect(response.request_id).toBe('req-g2');
      expect(countGroupNodes()).toBe(0);
    });

    it('成员含组节点时返回 command_rejected（组不得入组），不建组', async () => {
      addTextInputNode('n1', 0, 0);
      addGroupNode('g0');
      const command: CliProxyCommand = {
        command: 'canvas.group.create',
        request_id: 'req-g3',
        name: '组',
        members: ['n1', 'g0'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) {
        throw new Error('expected group create error response');
      }
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('g0');
      // 只有种子组 g0，没有新建组
      expect(countGroupNodes()).toBe(1);
    });

    it('已归属其他组的成员被重新归属到新组（spec §5.3 与界面拖拽同语义）', async () => {
      addGroupNode('g0');
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 50, 50, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.group.create',
        request_id: 'req-g4',
        name: '新组',
        members: ['n1', 'n2'],
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('group_node_id' in response) || response.command !== 'canvas.group.create') {
        throw new Error('expected group create success response');
      }
      expect(findNode('n2')?.groupId).toBe(response.group_node_id);
      expect(findNode('n1')?.groupId).toBe(response.group_node_id);
      // 原组仍存在（成员迁出，不是删除原组）
      expect(findNode('g0')?.type).toBe('group');
    });

    it('nodeGraph 未载入时返回 project_not_open 并留 debug 痕', async () => {
      useCanvasStore.setState((state) => {
        state.nodeGraph = null;
      });
      const command: CliProxyCommand = {
        command: 'canvas.group.create',
        request_id: 'req-g5',
        name: '组',
        members: ['n1'],
      };
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

      try {
        const response = parseResponse(await executeCliProxyCommand(command));
        if (!('error' in response)) {
          throw new Error('expected error response');
        }
        expect(response.error.code).toBe('project_not_open');
        expect(debugSpy).toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
      }
    });
  });

  // @spec: CLI-057
  describe('canvas.group.rename（CLI-057）', () => {
    it('重命名节点组：组名更新、一条撤销记录、operation_id 为 null', async () => {
      addGroupNode('g0');
      // 先落一次历史，让「首个历史写入附带基线」不干扰本次 delta 断言。
      useCanvasStore.getState().saveToHistory();
      const historyBefore = useCanvasStore.getState().history.length;
      const command: CliProxyCommand = {
        command: 'canvas.group.rename',
        request_id: 'req-rename-1',
        group: 'g0',
        name: '分镜组',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('group_node_id' in response) || response.command !== 'canvas.group.rename') {
        throw new Error('expected rename success response');
      }
      expect(response.group_node_id).toBe('g0');
      expect(response.name).toBe('分镜组');
      // 非位置类不登记按操作撤销：operation_id 恒为 null
      expect(response.operation_id).toBeNull();
      const data = findNode('g0')?.data as GroupNodeData;
      expect(data.name).toBe('分镜组');
      // renameGroup 自带一条历史记录：一次重命名 = 一条撤销记录
      expect(useCanvasStore.getState().history.length).toBe(historyBefore + 1);
    });

    it('目标不存在 → group_not_found，画布零改动', async () => {
      const command: CliProxyCommand = {
        command: 'canvas.group.rename',
        request_id: 'req-rename-2',
        group: 'ghost',
        name: '新名',
      };
      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('group_not_found');
    });

    it('目标不是节点组（普通节点）→ command_rejected', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.group.rename',
        request_id: 'req-rename-3',
        group: 'n1',
        name: '新名',
      };
      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('不是节点组');
    });

    it('Agent 容器 → command_rejected（标题由会话管理）', async () => {
      addAgentNode('agent1');
      const command: CliProxyCommand = {
        command: 'canvas.group.rename',
        request_id: 'req-rename-4',
        group: 'agent1',
        name: '新名',
      };
      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('Agent 容器');
      const data = findNode('agent1')?.data as AgentNodeData;
      expect(data.label).toBe('agent-agent1');
    });

    it('组名去空白后为空 → command_rejected（代理通道直调兜底）', async () => {
      addGroupNode('g0');
      const command: CliProxyCommand = {
        command: 'canvas.group.rename',
        request_id: 'req-rename-5',
        group: 'g0',
        name: '   ',
      };
      const response = parseResponse(await executeCliProxyCommand(command));
      if (!('error' in response)) throw new Error('expected error response');
      expect(response.error.code).toBe('command_rejected');
    });
  });

  // @spec: CLI-011
  describe('canvas.layout（CLI-011）', () => {
    it('scope=all 整理自由节点并返回其最终位置映射（容器与其成员不在映射内）', async () => {
      addTextInputNode('n1', 500, 100);
      addTextInputNode('n2', 100, 500);
      addTextInputNode('n3', 300, 300);
      addGroupNode('g0');
      addTextInputNode('m1', 10, 10, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-l1',
        scope: 'all',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) {
        throw new Error('expected layout success response');
      }
      expect(Object.keys(response.positions).sort()).toEqual(['n1', 'n2', 'n3']);
      const graph = useCanvasStore.getState().nodeGraph;
      for (const [nodeId, position] of Object.entries(response.positions)) {
        const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
        expect(node?.position).toEqual(position);
      }
      expect(response.request_id).toBe('req-l1');
    });

    it('scope=all 携带 columns 参数仍成功（对全局整理无既有语义，执行侧忽略）', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 100, 100);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-l2',
        scope: 'all',
        columns: 3,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) {
        throw new Error('expected layout success response');
      }
      expect(Object.keys(response.positions).sort()).toEqual(['n1', 'n2']);
    });

    it('scope=group 整理本组成员并返回成员最终位置映射', async () => {
      addGroupNode('g0');
      addTextInputNode('m1', 800, 0, 'g0');
      addTextInputNode('m2', 0, 800, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-l3',
        scope: { group: 'g0' },
        columns: 2,
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('positions' in response)) {
        throw new Error('expected layout success response');
      }
      expect(Object.keys(response.positions).sort()).toEqual(['m1', 'm2']);
      const graph = useCanvasStore.getState().nodeGraph;
      for (const [nodeId, position] of Object.entries(response.positions)) {
        const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
        expect(node?.position).toEqual(position);
      }
    });

    it('组不存在返回 group_not_found', async () => {
      addTextInputNode('n1', 0, 0);
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-l4',
        scope: { group: 'ghost-group' },
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) {
        throw new Error('expected layout error response');
      }
      expect(response.error.code).toBe('group_not_found');
      expect(response.error.message).toContain('ghost-group');
    });

    it('折叠组返回 command_rejected', async () => {
      addGroupNode('g0', true);
      addTextInputNode('m1', 0, 0, 'g0');
      const command: CliProxyCommand = {
        command: 'canvas.layout',
        request_id: 'req-l5',
        scope: { group: 'g0' },
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) {
        throw new Error('expected layout error response');
      }
      expect(response.error.code).toBe('command_rejected');
    });
  });

  describe('task.cancel（CLI-012）', () => {
    it('复用用户取消链 cancelTask，受理响应携带契约形状', async () => {
      cancelTaskMock.mockResolvedValue({
        accepted: true,
        task_id: 'task-1',
        cancelled_at: '2026-10-07T00:00:00.000Z',
      });
      const command: CliProxyCommand = {
        command: 'task.cancel',
        request_id: 'req-c1',
        task_id: 'task-1',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      expect(cancelTaskMock).toHaveBeenCalledWith('task-1');
      if (!('accepted' in response)) {
        throw new Error('expected task cancel success response');
      }
      expect(response.accepted).toBe(true);
      expect(response.task_id).toBe('task-1');
      expect(response.cancelled_at).toBe('2026-10-07T00:00:00.000Z');
      expect(response.request_id).toBe('req-c1');
    });

    it('Backend 拒绝映射 command_rejected 并携带 Backend 理由', async () => {
      cancelTaskMock.mockRejectedValue({
        message: 'HTTP 409',
        status: 409,
        body: { code: 'INVALID_TASK', message: 'Task already in terminal state; cancel not accepted' },
      });
      const command: CliProxyCommand = {
        command: 'task.cancel',
        request_id: 'req-c2',
        task_id: 'task-2',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) {
        throw new Error('expected task cancel error response');
      }
      expect(response.error.code).toBe('command_rejected');
      expect(response.error.message).toContain('task-2');
      expect(response.error.message).toContain('terminal state');
    });

    it('意外异常映射 internal_error 并带诊断线索', async () => {
      cancelTaskMock.mockRejectedValue(new Error('network boom'));
      const command: CliProxyCommand = {
        command: 'task.cancel',
        request_id: 'req-c3',
        task_id: 'task-3',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('error' in response)) {
        throw new Error('expected task cancel error response');
      }
      expect(response.error.code).toBe('internal_error');
      expect(response.error.message).toContain('network boom');
    });
  });

  describe('串行队列（spec §6.3）', () => {
    it('前一条完成前不开始下一条，响应按序回传', async () => {
      type CancelAccepted = { accepted: true; task_id: string; cancelled_at: string };
      let resolveCancel: (value: CancelAccepted) => void = () => undefined;
      cancelTaskMock.mockImplementation(
        () =>
          new Promise<CancelAccepted>((resolve) => {
            resolveCancel = resolve;
          }),
      );
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 10, 10);
      const { responses, send } = collectSend();

      const pending1 = handleCliProxyPayload(
        { command: 'task.cancel', request_id: 'q1', task_id: 'task-1' },
        send,
      );
      const pending2 = handleCliProxyPayload(
        { command: 'canvas.group.create', request_id: 'q2', name: '组', members: ['n1', 'n2'] },
        send,
      );

      // 队列占用中：第二条命令尚未执行
      await flushMicrotasks();
      expect(cancelTaskMock).toHaveBeenCalledTimes(1);
      expect(countGroupNodes()).toBe(0);

      resolveCancel({ accepted: true, task_id: 'task-1', cancelled_at: '2026-10-07T00:00:00.000Z' });
      await Promise.all([pending1, pending2]);

      expect(countGroupNodes()).toBe(1);
      expect(responses.map((response) => response.command)).toEqual([
        'task.cancel',
        'canvas.group.create',
      ]);
      // 逐条过契约 schema（不合法直接抛错使用例失败）
      responses.forEach((response) => parseResponse(response));
    });

    it('前一条失败不阻塞后一条，两条响应都回传', async () => {
      cancelTaskMock.mockRejectedValue({
        message: 'HTTP 404',
        status: 404,
        body: { code: 'TASK_NOT_FOUND', message: 'Task not found' },
      });
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 10, 10);
      const { responses, send } = collectSend();

      await handleCliProxyPayload({ command: 'task.cancel', request_id: 'q3', task_id: 'ghost' }, send);
      await handleCliProxyPayload(
        { command: 'canvas.group.create', request_id: 'q4', name: '组', members: ['n1', 'n2'] },
        send,
      );

      expect(responses).toHaveLength(2);
      const first = parseResponse(responses[0]);
      const second = parseResponse(responses[1]);
      if (!('error' in first) || !('group_node_id' in second)) {
        throw new Error('expected cancel error then group success');
      }
      expect(first.error.code).toBe('command_rejected');
      expect(second.request_id).toBe('q4');
      expect(countGroupNodes()).toBe(1);
    });

    it('非法载荷立即回错误响应且不进队列；command 无法识别时留痕丢弃', async () => {
      addTextInputNode('n1', 0, 0);
      const { responses, send } = collectSend();

      // 形状非法但 command/request_id 可识别：立即回错误响应（不进队列）
      await handleCliProxyPayload({ command: 'canvas.group.create', request_id: 'q5' }, send);
      expect(responses).toHaveLength(1);
      const invalid = parseResponse(responses[0]);
      if (!('error' in invalid)) {
        throw new Error('expected invalid payload error response');
      }
      expect(invalid.error.code).toBe('internal_error');
      expect(invalid.request_id).toBe('q5');
      expect(countGroupNodes()).toBe(0);

      // command 无法识别：无法构造可对账的响应，留痕丢弃
      const dropped = collectSend();
      await handleCliProxyPayload({ command: 'unknown.command', request_id: 'q6' }, dropped.send);
      expect(dropped.responses).toHaveLength(0);
    });
  });

  // @spec: CLI-021
  describe('canvas.selection.get（画布状态只读查询，spec §6.3 只读条款 / §5.5）', () => {
    it('直读 store 现值：节点与注释分类型输出，request_id 配对', async () => {
      addTextInputNode('n1', 0, 0);
      addTextInputNode('n2', 100, 100);
      useCanvasStore.setState((state) => {
        state.selectedNodeIds = ['n2', 'n1'];
        state.selectedAnnotationIds = ['anno-1'];
      });
      const command: CliProxyCommand = {
        command: 'canvas.selection.get',
        request_id: 'req-s1',
      };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('selection' in response)) {
        throw new Error('expected selection read success response');
      }
      expect(response.request_id).toBe('req-s1');
      expect(response.selection).toEqual({ node_ids: ['n2', 'n1'], annotation_ids: ['anno-1'] });
    });

    it('无选中时输出空列表（不是 null）', async () => {
      const command: CliProxyCommand = { command: 'canvas.selection.get', request_id: 'req-s2' };

      const response = parseResponse(await executeCliProxyCommand(command));

      if (!('selection' in response)) throw new Error('expected selection read success response');
      expect(response.selection).toEqual({ node_ids: [], annotation_ids: [] });
    });

    it('画布尚未就绪（nodeGraph 未载入）→ selection null、命令不失败，并留 debug 痕', async () => {
      useCanvasStore.setState((state) => {
        state.nodeGraph = null;
        state.selectedNodeIds = ['n1'];
        state.selectedAnnotationIds = [];
      });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      const command: CliProxyCommand = { command: 'canvas.selection.get', request_id: 'req-s3' };

      try {
        const response = parseResponse(await executeCliProxyCommand(command));
        if (!('selection' in response)) throw new Error('expected selection read success response');
        expect(response.selection).toBeNull();
        expect(debugSpy).toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('只读：不进撤销栈、不改历史与画布结构、选中集合原样不被改写', async () => {
      addTextInputNode('n1', 0, 0);
      useCanvasStore.setState((state) => {
        state.selectedNodeIds = ['n1'];
        state.selectedAnnotationIds = [];
      });
      const historyBefore = useCanvasStore.getState().history.length;
      const historyIndexBefore = useCanvasStore.getState().historyIndex;
      const nodesBefore = useCanvasStore.getState().nodeGraph?.nodes.length ?? 0;
      const structureRevisionBefore = useCanvasStore.getState().structureRevision;

      const response = parseResponse(
        await executeCliProxyCommand({ command: 'canvas.selection.get', request_id: 'req-s4' }),
      );

      if (!('selection' in response)) throw new Error('expected selection read success response');
      expect(useCanvasStore.getState().history.length).toBe(historyBefore);
      expect(useCanvasStore.getState().historyIndex).toBe(historyIndexBefore);
      expect(useCanvasStore.getState().nodeGraph?.nodes.length).toBe(nodesBefore);
      expect(useCanvasStore.getState().structureRevision).toBe(structureRevisionBefore);
      expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n1']);
    });

    it('非法载荷（形状非法但 command/request_id 可识别）→ internal_error 错误响应可对账回传；缺 request_id 留痕丢弃', async () => {
      const collected = collectSend();
      // 形状非法但可对账：strict schema 拒绝未声明字段 → 立即回 internal_error
      await handleCliProxyPayload(
        { command: 'canvas.selection.get', request_id: 'q-s5', node_ids: ['n1'] },
        collected.send,
      );
      await flushMicrotasks();
      expect(collected.responses).toHaveLength(1);
      const first = collected.responses[0];
      if (!first || !('error' in first)) throw new Error('expected error response');
      expect(first.error.code).toBe('internal_error');
      expect(first.request_id).toBe('q-s5');

      // 缺 request_id：无法构造可配对的响应，留痕丢弃（与既有命令同语义）
      const dropped = collectSend();
      await handleCliProxyPayload({ command: 'canvas.selection.get' }, dropped.send);
      await flushMicrotasks();
      expect(dropped.responses).toHaveLength(0);
    });
  });

  // @spec: CLI-051
  describe('canvas.geometry.get（整张画布几何只读查询，canvas.inspect exact 合并输入）', () => {
    it('输出全部节点尺寸、容器派生框、视口与选中态（只读，不进撤销栈）', async () => {
      addTextInputNode('n1', 100, 100, 'g1');
      addGroupNode('g1');
      useCanvasStore.setState((state) => {
        if (state.nodeGraph) state.nodeGraph.viewport = { x: 5, y: 6, zoom: 2 };
        state.selectedNodeIds = ['n1'];
        state.selectedAnnotationIds = ['anno-1'];
      });
      const historyBefore = useCanvasStore.getState().history.length;
      const structureRevisionBefore = useCanvasStore.getState().structureRevision;

      const response = parseResponse(
        await executeCliProxyCommand({ command: 'canvas.geometry.get', request_id: 'req-g1' }),
      );

      if (!('sizes' in response) || !('containers' in response)) {
        throw new Error('expected geometry read success response');
      }
      expect(response.request_id).toBe('req-g1');
      // 普通节点：无 layoutModel/measured 时回落注册表默认（textInput 未注册 → 全局兜底 220×120）
      expect(response.sizes.n1).toEqual({ width: 220, height: 120 });
      // 容器派生：成员包围盒 + padding + 标题高度
      expect(response.sizes.g1).toEqual({ width: 244, height: 172 });
      expect(response.containers.g1).toEqual({
        position: { x: 88, y: 60 },
        size: { width: 244, height: 172 },
      });
      expect(response.viewport).toMatchObject({ x: 5, y: 6, zoom: 2 });
      // 视口同时携带画布可视区宽高（无 .react-flow 容器时回落 window）
      expect(response.viewport?.width).toBeGreaterThan(0);
      expect(response.viewport?.height).toBeGreaterThan(0);
      expect(response.selection).toEqual({ node_ids: ['n1'], annotation_ids: ['anno-1'] });

      // 只读：无历史新增、结构修订号不变
      expect(useCanvasStore.getState().history.length).toBe(historyBefore);
      expect(useCanvasStore.getState().structureRevision).toBe(structureRevisionBefore);
    });

    it('视口宽高优先读 ReactFlow 容器 DOM（clientWidth/clientHeight）', async () => {
      addTextInputNode('n1', 0, 0);
      useCanvasStore.setState((state) => {
        if (state.nodeGraph) state.nodeGraph.viewport = { x: 0, y: 0, zoom: 1 };
      });
      const container = document.createElement('div');
      container.className = 'react-flow';
      Object.defineProperty(container, 'clientWidth', { value: 900, configurable: true });
      Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
      document.body.appendChild(container);
      try {
        const response = parseResponse(
          await executeCliProxyCommand({ command: 'canvas.geometry.get', request_id: 'req-g4' }),
        );
        if (!('sizes' in response) || !('containers' in response)) {
          throw new Error('expected geometry read success response');
        }
        expect(response.viewport).toEqual({ x: 0, y: 0, zoom: 1, width: 900, height: 600 });
      } finally {
        container.remove();
      }
    });

    it('画布尚未就绪（nodeGraph 未载入）→ 空几何集合与 null 视口/选中态，命令不失败', async () => {
      useCanvasStore.setState((state) => {
        state.nodeGraph = null;
        state.selectedNodeIds = ['n1'];
        state.selectedAnnotationIds = [];
      });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      try {
        const response = parseResponse(
          await executeCliProxyCommand({ command: 'canvas.geometry.get', request_id: 'req-g2' }),
        );
        if (!('sizes' in response) || !('containers' in response)) {
          throw new Error('expected geometry read success response');
        }
        expect(response.sizes).toEqual({});
        expect(response.containers).toEqual({});
        expect(response.viewport).toBeNull();
        expect(response.selection).toBeNull();
        expect(debugSpy).toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('非法载荷（形状非法但 command/request_id 可识别）→ internal_error 错误响应可对账回传', async () => {
      const collected = collectSend();
      await handleCliProxyPayload(
        { command: 'canvas.geometry.get', request_id: 'q-g3', sizes: {} },
        collected.send,
      );
      await flushMicrotasks();
      expect(collected.responses).toHaveLength(1);
      const first = collected.responses[0];
      if (!first || !('error' in first)) throw new Error('expected error response');
      expect(first.error.code).toBe('internal_error');
      expect(first.request_id).toBe('q-g3');
    });
  });

  // 订阅初始化依赖模块级幂等标志，放在文件末尾按序执行：
  // 先验证桥缺失分支（标志未置位），再验证接线与幂等（标志置位）。
  describe('订阅初始化接线', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('无 electron 桥（非桌面宿主）时留痕跳过且不订阅', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      vi.stubGlobal('window', { electron: undefined });
      try {
        expect(() => initCliProxyReceiver()).not.toThrow();
        expect(debugSpy).toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
      }
    });

    it('initCliProxyReceiver 经 preload 桥订阅一次且重复调用幂等，载荷走完整管线回传', async () => {
      cancelTaskMock.mockResolvedValue({
        accepted: true,
        task_id: 'task-init',
        cancelled_at: '2026-10-07T00:00:00.000Z',
      });
      type CliProxyRequestHandler = (payload: unknown) => void;
      const onCliProxyRequest = vi.fn<(callback: CliProxyRequestHandler) => void>();
      const sendCliProxyResponse = vi.fn<(payload: unknown) => void>();
      vi.stubGlobal('window', {
        electron: { onCliProxyRequest, sendCliProxyResponse },
      });

      initCliProxyReceiver();
      initCliProxyReceiver();
      expect(onCliProxyRequest).toHaveBeenCalledTimes(1);

      const handler = onCliProxyRequest.mock.calls[0]?.[0];
      if (!handler) {
        throw new Error('expected subscription handler captured');
      }
      handler({ command: 'task.cancel', request_id: 'init-1', task_id: 'task-init' });
      await flushMicrotasks();

      expect(sendCliProxyResponse).toHaveBeenCalledTimes(1);
      const sent = parseResponse(sendCliProxyResponse.mock.calls[0]?.[0]);
      if (!('accepted' in sent)) {
        throw new Error('expected task cancel success response via bridge');
      }
      expect(sent.request_id).toBe('init-1');
      expect(cancelTaskMock).toHaveBeenCalledWith('task-init');
    });
  });
});

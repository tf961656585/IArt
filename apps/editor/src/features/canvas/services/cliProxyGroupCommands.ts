/**
 * CLI 代理执行通道 · 组/容器命令映射（spec docs/integrations/CLI与本地Agent集成.md §6.3）。
 *
 * 从 cliProxyReceiver.ts 拆出的职责边界（行数预算）：建组、解散、成员加入与移出。
 * 全部映射既有编辑 action / 删除咽喉执行，享受撤销栈与自动保存；接收器只负责排队、校验
 * 与回传，不重复成员关系写入逻辑。
 *
 * 映射口径：
 * - `canvas.group.create` → `createGroup`（组语义 docs/runtime/画布节点组.md）：
 *   成员不存在 → `node_not_found`；成员含组节点 → `command_rejected`（组不得入组，AG-CN-001；
 *   createGroup 对非法成员按静默过滤处理，映射层在此显式拒绝，避免静默丢成员的假成功）。
 *   已归属其他容器的成员先解除归属再建组（spec §5.3「成员已归属其他组时按空间归属改写语义
 *   重新归属，与界面拖拽同语义」），解除归属与建组在同一历史合批内收口为一条撤销记录
 *   （historyBatchActive 既有合批模式，本映射不自建第二套入栈）；组名经 `renameGroup`
 *   落到组节点（renameGroup 非合批感知，独立成一条历史，用户可逐步撤销）。
 * - `canvas.group.dissolve` → 按容器类型分述（spec CLI-027；docs/runtime/画布节点组.md「解散」）：
 *   组 → 删除咽喉 `removeNodes([groupId], { deleteGroupMembers: false })`——画布级删除组与
 *   解散是同一解散数据动作，成员关系解除、组节点删除、绑定组注释级联在同一存储写入路径收口
 *   （不连删，成员保留原位）；Agent 容器 → `dissolveAgentContainer`（纯解除成员关系，头节点
 *   保留回落单节点形态，会话与历史保留）。目标不存在 → `group_not_found`；目标非容器节点 →
 *   `command_rejected`；无成员（单节点形态）的 Agent 节点 → `command_rejected`（AG-CN-015）。
 *   响应回传解散前成员 id 列表。
 * - `canvas.group.add` → 成员归属写入（spec CLI-049）：复用既有 addNodesToGroup（未归属直接
 *   加入）与 moveNodesBetweenGroups（跨组迁移）；已在目标组的成员为 no-op。目标必须是节点组
 *   （Agent 容器成员由会话管理，不接受 add）；成员不存在 → `node_not_found`、成员是组节点 →
 *   `command_rejected`、目标不存在 → `group_not_found`。整批在同一历史合批内收口为一条撤销
 *   记录，不提供部分成功。响应按加入前归属回传新增/迁移/未变三组标识。
 * - `canvas.group.remove` → 成员移出（spec CLI-049）：复用既有 removeNodesFromGroup；成员保留
 *   画布原位、归属解除。目标必须是节点组（Agent 容器不接受 remove）；成员不存在 →
 *   `node_not_found`、成员是组节点或当前不属于目标组 → `command_rejected`（点名不属于该组的
 *   成员，整批拒绝）。整批一条撤销记录。
 */

import type { CliProxyCommand, CliProxyCommandError, CliProxyCommandResponse } from '@iart/contracts';
import {
  getGroupMembers,
  isContainerNode,
  isGroupMember,
} from '@/features/canvas/services/groupMembership';
import { createBirthGroup } from '@/features/promptdock/projection/taskProjectionService';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { NodeGraph } from '@/features/canvas/types';
import { buildErrorResponse, projectNotOpenResponse } from './cliProxyErrorResponses';
import { registerUnsupportedOperation } from './cliOperationRegistry';

const executeGroupCreate = (
  command: Extract<CliProxyCommand, { command: 'canvas.group.create' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    return projectNotOpenResponse('canvas.group.create', requestId);
  }

  // 成员去重保序：同一 id 重复出现按一个成员处理
  const memberIds = [...new Set(command.members)];

  // 空组建组（spec CLI-044，仅 CLI 侧放开；界面多选入口保持 ≥2 语义）：复用出生组自动建组
  // 实现——视口安全区防重叠块搜索定位（零坐标兜底）+ 空组建组（allowEmpty 专用通道）+ 命名。
  if (memberIds.length === 0) {
    const emptyGroupId = createBirthGroup(command.name);
    if (emptyGroupId === null) {
      console.debug('[cliProxyReceiver] empty group create failed', { request_id: requestId });
      return buildErrorResponse(
        'canvas.group.create',
        requestId,
        'internal_error',
        '无法创建节点组，请稍后重试。',
      );
    }
    return {
      command: 'canvas.group.create',
      request_id: requestId,
      group_node_id: emptyGroupId,
      // 空组建组：创建后组内没有成员，如实回传空数组（不伪造成员）。
      member_ids: [],
      // 建组不支持按操作撤销：仍返回操作标识，使 canvas.undo 返回 command_rejected。
      operation_id: registerUnsupportedOperation(),
    };
  }

  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));

  // 映射层前置校验（createGroup 对非法成员是静默过滤，CLI 面必须显式拒绝而不是假成功）
  const missingIds: string[] = [];
  const groupNodeIds: string[] = [];
  const reassignedIds: string[] = [];
  for (const id of memberIds) {
    const node = nodeById.get(id);
    if (!node) {
      missingIds.push(id);
      continue;
    }
    if (node.type === 'group') {
      groupNodeIds.push(id);
      continue;
    }
    if (isGroupMember(node)) {
      reassignedIds.push(id);
    }
  }
  if (missingIds.length > 0) {
    console.debug('[cliProxyReceiver] group create rejected: member nodes not found', {
      request_id: requestId,
      missing: missingIds,
    });
    return buildErrorResponse(
      'canvas.group.create',
      requestId,
      'node_not_found',
      `画布上找不到这些节点：${missingIds.join('、')}。请确认节点标识后重试。`,
    );
  }
  if (groupNodeIds.length > 0) {
    console.debug('[cliProxyReceiver] group create rejected: group nodes in members', {
      request_id: requestId,
      groupNodes: groupNodeIds,
    });
    return buildErrorResponse(
      'canvas.group.create',
      requestId,
      'command_rejected',
      `这些节点本身是节点组，不能作为另一个组的成员：${groupNodeIds.join('、')}。请调整成员清单后重试。`,
    );
  }

  // 解除既有归属 + 建组在同一历史合批内收口为一条撤销记录（historyBatchActive 既有合批模式，
  // 与 AgentNodeChrome dissolve 的编排先例一致）；映射层不重复入栈、不重复标脏。
  let groupId: string | null = null;
  useCanvasStore.setState((state) => {
    state.historyBatchActive = true;
  });
  try {
    if (reassignedIds.length > 0) {
      store.removeNodesFromGroup(reassignedIds);
    }
    groupId = store.createGroup(memberIds, undefined);
  } finally {
    useCanvasStore.setState((state) => {
      state.historyBatchActive = false;
    });
  }

  if (groupId === null) {
    // 前置校验已排除全部失败原因，此处是防御分支；解除归属若已生效仍落一条历史保持存储一致。
    console.debug('[cliProxyReceiver] group create returned no group id', {
      request_id: requestId,
    });
    if (reassignedIds.length > 0) {
      useCanvasStore.getState().saveToHistory();
    }
    return buildErrorResponse(
      'canvas.group.create',
      requestId,
      'internal_error',
      '无法创建节点组，请稍后重试。',
    );
  }

  useCanvasStore.getState().saveToHistory();

  const groupName = command.name.trim();
  if (groupName.length > 0) {
    // renameGroup 非合批感知，独立成一条历史：用户可在界面上逐步撤销 Agent 的建组与命名。
    useCanvasStore.getState().renameGroup(groupId, groupName);
  }

  // 创建后实际在组内的成员：从 store 现值读取（不假定 createGroup 的内部写入结果）。
  const graphAfterCreate = useCanvasStore.getState().nodeGraph;
  const memberIdsInGroup =
    graphAfterCreate !== null ? getGroupMembers(graphAfterCreate, groupId).map((member) => member.id) : [];

  return {
    command: 'canvas.group.create',
    request_id: requestId,
    group_node_id: groupId,
    member_ids: memberIdsInGroup,
    operation_id: registerUnsupportedOperation(),
  };
};

/**
 * `canvas group rename` → 节点组重命名（spec §5.3 / CLI-057）。
 *
 * 目标必须是节点组：不存在 → `group_not_found`；Agent 容器（标题由会话管理）与其他节点
 * → `command_rejected`。映射既有 renameGroup（非合批感知、自带一条历史记录），因此
 * 一次重命名 = 一条撤销记录。本命令属非位置类，按既有按操作撤销范围不登记，
 * `operation_id` 恒为 null。
 */
const executeGroupRename = (
  command: Extract<CliProxyCommand, { command: 'canvas.group.rename' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    return projectNotOpenResponse('canvas.group.rename', requestId);
  }

  const target = nodeGraph.nodes.find((node) => node.id === command.group);
  if (target === undefined) {
    console.debug('[cliProxyReceiver] group rename rejected: target not found', {
      request_id: requestId,
      group: command.group,
    });
    return buildErrorResponse(
      'canvas.group.rename',
      requestId,
      'group_not_found',
      `画布上找不到这个组：${command.group}。请确认组标识后重试。`,
    );
  }
  if (target.type !== 'group') {
    console.debug('[cliProxyReceiver] group rename rejected: target is not a node group', {
      request_id: requestId,
      group: command.group,
      nodeType: target.type,
    });
    return buildErrorResponse(
      'canvas.group.rename',
      requestId,
      'command_rejected',
      target.type === 'agent'
        ? `这个节点是 Agent 容器，其标题由会话管理，不能通过命令重命名：${command.group}。`
        : `这个节点不是节点组：${command.group}。重命名命令只作用于节点组。`,
    );
  }

  const name = command.name.trim();
  if (name.length === 0) {
    // 解析器已按用法错误拒绝一次；代理通道可被直接调用，此处兜底。
    console.debug('[cliProxyReceiver] group rename rejected: empty name', {
      request_id: requestId,
      group: command.group,
    });
    return buildErrorResponse(
      'canvas.group.rename',
      requestId,
      'command_rejected',
      '组名不能为空：去除首尾空白后必须至少包含一个字符。',
    );
  }

  store.renameGroup(command.group, name);

  return {
    command: 'canvas.group.rename',
    request_id: requestId,
    group_node_id: command.group,
    name,
    operation_id: null,
  };
};

/**
 * canvas.group.dissolve → 按容器类型分述的解散（spec CLI-027；docs/runtime/画布节点组.md「解散」）。
 *
 * 组：映射删除咽喉 removeNodes（deleteGroupMembers=false，不连删）——画布级删除组与解散是
 * 同一个解散数据动作，成员关系解除、组节点删除、绑定组注释级联在同一存储写入路径收口；
 * Agent 容器：映射 dissolveAgentContainer（纯解除成员关系，头节点保留、会话保留）。
 * 成员列表在动作执行前从 store 现值捕获，随响应回传。
 */
const executeGroupDissolve = (
  command: Extract<CliProxyCommand, { command: 'canvas.group.dissolve' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    return projectNotOpenResponse('canvas.group.dissolve', requestId);
  }

  const target = nodeGraph.nodes.find((node) => node.id === command.group);
  if (!target) {
    console.debug('[cliProxyReceiver] group dissolve rejected: container not found', {
      request_id: requestId,
      group: command.group,
    });
    return buildErrorResponse(
      'canvas.group.dissolve',
      requestId,
      'group_not_found',
      `画布上找不到这个组：${command.group}。请确认组标识后重试。`,
    );
  }
  if (!isContainerNode(target)) {
    console.debug('[cliProxyReceiver] group dissolve rejected: target is not a container', {
      request_id: requestId,
      group: command.group,
      nodeType: target.type,
    });
    return buildErrorResponse(
      'canvas.group.dissolve',
      requestId,
      'command_rejected',
      `这个节点不是节点组：${command.group}。解散命令只作用于节点组或 Agent 容器。`,
    );
  }
  if (target.type === 'agent') {
    // Agent 容器解散仅对容器形态（有成员）可用（AG-CN-015）：无成员已是单节点形态、无组织关系可解除
    const members = getGroupMembers(nodeGraph, command.group);
    const dissolved = store.dissolveAgentContainer(command.group);
    if (!dissolved) {
      console.debug('[cliProxyReceiver] group dissolve rejected: agent node has no members', {
        request_id: requestId,
        group: command.group,
      });
      return buildErrorResponse(
        'canvas.group.dissolve',
        requestId,
        'command_rejected',
        `这个 Agent 节点当前没有成员，已呈单节点形态，无需解散：${command.group}。`,
      );
    }
    return {
      command: 'canvas.group.dissolve',
      request_id: requestId,
      dissolved: true,
      group_node_id: command.group,
      member_ids: members.map((member) => member.id),
      operation_id: registerUnsupportedOperation(),
    };
  }

  // 组解散 = 画布级删除组的同一解散数据动作：走删除咽喉（不连删），成员保留原位、归属解除。
  const members = getGroupMembers(nodeGraph, command.group);
  store.removeNodes([command.group], { deleteGroupMembers: false });
  return {
    command: 'canvas.group.dissolve',
    request_id: requestId,
    dissolved: true,
    group_node_id: command.group,
    member_ids: members.map((member) => member.id),
    operation_id: registerUnsupportedOperation(),
  };
};

/**
 * 成员加入/移出的目标校验（spec CLI-049）：目标必须是节点组。
 *
 * Agent 容器的成员由会话管理，命令面不提供其成员增删；其他节点类型也一律拒绝。
 * 目标不存在 → group_not_found；存在但不是节点组 → command_rejected。
 */
const resolveNodeGroupTarget = (
  commandName: 'canvas.group.add' | 'canvas.group.remove',
  requestId: string,
  groupId: string,
  nodeGraph: NodeGraph,
): { ok: true; target: NodeGraph['nodes'][number] } | { ok: false; error: CliProxyCommandError } => {
  const target = nodeGraph.nodes.find((node) => node.id === groupId);
  if (target === undefined) {
    console.debug('[cliProxyReceiver] group membership rejected: target not found', {
      request_id: requestId,
      command: commandName,
      group: groupId,
    });
    return {
      ok: false,
      error: buildErrorResponse(
        commandName,
        requestId,
        'group_not_found',
        `画布上找不到这个组：${groupId}。请确认组标识后重试。`,
      ),
    };
  }
  if (target.type === 'group') return { ok: true, target };
  console.debug('[cliProxyReceiver] group membership rejected: target is not a node group', {
    request_id: requestId,
    command: commandName,
    group: groupId,
    nodeType: target.type,
  });
  return {
    ok: false,
    error: buildErrorResponse(
      commandName,
      requestId,
      'command_rejected',
      target.type === 'agent'
        ? `这个节点是 Agent 容器，其成员由会话管理，不能通过命令加入或移出：${groupId}。`
        : `这个节点不是节点组：${groupId}。成员加入/移出命令只作用于节点组。`,
    ),
  };
};

/**
 * canvas.group.add → 成员归属写入（spec CLI-049）。
 *
 * 复用既有 store 动作：未归属成员经 addNodesToGroup 直接加入，跨组迁移经
 * moveNodesBetweenGroups 覆盖原 groupId（原组关系自然解除）。已在目标组的成员为 no-op。
 * 组节点不得入组、成员必须存在（整批前置校验，不部分成功）；新增与迁移在同一历史合批内
 * 收口为一条撤销记录（historyBatchActive 既有模式，不另建入栈路径）。
 */
const executeGroupAdd = (
  command: Extract<CliProxyCommand, { command: 'canvas.group.add' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    return projectNotOpenResponse('canvas.group.add', requestId);
  }

  const target = resolveNodeGroupTarget('canvas.group.add', requestId, command.group, nodeGraph);
  if (!target.ok) return target.error;

  // 成员去重保序：同一 id 重复出现按一个成员处理
  const memberIds = [...new Set(command.members)];
  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));
  const missingIds = memberIds.filter((id) => !nodeById.has(id));
  if (missingIds.length > 0) {
    console.debug('[cliProxyReceiver] group add rejected: member nodes not found', {
      request_id: requestId,
      missing: missingIds,
    });
    return buildErrorResponse(
      'canvas.group.add',
      requestId,
      'node_not_found',
      `画布上找不到这些节点：${missingIds.join('、')}。请确认节点标识后重试。`,
    );
  }
  const groupNodeIds = memberIds.filter((id) => nodeById.get(id)?.type === 'group');
  if (groupNodeIds.length > 0) {
    console.debug('[cliProxyReceiver] group add rejected: group nodes in members', {
      request_id: requestId,
      groupNodes: groupNodeIds,
    });
    return buildErrorResponse(
      'canvas.group.add',
      requestId,
      'command_rejected',
      `这些节点本身是节点组，不能作为另一个组的成员：${groupNodeIds.join('、')}。请调整成员清单后重试。`,
    );
  }

  // 按加入前归属分类（响应事实源）：未归属 → 新增；属于其他组 → 跨组迁移；已在目标组 → 无操作。
  const addedNodeIds: string[] = [];
  const movedNodeIds: string[] = [];
  const unchangedNodeIds: string[] = [];
  for (const id of memberIds) {
    const node = nodeById.get(id);
    if (node === undefined) continue; // 前置校验已排除缺失，防御分支
    if (node.groupId === command.group) {
      unchangedNodeIds.push(id);
    } else if (typeof node.groupId === 'string' && node.groupId.length > 0) {
      movedNodeIds.push(id);
    } else {
      addedNodeIds.push(id);
    }
  }

  if (addedNodeIds.length > 0 || movedNodeIds.length > 0) {
    // 新增 + 迁移在同一历史合批内收口为一条撤销记录（与 executeGroupCreate 同一模式）。
    useCanvasStore.setState((state) => {
      state.historyBatchActive = true;
    });
    try {
      if (addedNodeIds.length > 0) {
        store.addNodesToGroup(addedNodeIds, command.group);
      }
      if (movedNodeIds.length > 0) {
        store.moveNodesBetweenGroups(movedNodeIds, command.group);
      }
    } finally {
      useCanvasStore.setState((state) => {
        state.historyBatchActive = false;
      });
    }
    useCanvasStore.getState().saveToHistory();
  }

  return {
    command: 'canvas.group.add',
    request_id: requestId,
    group_node_id: command.group,
    added_node_ids: addedNodeIds,
    moved_node_ids: movedNodeIds,
    unchanged_node_ids: unchangedNodeIds,
    operation_id: registerUnsupportedOperation(),
  };
};

/**
 * canvas.group.remove → 成员移出目标组（spec CLI-049）。
 *
 * 复用既有 removeNodesFromGroup；成员保留画布原位、归属解除。成员必须当前属于目标组，
 * 任一成员不属于（含未归属、属于其他组）即整批拒绝并点名；成员不存在 → node_not_found；
 * 组节点不是任何容器的成员，直接以 command_rejected 拒绝。整批一条撤销记录。
 */
const executeGroupRemove = (
  command: Extract<CliProxyCommand, { command: 'canvas.group.remove' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    return projectNotOpenResponse('canvas.group.remove', requestId);
  }

  const target = resolveNodeGroupTarget('canvas.group.remove', requestId, command.group, nodeGraph);
  if (!target.ok) return target.error;

  // 成员去重保序：同一 id 重复出现按一个成员处理
  const memberIds = [...new Set(command.members)];
  const nodeById = new Map(nodeGraph.nodes.map((node) => [node.id, node] as const));
  const missingIds = memberIds.filter((id) => !nodeById.has(id));
  if (missingIds.length > 0) {
    console.debug('[cliProxyReceiver] group remove rejected: member nodes not found', {
      request_id: requestId,
      missing: missingIds,
    });
    return buildErrorResponse(
      'canvas.group.remove',
      requestId,
      'node_not_found',
      `画布上找不到这些节点：${missingIds.join('、')}。请确认节点标识后重试。`,
    );
  }
  const groupNodeIds = memberIds.filter((id) => nodeById.get(id)?.type === 'group');
  if (groupNodeIds.length > 0) {
    console.debug('[cliProxyReceiver] group remove rejected: group nodes in members', {
      request_id: requestId,
      groupNodes: groupNodeIds,
    });
    return buildErrorResponse(
      'canvas.group.remove',
      requestId,
      'command_rejected',
      `这些节点本身是节点组，不是任何组的成员：${groupNodeIds.join('、')}。请调整成员清单后重试。`,
    );
  }
  const notMemberIds = memberIds.filter((id) => {
    const node = nodeById.get(id);
    return node === undefined || node.groupId !== command.group;
  });
  if (notMemberIds.length > 0) {
    console.debug('[cliProxyReceiver] group remove rejected: members not in target group', {
      request_id: requestId,
      group: command.group,
      notMembers: notMemberIds,
    });
    return buildErrorResponse(
      'canvas.group.remove',
      requestId,
      'command_rejected',
      `这些节点当前不属于这个组：${notMemberIds.join('、')}。移出命令要求成员都属于目标组，请确认后重试。`,
    );
  }

  useCanvasStore.setState((state) => {
    state.historyBatchActive = true;
  });
  try {
    store.removeNodesFromGroup(memberIds);
  } finally {
    useCanvasStore.setState((state) => {
      state.historyBatchActive = false;
    });
  }
  useCanvasStore.getState().saveToHistory();

  return {
    command: 'canvas.group.remove',
    request_id: requestId,
    group_node_id: command.group,
    removed_node_ids: memberIds,
    operation_id: registerUnsupportedOperation(),
  };
};

export const executeGroupCommand = (
  command: Extract<
    CliProxyCommand,
    {
      command:
        | 'canvas.group.create'
        | 'canvas.group.rename'
        | 'canvas.group.dissolve'
        | 'canvas.group.add'
        | 'canvas.group.remove';
    }
  >,
): CliProxyCommandResponse => {
  switch (command.command) {
    case 'canvas.group.create':
      return executeGroupCreate(command);
    case 'canvas.group.rename':
      return executeGroupRename(command);
    case 'canvas.group.dissolve':
      return executeGroupDissolve(command);
    case 'canvas.group.add':
      return executeGroupAdd(command);
    case 'canvas.group.remove':
      return executeGroupRemove(command);
  }
};

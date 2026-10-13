/**
 * CLI 代理执行通道 · 画布窗口侧接收器（spec docs/integrations/CLI与本地Agent集成.md §6.3）。
 *
 * 职责：
 * - 订阅主进程发来的命令请求（`CLI_PROXY_REQUEST_CHANNEL`，经 preload `onCliProxyRequest`
 *   原样透传），消费端先经 `CliProxyCommandSchema.parse()` 校验；非法形状立即回错误响应，
 *   不抛进队列（消费端 Zod parse 纪律）。
 * - 命令逐条串行执行：前一条 settle（成功或失败）后才开始下一条，逐条捕获异常映射为错误
 *   响应，单条失败不阻塞队列。「用户手工操作优先」由事件循环天然提供（命令之间、命令与
 *   用户操作之间不交错撕裂），不做手势检测。
 * - 命令映射为既有编辑 action / 用户取消链执行，享受撤销栈、自动保存与画布投影的既有机制；
 *   响应经 `CliProxyCommandResponseSchema.parse()` 校验后原路回传（request_id 原样携带）。
 * - 每条命令的执行结果（成功/错误码）留 debug 日志，与主进程侧按请求标识对账（spec §11）。
 *
 * 映射口径：
 * - `canvas.group.create` → `createGroup`（组语义 docs/runtime/画布节点组.md）：
 *   成员不存在 → `node_not_found`；成员含组节点 → `command_rejected`（组不得入组，AG-CN-001；
 *   createGroup 对非法成员按静默过滤处理，映射层在此显式拒绝，避免静默丢成员的假成功）。
 *   已归属其他容器的成员先解除归属再建组（spec §5.3「成员已归属其他组时按空间归属改写语义
 *   重新归属，与界面拖拽同语义」），解除归属与建组在同一历史合批内收口为一条撤销记录
 *   （historyBatchActive 既有合批模式，本映射不自建第二套入栈）；组名经 `renameGroup`
 *   落到组节点（renameGroup 非合批感知，独立成一条历史，用户可逐步撤销）。
 * - `canvas.layout` → `scope=all` 映射 `autoLayout`（columns 参数对全局整理无既有语义，
 *   契约允许携带、执行侧忽略——全局整理固定单列，docs/runtime/画布自动布局算法.md）；
 *   `scope={group}` 映射 `autoLayoutContainer`（组与 Agent 容器同一动作同一语义）；
 *   受影响节点的最终位置映射从 store 现值读取（不使用 action 返回值，容器内整理的返回
 *   位置是锚点补偿前的算法输出）。
 * - `task.cancel` → `promptDockApi.cancelTask`（与 TaskNode 用户取消链同一函数，同语义；
 *   投影移除由 Backend 结算终态通知驱动，此处不新增「立即移除」旁路）。Backend 拒绝
 *   （非 2xx）映射 `command_rejected` 并携带 Backend 理由。
 * - `generate` → 程序化提交纯入口 `submitGenerationBatchFromIntent`（spec §6.4：与界面提交
 *   同一共享核心——同一前置校验、同一提交请求、同一受理回执处理；CLI 形态差异仅错误码映射
 *   与不做任务节点选中反馈）。校验失败按问题输入映射错误码（invalid_reference /
 *   model_not_available / command_rejected，定位到问题输入）；提交传输层失败原样映射
 *   internal_error，不重试（spec §5.4）。`wait` 参数画布侧不消费（受理后轮询归本地控制服务侧）。
 *   本分支只读模型目录（promptDockStore.catalog），不读写创作面草稿状态。
 * - `canvas.selection.get` → 画布状态只读查询（spec §6.3 只读查询条款 / §5.5 app status）：
 *   直读 canvasStore 现值（selectedNodeIds / selectedAnnotationIds），不映射 action、不进撤销栈、
 *   不产生任何写入；画布尚未就绪（nodeGraph 未载入）时选中态输出 null，命令不失败（CLI-021）。
 *   与写命令的 project_not_open 拒绝不同：窗口在役事实由主进程侧守卫，此处只读不拒项目。
 *
 * 本模块不读写创作面输入草稿状态；仅画布窗口经 desktop-main 入口初始化订阅。
 */

import {
  CliProxyCommandResponseSchema,
  CliProxyCommandSchema,
} from '@iart/contracts';
import type {
  CliErrorCode,
  CliProxyCommand,
  CliProxyCommandError,
  CliProxyCommandResponse,
  CliProxyCommandResult,
} from '@iart/contracts';
import { isApiError } from '@/client/api/clientTypes';
import { cancelTask } from '@/client/api/promptDockApi';
import {
  getGroupMembers,
  isContainerCollapsed,
  isContainerNode,
  isGroupMember,
} from '@/features/canvas/services/groupMembership';
import {
  buildProgrammaticIntentFromCliParams,
  submitGenerationBatchFromIntent,
} from '@/features/promptdock/programmaticSubmission';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';

// ---------------------------------------------------------------------------
// 错误响应构造（spec §9：message 面向使用 CLI 的开发者，用户视角业务语言，不暴露内部术语）
// ---------------------------------------------------------------------------

const buildErrorResponse = (
  commandName: CliProxyCommand['command'],
  requestId: string,
  code: CliErrorCode,
  message: string,
): CliProxyCommandError => ({
  command: commandName,
  request_id: requestId,
  error: { code, message },
});

/** 从 unknown 记录读取一个字符串字段（不命中返回 null）。 */
const readRecordStringField = (value: unknown, key: string): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' && field.length > 0 ? field : null;
};

/** 把 HTTP 错误体（{code, message}）里的 Backend 理由取出，缺失时回退到 transport 消息。 */
const readBackendRejectionDetail = (body: unknown, fallback: string): string => {
  const message = readRecordStringField(body, 'message');
  return message ?? fallback;
};

// ---------------------------------------------------------------------------
// 串行执行队列
// ---------------------------------------------------------------------------

let queueTail: Promise<void> = Promise.resolve();

/**
 * 把一条命令的执行任务追加到串行队列尾部。
 *
 * 返回本条任务自身的 settle promise（调用方可 await 观察本条结果）；队列尾始终吞掉上一条
 * 的异常，保证前一条失败不阻塞后一条。
 */
const enqueueCommand = (task: () => Promise<void>): Promise<void> => {
  const run = queueTail.then(task);
  queueTail = run.catch(() => undefined);
  return run;
};

// ---------------------------------------------------------------------------
// 三条命令的执行映射
// ---------------------------------------------------------------------------

/** 项目上下文缺失（nodeGraph 未载入）时的统一拒绝；条件跳过按仓库纪律留 debug 痕。 */
const projectNotOpenResponse = (
  commandName: CliProxyCommand['command'],
  requestId: string,
): CliProxyCommandError => {
  console.debug('[cliProxyReceiver] command skipped: canvas graph not loaded', {
    request_id: requestId,
    command: commandName,
  });
  return buildErrorResponse(
    commandName,
    requestId,
    'project_not_open',
    '这个项目还没有在画布中打开，请先在应用中打开项目后再试。',
  );
};

/** 从 store 现值读取受影响节点的最终位置映射（缺失节点静默跳过）。 */
const readFinalPositions = (
  requestId: string,
  affectedNodeIds: readonly string[],
): Extract<CliProxyCommandResult, { command: 'canvas.layout' }> => {
  const nodeGraph = useCanvasStore.getState().nodeGraph;
  const positions: Record<string, { x: number; y: number }> = {};
  if (nodeGraph !== null) {
    for (const nodeId of affectedNodeIds) {
      const node = nodeGraph.nodes.find((candidate) => candidate.id === nodeId);
      if (node) {
        positions[nodeId] = { x: node.position.x, y: node.position.y };
      }
    }
  }
  return { command: 'canvas.layout', request_id: requestId, positions };
};

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

  return {
    command: 'canvas.group.create',
    request_id: requestId,
    group_node_id: groupId,
  };
};

const executeCanvasLayout = async (
  command: Extract<CliProxyCommand, { command: 'canvas.layout' }>,
): Promise<CliProxyCommandResponse> => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    return projectNotOpenResponse('canvas.layout', requestId);
  }

  if (command.scope === 'all') {
    // columns 参数对全局整理无既有语义（全局整理固定单列），契约允许携带、执行侧忽略。
    const affectedNodeIds = nodeGraph.nodes
      .filter((node) => !isContainerNode(node) && !isGroupMember(node))
      .map((node) => node.id);
    await store.autoLayout(undefined);
    return readFinalPositions(requestId, affectedNodeIds);
  }

  const groupId = command.scope.group;
  const container = nodeGraph.nodes.find((node) => node.id === groupId && isContainerNode(node));
  if (!container) {
    console.debug('[cliProxyReceiver] layout rejected: group not found', {
      request_id: requestId,
      group: groupId,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'group_not_found',
      `画布上找不到这个组：${groupId}。请确认组标识后重试。`,
    );
  }
  if (isContainerCollapsed(container)) {
    console.debug('[cliProxyReceiver] layout rejected: container collapsed', {
      request_id: requestId,
      group: groupId,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      '这个组当前处于折叠状态，展开后才能整理布局。',
    );
  }
  const members = getGroupMembers(nodeGraph, groupId);
  if (members.length === 0) {
    console.debug('[cliProxyReceiver] layout rejected: no layout-able members', {
      request_id: requestId,
      group: groupId,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      '这个组还没有成员，无法整理布局。',
    );
  }

  // measured 传 undefined：走 store 会话态缓存兜底（与全局整理同口径，视口外节点不可实时测量）
  const result = await store.autoLayoutContainer(groupId, {
    measuredSizeByNodeId: undefined,
    derivedSizeByNodeId: undefined,
    columns: command.columns,
  });
  if (result === null) {
    console.debug('[cliProxyReceiver] container layout returned null', {
      request_id: requestId,
      group: groupId,
    });
    return buildErrorResponse(
      'canvas.layout',
      requestId,
      'command_rejected',
      '无法整理这个组的布局，请稍后重试。',
    );
  }
  return readFinalPositions(requestId, members.map((member) => member.id));
};

const executeTaskCancel = async (
  command: Extract<CliProxyCommand, { command: 'task.cancel' }>,
): Promise<CliProxyCommandResponse> => {
  const requestId = command.request_id;
  const taskId = command.task_id;
  try {
    const result = await cancelTask(taskId);
    if (!result.accepted) {
      // 防御分支：现行 Backend 拒绝一律走非 2xx，不会出现 200 + accepted:false
      console.debug('[cliProxyReceiver] task cancel not accepted', {
        request_id: requestId,
        task_id: taskId,
      });
      return buildErrorResponse(
        'task.cancel',
        requestId,
        'command_rejected',
        `任务 ${taskId} 当前不接受取消操作，请稍后重试。`,
      );
    }
    return {
      command: 'task.cancel',
      request_id: requestId,
      accepted: true,
      task_id: result.task_id,
      cancelled_at: result.cancelled_at,
    };
  } catch (error) {
    // isApiError 只看「对象持有 string message」，Error 实例也会命中；
    // transport 的 HTTP 拒绝恒携带数字 status，用它判别「Backend 拒绝」与「传输层/意外失败」。
    if (isApiError(error) && typeof error.status === 'number') {
      // Backend 拒绝（非 2xx，错误体 {code, message}）→ command_rejected 并携带 Backend 理由
      const detail = readBackendRejectionDetail(
        error.body,
        typeof error.message === 'string' && error.message.length > 0 ? error.message : '未知原因',
      );
      console.debug('[cliProxyReceiver] task cancel rejected by backend', {
        request_id: requestId,
        task_id: taskId,
        status: error.status,
      });
      if (error.status === 404) {
        return buildErrorResponse(
          'task.cancel',
          requestId,
          'command_rejected',
          `找不到任务 ${taskId}，无法取消。`,
        );
      }
      return buildErrorResponse(
        'task.cancel',
        requestId,
        'command_rejected',
        `任务 ${taskId} 无法取消：${detail}。`,
      );
    }
    const detail = error instanceof Error
      ? error.message
      : isApiError(error)
        ? error.message
        : String(error);
    console.debug('[cliProxyReceiver] task cancel crashed', {
      request_id: requestId,
      task_id: taskId,
      detail,
    });
    return buildErrorResponse(
      'task.cancel',
      requestId,
      'internal_error',
      `取消任务时出现意外错误。技术细节：${detail}`,
    );
  }
};

/**
 * generate → 程序化提交纯入口（spec §6.4 程序化提交）。
 *
 * 与界面提交同一共享核心（前置校验 → 提交受理 → 受理回执创建任务节点并落位）；本映射只做
 * 通道形态转换：契约参数 → 提交意图、受理结果/错误 → 原路响应。项目未打开（nodeGraph 未
 * 载入）在进入程序化提交前拒绝（spec §4.2：生成提交要求项目已打开，不提交后才发现）。
 */
const executeGenerate = async (
  command: Extract<CliProxyCommand, { command: 'generate' }>,
): Promise<CliProxyCommandResponse> => {
  const requestId = command.request_id;
  if (useCanvasStore.getState().nodeGraph === null) {
    return projectNotOpenResponse('generate', requestId);
  }
  const intent = buildProgrammaticIntentFromCliParams({
    prompt: command.prompt,
    model: command.model,
    count: command.count,
    ref: command.ref,
    arg: command.arg,
    // wait 由本地控制服务侧消费（受理后轮询）；画布窗口只做程序化提交，原样透传不消费。
    wait: command.wait,
  });
  try {
    const outcome = await submitGenerationBatchFromIntent(intent);
    if (outcome.ok) {
      // 受理结果与 B 命令面 generate 响应的受理部分同形状（批次标识 + 任务身份列表）。
      return {
        command: 'generate',
        request_id: requestId,
        batch_id: outcome.acceptance.batch_id,
        tasks: outcome.acceptance.tasks,
      };
    }
    console.debug('[cliProxyReceiver] generate rejected', {
      request_id: requestId,
      code: outcome.error.code,
    });
    return buildErrorResponse('generate', requestId, outcome.error.code, outcome.error.message);
  } catch (error) {
    // 防御分支：纯入口已把可预期失败收敛为结果值（含传输层失败）；此处只兜意外异常。
    const detail = error instanceof Error ? error.message : String(error);
    console.debug('[cliProxyReceiver] generate crashed', { request_id: requestId, detail });
    return buildErrorResponse(
      'generate',
      requestId,
      'internal_error',
      `提交生成时出现意外错误。技术细节：${detail}`,
    );
  }
};

/**
 * canvas.selection.get → 画布状态只读查询（spec §6.3 只读查询条款 / §5.5 CLI-021）。
 *
 * 直读 canvasStore 现值，不映射 action、不进撤销栈、不产生任何写入；选中集合可能含
 * 组/Agent 容器等，凡在 selectedNodeIds 里即按节点 id 原样输出，不做特判。
 * 画布尚未就绪（窗口已创建、nodeGraph 仍未载入）时选中态输出 null——与写命令的
 * project_not_open 拒绝语义不同：窗口在役事实由主进程侧守卫，本查询只读不失败。
 */
const executeSelectionGet = (
  command: Extract<CliProxyCommand, { command: 'canvas.selection.get' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  if (store.nodeGraph === null) {
    console.debug('[cliProxyReceiver] selection read skipped: canvas graph not loaded', {
      request_id: requestId,
    });
    return { command: 'canvas.selection.get', request_id: requestId, selection: null };
  }
  return {
    command: 'canvas.selection.get',
    request_id: requestId,
    selection: {
      node_ids: [...store.selectedNodeIds],
      annotation_ids: [...store.selectedAnnotationIds],
    },
  };
};

/**
 * 执行单条已通过 schema 校验的命令并产出响应。
 *
 * 所有可预期失败都在映射层收敛为错误响应；本函数自身不再向外抛异常以外的失败
 * （外层 processValidCommand 另有兜底）。
 */
export const executeCliProxyCommand = async (
  command: CliProxyCommand,
): Promise<CliProxyCommandResponse> => {
  switch (command.command) {
    case 'canvas.group.create':
      return executeGroupCreate(command);
    case 'canvas.layout':
      return executeCanvasLayout(command);
    case 'task.cancel':
      return executeTaskCancel(command);
    case 'generate':
      return executeGenerate(command);
    case 'canvas.selection.get':
      return executeSelectionGet(command);
  }
};

// ---------------------------------------------------------------------------
// 载荷处理管线（订阅入口与测试共用）
// ---------------------------------------------------------------------------

const sendValidatedResponse = (
  response: CliProxyCommandResponse,
  send: (payload: CliProxyCommandResponse) => void,
): void => {
  // 发送前经契约 schema 校验（响应构造缺陷在边界即失败，不带病出窗）
  const validated = CliProxyCommandResponseSchema.parse(response);
  send(validated);
};

/** 命令执行任务：执行 → 结果留痕 → 校验后回传。异常兜底为 internal_error，不阻塞队列。 */
const processValidCommand = async (
  command: CliProxyCommand,
  send: (payload: CliProxyCommandResponse) => void,
): Promise<void> => {
  try {
    const response = await executeCliProxyCommand(command);
    console.debug('[cliProxyReceiver] command completed', {
      request_id: command.request_id,
      command: command.command,
      ok: !('error' in response),
      errorCode: 'error' in response ? response.error.code : null,
    });
    sendValidatedResponse(response, send);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[cliProxyReceiver] command pipeline crashed', {
      request_id: command.request_id,
      command: command.command,
      detail,
    });
    sendValidatedResponse(
      buildErrorResponse(
        command.command,
        command.request_id,
        'internal_error',
        '命令执行失败，出现意外错误。',
      ),
      send,
    );
  }
};

/**
 * 处理一条来自主进程的原始命令载荷：schema 校验 → 入串行队列 → 执行 → 回传。
 *
 * 非法载荷立即回错误响应、不进队列；载荷里连 request_id/command 都识别不出来时无法
 * 构造可对账的响应，只能留痕丢弃（响应必须原样携带 request_id，凑不出来无从配对）。
 *
 * 返回本条命令的 settle promise（仅队内命令；非法载荷立即 resolve），供测试与订阅侧观察。
 */
export const handleCliProxyPayload = (
  raw: unknown,
  send: (payload: CliProxyCommandResponse) => void,
): Promise<void> => {
  const parsed = CliProxyCommandSchema.safeParse(raw);
  if (!parsed.success) {
    const rawCommand = readRecordStringField(raw, 'command');
    const rawRequestId = readRecordStringField(raw, 'request_id');
    console.debug('[cliProxyReceiver] invalid command payload', {
      command: rawCommand,
      request_id: rawRequestId,
      issues: parsed.error.issues.length,
    });
    const commandName =
      rawCommand === 'canvas.group.create' ||
      rawCommand === 'canvas.layout' ||
      rawCommand === 'task.cancel' ||
      rawCommand === 'generate' ||
      rawCommand === 'canvas.selection.get'
        ? rawCommand
        : null;
    if (commandName !== null && rawRequestId !== null) {
      sendValidatedResponse(
        buildErrorResponse(
          commandName,
          rawRequestId,
          'internal_error',
          '命令格式不正确，无法执行。请检查命令参数后重试。',
        ),
        send,
      );
    }
    return Promise.resolve();
  }
  return enqueueCommand(() => processValidCommand(parsed.data, send));
};

// ---------------------------------------------------------------------------
// 订阅初始化（仅画布窗口：desktop-main 入口一次性调用）
// ---------------------------------------------------------------------------

let receiverInitialized = false;

/**
 * 初始化 CLI 代理执行通道接收器：订阅主进程命令请求并原路回传响应。
 *
 * 幂等：重复调用不重复订阅。非桌面宿主（无 electron 桥）留痕跳过——渲染层不重试，
 * 画布窗口一定经桌面宿主加载。桥成员类型已登记在 backend-sdk ElectronBridge
 * （批次二欠账随批次四补齐），不再局部收窄；运行期仍守卫成员存在（防宿主桥版本漂移）。
 */
export const initCliProxyReceiver = (): void => {
  if (receiverInitialized) return;
  if (typeof window === 'undefined') return;
  const electron = window.electron;
  if (!electron) {
    console.debug('[cliProxyReceiver] electron bridge unavailable; receiver not initialized');
    return;
  }
  if (typeof electron.onCliProxyRequest !== 'function' || typeof electron.sendCliProxyResponse !== 'function') {
    console.debug('[cliProxyReceiver] cli proxy bridge members unavailable; receiver not initialized');
    return;
  }
  // 收窄固化到局部常量：属性收窄不随闭包延续，回调内不能直接依赖守卫后的成员收窄。
  const { onCliProxyRequest, sendCliProxyResponse } = {
    onCliProxyRequest: electron.onCliProxyRequest,
    sendCliProxyResponse: electron.sendCliProxyResponse,
  };
  receiverInitialized = true;
  onCliProxyRequest((payload) => {
    void handleCliProxyPayload(payload, (response) => {
      sendCliProxyResponse(response);
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[cliProxyReceiver] queued command failed unexpectedly', { detail });
    });
  });
};

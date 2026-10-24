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
 * - `asset.import` → 既有导入链（前置校验原子性 → 写盘登记 → 素材节点落图 → 整批一条撤销；复用边界见 cliAssetImport.ts）。
 * - `canvas.group.create / dissolve / add / remove` → 组/容器命令映射拆到
 *   `cliProxyGroupCommands.ts`（建组、解散、成员加入与移出；复用既有编辑 action 与删除咽喉）。
 * - `canvas.node.move` → `updateNodePositionsBatch`（与界面拖拽同一位置写入 action，伴随节点
 *   跟随与容器 position 重派生走其既有展开逻辑，spec CLI-028）。目标不存在 → `node_not_found`；
 *   目标是容器节点 → `command_rejected`（组位置是成员包围盒的派生量、不独立可写，移动一律
 *   成员级）。响应回传目标最终坐标（store 现值）与实际发生位移的节点集合（容器派生位移不计入）。
 * - `canvas.node.create` → 资产回填画布（CLI-056）：把已存在资产物化为资产节点
 *   （`addNode('asset', …)`，与任务投影/加工产出同一创建通道），可选入组与绝对落点；
 *   素材节点仍只能经 `asset.import` 导入链创建。实现在 `cliCanvasNodeCommands.ts`。
 * - `canvas.node.delete` → 删除咽喉 `removeNodes(ids, { deleteGroupMembers: false })`——与界面
 *   删除（deleteSelectedElements → removeNodes）同一动作同一连带语义：伴随节点级联、绑定注释
 *   级联、组节点删除即解散、Agent 删除前置钩子（先在途终止再删除）；CLI 不提供连删（连删是
 *   界面显式危险动作）。请求集直接命中 Agent 节点时必须携带 `yes: true`（界面删除确认框的
 *   CLI 对应物，AG-CT-011 禁旁路）。目标不存在 → `node_not_found`。响应回传实际删除集合
 *   （请求集 + 伴随节点级联）。
 * - `canvas.layout` → `scope=all` 映射 `autoLayout`（columns 语义对齐 spec §5.3「均映射
 *   列数语义」/ CLI-032：--columns 透传布局引擎，缺省单列默认行为不变）；
 *   `scope={group}` 映射 `autoLayoutContainer`（组与 Agent 容器同一动作同一语义）；
 *   `order` 显式顺序（spec CLI-030）在映射层前置校验（order 节点必须存在且属于本次整理
 *   作用域，缺失 → `node_not_found`、越界 → `command_rejected`）后经 store options 透传为
 *   布局输入序；缺省时不传 order，默认排序行为完全不变。受影响节点的最终位置映射从 store
 *   现值读取（不使用 action 返回值，容器内整理的返回位置是锚点补偿前的算法输出）。
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
import type { CliProxyCommand, CliProxyCommandResponse } from '@iart/contracts';
import { isApiError } from '@/client/api/clientTypes';
import { cancelTask } from '@/client/api/promptDockApi';
import { isContainerNode } from '@/features/canvas/services/groupMembership';
import {
  buildErrorResponse,
  projectNotOpenResponse,
  readBackendRejectionDetail,
  readRecordStringField,
} from './cliProxyErrorResponses';
import { executeGroupCommand } from './cliProxyGroupCommands';
import { expandRemovalWithCompanions } from '@/features/canvas/services/nodeCompanion/nodeCompanionManager';
import {
  buildProgrammaticIntentFromCliParams,
  submitGenerationBatchFromIntent,
} from '@/features/promptdock/programmaticSubmission';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { NodeGraph } from '@/features/canvas/types';
import { buildCanvasSizeSources } from '@/features/canvas/utils/nodeOccupancy';
import { buildGroupDerivedSize } from '@/features/canvas/components/canvas/groupDerivedSize';
import { resolveEffectiveSize } from '@/features/canvas/utils/effectiveSize';
import { executeAssetImport } from './cliAssetImport';
import { executeCanvasNodeCreate } from './cliCanvasNodeCommands';
import {
  executeCanvasUndo,
  executeGroupMove,
  executeNodeMove,
  executeNodesMove,
  issueUnsupportedOperationId,
} from './cliCanvasWriteCommands';
import { executeCanvasLayoutCommand } from './cliCanvasPlanCommand';

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

// canvas.node.move / canvas.nodes.move / canvas.group.move / canvas.layout / canvas.undo
// 的实现拆到 cliCanvasWriteCommands.ts（行数预算拆分）；接收器只保留分派。

/**
 * canvas.node.delete → 删除咽喉 removeNodes（spec CLI-029）。
 *
 * 与界面删除（deleteSelectedElements → removeNodes）同一动作同一连带语义：伴随节点级联、
 * 绑定注释级联、组节点删除即解散（不连删，成员保留）、Agent 删除前置钩子；CLI 不提供连删。
 * 请求集直接命中 Agent 节点时必须携带 yes=true（界面删除确认框的 CLI 对应物，AG-CT-011
 * 禁旁路）；确认后 removeNodes 的既有不可逆历史重建语义照常生效（删除 Agent 不提供撤销兜底）。
 * 响应回传实际删除集合（请求集 + 伴随节点级联，按删除前图展开）。
 */
const executeNodeDelete = (
  command: Extract<CliProxyCommand, { command: 'canvas.node.delete' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    return projectNotOpenResponse('canvas.node.delete', requestId);
  }

  // 去重保序：同一 id 重复出现按一个节点处理
  const nodeIds = [...new Set(command.nodes)];
  const missingIds: string[] = [];
  const agentNodeIds: string[] = [];
  for (const id of nodeIds) {
    const node = nodeGraph.nodes.find((candidate) => candidate.id === id);
    if (!node) {
      missingIds.push(id);
      continue;
    }
    if (node.type === 'agent') {
      agentNodeIds.push(id);
    }
  }
  if (missingIds.length > 0) {
    console.debug('[cliProxyReceiver] node delete rejected: nodes not found', {
      request_id: requestId,
      missing: missingIds,
    });
    return buildErrorResponse(
      'canvas.node.delete',
      requestId,
      'node_not_found',
      `画布上找不到这些节点：${missingIds.join('、')}。请确认节点标识后重试。`,
    );
  }
  if (agentNodeIds.length > 0 && command.yes !== true) {
    console.debug('[cliProxyReceiver] node delete rejected: agent delete without explicit confirm', {
      request_id: requestId,
      agentNodes: agentNodeIds,
    });
    return buildErrorResponse(
      'canvas.node.delete',
      requestId,
      'command_rejected',
      `删除 Agent 节点会同时删除它的会话与全部消息历史，且无法恢复：${agentNodeIds.join('、')}。请携带 --yes 显式确认后重试。`,
    );
  }

  // 实际删除集合按删除前图展开（请求集 + 伴随节点级联；deleteGroupMembers=false 不连删成员）
  const deletedNodeIds = expandRemovalWithCompanions(nodeGraph, nodeIds);
  store.removeNodes(nodeIds, { deleteGroupMembers: false });
  return {
    command: 'canvas.node.delete',
    request_id: requestId,
    deleted: true,
    deleted_node_ids: deletedNodeIds,
    // 删除属「不支持按操作撤销」的写命令：仍返回操作标识，使 canvas.undo 能返回
    // command_rejected（而不是把它当作未知标识）。
    operation_id: issueUnsupportedOperationId(),
  };
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
    // 受理幂等键原样透传（spec §5.4 受理幂等键 / CLI-033）：未携带为 undefined。
    client_request_id: command.client_request_id,
    // 出生组组名原样透传（spec CLI-043）：组名解析与出生入组在共享核心完成。
    ...(command.group !== undefined ? { group: command.group } : {}),
  });
  try {
    const outcome = await submitGenerationBatchFromIntent(intent);
    if (outcome.ok) {
      // 受理结果与 B 命令面 generate 响应的受理部分同形状（批次标识 + 任务身份列表）；
      // 幂等键回显与重放标志原样透传（spec §5.4 受理幂等键 / CLI-033）。
      return {
        command: 'generate',
        request_id: requestId,
        batch_id: outcome.acceptance.batch_id,
        tasks: outcome.acceptance.tasks,
        ...(outcome.acceptance.client_request_id !== undefined
          ? { client_request_id: outcome.acceptance.client_request_id }
          : {}),
        ...(outcome.acceptance.replayed !== undefined
          ? { replayed: outcome.acceptance.replayed }
          : {}),
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
 * 画布可视区像素尺寸（CSS px）：优先 ReactFlow 容器 DOM 的 clientWidth/clientHeight，
 * 容器不可得（未挂载 / 隐藏）时回落 window.innerWidth/innerHeight；非法或非正值输出 null。
 */
const readCanvasVisibleSize = (): { width: number | null; height: number | null } => {
  const normalize = (domValue: number | undefined, windowValue: number | undefined): number | null => {
    const value =
      typeof domValue === 'number' && Number.isFinite(domValue) && domValue > 0
        ? domValue
        : windowValue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    return null;
  };
  const windowWidth = typeof window === 'undefined' ? undefined : window.innerWidth;
  const windowHeight = typeof window === 'undefined' ? undefined : window.innerHeight;
  const container = typeof document === 'undefined' ? null : document.querySelector('.react-flow');
  if (container instanceof HTMLElement) {
    return {
      width: normalize(container.clientWidth, windowWidth),
      height: normalize(container.clientHeight, windowHeight),
    };
  }
  console.debug('[cliProxyReceiver] canvas container not found; viewport size falls back to window');
  return {
    width: normalize(undefined, windowWidth),
    height: normalize(undefined, windowHeight),
  };
};

/** 画布视口现值 → 契约视口形状（含可视区宽高）；缺失或数值非法输出 null（不伪造）。 */
const readCanvasViewport = (
  viewport: NodeGraph['viewport'],
): { x: number; y: number; zoom: number; width: number | null; height: number | null } | null => {
  if (viewport === undefined) return null;
  if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom)) {
    console.debug('[cliProxyReceiver] viewport values non-finite; output null');
    return null;
  }
  const visible = readCanvasVisibleSize();
  return {
    x: viewport.x,
    y: viewport.y,
    zoom: viewport.zoom,
    width: visible.width,
    height: visible.height,
  };
};

/**
 * canvas.geometry.get → 整张画布几何只读查询（canvas.inspect 的 exact 合并输入）。
 *
 * 直读 canvasStore 现值：普通节点尺寸经统一入口 resolveEffectiveSize 解析（layoutModel >
 * measured > default），容器 position/size 由 buildGroupDerivedSize 派生（与画布渲染同一
 * owner），容器派生 entry 缺失时按 nodeOccupancy 同口径回落有效尺寸 + store position。
 * 不映射 action、不进撤销栈、不产生任何写入。画布尚未就绪（nodeGraph 未载入）时返回空
 * 几何集合与 null 视口/选中态——主进程侧据此整体回落 derived，命令不失败。
 */
const executeGeometryGet = (
  command: Extract<CliProxyCommand, { command: 'canvas.geometry.get' }>,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) {
    console.debug('[cliProxyReceiver] geometry read skipped: canvas graph not loaded', {
      request_id: requestId,
    });
    return {
      command: 'canvas.geometry.get',
      request_id: requestId,
      sizes: {},
      containers: {},
      viewport: null,
      selection: null,
    };
  }

  const sizeSources = buildCanvasSizeSources(store);
  const derived = buildGroupDerivedSize({ nodes: nodeGraph.nodes, sizeSources });
  const sizes: Record<string, { width: number; height: number }> = {};
  const containers: Record<
    string,
    { position: { x: number; y: number }; size: { width: number; height: number } }
  > = {};

  for (const node of nodeGraph.nodes) {
    if (isContainerNode(node)) {
      const entry = derived.byGroupId[node.id];
      if (entry === undefined) {
        console.debug('[cliProxyReceiver] container derived entry missing, fallback to effective size', {
          nodeId: node.id,
          type: node.type,
        });
      }
      const size = entry?.size ?? resolveEffectiveSize(node, sizeSources);
      const position = entry?.position ?? { x: node.position.x, y: node.position.y };
      sizes[node.id] = { width: size.width, height: size.height };
      containers[node.id] = {
        position: { x: position.x, y: position.y },
        size: { width: size.width, height: size.height },
      };
      continue;
    }
    const size = resolveEffectiveSize(node, sizeSources);
    sizes[node.id] = { width: size.width, height: size.height };
  }

  return {
    command: 'canvas.geometry.get',
    request_id: requestId,
    sizes,
    containers,
    viewport: readCanvasViewport(nodeGraph.viewport),
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
    // asset.import → 既有导入链（映射与复用边界见 cliAssetImport.ts 文件头注）
    case 'asset.import':
      return executeAssetImport(command);
    case 'canvas.group.create':
    case 'canvas.group.rename':
    case 'canvas.group.dissolve':
    case 'canvas.group.add':
    case 'canvas.group.remove':
      return executeGroupCommand(command);
    case 'canvas.node.move':
      return executeNodeMove(command);
    case 'canvas.nodes.move':
      return executeNodesMove(command);
    case 'canvas.group.move':
      return executeGroupMove(command);
    case 'canvas.node.delete':
      return executeNodeDelete(command);
    case 'canvas.node.create':
      return executeCanvasNodeCreate(command);
    case 'canvas.layout':
      return executeCanvasLayoutCommand(command);
    case 'canvas.undo':
      return executeCanvasUndo(command);
    case 'task.cancel':
      return executeTaskCancel(command);
    case 'generate':
      return executeGenerate(command);
    case 'canvas.selection.get':
      return executeSelectionGet(command);
    case 'canvas.geometry.get':
      return executeGeometryGet(command);
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
      rawCommand === 'asset.import' ||
      rawCommand === 'canvas.group.create' ||
      rawCommand === 'canvas.group.rename' ||
      rawCommand === 'canvas.group.dissolve' ||
      rawCommand === 'canvas.group.add' ||
      rawCommand === 'canvas.group.remove' ||
      rawCommand === 'canvas.node.move' ||
      rawCommand === 'canvas.nodes.move' ||
      rawCommand === 'canvas.group.move' ||
      rawCommand === 'canvas.node.delete' ||
      rawCommand === 'canvas.node.create' ||
      rawCommand === 'canvas.layout' ||
      rawCommand === 'canvas.undo' ||
      rawCommand === 'task.cancel' ||
      rawCommand === 'generate' ||
      rawCommand === 'canvas.selection.get' ||
      rawCommand === 'canvas.geometry.get'
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

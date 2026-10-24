/**
 * CLI 代理执行通道 · 资产回填画布命令（spec docs/integrations/CLI与本地Agent集成.md §5.3 /
 * CLI-056；契约 packages/contracts/src/cli-canvas-contract.ts）。
 *
 * 从 cliProxyReceiver.ts / cliCanvasWriteCommands.ts 之外独立成模块（接收器只做分派；
 * cliCanvasWriteCommands 承载位置写原语且已接近行数预算）：
 * `canvas.node.create` → 既有 canvasStore.addNode('asset', …)（与任务投影/加工产出同一
 * 资产节点创建通道、同一 data 形状）。本模块不出现第二套建节点逻辑。
 *
 * 产品边界（上位依据 docs/product/00-产品定位与核心动作.md）：
 * - 已有资产放回画布**只按资产节点物化**（type=asset）；素材节点仍只能经本地导入链创建，
 *   本命令不接受素材节点类型；
 * - 同一资产可重复放入画布（每次新建一个资产节点），与「重复导入同一文件产生新节点」
 *   先例一致：不阻断、不提示错误；
 * - 生成产物的来源（批次/任务/模型）随节点保留：三字段由主进程反查后经代理命令补充
 *   （画布窗口没有资产→任务溯源读通道），导入素材无来源时落空串（AssetNodeData 的
 *   source* 字段是非空 string，不是自造可空字段）。
 *
 * 不变式：一次命令 = 一次 addNode = 一条撤销记录（addNode 在非合批态自行 saveToHistory）；
 * dry-run 只做校验与落位计算（纯读），零写入、零撤销记录，node_id/operation_id 为 null。
 */

import type { CliProxyCommand, CliProxyCommandResponse } from '@iart/contracts';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { AssetNodeData, GraphNode } from '@/features/canvas/types/node';
import { ASSET_NODE_LABEL } from '@/features/canvas/nodes/asset/assetNodeFactory';
import { buildErrorResponse, projectNotOpenResponse } from './cliProxyErrorResponses';
import { computeCliPlacementPositions } from './cliCanvasPlacement';
import { registerUnsupportedOperation } from './cliOperationRegistry';

type NodeCreateCommand = Extract<CliProxyCommand, { command: 'canvas.node.create' }>;

/** 媒体类型收窄（契约已收敛为三值；运行时守卫防旧库/异常投影把未知类型带进资产节点）。 */
const isSupportedMediaType = (value: string): value is AssetNodeData['mediaType'] =>
  value === 'image' || value === 'video' || value === 'audio';

/** 资产节点 data（字段事实源 AssetNodeData；来源缺失时按既有非空 string 落空串）。 */
const buildAssetNodeData = (params: {
  assetId: string;
  mediaType: AssetNodeData['mediaType'];
  sourceBatchId: string | undefined;
  sourceTaskId: string | undefined;
  sourceModelId: string | undefined;
}): AssetNodeData => ({
  label: ASSET_NODE_LABEL,
  sourceBatchId: params.sourceBatchId ?? '',
  sourceTaskId: params.sourceTaskId ?? '',
  sourceModelId: params.sourceModelId ?? '',
  mediaType: params.mediaType,
  assetId: params.assetId,
});

export const executeCanvasNodeCreate = (
  command: NodeCreateCommand,
): CliProxyCommandResponse => {
  const requestId = command.request_id;
  const store = useCanvasStore.getState();
  const nodeGraph = store.nodeGraph;
  if (nodeGraph === null) return projectNotOpenResponse('canvas.node.create', requestId);

  // 两轴成对（解析器已按用法错误拒绝一次；代理通道可被直调，这里兜业务拒绝）。
  const hasX = command.x !== undefined;
  const hasY = command.y !== undefined;
  if (hasX !== hasY) {
    console.debug('[cliCanvasNodeCreate] rejected: only one axis given', {
      request_id: requestId,
      asset: command.asset,
    });
    return buildErrorResponse(
      'canvas.node.create',
      requestId,
      'command_rejected',
      '--x 与 --y 必须同时给出或同时省略：只给一个轴无法确定落点。',
    );
  }

  // 资产必须在项目媒体资产中（主进程已前置拒绝；画布侧再兜一次，防代理通道直调）。
  const asset = store.mediaAssets[command.asset];
  if (asset === undefined) {
    console.debug('[cliCanvasNodeCreate] rejected: asset not in project media assets', {
      request_id: requestId,
      asset: command.asset,
    });
    return buildErrorResponse(
      'canvas.node.create',
      requestId,
      'asset_not_found',
      `没有找到这个资产：${command.asset}。请确认资产标识属于该项目（可用 asset list 查询）。`,
    );
  }
  // 媒体类型必须 ∈ image/video/audio（契约已收敛；运行时守卫防旧库或异常投影）。
  const mediaTypeRaw: string = asset.mediaType;
  if (!isSupportedMediaType(mediaTypeRaw)) {
    console.debug('[cliCanvasNodeCreate] rejected: unsupported media type', {
      request_id: requestId,
      asset: command.asset,
      mediaType: mediaTypeRaw,
    });
    return buildErrorResponse(
      'canvas.node.create',
      requestId,
      'command_rejected',
      `这个资产的媒体类型不支持放到画布：${mediaTypeRaw}。只支持图片、视频或音频。`,
    );
  }
  const mediaType = mediaTypeRaw;

  // --group 必须是存在的节点组（type=group）；Agent 容器与其他节点不接受。
  let groupId: string | null = null;
  if (command.group !== undefined) {
    const target = nodeGraph.nodes.find((node) => node.id === command.group);
    if (target === undefined) {
      console.debug('[cliCanvasNodeCreate] rejected: group not found', {
        request_id: requestId,
        group: command.group,
      });
      return buildErrorResponse(
        'canvas.node.create',
        requestId,
        'group_not_found',
        `画布上找不到这个组：${command.group}。请确认组标识后重试。`,
      );
    }
    if (target.type !== 'group') {
      console.debug('[cliCanvasNodeCreate] rejected: target is not a node group', {
        request_id: requestId,
        group: command.group,
        nodeType: target.type,
      });
      return buildErrorResponse(
        'canvas.node.create',
        requestId,
        'command_rejected',
        `这个节点不是节点组，不能把资产放进去：${command.group}。`,
      );
    }
    groupId = target.id;
  }

  // 落位：给了 --x/--y 用给定坐标；否则复用导入链的防重叠落位（同一几何源）。
  let position: { x: number; y: number };
  if (command.x !== undefined && command.y !== undefined) {
    position = { x: command.x, y: command.y };
  } else {
    const planned = computeCliPlacementPositions(['asset']);
    const first = planned?.[0];
    if (first === undefined) {
      // 防御分支：命令入口已校验图已载入，落位搜索放不下走无界平面（不返回 null）。
      console.debug('[cliCanvasNodeCreate] placement unavailable', {
        request_id: requestId,
        asset: command.asset,
      });
      return buildErrorResponse(
        'canvas.node.create',
        requestId,
        'internal_error',
        '无法为这个资产找到画布空位，请整理画布后重试。',
      );
    }
    position = first;
  }

  if (command.dry_run === true) {
    // 零写入：不建节点、不落历史、不登记撤销记录（没有可撤销的操作，不伪造标识）。
    console.debug('[cliCanvasNodeCreate] dry-run planned', {
      request_id: requestId,
      asset: command.asset,
      position,
      groupId,
    });
    return {
      command: 'canvas.node.create',
      request_id: requestId,
      node_id: null,
      asset_id: command.asset,
      position,
      group_id: groupId,
      operation_id: null,
      dry_run: true,
    };
  }

  const data = buildAssetNodeData({
    assetId: command.asset,
    mediaType,
    sourceBatchId: command.source_batch_id,
    sourceTaskId: command.source_task_id,
    sourceModelId: command.source_model_id,
  });
  // 组归属走既有成员归属写入通道（addNode 的 membership 参数），不单独写 groupId 字段。
  const membership = groupId !== null ? { groupId } : undefined;
  const created: GraphNode | null = store.addNode('asset', position, data, membership);
  if (created === null) {
    // 防御分支：资产节点在注册表中恒存在，返回 null 说明节点注册链路异常。
    console.debug('[cliCanvasNodeCreate] addNode returned null', {
      request_id: requestId,
      asset: command.asset,
    });
    return buildErrorResponse(
      'canvas.node.create',
      requestId,
      'internal_error',
      '没能把这个资产放到画布上，请稍后重试。',
    );
  }

  // addNode 在非历史合批态自行 saveToHistory：一次创建即一条撤销记录，无需额外合批。
  const createdNodeId = created.id;
  const stored = useCanvasStore.getState().nodeGraph?.nodes.find((node) => node.id === createdNodeId);
  const actualPosition = stored?.position ?? position;
  const actualGroupId = stored?.groupId ?? null;
  if (groupId !== null && actualGroupId !== groupId) {
    // addNode 的成员资格通道降级（理论上 asset → group 恒合法）：如实回传实际归属并留痕。
    console.debug('[cliCanvasNodeCreate] membership downgraded to free node', {
      request_id: requestId,
      asset: command.asset,
      requestedGroup: groupId,
    });
  }
  return {
    command: 'canvas.node.create',
    request_id: requestId,
    node_id: createdNodeId,
    asset_id: command.asset,
    position: actualPosition,
    group_id: actualGroupId,
    // 创建类操作不登记按操作撤销：返回标识使 canvas.undo 返回 command_rejected
    // （与建组/导入/删除同口径，而不是把它当作未知标识）。
    operation_id: registerUnsupportedOperation(),
    dry_run: false,
  };
};

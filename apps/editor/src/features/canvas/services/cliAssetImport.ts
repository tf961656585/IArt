/**
 * CLI 素材导入命令执行（spec docs/integrations/CLI与本地Agent集成.md §5.3 asset import /
 * CLI-047；契约 packages/contracts/src/cli-asset-import-contract.ts）。
 *
 * 从 cliProxyReceiver.ts 拆出的职责边界（接收器受 max-lines 门禁约束，与 cliProxyErrorResponses
 * 同先例）：C 代理执行通道的 `asset.import` 命令 → 画布侧既有导入链。
 *
 * 执行口径（从构造保证）：
 * - 前置校验原子性：全部文件先逐一只读校验（扩展名可判定的媒体类型 + 字节可读），任一失败
 *   整体拒绝、零副作用——不存在部分导入。不存在/不可读 → `file_not_found`（message 点名该
 *   文件）；类型不支持 → `unsupported_file_type`。
 * - 写盘 + 登记复用界面导入链的同一内层（localMediaImport.importMediaBytes：界面 File 版与
 *   本命令共用一个实现），本模块不出现第二套写盘/登记逻辑；字节经既有
 *   `storage:read-file-bytes` 通道按路径读取（不新增 IPC）。
 * - 素材节点创建走 store 既有 action addNode（与界面拖入同一 action、同一 data 形状），落位
 *   复用共享几何源：computeViewportRects 安全区（→ 可见区 → 无界平面）+ searchFreeBlockPosition
 *   防重叠块搜索，批内网格由 computeGridCellsForSizes 按节点类型默认尺寸构造（多文件排成一块、
 *   单文件单块）。
 * - 整批导入在 historyBatchActive 合批内收口为一条撤销记录（executeGroupCreate 同款合批模式）；
 *   不调用 selectNodes、不弹 toast（程序化提交不触碰 UI 状态，spec §6.4 同口径）。
 */

import type { CliErrorCode, CliImportedAssetEntry, CliProxyCommand, CliProxyCommandResponse } from '@iart/contracts';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { normalizeViewport } from '@/features/canvas/components/canvas/nodeCanvasConstants';
import { resolveNodeTypeDefaultSize } from '@/features/canvas/utils/effectiveSize';
import { base64DataUrlToBlob } from '@/features/canvas/utils/mediaUtils';
import {
  getFileNameFromPath,
  resolveMediaKindFromPath,
  resolveMimeTypeFromPath,
  type MediaFileKind,
} from '@/features/canvas/utils/mediaFileKind';
import {
  buildCanvasSizeSources,
  buildNodeOccupancyRects,
  type OccupancyRect,
} from '@/features/canvas/utils/nodeOccupancy';
import {
  TASK_BATCH_GAP_X,
  TASK_BATCH_GAP_Y,
  computeGridCellsForSizes,
  computeViewportRects,
  searchFreeBlockPosition,
} from '@/features/canvas/utils/taskNodePlacement';
import type {
  AudioInputNodeData,
  GraphNode,
  ImageInputNodeData,
  NodePosition,
  VideoInputNodeData,
} from '@/features/canvas/types/node';
import { buildErrorResponse } from './cliProxyErrorResponses';
import { importMediaBytes, readLocalFileBytes } from './localMediaImport';

/** 批量导入网格每行个数（与任务批次投影落位同口径：3 列一块）。 */
const MEDIA_IMPORT_PER_ROW = 3;

const MEDIA_NODE_KEY_BY_KIND = {
  image: 'imageInput',
  video: 'videoInput',
  audio: 'audioInput',
} as const satisfies Record<MediaFileKind, GraphNode['type']>;

// ---------------------------------------------------------------------------
// 前置校验（原子性：全部文件先校验，任一失败整体拒绝）
// ---------------------------------------------------------------------------

type PlannedImport = {
  /** 原始文件名（回传 file_name 与资产登记 sourceFileName 同一值）。 */
  fileName: string;
  dataBase64: string;
  mediaType: MediaFileKind;
  mimeType: string;
};

type ImportPreflightOutcome =
  | { kind: 'ok'; planned: PlannedImport[] }
  | { kind: 'rejected'; response: CliProxyCommandResponse };

/**
 * 逐文件只读校验：媒体类型可判定（按路径扩展名）→ 字节可读（read-file-bytes）。
 *
 * 顺序上先判类型再读字节：类型不支持的文件不必读盘（大文件场景减少无谓 IO），
 * 两类失败都在任何写盘/建节点之前返回，零副作用由调用方保证。
 */
const preflightImportFiles = async (
  requestId: string,
  filePaths: readonly string[],
): Promise<ImportPreflightOutcome> => {
  const planned: PlannedImport[] = [];
  for (const filePath of filePaths) {
    const mediaType = resolveMediaKindFromPath(filePath);
    if (mediaType === null) {
      console.debug('[cliAssetImport] asset import rejected: unsupported file type', {
        request_id: requestId,
        file: filePath,
      });
      return {
        kind: 'rejected',
        response: buildErrorResponse(
          'asset.import',
          requestId,
          'unsupported_file_type',
          `这个文件不是可导入的媒体文件，只支持图片、视频或音频：${filePath}。`,
        ),
      };
    }
    try {
      const bytes = await readLocalFileBytes(filePath);
      planned.push({
        fileName: getFileNameFromPath(filePath),
        dataBase64: bytes.dataBase64,
        mediaType,
        mimeType: resolveMimeTypeFromPath(filePath),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.debug('[cliAssetImport] asset import rejected: file unreadable', {
        request_id: requestId,
        file: filePath,
        detail,
      });
      return {
        kind: 'rejected',
        response: buildErrorResponse(
          'asset.import',
          requestId,
          'file_not_found',
          `找不到这个文件或读不出来：${filePath}。请确认文件路径后重试。`,
        ),
      };
    }
  }
  return { kind: 'ok', planned };
};

// ---------------------------------------------------------------------------
// 落位（CLI 无光标坐标：视口安全区 → 可见区 → 无界平面防重叠块搜索）
// ---------------------------------------------------------------------------

/**
 * 计算整批导入节点的落位坐标（与 kinds 顺序一一对应）。
 *
 * 批内相对几何由 computeGridCellsForSizes 按节点类型默认尺寸（注册表 defaultSize）构造，
 * 整块经 searchFreeBlockPosition 在安全区定位；安全区放不下退化到可见区、再退化到无界平面
 * （不重叠是硬约束，不存在允许重叠的兜底）。返回 null 仅发生在图未载入（防御分支）。
 */
const computeImportPositions = (kinds: readonly MediaFileKind[]): NodePosition[] | null => {
  const state = useCanvasStore.getState();
  const graph = state.nodeGraph;
  if (graph === null) return null;

  const { visible, safe } = computeViewportRects(
    normalizeViewport(graph.viewport),
    state.ui.canvasContainerSize,
  );
  const sizes = kinds.map((kind) => resolveNodeTypeDefaultSize(MEDIA_NODE_KEY_BY_KIND[kind]));
  const { cells } = computeGridCellsForSizes(sizes, MEDIA_IMPORT_PER_ROW, TASK_BATCH_GAP_X, TASK_BATCH_GAP_Y);
  const firstCell = cells[0];
  if (firstCell === undefined) return [];
  const batchWidth = Math.max(...cells.map((cell) => cell.dx + cell.width));
  const batchHeight = Math.max(...cells.map((cell) => cell.dy + cell.height));
  const anchor: NodePosition = {
    x: safe.x + (safe.width - batchWidth) / 2,
    y: safe.y + (safe.height - batchHeight) / 2,
  };
  const stepX = Math.max(...sizes.map((size) => size.width)) + TASK_BATCH_GAP_X;
  const stepY = Math.max(...sizes.map((size) => size.height)) + TASK_BATCH_GAP_Y;
  const search = (target: OccupancyRect | null): NodePosition | null =>
    searchFreeBlockPosition({
      occupancy: buildNodeOccupancyRects(graph.nodes, buildCanvasSizeSources(state)),
      anchor,
      cells,
      stepX,
      stepY,
      target,
    });

  const base = search(safe) ?? search(visible) ?? search(null);
  if (base === null) {
    // 防御分支：无界搜索不返回 null（超限在 search 内抛内部断言），走到这里说明几何输入被污染
    console.debug('[cliAssetImport] placement search exhausted all target zones', {
      fileCount: kinds.length,
    });
    return null;
  }
  return cells.map((cell) => ({ x: base.x + cell.dx, y: base.y + cell.dy }));
};

// ---------------------------------------------------------------------------
// 素材节点创建（与界面拖入同一 action、同一 data 形状）
// ---------------------------------------------------------------------------

/**
 * 创建素材节点（addNode 既有 action）。data 形状对齐界面导入链路：assetId + 持久化 URL +
 * valueSource='upload'（图片另带 resizePercent/originalImageMeta 的初始语义）。
 *
 * 音频时长：界面链路按浏览器 File 测量时长，CLI 通道不构造 File；本批按节点默认时长 0 落图。
 */
const createMediaNode = (
  kind: MediaFileKind,
  position: NodePosition,
  imported: { assetId: string; persistentUrl: string },
): GraphNode | null => {
  const store = useCanvasStore.getState();
  if (kind === 'image') {
    return store.addNode(MEDIA_NODE_KEY_BY_KIND.image, position, {
      assetId: imported.assetId,
      imageUrl: imported.persistentUrl,
      imageMeta: null,
      originalImageMeta: null,
      resizePercent: 100,
      valueSource: 'upload',
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
    } satisfies Partial<ImageInputNodeData>);
  }
  if (kind === 'audio') {
    return store.addNode(MEDIA_NODE_KEY_BY_KIND.audio, position, {
      assetId: imported.assetId,
      audioUrl: imported.persistentUrl,
      duration: 0,
      valueSource: 'upload',
      taskInfo: undefined,
      lastExecutionId: undefined,
      lastSourceNodeId: undefined,
      lastSourcePortId: undefined,
      segments: [],
      segmentModeEnabled: false,
    } satisfies Partial<AudioInputNodeData>);
  }
  return store.addNode(MEDIA_NODE_KEY_BY_KIND.video, position, {
    assetId: imported.assetId,
    videoUrl: imported.persistentUrl,
    videoMeta: null,
    valueSource: 'upload',
    taskInfo: undefined,
    lastExecutionId: undefined,
    lastSourceNodeId: undefined,
    lastSourcePortId: undefined,
  } satisfies Partial<VideoInputNodeData>);
};

/** 按读回字节构造尺寸测量用 blob URL（图片专用；环境不支持时缺省不测量）。 */
const createMeasurementBlobUrl = (dataBase64: string, mimeType: string): string | null => {
  if (typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(base64DataUrlToBlob(`data:${mimeType};base64,${dataBase64}`));
};

const revokeMeasurementBlobUrl = (blobUrl: string): void => {
  if (typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(blobUrl);
};

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

/**
 * asset.import → 前置校验（原子性）→ 既有导入链写盘登记 → 素材节点创建（自动落位）
 * → 整批一条撤销记录 → 回传 imported（按输入顺序对应）。
 */
export const executeAssetImport = async (
  command: Extract<CliProxyCommand, { command: 'asset.import' }>,
): Promise<CliProxyCommandResponse> => {
  const requestId = command.request_id;
  if (useCanvasStore.getState().nodeGraph === null) {
    console.debug('[cliAssetImport] command skipped: canvas graph not loaded', {
      request_id: requestId,
      fileCount: command.file.length,
    });
    return buildErrorResponse(
      'asset.import',
      requestId,
      'project_not_open',
      '这个项目还没有在画布中打开，请先在应用中打开项目后再试。',
    );
  }

  const preflight = await preflightImportFiles(requestId, command.file);
  if (preflight.kind === 'rejected') return preflight.response;

  const positions = computeImportPositions(preflight.planned.map((item) => item.mediaType));
  if (positions === null) {
    // 防御分支：命令入口已校验图已载入，落位搜索放不下走无界平面（不返回 null）——
    // 走到这里说明画布几何输入异常，按条件跳过留痕后如实报错，不静默继续。
    console.debug('[cliAssetImport] placement unavailable before execution', {
      request_id: requestId,
      fileCount: preflight.planned.length,
    });
    return buildErrorResponse(
      'asset.import',
      requestId,
      'internal_error',
      '无法为导入的素材找到画布空位，请整理画布后重试。',
    );
  }

  const imported: CliImportedAssetEntry[] = [];
  let failure: { code: CliErrorCode; message: string } | null = null;
  // 整批导入合批为一条撤销记录：addNode 在 historyBatchActive 下跳过各自入栈，
  // 收尾一次 saveToHistory 落一条全图快照（与 executeGroupCreate 同款既有合批模式）。
  useCanvasStore.setState((state) => {
    state.historyBatchActive = true;
  });
  try {
    for (const [index, item] of preflight.planned.entries()) {
      const position = positions[index];
      if (position === undefined) {
        failure = { code: 'internal_error', message: '导入落位计算与文件清单不一致，导入已中止。' };
        break;
      }
      // 图片尺寸对齐界面语义（读回字节 → blob URL → Image 取宽高）；非图片类型不构造 URL。
      const measurementBlobUrl =
        item.mediaType === 'image' ? createMeasurementBlobUrl(item.dataBase64, item.mimeType) : null;
      try {
        const result = await importMediaBytes({
          dataBase64: item.dataBase64,
          mimeType: item.mimeType,
          originalFileName: item.fileName,
          ...(measurementBlobUrl !== null ? { measurementBlobUrl } : {}),
        });
        const node = createMediaNode(item.mediaType, position, {
          assetId: result.assetId,
          persistentUrl: result.persistentUrl,
        });
        if (node === null) {
          // 防御分支：注册表恒含三类素材节点，addNode 返回 null 说明节点注册链路异常
          console.debug('[cliAssetImport] media node creation returned null', {
            request_id: requestId,
            mediaType: item.mediaType,
          });
          failure = { code: 'internal_error', message: `没能把导入的素材放到画布上：${item.fileName}。` };
          break;
        }
        imported.push({
          file_name: item.fileName,
          asset_id: result.assetId,
          node_id: node.id,
          media_type: item.mediaType,
        });
      } catch (error) {
        // 前置校验已排除可预期失败（文件不存在/类型不支持）；此处是写盘/登记链路的意外失败。
        const detail = error instanceof Error ? error.message : String(error);
        console.debug('[cliAssetImport] media import crashed', {
          request_id: requestId,
          file: item.fileName,
          detail,
        });
        failure = {
          code: 'internal_error',
          message: `导入文件时出现意外错误：${item.fileName}。技术细节：${detail}`,
        };
        break;
      } finally {
        if (measurementBlobUrl !== null) revokeMeasurementBlobUrl(measurementBlobUrl);
      }
    }
  } finally {
    useCanvasStore.setState((state) => {
      state.historyBatchActive = false;
    });
  }

  if (imported.length > 0) {
    // 已落图节点仍需入历史（意外失败不能回滚磁盘写入，但画布侧保持可撤销、存储一致）
    useCanvasStore.getState().saveToHistory();
  }
  if (failure !== null) {
    return buildErrorResponse('asset.import', requestId, failure.code, failure.message);
  }
  return { command: 'asset.import', request_id: requestId, imported };
};

/**
 * Agent Tool Executor
 *
 * agent 工具调用的执行编排（spec 04「工具集合投影」「工具调用循环语义」）：
 *
 * - 生成工具（generate_image / generate_video）：组装与 PromptDock 同构的批次请求，
 *   复用标准生成主链（acceptGenerationBatch → persist → dispatch），任务 metadata 注入
 *   agentLineage 血缘；阻塞等待派生任务全部到达终态后回收产物资产。等待期间请求被取消时，
 *   派生任务经取消链结算（cancelled 终态 → 等待器结算 → 本条目以 cancelled 收口）。
 * - 加工工具（7 项固定注册表）：直调既有本地媒体处理执行器，产物统一注册为项目媒体资产。
 *
 * 失败语义（spec 04「失败与阻断」）：单条工具失败仅阻断该条目，错误摘要交回模型，不自动重试。
 */

import * as z from 'zod';
import {
  AgentToolResultAssetSchema,
  type AgentReferenceAssetBrief,
  type AgentToolResultAsset,
  type ExecutableModelDirectoryEntry,
  type PromptDockBatchSubmitRequest,
} from '@iart/contracts';
import {
  acceptGenerationBatch,
  dispatchAcceptedBatch,
  persistAcceptedBatch,
} from './business-actions/generation-batch.cts';
import { executeImageProcessing } from './image-processing-executor.cts';
import { listExecutableCatalogEntries } from './model-catalog-entry.cts';
import { resolveToolKind, GENERATION_TOOL_IMAGE } from './agent-tool-registry.cts';
import { awaitTaskTerminal } from './task-terminal-waiter.cts';
import { cancelTaskExecution } from './task-executor.cts';
import {
  buildCancelRecord,
  persistCancelRecord,
  registerCancelledBarrier,
  settleCancelledTask,
  unregisterCancelledBarrier,
} from './task-cancel-service.cts';
import { executeVideoSpriteSheet } from './video-sprite-sheet.cts';
import { executeVideoFrameExtract } from './video-frame-extract.cts';
import { executeVideoTrim } from './video-trim-executor.cts';
import { logDebug, logWarn } from './logging.cts';

export type AgentToolExecutionContext = {
  projectPath: string;
  agentSessionId: string;
  requestId: string;
  toolCallId: string;
  /** 会话引用资产简报（提交载荷携带；工具参数按 assetId 引用这里的资产）。 */
  referenceAssets: AgentReferenceAssetBrief[];
  /** 本轮请求的中止信号：生成等待期间触发 → 派生任务走取消链。 */
  abortSignal: AbortSignal;
};

export type AgentToolExecutionResult = {
  status: 'succeeded' | 'failed' | 'cancelled';
  summary: string;
  assets: AgentToolResultAsset[];
  errorSummary: string | null;
  /** 生成类派生引用（加工类为 null），供工具调用记录落库。 */
  batchId: string | null;
  taskIds: string[];
};

const normalizeString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/** 开放结构的本地投影容器（稳定业务区：隐藏裸 Record<string, unknown> 边界命名）。 */
type DynamicFields = Record<string, unknown>;

const toRecord = (value: unknown): DynamicFields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as DynamicFields)
    : {};

// ────────────────────────────────────────────
// 产物资产投影（兼容 MediaAsset（id）与 RuntimeMediaAssetView（assetId）两种形状）
// ────────────────────────────────────────────

const projectAssetBrief = (mediaAsset: unknown): AgentToolResultAsset | null => {
  const source = toRecord(mediaAsset);
  const original = toRecord(source.original);
  const thumbnail = toRecord(source.thumbnail);
  const assetId = normalizeString(source.assetId ?? source.id);
  if (!assetId) return null;
  const parsed = AgentToolResultAssetSchema.safeParse({
    assetId,
    mediaType: source.mediaType,
    url: typeof original.url === 'string' ? original.url : null,
    thumbnailUrl: typeof thumbnail.url === 'string' ? thumbnail.url : null,
    width: typeof original.width === 'number' ? original.width : null,
    height: typeof original.height === 'number' ? original.height : null,
    durationMs: typeof original.durationMs === 'number' ? original.durationMs : null,
  });
  return parsed.success ? parsed.data : null;
};

const collectAssetBriefs = (values: ReadonlyArray<unknown>): AgentToolResultAsset[] =>
  values
    .map((value) => projectAssetBrief(value))
    .filter((brief): brief is AgentToolResultAsset => brief !== null);

// ────────────────────────────────────────────
// 工具调用参数解析（模型侧 argsJson → 类型化参数；形状错误以可读错误交回模型）
// ────────────────────────────────────────────

const parseArgsJson = (argsJson: string): unknown => {
  try {
    return JSON.parse(argsJson || '{}');
  } catch {
    return { __invalid_json: true };
  };
};

const GenerationToolArgsSchema = z
  .object({
    model_id: z.string(),
    prompt: z.string(),
    arguments: z.record(z.unknown()).optional(),
    reference_asset_ids: z.array(z.string()).optional(),
  })
  .passthrough();

type GenerationToolArgs = {
  modelId: string;
  prompt: string;
  args: DynamicFields;
  referenceAssetIds: string[];
};

const parseGenerationToolArgs = (argsJson: string): GenerationToolArgs | { error: string } => {
  const parsed = GenerationToolArgsSchema.safeParse(parseArgsJson(argsJson));
  if (!parsed.success) {
    return { error: `工具调用参数不符合约定形状：${parsed.error.message}` };
  }
  const modelId = normalizeString(parsed.data.model_id);
  const prompt = typeof parsed.data.prompt === 'string' ? parsed.data.prompt : '';
  if (!modelId) return { error: '缺少必填参数 model_id' };
  if (!prompt.trim()) return { error: '缺少必填参数 prompt' };
  return {
    modelId,
    prompt,
    args: parsed.data.arguments ?? {},
    referenceAssetIds: (parsed.data.reference_asset_ids ?? [])
      .map((value) => normalizeString(value))
      .filter(Boolean),
  };
};

/** 按目录条目校验生成参数：缺必填字段报可操作错误（列明缺失字段），缺省可选字段按 default_values 补齐。 */
const resolveGenerationArguments = (
  args: DynamicFields,
  parameterSchema: ExecutableModelDirectoryEntry['parameter_schema'],
): { arguments: DynamicFields } | { error: string } => {
  const merged: DynamicFields = { ...parameterSchema.default_values };
  for (const field of parameterSchema.fields) {
    if (field.defaultValue !== undefined && field.defaultValue !== null && merged[field.fieldKey] === undefined) {
      merged[field.fieldKey] = field.defaultValue;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    merged[key] = value;
  }
  const missing = parameterSchema.required_fields.filter((fieldKey) => {
    const value = merged[fieldKey];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    return {
      error: `缺少目标模型的必填参数：${missing.join('、')}（可用参数见工具描述中该模型的参数速览）`,
    };
  }
  return { arguments: merged };
};

/** 会话取消联动：派生任务走取消链（命令接受 → abort → 独立 cancelled 终态结算）。 */
const cancelDerivedTask = (params: { projectPath: string; record: unknown }): void => {
  void (async () => {
    const record = toRecord(params.record);
    const metadata = toRecord(record.metadata);
    const taskId = normalizeString(metadata.taskId ?? record.id);
    if (!taskId) {
      logWarn('[agent-tool-executor] derived task cancel skipped: taskId unavailable', {
        projectPath: params.projectPath,
      });
      return;
    }
    registerCancelledBarrier(taskId);
    const persisted = await persistCancelRecord({
      taskId,
      projectPath: params.projectPath,
      status: record.status,
      metadata: record.metadata ?? {},
      request: record.request ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    if (!persisted) {
      unregisterCancelledBarrier(taskId);
      return;
    }
    cancelTaskExecution(taskId);
    await settleCancelledTask({
      taskId,
      projectPath: params.projectPath,
      metadata: record.metadata ?? {},
      request: record.request ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      cancelRecord: buildCancelRecord(taskId, new Date().toISOString()),
    });
  })().catch((error: unknown) => {
    logWarn('[agent-tool-executor] derived task cancel failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

const executeGenerationTool = async (params: {
  toolName: string;
  argsJson: string;
  context: AgentToolExecutionContext;
}): Promise<AgentToolExecutionResult> => {
  const { toolName, argsJson, context } = params;
  const parsedArgs = parseGenerationToolArgs(argsJson);
  if ('error' in parsedArgs) {
    return { status: 'failed', summary: '工具调用参数无效', assets: [], errorSummary: parsedArgs.error, batchId: null, taskIds: [] };
  }
  const requiredModality = toolName === GENERATION_TOOL_IMAGE ? 'image' : 'video';
  const entry = listExecutableCatalogEntries().find(
    (candidate) =>
      candidate.model_id === parsedArgs.modelId &&
      candidate.deployment.deployable &&
      candidate.capability.output_modalities.includes(requiredModality),
  );
  if (!entry) {
    return {
      status: 'failed',
      summary: '目标模型不可提交',
      assets: [],
      errorSummary: `模型 ${parsedArgs.modelId} 不在当前可提交目录中（未安装、未接入或输出类型不符）`,
      batchId: null,
      taskIds: [],
    };
  }
  const resolvedArgs = resolveGenerationArguments(parsedArgs.args, entry.parameter_schema);
  if ('error' in resolvedArgs) {
    return { status: 'failed', summary: '工具调用参数无效', assets: [], errorSummary: resolvedArgs.error, batchId: null, taskIds: [] };
  }

  const briefsByAssetId = new Map(context.referenceAssets.map((brief) => [brief.assetId, brief]));
  const mediaInputs = parsedArgs.referenceAssetIds
    .map((assetId) => briefsByAssetId.get(assetId))
    .filter((brief): brief is AgentReferenceAssetBrief => brief !== undefined)
    .map((brief) => ({
      media_kind: brief.mediaType,
      source_kind: 'attachment' as const,
      value: brief.url,
      mime_type: null,
      filename: null,
      // 工具调用只带资产标识（没有界面用途信息）：仍记录来源资产，让派生批次的档案能把
      // 出网文件对回资产；slot_id 缺省（没有可推断的用途，不猜）。
      asset_id: brief.assetId,
    }));
  const submitRequest: PromptDockBatchSubmitRequest = {
    model_id: entry.model_id,
    model_version: entry.model_version,
    prompt: parsedArgs.prompt,
    arguments: resolvedArgs.arguments,
    ...(mediaInputs.length > 0 ? { media_inputs: mediaInputs } : {}),
    ...(parsedArgs.referenceAssetIds.length > 0
      ? { reference_asset_ids: parsedArgs.referenceAssetIds }
      : {}),
    task_count: 1,
    project_path: context.projectPath,
  };

  const accepted = await acceptGenerationBatch({
    body: submitRequest,
    baseDir: null,
    agentLineage: { agentSessionId: context.agentSessionId, toolCallId: context.toolCallId },
  });
  if (!accepted.ok) {
    return {
      status: 'failed',
      summary: '生成任务受理失败',
      assets: [],
      errorSummary: `${accepted.code}: ${accepted.message}`,
      batchId: null,
      taskIds: [],
    };
  }
  const persisted = await persistAcceptedBatch({
    projectPath: context.projectPath,
    intentSnapshot: accepted.intentSnapshot,
    tasks: accepted.tasks,
    // agent 工具调用派生批次不携带客户端受理幂等键（幂等键是 CLI 提交面语义，spec §5.4）。
    clientRequestId: null,
  });
  if (!persisted.ok) {
    return {
      status: 'failed',
      summary: '生成任务受理失败',
      assets: [],
      errorSummary: `${persisted.code}: ${persisted.message}`,
      batchId: accepted.batchId,
      taskIds: accepted.tasks.map((task) => task.taskId),
    };
  }

  // 等待登记先于派发（终态结算可能早于 await 调用，登记表必须先就位）。
  const taskIds = accepted.tasks.map((task) => task.taskId);
  const waitPromise = Promise.all(accepted.tasks.map((task) => awaitTaskTerminal(task.taskId)));
  dispatchAcceptedBatch({ projectPath: context.projectPath, tasks: accepted.tasks });
  const onAbort = (): void => {
    for (const task of accepted.tasks) {
      cancelDerivedTask({ projectPath: context.projectPath, record: task.record });
    }
  };
  context.abortSignal.addEventListener('abort', onAbort, { once: true });
  let outcomes;
  try {
    outcomes = await waitPromise;
  } finally {
    context.abortSignal.removeEventListener('abort', onAbort);
  }

  if (outcomes.some((outcome) => outcome.status === 'cancelled')) {
    return {
      status: 'cancelled',
      summary: '生成已取消',
      assets: [],
      errorSummary: null,
      batchId: accepted.batchId,
      taskIds,
    };
  }
  const failure = outcomes.find((outcome) => outcome.status === 'failed');
  if (failure) {
    return {
      status: 'failed',
      summary: '生成失败',
      assets: [],
      errorSummary: failure.errorMessage ?? '生成任务失败',
      batchId: accepted.batchId,
      taskIds,
    };
  }
  const assets = collectAssetBriefs(outcomes.flatMap((outcome) => outcome.mediaAssets));
  return {
    status: 'succeeded',
    summary: `已生成 ${assets.length} 个${requiredModality === 'image' ? '图片' : '视频'}资产`,
    assets,
    errorSummary: null,
    batchId: accepted.batchId,
    taskIds,
  };
};

// ────────────────────────────────────────────
// 加工工具执行
// ────────────────────────────────────────────

const hexToRgb = (value: string): { r: number; g: number; b: number } | null => {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match || !match[1]) return null;
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

/** 加工工具参数（全量形状；各工具只消费自己关心的字段，缺必填项在该工具分支报可读错误）。 */
const ProcessingToolArgsSchema = z
  .object({
    asset_id: z.string(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    percent: z.number().optional(),
    target_color: z.string().optional(),
    tolerance: z.number().optional(),
    feather: z.number().optional(),
    start_time: z.number().optional(),
    end_time: z.number().optional(),
    with_audio: z.boolean().optional(),
    fps_multiplier: z.number().optional(),
    time_sec: z.number().optional(),
  })
  .passthrough();

type ProcessingToolArgs = {
  assetId: string;
  url: string;
  args: z.infer<typeof ProcessingToolArgsSchema>;
};

const parseProcessingToolArgs = (
  argsJson: string,
  context: AgentToolExecutionContext,
): ProcessingToolArgs | { error: string } => {
  const parsed = ProcessingToolArgsSchema.safeParse(parseArgsJson(argsJson));
  if (!parsed.success) {
    return { error: `工具调用参数不符合约定形状：${parsed.error.message}` };
  }
  const assetId = normalizeString(parsed.data.asset_id);
  if (!assetId) return { error: '缺少必填参数 asset_id' };
  const brief = context.referenceAssets.find((candidate) => candidate.assetId === assetId);
  if (!brief || !brief.url) {
    return { error: `资产 ${assetId} 不在当前会话的资产清单中，无法引用` };
  }
  return { assetId, url: brief.url, args: parsed.data };
};

const invalidArgsResult = (errorSummary: string): AgentToolExecutionResult => ({
  status: 'failed',
  summary: '工具调用参数无效',
  assets: [],
  errorSummary,
  batchId: null,
  taskIds: [],
});

const executeProcessingTool = async (params: {
  toolName: string;
  argsJson: string;
  context: AgentToolExecutionContext;
}): Promise<AgentToolExecutionResult> => {
  const { toolName, argsJson, context } = params;
  const parsedArgs = parseProcessingToolArgs(argsJson, context);
  if ('error' in parsedArgs) {
    return invalidArgsResult(parsedArgs.error);
  }
  const { url, args: rest } = parsedArgs;
  const source = { type: 'media-url' as const, url };

  switch (toolName) {
    case 'crop_image': {
      const { x, y, width, height } = rest;
      if (x === undefined || y === undefined || width === undefined || height === undefined) {
        return invalidArgsResult('缺少裁剪参数：需要 x、y、width、height（像素，整数）。');
      }
      const result = await executeImageProcessing(context.projectPath, {
        source,
        operation: { type: 'crop', x, y, width, height },
      });
      return {
        status: 'succeeded',
        summary: '已裁剪图片',
        assets: collectAssetBriefs([result]),
        errorSummary: null,
        batchId: null,
        taskIds: [],
      };
    }
    case 'resize_image': {
      const percent = rest.percent;
      if (percent === undefined || percent < 10 || percent > 100) {
        return invalidArgsResult('percent 无效（10–100，相对原始尺寸的百分比，只支持缩小）。');
      }
      const result = await executeImageProcessing(context.projectPath, {
        source,
        operation: { type: 'resize', percent },
      });
      return {
        status: 'succeeded',
        summary: '已缩放图片',
        assets: collectAssetBriefs([result]),
        errorSummary: null,
        batchId: null,
        taskIds: [],
      };
    }
    case 'chroma_key_image': {
      const targetColor = hexToRgb(rest.target_color ?? '');
      if (!targetColor) {
        return invalidArgsResult('target_color 不是合法的十六进制 RGB 颜色（如 #00FF00）');
      }
      const result = await executeImageProcessing(context.projectPath, {
        source,
        operation: {
          type: 'chromaKey',
          targetColor,
          tolerance: rest.tolerance ?? 30,
          feather: rest.feather ?? 2,
        },
      });
      return {
        status: 'succeeded',
        summary: '已完成色键抠像',
        assets: collectAssetBriefs([result]),
        errorSummary: null,
        batchId: null,
        taskIds: [],
      };
    }
    case 'smart_split_image': {
      const result = await executeImageProcessing(context.projectPath, {
        source,
        operation: { type: 'smartSplit' },
      });
      const tiles = result.resultType === 'smartSplit' ? result.tiles : [];
      const assets = collectAssetBriefs(tiles);
      return {
        status: 'succeeded',
        summary: `已分割出 ${assets.length} 个主体`,
        assets,
        errorSummary: null,
        batchId: null,
        taskIds: [],
      };
    }
    case 'trim_video': {
      const { start_time: startTime, end_time: endTime } = rest;
      if (startTime === undefined || endTime === undefined || endTime <= startTime) {
        return invalidArgsResult('start_time / end_time 无效（end_time 必须大于 start_time）');
      }
      const result = await executeVideoTrim({
        projectPath: context.projectPath,
        sourceUrl: url,
        startTime,
        endTime,
        withAudio: rest.with_audio !== false,
      });
      const assets = collectAssetBriefs([result.mediaAsset]);
      return {
        status: 'succeeded',
        summary:
          assets.length > 0
            ? '已截取视频片段'
            : '已截取视频片段（片段文件已产出，资产注册未完成）',
        assets,
        errorSummary: null,
        batchId: null,
        taskIds: [],
      };
    }
    case 'make_video_spritesheet': {
      const { start_time: startTime, end_time: endTime } = rest;
      if (startTime === undefined || endTime === undefined || endTime <= startTime) {
        return invalidArgsResult('start_time / end_time 无效（end_time 必须大于 start_time）');
      }
      const result = await executeVideoSpriteSheet(context.projectPath, {
        source,
        operation: {
          startTime,
          endTime,
          fpsMultiplier: rest.fps_multiplier ?? 0.5,
        },
      });
      return {
        status: 'succeeded',
        summary: '已生成视频序列帧图集',
        assets: collectAssetBriefs([result]),
        errorSummary: null,
        batchId: null,
        taskIds: [],
      };
    }
    case 'extract_video_frames': {
      const timeSec = rest.time_sec;
      if (timeSec === undefined || timeSec < 0) {
        return invalidArgsResult('time_sec 无效（必须是非负秒数）');
      }
      const result = await executeVideoFrameExtract(context.projectPath, {
        sourceUrl: url,
        timeSec,
      });
      return {
        status: 'succeeded',
        summary: '已抽取视频帧',
        assets: collectAssetBriefs([result]),
        errorSummary: null,
        batchId: null,
        taskIds: [],
      };
    }
    default:
      return {
        status: 'failed',
        summary: '未知加工工具',
        assets: [],
        errorSummary: `未注册的加工工具：${toolName}`,
        batchId: null,
        taskIds: [],
      };
  }
};

// ────────────────────────────────────────────
// 统一执行入口
// ────────────────────────────────────────────

/** 按工具名分派执行（类别第一判据见 resolveToolKind）；未知工具一律显式失败。 */
const executeAgentTool = async (params: {
  toolName: string;
  argsJson: string;
  context: AgentToolExecutionContext;
}): Promise<AgentToolExecutionResult> => {
  const kind = resolveToolKind(params.toolName);
  if (kind === null) {
    return {
      status: 'failed',
      summary: '未知工具',
      assets: [],
      errorSummary: `未注册的工具调用：${params.toolName}`,
      batchId: null,
      taskIds: [],
    };
  }
  logDebug('[agent-tool-executor] execute tool', {
    toolName: params.toolName,
    kind,
    toolCallId: params.context.toolCallId,
  });
  try {
    if (kind === 'generation') {
      return await executeGenerationTool(params);
    }
    return await executeProcessingTool(params);
  } catch (error: unknown) {
    return {
      status: 'failed',
      summary: '工具执行失败',
      assets: [],
      errorSummary: error instanceof Error ? error.message : String(error),
      batchId: null,
      taskIds: [],
    };
  }
};

export {
  executeAgentTool,
  cancelDerivedTask,
  projectAssetBrief,
};

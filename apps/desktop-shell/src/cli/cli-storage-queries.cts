import {
  readAllMediaAssets,
  readAllTasks,
  readBatchById,
  readBatchByClientRequestId,
  readMediaAssetById,
  readManifestFromDb,
  readNodeGraphFromDb,
  readTaskOutputAssetIndex,
  readTaskOutputs,
  readTasksByBatchId,
} from "../storage/editor-storage-read-model.cjs";
import { getDbForExistingProject } from "../storage/editor-storage-service.cjs";
import { touchRecentProjectOpenedAt } from "../storage/editor-storage-recent-projects.cjs";
import type { BatchIntentSnapshot, RuntimeMediaAssetView, RuntimeTaskView } from "@iart/contracts";

/**
 * CLI 执行器的存储只读查询适配（spec docs/integrations/CLI与本地Agent集成.md §4.2：
 * 只读查询走「存储只读投影」）。控制服务在 Main 进程内，直接调用 storage service /
 * read-model 层函数，不绕 IPC、不新增第二读取路径。
 *
 * 本模块只做「取 db → 调既有读取函数」的薄适配；投影与判定逻辑在
 * cli-canvas-projection（纯函数）与 cli-command-executors（编排），便于测试。
 * 项目库不可用（路径无效等）时按空集合处理并 debug 留痕（条件跳过必须留痕）。
 */

export const readCliProjectMediaAssets = (projectPath: string): RuntimeMediaAssetView[] => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按空资产清单处理", { projectPath });
    return [];
  }
  return readAllMediaAssets(db);
};

export const readCliProjectMediaAssetById = (projectPath: string, assetId: string): RuntimeMediaAssetView | null => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按资产不存在处理", { projectPath, assetId });
    return null;
  }
  return readMediaAssetById(db, assetId);
};

/** 资产 → 产出任务标识索引（asset list 的生成来源摘要数据源）。 */
export const readCliAssetTaskIndex = (projectPath: string): ReadonlyMap<string, string> => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按空来源索引处理", { projectPath });
    return new Map();
  }
  return readTaskOutputAssetIndex(db);
};

/** 资产的生成来源详情（asset list 的 --query/--model 检索底座：模型与提交提示词经任务溯源反查）。 */
export interface CliAssetGenerationSource {
  taskId: string;
  modelId: string | null;
  prompt: string | null;
}

/**
 * 资产 → 生成来源索引（assetId → 产出任务、所用模型、提交提示词）。
 *
 * 反查链：task_outputs（assetId→taskId）→ tasks.metadataJson（batchId/model_id 白名单键）
 * → batches.payloadJson 的 BatchIntentSnapshot.prompt（受理时冻结的不可变快照）。
 * 只覆盖生成产物；导入素材与媒体工具加工产物无产出来源，不进索引（检索时按无提示词处理）。
 */
export const readCliAssetGenerationIndex = (projectPath: string): ReadonlyMap<string, CliAssetGenerationSource> => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按空生成来源索引处理", { projectPath });
    return new Map();
  }
  const outputIndex = readTaskOutputAssetIndex(db);
  const tasks = readAllTasks(db, undefined);
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const promptByBatchId = new Map<string, string | null>();
  const index = new Map<string, CliAssetGenerationSource>();
  for (const [assetId, taskId] of outputIndex) {
    const task = taskById.get(taskId);
    if (task === undefined) {
      console.debug("[cli-storage] 资产来源任务不存在，跳过", { assetId, taskId });
      continue;
    }
    /** 任务 metadata 白名单里与生成来源相关的键（TASK_METADATA_KEYS：batchId/batch_id、model_id/modelId 双形态）。 */
    const metadata = (task.metadata ?? {}) as {
      batchId?: unknown;
      batch_id?: unknown;
      model_id?: unknown;
      modelId?: unknown;
    };
    const batchId = typeof metadata.batchId === "string" && metadata.batchId.length > 0
      ? metadata.batchId
      : typeof metadata.batch_id === "string" && metadata.batch_id.length > 0
        ? metadata.batch_id
        : null;
    const modelId = typeof metadata.model_id === "string" && metadata.model_id.length > 0
      ? metadata.model_id
      : typeof metadata.modelId === "string" && metadata.modelId.length > 0
        ? metadata.modelId
        : null;
    let prompt: string | null = null;
    if (batchId !== null) {
      if (!promptByBatchId.has(batchId)) {
        const batch = readBatchById(db, batchId);
        promptByBatchId.set(batchId, batch === null ? null : batch.prompt);
      }
      prompt = promptByBatchId.get(batchId) ?? null;
    }
    index.set(assetId, { taskId, modelId, prompt });
  }
  return index;
};

/** 任务的产物资产清单（task wait / generate --wait 的产物数据源，走 task_outputs 关联）。 */
export const readCliTaskOutputAssets = (projectPath: string, taskId: string): RuntimeMediaAssetView[] => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按空产物清单处理", { projectPath, taskId });
    return [];
  }
  const outputs = readTaskOutputs(db, taskId);
  const assets: RuntimeMediaAssetView[] = [];
  for (const output of outputs) {
    if (typeof output.assetId !== "string" || output.assetId.length === 0) {
      // 文本类输出（textValue）不在 CLI 产物资产面（契约只承载媒体资产）
      console.debug("[cli-storage] 任务输出无关联资产，跳过", { taskId, outputId: output.outputId });
      continue;
    }
    const asset = readMediaAssetById(db, output.assetId);
    if (asset === null) {
      console.debug("[cli-storage] 任务输出引用的资产不存在，跳过", { taskId, assetId: output.assetId });
      continue;
    }
    assets.push(asset);
  }
  return assets;
};

/**
 * 按客户端受理幂等键读取批次快照（spec docs/integrations/CLI与本地Agent集成.md §5.4 受理幂等键，
 * `task list --request-id` 反查与 generate 幂等重放读取的底座）。未命中返回 null（幂等键没有
 * 对应批次 = 该次提交从未落库，是对账答案不是错误）。
 */
export const readCliBatchByClientRequestId = (
  projectPath: string,
  clientRequestId: string,
): BatchIntentSnapshot | null => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按无批次处理", { projectPath, clientRequestId });
    return null;
  }
  return readBatchByClientRequestId(db, clientRequestId);
};

/** 按批次读取任务视图（task list --request-id 的任务清单数据源，按受理期任务索引排序）。 */
export const readCliTaskViewsByBatchId = (projectPath: string, batchId: string): RuntimeTaskView[] => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按空任务清单处理", { projectPath, batchId });
    return [];
  }
  return readTasksByBatchId(db, batchId);
};

/** 画布节点载荷清单（raw payload 数组，投影由 cli-canvas-projection 承担）。 */
export const readCliCanvasNodePayloads = (projectPath: string): readonly unknown[] => {
  const db = getDbForExistingProject(projectPath);
  if (db === null) {
    console.debug("[cli-storage] 项目库不可用，按空画布节点清单处理", { projectPath });
    return [];
  }
  const manifest = readManifestFromDb(db);
  if (manifest === null) {
    console.debug("[cli-storage] 项目 manifest 缺失，按空画布节点清单处理", { projectPath });
    return [];
  }
  const graph = readNodeGraphFromDb(db, manifest.nodeGraphId);
  if (graph === null) {
    console.debug("[cli-storage] 项目画布图缺失，按空画布节点清单处理", { projectPath });
    return [];
  }
  return Array.isArray(graph.nodes) ? graph.nodes : [];
};

/** 项目打开链的最近打开时间更新（project list 的 last_opened_at 事实源写入点）。 */
export const touchCliProjectOpenedAt = (projectPath: string, openedAt: number): void => {
  touchRecentProjectOpenedAt(projectPath, openedAt);
};

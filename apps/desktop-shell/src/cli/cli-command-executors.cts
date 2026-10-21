import {
  TaskCancelAcceptedResponseSchema,
  UNIFIED_GENERATION_RUNNING_STATUSES,
  type BatchIntentSnapshot,
  type CliCanvasSelection,
  type CliCommandRequest,
  type CliErrorCode,
  type OpenEditorWindowResult,
  type RuntimeMediaAssetView,
  type RuntimeTaskView,
} from "@iart/contracts";
import * as path from "node:path";
import type { CliCanvasNodeEntry } from "@iart/contracts";
import type { ProjectRegistryEntry } from "../storage/editor-storage-recent-projects.cjs";
import { getEntryLastOpenedAt } from "../storage/editor-storage-recent-projects.cjs";
import {
  buildTaskCanvasIdentityIndex,
  projectCanvasNodePayload,
  projectCanvasGroupSummaries,
  resolveLocalMediaFilePath,
} from "./cli-canvas-projection.cjs";
import type { CliAssetGenerationSource } from "./cli-storage-queries.cjs";
import mediaFileKeyModule = require("@iart/utils/media-file-key");
const { extractContentHashFromFileKey } = mediaFileKeyModule;
import {
  parseExecutableModelCatalogPayload,
  parseTaskByIdPayload,
  parseTaskListPayload,
  type CliBackendForwarder,
} from "./cli-backend-forwarder.cjs";
import type { CliGenerationArchive } from "@iart/contracts";
import { buildGenerationArchive, resolveTaskBatchId } from "./cli-generation-archive.cjs";
import type { CliProxyCommandCandidate, CliProxyDispatchOutcome } from "./cli-proxy-dispatcher.cjs";
import { resolveCliProject, type CliProjectRegistryReader, type CliResolvedProject } from "./cli-project-resolver.cjs";
import { buildGenerationWarnings, toCliAssetWithLocalPath } from "./cli-task-result-projection.cjs";

// 纯函数出口（尺寸提示单测按执行器模块取用）；实现承载在 cli-task-result-projection（行数预算拆分）。
export { buildGenerationWarnings };

/**
 * CLI 命令执行器注册表（spec docs/integrations/CLI与本地Agent集成.md §4.2 分派规则）。
 * 本批次（批次四）接入 21 条：项目生命周期 6 + 只读查询 7 + 画布命令 8 + 生成与任务 3
 * （画布命令含 group dissolve / node move / node delete / layout 与 group add / group remove）；
 * 另有应用状态感知 app.status（spec §5.5，CLI-020/021）。
 * 分派规则是固定语义（spec §4.2），同一命令不得因调用方不同而改变执行后端或前提条件：
 * - 项目生命周期 → 主进程存储服务与窗口控制（全部复用既有实现，不另建执行路径）；
 * - 只读查询 → 运行域代理转发（模型/任务）或存储只读投影（资产/画布节点），项目未打开也可用；
 * - 画布命令 / 生成提交 → 代理执行通道 → 画布窗口，**要求项目已打开**：无窗口一律 project_not_open（CLI-007），不做任何降级（spec §13）；
 * - task.cancel → 项目已打开走代理通道（复用用户取消链），未打开走运行域取消端点（CLI-012）；
 * - task.wait → 运行域轮询至终态，产物资产经存储只读投影。
 * 依赖全部注入（可测性）；执行器返回 { response, errorCode }：业务错误以 ok:false 响应返回（命令日志记 errorCode），未预期异常向上抛由控制服务兜底 internal_error。
 */

export type CliExecutorResult = { response: unknown; errorCode: CliErrorCode | null };

export type CliCommandExecutor = (request: CliCommandRequest) => CliExecutorResult | Promise<CliExecutorResult>;

/**
 * 已打开画布窗口的项目快照（app status 数据源，spec §5.5/CLI-020/CLI-021）：
 * 焦点与加载态均按查询时点判定，不维护任何历史。
 */
export interface CliOpenProjectWindowSnapshot {
  projectPath: string;
  /** 查询时点是否持有焦点（spec CLI-020：不维护焦点历史）。 */
  focused: boolean;
  /** 查询时点画布页面是否仍在加载（true → 不向该窗口分发选中查询，选中态输出 null，spec CLI-021）。 */
  canvasLoading: boolean;
}

export interface CliCommandExecutorWindows {
  /** 复用项目打开主链：校验 → 等 backend 就绪 → 创建/聚焦画布窗口 → 注册项目作用域。 */
  openOrFocus: (projectPath: string) => Promise<OpenEditorWindowResult>;
  /** 该项目是否有存活的画布窗口。 */
  hasOpenWindow: (projectPath: string) => boolean;
  /** 关闭承载该项目的画布窗口（复用 BrowserWindow.close 触发的既有关闭/清理链）；返回是否找到窗口。 */
  closeByProjectPath: (projectPath: string) => boolean;
  /** 枚举全部已打开画布窗口的项目快照（app status 消费，spec CLI-020/CLI-021）。 */
  listOpenEditorProjects: () => readonly CliOpenProjectWindowSnapshot[];
}

export interface CliCommandExecutorStorage {
  /** 复用既有创建链（建目录、建库、写清单、登记注册表）；重名在实现入口抛 PROJECT_NAME_CONFLICT。 */
  createProject: (params: { parentDir: string; name: string }) => { projectPath: string };
  /** 复用既有删除语义：移除注册表记录并关闭项目库连接；不删除磁盘文件。 */
  deleteProject: (params: { projectPath: string }) => void;
  /** 项目打开链的最近打开时间写入点（project list 的 last_opened_at 事实源）。 */
  touchProjectOpenedAt: (projectPath: string, openedAt: number) => void;
  readMediaAssets: (projectPath: string) => readonly RuntimeMediaAssetView[];
  readMediaAssetById: (projectPath: string, assetId: string) => RuntimeMediaAssetView | null;
  readAssetTaskIndex: (projectPath: string) => ReadonlyMap<string, string>;
  /** 资产 → 生成来源索引（--query 提示词命中与 --model 过滤的数据源；仅 --query/--model 时消费）。 */
  readAssetGenerationIndex: (projectPath: string) => ReadonlyMap<string, CliAssetGenerationSource>;
  readTaskOutputAssets: (projectPath: string, taskId: string) => readonly RuntimeMediaAssetView[];
  /**
   * 按客户端受理幂等键读取批次快照（spec §5.4 受理幂等键 / CLI-033）：
   * task list --request-id 反查的底座；未命中（幂等键没有对应批次）返回 null。
   */
  readBatchByClientRequestId: (projectPath: string, clientRequestId: string) => BatchIntentSnapshot | null;
  /** 按批次读取任务视图（task list --request-id 的任务清单数据源，受理期任务索引排序）。 */
  readTaskViewsByBatchId: (projectPath: string, batchId: string) => readonly RuntimeTaskView[];
  /** 按任务 id 读取任务视图（生成档案的批次归属解析底座，spec §5.2/CLI-039/040）。 */
  readTaskById: (projectPath: string, taskId: string) => RuntimeTaskView | null;
  /** 按批次 id 读取批次快照（batch get 与档案内联的数据源，spec §5.2/CLI-038）。 */
  readBatchById: (projectPath: string, batchId: string) => BatchIntentSnapshot | null;
  readCanvasNodePayloads: (projectPath: string) => readonly unknown[];
}

export interface CliCommandExecutorDeps {
  readProjects: CliProjectRegistryReader;
  windows: CliCommandExecutorWindows;
  forwarder: CliBackendForwarder;
  storage: CliCommandExecutorStorage;
  /**
   * 代理执行通道分发端（spec §6.3，批次四）：画布命令 / 生成提交 / 画布侧 task.cancel
   * 经此进入目标项目的画布窗口执行。
   */
  proxy: CliCommandExecutorProxy;
  /** task.wait 轮询间隔毫秒；生产 2000（spec §5.4 轮询语义），测试注入小值。 */
  pollIntervalMs?: number;
}

/** 代理执行通道分发端注入面（cli-proxy-dispatcher 的 dispatch 的收窄视图）。 */
export interface CliCommandExecutorProxy {
  dispatch: (projectPath: string, candidate: CliProxyCommandCandidate) => Promise<CliProxyDispatchOutcome>;
}

const RUNNING_STATUS_SET: ReadonlySet<string> = new Set<string>(UNIFIED_GENERATION_RUNNING_STATUSES);
const DEFAULT_POLL_INTERVAL_MS = 2000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const okResult = <TPayload extends object>(
  command: CliCommandRequest["command"],
  payload: TPayload,
): CliExecutorResult => ({
  response: { command, ok: true, ...payload },
  errorCode: null,
});

const errorResult = (command: CliCommandRequest["command"], code: CliErrorCode, message: string): CliExecutorResult => ({
  response: { command, ok: false, error: { code, message } },
  errorCode: code,
});

/**
 * 同内容等价 id 计算（spec CLI-019）：以 fileKey 解析出的内容 sha256 为等价判据
 * （唯一文档事实源：storage-schema.md「资产 id 派生规则」存量语义），同媒体类型内分组；
 * 无等价项返回空数组（响应侧不输出该字段，不以空数组占位）。
 */
const computeEquivalentAssetIds = (
  assets: readonly RuntimeMediaAssetView[],
  target: RuntimeMediaAssetView,
): string[] => {
  const targetFileKey = target.original.fileKey;
  if (typeof targetFileKey !== "string" || targetFileKey.length === 0) return [];
  const targetHash = extractContentHashFromFileKey(targetFileKey);
  if (targetHash === null) return [];
  const equivalents: string[] = [];
  for (const candidate of assets) {
    if (candidate.assetId === target.assetId || candidate.mediaType !== target.mediaType) continue;
    const candidateFileKey = candidate.original.fileKey;
    if (typeof candidateFileKey !== "string" || candidateFileKey.length === 0) continue;
    if (extractContentHashFromFileKey(candidateFileKey) === targetHash) equivalents.push(candidate.assetId);
  }
  return equivalents;
};

/** 项目解析失败 → 统一错误响应（project_not_found / project_name_ambiguous，spec §9）。 */
type Resolution = { ok: true; project: CliResolvedProject } | { ok: false; result: CliExecutorResult };

const resolveProjectOrFail = (request: CliCommandRequest, deps: CliCommandExecutorDeps): Resolution => {
  const rawProject =
    "project" in request && typeof request.project === "string" ? request.project : null;
  if (rawProject === null) {
    return {
      ok: false,
      result: errorResult(request.command, "internal_error", "命令缺少项目参数。"),
    };
  }
  const resolution = resolveCliProject(rawProject, deps.readProjects);
  if (!resolution.ok) {
    return {
      ok: false,
      result: errorResult(request.command, resolution.code, resolution.message),
    };
  }
  return { ok: true, project: resolution.project };
};

const buildTaskQueryPath = (pathname: string, projectPath: string): string =>
  `${pathname}?projectPath=${encodeURIComponent(projectPath)}`;

/** 带额外出发端查询参数的任务列表路径（status 等）：单一定位符拼装，避免双 `?`。 */
const buildTaskListQueryPath = (params: { projectPath: string; status: string | null }): string => {
  const query = new URLSearchParams({ projectPath: params.projectPath });
  if (params.status !== null) query.set("status", params.status);
  return `/api/tasks?${query.toString()}`;
};

/**
 * 画布命令 / 生成提交的项目已打开守卫（CLI-007，spec §4.2/§13）：
 * 无存活画布窗口一律 project_not_open 拒绝，编辑域存储无任何写入、不做任何降级。
 */
const guardProjectOpenOrFail = (
  command: CliCommandRequest["command"],
  projectPath: string,
  deps: CliCommandExecutorDeps,
): CliExecutorResult | null => {
  if (deps.windows.hasOpenWindow(projectPath)) return null;
  console.debug("[cli-executor] 画布命令在项目未打开时被拒（CLI-007）", { command, projectPath });
  return errorResult(
    command,
    "project_not_open",
    "这个项目还没有在画布中打开，请先在应用中打开项目后再试。",
  );
};

/** 代理执行通道响应 → CLI 响应直通映射（成功结果原样、Editor 回的错误码原样透传）。 */
const proxyOutcomeToResult = (
  command: CliCommandRequest["command"],
  outcome: CliProxyDispatchOutcome,
  noWindowMessage: string,
): CliExecutorResult => {
  if (!outcome.ok) {
    console.debug("[cli-executor] 代理分发未成功", { command, reason: outcome.reason, detail: outcome.detail });
    // no_window：守卫与分发之间的竞态（窗口刚被关闭）——仍按项目未打开拒绝（spec §10）。
    if (outcome.reason === "no_window") {
      return errorResult(command, "project_not_open", noWindowMessage);
    }
    return errorResult(command, "internal_error", "命令执行出现内部错误，请稍后重试。");
  }
  const response = outcome.response;
  if ("error" in response) {
    return errorResult(command, response.error.code, response.error.message);
  }
  switch (response.command) {
    case "asset.import":
      // 导入结果直通（产物条目列表：文件名/资产标识/节点标识/媒体类型）；文件存在性与类型
      // 校验在画布窗口侧前置完成，错误经 error 分支原样透传（spec §5.3 / CLI-047）。
      return okResult(command, { imported: response.imported });
    case "canvas.group.create":
      return okResult(command, { group_node_id: response.group_node_id });
    case "canvas.group.dissolve":
      return okResult(command, {
        dissolved: response.dissolved,
        group_node_id: response.group_node_id,
        member_ids: response.member_ids,
      });
    case "canvas.group.add":
    case "canvas.group.remove": {
      // 成员加入/移出结果直通（加入三组标识按加入前归属分类；移出为实际移出集合）。
      const { command: _command, request_id: _requestId, ...membershipOutcome } = response;
      return okResult(command, membershipOutcome);
    }
    case "canvas.node.move":
      return okResult(command, {
        node_id: response.node_id,
        position: response.position,
        moved_node_ids: response.moved_node_ids,
      });
    case "canvas.node.delete":
      return okResult(command, { deleted: response.deleted, deleted_node_ids: response.deleted_node_ids });
    case "canvas.layout":
      return okResult(command, { positions: response.positions });
    case "task.cancel":
      return okResult(command, {
        accepted: response.accepted,
        task_id: response.task_id,
        cancelled_at: response.cancelled_at,
      });
    case "generate":
      // 受理结果直通（批次标识 + 任务身份列表 + 幂等键回显/重放标志）；逐任务终态由 CLI 客户端
      // --wait 轮询 task.wait 命令收集（批次三实现），代理通道不承载，恒为空数组。
      return okResult(command, {
        batch_id: response.batch_id,
        tasks: response.tasks,
        ...(response.client_request_id !== undefined ? { client_request_id: response.client_request_id } : {}),
        ...(response.replayed !== undefined ? { replayed: response.replayed } : {}),
        task_results: [],
      });
    case "canvas.selection.get":
      // 防御分支：画布状态只读查询不经本映射（app.status 执行器直读 selection），不应到达此处。
      return errorResult(command, "internal_error", "命令执行出现内部错误，请稍后重试。");
  }
};

export const createCliCommandExecutors = (deps: CliCommandExecutorDeps): Map<CliCommandRequest["command"], CliCommandExecutor> => {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const registry = new Map<CliCommandRequest["command"], CliCommandExecutor>();

  /**
   * 生成档案单一读取链（spec §5.2/§5.4 / CLI-038/039/040）：任务 id → 任务视图 → 批次归属
   * → 批次快照 → buildGenerationArchive。asset get 内联与 task get 内联共用本函数，
   * 与 batch get 同一构建出口（任何入口不得出现字段子集）；任一环节缺失（无产出来源任务、
   * 无批次归属、批次快照缺失）返回 null，调用方缺省 generation 字段、主响应照常输出。
   */
  const buildArchiveFromTaskId = (projectPath: string, taskId: string): CliGenerationArchive | null => {
    const task = deps.storage.readTaskById(projectPath, taskId);
    if (task === null) {
      console.debug("[cli-executor] 生成档案：任务在项目库不存在，跳过档案内联", { projectPath, taskId });
      return null;
    }
    const batchId = resolveTaskBatchId(task);
    if (batchId === null) {
      console.debug("[cli-executor] 生成档案：任务无批次归属，跳过档案内联", { projectPath, taskId });
      return null;
    }
    const snapshot = deps.storage.readBatchById(projectPath, batchId);
    if (snapshot === null) {
      console.debug("[cli-executor] 生成档案：批次快照缺失，跳过档案内联", { projectPath, taskId, batchId });
      return null;
    }
    return buildGenerationArchive({
      projectPath,
      snapshot,
      assets: {
        readAssetById: (assetId: string) => deps.storage.readMediaAssetById(projectPath, assetId),
        listAssets: () => deps.storage.readMediaAssets(projectPath),
      },
    });
  };

  // ── 项目生命周期（§5.1：主进程存储服务与窗口控制） ─────────────────────────────

  registry.set("project.list", () => {
    const projects = deps.readProjects().map((entry: ProjectRegistryEntry) => ({
      name: entry.name,
      path: entry.path,
      last_opened_at: getEntryLastOpenedAt(entry),
    }));
    return okResult("project.list", { projects });
  });

  registry.set("project.status", async (request) => {
    if (request.command !== "project.status") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    // 运行域在途任务数：代理转发任务列表端点（写守卫外，读不需要 token），按项目过滤运行中状态。
    const forwarded = await deps.forwarder.getJson(buildTaskQueryPath("/api/tasks", project.path));
    if (!forwarded.ok) {
      console.debug("[cli-executor] project.status 统计在途任务失败", { reason: forwarded.reason, detail: forwarded.detail });
      return errorResult(
        request.command,
        "internal_error",
        "生成任务服务暂时不可达，无法统计在途任务，请稍后重试。",
      );
    }
    const list = parseTaskListPayload(forwarded.payload);
    if (list === null) {
      return errorResult(request.command, "internal_error", "生成任务列表暂时读不出来，请稍后重试。");
    }
    const activeTaskCount = list.tasks.filter(
      (task) => task.projectPath === project.path && RUNNING_STATUS_SET.has(task.status),
    ).length;
    return okResult(request.command, {
      project: { name: project.name, path: project.path },
      registered: project.registered,
      window_open: deps.windows.hasOpenWindow(project.path),
      active_task_count: activeTaskCount,
    });
  });

  registry.set("project.create", (request) => {
    if (request.command !== "project.create") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    let created: { projectPath: string };
    try {
      created = deps.storage.createProject({ parentDir: request.path, name: request.name });
    } catch (error: unknown) {
      // 重名守卫在 createProject 入口（CLI-005：GUI 同链受益）；此处只做错误码映射。
      if (error instanceof Error && error.message === "PROJECT_NAME_CONFLICT") {
        console.debug("[cli-executor] project.create 命中同名项目目录", { parentDir: request.path, name: request.name });
        return errorResult(
          request.command,
          "project_name_conflict",
          "目标位置已存在同名项目文件夹，请换一个名称或位置。",
        );
      }
      throw error;
    }
    return okResult(request.command, { project: { name: request.name, path: created.projectPath } });
  });

  registry.set("project.open", async (request) => {
    if (request.command !== "project.open") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    // CLI-006：复用项目打开主链，窗口显式打开并聚焦；已打开时聚焦既有窗口（幂等成功）。
    const opened = await deps.windows.openOrFocus(project.path);
    if (!opened.ok) {
      console.debug("[cli-executor] project.open 打开主链失败", { code: opened.code, message: opened.message });
      if (opened.code === "invalid-project-folder") {
        return errorResult(request.command, "project_not_found", opened.message);
      }
      return errorResult(request.command, "internal_error", "画布窗口打开失败，请稍后重试。");
    }
    deps.storage.touchProjectOpenedAt(project.path, Date.now());
    return okResult(request.command, { project: { name: project.name, path: project.path } });
  });

  registry.set("project.close", (request) => {
    if (request.command !== "project.close") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    // 项目未打开时幂等成功（spec §5.1）；关闭走既有关闭链（closed 事件完成会话注销与投影清理）。
    deps.windows.closeByProjectPath(resolution.project.path);
    return okResult(request.command, { closed: true });
  });

  registry.set("project.delete", (request) => {
    if (request.command !== "project.delete") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    // 复用既有删除语义：仅移除注册表记录并关闭项目库连接，不删除磁盘文件（spec §5.1/§13）。
    deps.storage.deleteProject({ projectPath: resolution.project.path });
    return okResult(request.command, { deleted: true });
  });

  // ── 只读查询（§5.2：运行域代理转发 / 存储只读投影，项目未打开也可用） ───────────

  registry.set("model.list", async (request) => {
    const forwarded = await deps.forwarder.getJson("/api/executable-model-catalog");
    if (!forwarded.ok) {
      console.debug("[cli-executor] model.list 目录转发失败", { reason: forwarded.reason, detail: forwarded.detail });
      return errorResult(request.command, "model_not_available", "可用模型目录暂时读不出来，请稍后重试。");
    }
    const catalog = parseExecutableModelCatalogPayload(forwarded.payload);
    if (catalog === null) {
      return errorResult(request.command, "model_not_available", "可用模型目录暂时读不出来，请稍后重试。");
    }
    return okResult(request.command, { models: catalog.models });
  });

  registry.set("model.get", async (request) => {
    if (request.command !== "model.get") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const forwarded = await deps.forwarder.getJson("/api/executable-model-catalog");
    if (!forwarded.ok) {
      console.debug("[cli-executor] model.get 目录转发失败", { reason: forwarded.reason, detail: forwarded.detail });
      return errorResult(request.command, "model_not_available", "可用模型目录暂时读不出来，请稍后重试。");
    }
    const catalog = parseExecutableModelCatalogPayload(forwarded.payload);
    if (catalog === null) {
      return errorResult(request.command, "model_not_available", "可用模型目录暂时读不出来，请稍后重试。");
    }
    const model = catalog.models.find((entry) => entry.model_id === request.model_id);
    if (model === undefined) {
      console.debug("[cli-executor] model.get 未命中可用模型", { model_id: request.model_id });
      return errorResult(
        request.command,
        "model_not_available",
        `模型 ${request.model_id} 当前不可用：不在可用模型目录中。`,
      );
    }
    return okResult(request.command, { model });
  });

  registry.set("asset.list", (request) => {
    if (request.command !== "asset.list") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    const assets = deps.storage.readMediaAssets(project.path);
    const sourceIndex = deps.storage.readAssetTaskIndex(project.path);
    // 生成来源索引只在需要时构建（--query 提示词命中 / --model 过滤）；纯结构化筛选或全量输出零额外读。
    const needsGenerationIndex = request.query !== null || request.model !== null;
    const generationIndex = needsGenerationIndex ? deps.storage.readAssetGenerationIndex(project.path) : null;
    const queryLower = request.query !== null ? request.query.toLowerCase() : null;
    const filtered = assets.filter((asset) => {
      if (request.media_type !== null && asset.mediaType !== request.media_type) return false;
      if (request.model !== null) {
        const modelId = generationIndex?.get(asset.assetId)?.modelId ?? null;
        if (modelId !== request.model) return false;
      }
      if (queryLower !== null) {
        const fileName = asset.original.sourceFileName ?? "";
        const prompt = generationIndex?.get(asset.assetId)?.prompt ?? "";
        if (!fileName.toLowerCase().includes(queryLower) && !prompt.toLowerCase().includes(queryLower)) return false;
      }
      return true;
    });
    const offset = request.offset;
    const paged = request.limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + request.limit);
    const summaries = paged.map((asset) => {
      const sourceTaskId = sourceIndex.get(asset.assetId);
      const sourceFileName = asset.original.sourceFileName;
      return {
        asset_id: asset.assetId,
        media_type: asset.mediaType,
        // 生成来源摘要：任务标识（短文本承载，不含提示词全文，spec §6.1 精神）；无产出来源为空串。
        source_summary: sourceTaskId !== undefined ? `任务 ${sourceTaskId}` : "",
        ...(typeof sourceFileName === "string" && sourceFileName.length > 0 ? { source_file_name: sourceFileName } : {}),
      };
    });
    return okResult(request.command, { assets: summaries });
  });

  registry.set("asset.get", (request) => {
    if (request.command !== "asset.get") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    const asset = deps.storage.readMediaAssetById(project.path, request.asset_id);
    if (asset === null) {
      console.debug("[cli-executor] asset.get 未命中资产", { asset_id: request.asset_id });
      return errorResult(request.command, "asset_not_found", "没有找到这个资产：请确认资产标识属于该项目。");
    }
    const localFilePath = resolveLocalMediaFilePath(project.path, asset);
    if (localFilePath === null) {
      // 契约要求 asset.get 必须携带本地绝对路径；资产存在但无本地文件承载时按资产不可用处理。
      console.debug("[cli-executor] asset.get 资产缺少本地文件承载", { asset_id: request.asset_id });
      return errorResult(request.command, "asset_not_found", "这个资产没有可用的本地媒体文件。");
    }
    // 同内容等价 id（存量双 id 残留的可查口径，spec CLI-019）：fileKey 内容指纹分组，无等价项不输出该字段。
    const equivalents = computeEquivalentAssetIds(deps.storage.readMediaAssets(project.path), asset);
    // 生成档案内联（spec §5.2 / CLI-039）：资产生成产物时附产出批次档案；导入素材等
    // 非生成产物无产出来源任务，缺省 generation 字段（主响应照常输出，回退现状）。
    const sourceTaskId = deps.storage.readAssetTaskIndex(project.path).get(request.asset_id);
    if (sourceTaskId === undefined) {
      console.debug("[cli-executor] asset.get 资产无产出来源任务，缺省生成档案", { asset_id: request.asset_id });
    }
    const generation = sourceTaskId !== undefined ? buildArchiveFromTaskId(project.path, sourceTaskId) : null;
    return okResult(request.command, {
      asset,
      local_file_path: localFilePath,
      ...(equivalents.length > 0 ? { equivalent_asset_ids: equivalents } : {}),
      ...(generation !== null ? { generation } : {}),
    });
  });

  registry.set("canvas.nodes.list", (request) => {
    if (request.command !== "canvas.nodes.list") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    // 项目未打开也可读（spec §5.2 只读可、写入拒）：统一走存储只读投影，不经画布窗口。
    const payloads = deps.storage.readCanvasNodePayloads(resolution.project.path);
    const nodes: CliCanvasNodeEntry[] = [];
    for (const payload of payloads) {
      const entry = projectCanvasNodePayload(payload);
      if (entry === null) continue;
      nodes.push(entry);
    }
    return okResult(request.command, { nodes });
  });

  registry.set("canvas.group.list", (request) => {
    if (request.command !== "canvas.group.list") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    // 组/容器清单走存储只读投影（spec §5.2 / CLI-045）：与 canvas nodes list 同通道定位，
    // 项目未打开也可读。聚合（成员计数）在投影函数内完成，执行器只做编排。
    const payloads = deps.storage.readCanvasNodePayloads(resolution.project.path);
    return okResult(request.command, { groups: projectCanvasGroupSummaries(payloads) });
  });

  registry.set("task.list", async (request) => {
    if (request.command !== "task.list") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    // --since 可解析性前置校验（本地报参数错误，不发起请求）；解析为 epoch ms 客户端后滤。
    let sinceMs: number | null = null;
    if (request.since !== null) {
      const parsed = Date.parse(request.since);
      if (!Number.isFinite(parsed)) {
        console.debug("[cli-executor] task.list --since 不是合法时间", { since: request.since });
        return errorResult(
          request.command,
          "command_rejected",
          `--since 需要是合法的 ISO 8601 时间（如 2026-10-14T08:00:00Z），收到：${request.since}。`,
        );
      }
      sinceMs = parsed;
    }

    let tasks: RuntimeTaskView[];
    if (request.client_request_id !== null) {
      // 受理幂等键反查（spec §5.4 受理幂等键 / CLI-033 考古语义）：按批次反查任务清单，
      // 存储只读投影承载（不经运行域列表端点）；未命中返回空列表且命令成功——
      // 「该 request_id 没有对应批次」本身就是对账答案（该次提交从未落库，可安全重提）。
      const batch = deps.storage.readBatchByClientRequestId(project.path, request.client_request_id);
      if (batch === null) {
        console.debug("[cli-executor] task.list 幂等键未命中批次，返回空列表", {
          clientRequestId: request.client_request_id,
          projectPath: project.path,
        });
        tasks = [];
      } else {
        tasks = deps.storage.readTaskViewsByBatchId(project.path, batch.batch_id).slice();
      }
    } else {
      const forwarded = await deps.forwarder.getJson(
        buildTaskListQueryPath({ projectPath: project.path, status: request.status }),
      );
      if (!forwarded.ok) {
        console.debug("[cli-executor] task.list 转发失败", { reason: forwarded.reason, detail: forwarded.detail });
        return errorResult(request.command, "internal_error", "生成任务列表暂时读不出来，请稍后重试。");
      }
      const list = parseTaskListPayload(forwarded.payload);
      if (list === null) {
        return errorResult(request.command, "internal_error", "生成任务列表暂时读不出来，请稍后重试。");
      }
      // 服务端已按 projectPath 过滤，此处再按解析出的项目路径收敛一次（防查询参数被忽略的漂移）。
      tasks = list.tasks.filter((task) => task.projectPath === project.path);
    }

    // --status 兜底过滤：转发路径服务端已按 status 过滤，此处幂等收敛（防参数被忽略的漂移，
    // 与 projectPath 双保险同语义）；幂等键反查路径在此处实际生效。
    if (request.status !== null) {
      tasks = tasks.filter((task) => task.status === request.status);
    }
    // --since 客户端后滤（改动面最小裁定：运行域列表端点无 since 参数）。
    if (sinceMs !== null) {
      tasks = tasks.filter((task) => task.createdAt >= sinceMs);
    }
    return okResult(request.command, { tasks });
  });

  registry.set("task.get", async (request) => {
    if (request.command !== "task.get") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const forwarded = await deps.forwarder.getJson(
      buildTaskQueryPath(`/api/tasks/${encodeURIComponent(request.task_id)}`, resolution.project.path),
    );
    if (!forwarded.ok && forwarded.reason === "http_error" && forwarded.status === 404) {
      return taskNotFoundResult(request.command, request.task_id);
    }
    if (!forwarded.ok) {
      console.debug("[cli-executor] task.get 转发失败", { reason: forwarded.reason, detail: forwarded.detail });
      return errorResult(request.command, "internal_error", "任务状态暂时读不出来，请稍后重试。");
    }
    const parsed = parseTaskByIdPayload(forwarded.payload);
    if (parsed === null) {
      return errorResult(request.command, "internal_error", "任务状态暂时读不出来，请稍后重试。");
    }
    const scopeMismatch = parsed.task.projectPath.length > 0 && parsed.task.projectPath !== resolution.project.path;
    if (scopeMismatch) {
      console.debug("[cli-executor] task.get 任务不属于该项目", { taskId: request.task_id });
      return taskNotFoundResult(request.command, request.task_id);
    }
    // 生成档案内联（spec §5.4 / CLI-040）：任务有批次归属且批次快照在库时附带该批次档案；
    // 无批次归属（如媒体工具加工任务）或批次行缺失时缺省 generation 字段、任务状态照常输出
    // （回退现状，留痕见 buildArchiveFromTaskId）。
    const generation = buildArchiveFromTaskId(resolution.project.path, request.task_id);
    // 任务画布投影身份（spec §5.4 / CLI-046）：按 task_id 经画布存储投影关联；无投影或项目
    // 库不可用时为 null（缺省不伪造）。
    const identity = buildTaskCanvasIdentityIndex(deps.storage.readCanvasNodePayloads(resolution.project.path)).get(
      request.task_id,
    );
    return okResult(request.command, {
      task: parsed.task,
      node_id: identity?.node_id ?? null,
      group_id: identity?.group_id ?? null,
      ...(generation !== null ? { generation } : {}),
    });
  });

  // ── 生成档案读取（§5.2：存储只读投影，项目未打开也可用） ─────────────────────────

  registry.set("batch.get", (request) => {
    if (request.command !== "batch.get") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    // 批次快照走存储只读投影（task list --request-id 批次反查同先例）：不经运行域端点，
    // 项目未打开也可读。未命中 = 该项目库里没有这个批次。
    const snapshot = deps.storage.readBatchById(project.path, request.batch_id);
    if (snapshot === null) {
      console.debug("[cli-executor] batch.get 未命中批次快照", { batch_id: request.batch_id, projectPath: project.path });
      return errorResult(request.command, "batch_not_found", `批次 ${request.batch_id} 不存在。`);
    }
    const archive = buildGenerationArchive({
      projectPath: project.path,
      snapshot,
      assets: {
        readAssetById: (assetId: string) => deps.storage.readMediaAssetById(project.path, assetId),
        listAssets: () => deps.storage.readMediaAssets(project.path),
      },
    });
    if (archive === null) {
      return errorResult(request.command, "internal_error", "生成档案暂时读不出来，请稍后重试。");
    }
    return okResult(request.command, { generation: archive });
  });

  // ── 任务等待（§5.4：运行域轮询；产物资产经存储只读投影） ───────────────────────

  registry.set("task.wait", async (request) => {
    if (request.command !== "task.wait") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    const taskQueryPath = buildTaskQueryPath(`/api/tasks/${encodeURIComponent(request.task_id)}`, project.path);
    // 不设轮询上限（仓库纪律：内部通信不设超时，误杀长任务）；--timeout 由 CLI 客户端侧承载。
    for (;;) {
      const forwarded = await deps.forwarder.getJson(taskQueryPath);
      if (forwarded.ok) {
        const parsed = parseTaskByIdPayload(forwarded.payload);
        if (parsed === null) {
          return errorResult(request.command, "internal_error", "任务状态暂时读不出来，请稍后重试。");
        }
        const scopeMismatch = parsed.task.projectPath.length > 0 && parsed.task.projectPath !== project.path;
        if (scopeMismatch) {
          console.debug("[cli-executor] task.wait 任务不属于该项目", { taskId: request.task_id });
          return taskNotFoundResult(request.command, request.task_id);
        }
        if (!RUNNING_STATUS_SET.has(parsed.task.status)) {
          const assets = deps.storage
            .readTaskOutputAssets(project.path, request.task_id)
            .map((asset) => toCliAssetWithLocalPath(project.path, asset))
            .filter((entry): entry is { asset: RuntimeMediaAssetView; local_file_path: string } => entry !== null);
          // 任务画布投影身份（spec §5.4 / CLI-046）：与 task get 同一关联通道（画布存储投影）。
          const identity = buildTaskCanvasIdentityIndex(deps.storage.readCanvasNodePayloads(project.path)).get(
            request.task_id,
          );
          return okResult(request.command, {
            task_result: {
              task: parsed.task,
              assets,
              // 生成终态尺寸对照（CLI-050）：信息性提示，不改变任务状态与 ok。
              warnings: buildGenerationWarnings(parsed.task, assets),
              node_id: identity?.node_id ?? null,
              group_id: identity?.group_id ?? null,
            },
          });
        }
      } else if (forwarded.reason === "http_error" && forwarded.status === 404) {
        return taskNotFoundResult(request.command, request.task_id);
      } else {
        console.debug("[cli-executor] task.wait 轮询暂未取到任务状态，继续等待", {
          taskId: request.task_id,
          reason: forwarded.reason,
        });
      }
      await sleep(pollIntervalMs);
    }
  });

  // ── 画布命令 / 生成提交（§4.2/§5.3/§5.4：代理执行通道 → 画布窗口，要求项目已打开） ──

  registry.set("asset.import", async (request) => {
    if (request.command !== "asset.import") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path, deps);
    if (guard !== null) return guard;
    // --file 路径清单原样进代理候选；文件存在性/媒体类型校验不在主进程做（spec §5.3 / CLI-047），
    // 由画布窗口侧前置校验产生 file_not_found / unsupported_file_type，经 error 分支透传。
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "asset.import",
      file: request.file,
    });
    return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
  });

  registry.set("canvas.group.create", async (request) => {
    if (request.command !== "canvas.group.create") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path, deps);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.group.create",
      name: request.name,
      members: request.members,
    });
    return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
  });

  registry.set("canvas.group.dissolve", async (request) => {
    if (request.command !== "canvas.group.dissolve") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path, deps);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.group.dissolve",
      group: request.group,
    });
    return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
  });

  for (const membershipCommand of ["canvas.group.add", "canvas.group.remove"] as const) {
    registry.set(membershipCommand, async (request) => {
      if (request.command !== "canvas.group.add" && request.command !== "canvas.group.remove") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
      const resolution = resolveProjectOrFail(request, deps);
      if (!resolution.ok) return resolution.result;
      const guard = guardProjectOpenOrFail(membershipCommand, resolution.project.path, deps);
      if (guard !== null) return guard;
      const fields = { group: request.group, members: request.members };
      const candidate = membershipCommand === "canvas.group.add"
        ? { command: "canvas.group.add" as const, ...fields }
        : { command: "canvas.group.remove" as const, ...fields };
      const outcome = await deps.proxy.dispatch(resolution.project.path, candidate);
      return proxyOutcomeToResult(membershipCommand, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
    });
  }

  registry.set("canvas.node.move", async (request) => {
    if (request.command !== "canvas.node.move") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path, deps);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.node.move",
      node: request.node,
      x: request.x,
      y: request.y,
    });
    return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
  });

  registry.set("canvas.node.delete", async (request) => {
    if (request.command !== "canvas.node.delete") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path, deps);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.node.delete",
      nodes: request.nodes,
      ...(request.yes !== undefined ? { yes: request.yes } : {}),
    });
    return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
  });

  registry.set("canvas.layout", async (request) => {
    if (request.command !== "canvas.layout") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path, deps);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.layout",
      scope: request.scope,
      ...(request.columns !== undefined ? { columns: request.columns } : {}),
      ...(request.order !== undefined ? { order: request.order } : {}),
    });
    return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
  });

  registry.set("generate", async (request) => {
    if (request.command !== "generate") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path, deps);
    if (guard !== null) return guard;
    // 程序化提交（spec §6.4）：画布窗口执行创作面提交主链；wait 轮询由 CLI 客户端承接，
    // 代理通道只承载受理（wait 原样携带、画布窗口执行侧忽略）。幂等键原样透传（CLI-033）。
    // 出生组组名原样透传（spec §5.4 / CLI-043）：组名解析与出生入组在画布窗口执行侧完成。
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "generate",
      prompt: request.prompt,
      model: request.model,
      ...(request.count !== undefined ? { count: request.count } : {}),
      ...(request.ref !== undefined ? { ref: request.ref } : {}),
      ...(request.arg !== undefined ? { arg: request.arg } : {}),
      ...(request.wait !== undefined ? { wait: request.wait } : {}),
      ...(request.client_request_id !== undefined ? { client_request_id: request.client_request_id } : {}),
      ...(request.group !== undefined ? { group: request.group } : {}),
    });
    return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，请先在应用中打开项目后再试。");
  });

  // ── 任务取消（§5.4：CLI-012 两形态——项目已打开走代理通道，未打开走运行域取消端点） ──

  registry.set("task.cancel", async (request) => {
    if (request.command !== "task.cancel") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request, deps);
    if (!resolution.ok) return resolution.result;
    const { project } = resolution;
    if (deps.windows.hasOpenWindow(project.path)) {
      const outcome = await deps.proxy.dispatch(project.path, {
        command: "task.cancel",
        task_id: request.task_id,
      });
      if (outcome.ok || outcome.reason !== "no_window") {
        return proxyOutcomeToResult(request.command, outcome, "画布窗口刚刚被关闭，取消没有送达画布。");
      }
      // 竞态：守卫后窗口被关闭 → 项目已未打开，回落运行域取消端点（与未打开形态同语义）。
      console.debug("[cli-executor] task.cancel 窗口在守卫后被关闭，回落运行域取消端点", {
        taskId: request.task_id,
      });
    } else {
      console.debug("[cli-executor] task.cancel 项目未打开，走运行域取消端点", {
        taskId: request.task_id,
        projectPath: project.path,
      });
    }
    const forwarded = await deps.forwarder.postJson(
      `/api/tasks/${encodeURIComponent(request.task_id)}/cancel`,
      {},
    );
    if (!forwarded.ok) {
      if (forwarded.reason === "http_error" && forwarded.status === 404) {
        // 与画布侧取消的 404 语义一致（command_rejected），message 与接收端同口径。
        console.debug("[cli-executor] task.cancel 运行域未命中任务", { taskId: request.task_id });
        return errorResult(request.command, "command_rejected", `找不到任务 ${request.task_id}，无法取消。`);
      }
      console.debug("[cli-executor] task.cancel 运行域取消转发失败", {
        taskId: request.task_id,
        reason: forwarded.reason,
        detail: forwarded.detail,
      });
      return errorResult(
        request.command,
        "internal_error",
        "生成任务服务暂时不可达，取消没有生效，请稍后重试。",
      );
    }
    // 受理响应经任务取消契约校验（CLI-012：取消被接受后任务进入取消结算）。
    const accepted = TaskCancelAcceptedResponseSchema.safeParse(forwarded.payload);
    if (!accepted.success) {
      console.debug("[cli-executor] task.cancel 运行域响应未通过契约校验", {
        taskId: request.task_id,
        issue: accepted.error.message.slice(0, 200),
      });
      return errorResult(request.command, "internal_error", "取消任务的响应异常，请稍后重试。");
    }
    return okResult(request.command, {
      accepted: accepted.data.accepted,
      task_id: accepted.data.task_id,
      cancelled_at: accepted.data.cancelled_at,
    });
  });

  // ── 应用状态感知（§5.5：全局只读；主进程直答打开集合 + 逐窗口代理只读查询选中态） ──

  registry.set("app.status", async (request) => {
    if (request.command !== "app.status") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    // 名称解析：注册表在册名优先；未在册项目（罕见）回退路径末段，保证条目名称可用。
    const nameByPath = new Map(
      deps.readProjects().map((entry: ProjectRegistryEntry) => [entry.path, entry.name] as const),
    );
    const openedProjects: {
      name: string;
      path: string;
      focused: boolean;
      selection: CliCanvasSelection | null;
    }[] = [];
    for (const snapshot of deps.windows.listOpenEditorProjects()) {
      const name = nameByPath.get(snapshot.projectPath) ?? path.basename(snapshot.projectPath);
      if (snapshot.canvasLoading) {
        // 画布尚未就绪（窗口已创建、画布页面仍在加载）：不向该窗口分发查询，选中态输出 null，
        // 命令整体不失败（spec CLI-021；避免向尚未注册接收器的窗口发消息挂起）。
        console.debug("[cli-executor] app.status 画布页面仍在加载，选中态输出 null", {
          projectPath: snapshot.projectPath,
        });
        openedProjects.push({ name, path: snapshot.projectPath, focused: snapshot.focused, selection: null });
        continue;
      }
      // 选中态经代理执行通道只读查询（spec §6.3：请求-响应、不映射 action、不产生写入）。
      const outcome = await deps.proxy.dispatch(snapshot.projectPath, { command: "canvas.selection.get" });
      if (!outcome.ok) {
        // 竞态：枚举后窗口刚被关闭（no_window）——该项目已不在打开集合，如实跳过该条目。
        console.debug("[cli-executor] app.status 选中查询分发未成功，跳过该项目条目", {
          projectPath: snapshot.projectPath,
          reason: outcome.reason,
          detail: outcome.detail,
        });
        continue;
      }
      const response = outcome.response;
      if ("error" in response || response.command !== "canvas.selection.get") {
        // 防御分支：只读查询不应回错误；仍保留项目条目（项目确实开着），选中态按不可用（null）输出。
        console.debug("[cli-executor] app.status 选中查询返回异常响应，选中态输出 null", {
          projectPath: snapshot.projectPath,
          ...( "error" in response ? { code: response.error.code } : { command: response.command }),
        });
        openedProjects.push({ name, path: snapshot.projectPath, focused: snapshot.focused, selection: null });
        continue;
      }
      openedProjects.push({
        name,
        path: snapshot.projectPath,
        focused: snapshot.focused,
        selection: response.selection,
      });
    }
    return okResult(request.command, { opened_projects: openedProjects });
  });

  return registry;
};

/**
 * 任务不存在错误（错误码 task_not_found，spec §9；2026-10-07 场景 C 补码：任务查询/取消
 * 目标不存在是可预期业务错误，不再落 internal_error）。
 */
const taskNotFoundResult = (command: CliCommandRequest["command"], taskId: string): CliExecutorResult =>
  errorResult(command, "task_not_found", `任务 ${taskId} 不存在。`);

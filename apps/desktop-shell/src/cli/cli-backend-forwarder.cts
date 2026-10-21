import {
  ExecutableModelCatalogResponseSchema,
  HubTaskListResponseSchema,
  RuntimeTaskViewSchema,
  type ExecutableModelDirectoryEntry,
  type HubTaskSummaryItem,
  type RuntimeTaskView,
} from "@iart/contracts";
import * as z from "zod";

/**
 * Main → Runtime Backend 轻量转发器（spec docs/integrations/CLI与本地Agent集成.md §4.1：
 * 运行域命令由本地控制服务代理转发 Runtime Backend 既有 HTTP 端点）。
 *
 * 边界：
 * - 只做「取 baseUrl + GET/POST + JSON 解析」，不承载命令语义；批次四的 task.cancel 代理
 *   也复用本转发器（POST cancel 端点）。
 * - 不设任何超时（仓库纪律：内部通信不设超时时长，生成任务时长差异极大）；
 *   不自动重试、不自动切换 fallback endpoint（docs/runtime/远端请求执行治理原则.md）。
 * - 读端点与全部 /api/tasks* 在 backend 写守卫之外（读不需要 token）；本转发器因此不携带
 *   hub write token——它不是写信任通道。
 * - 条件跳过留痕（仓库纪律）：baseUrl 缺失、网络失败、payload 解析失败一律 debug 级日志。
 */

export type CliForwardFailureReason = "no_base_url" | "network_error" | "http_error" | "bad_payload";

export type CliForwardResult =
  | { ok: true; payload: unknown }
  | {
      ok: false;
      reason: CliForwardFailureReason;
      /** HTTP 状态码（http_error 时存在）。 */
      status?: number;
      /** 诊断线索（进日志与错误 message）。 */
      detail: string;
    };

export interface CliBackendForwarder {
  getJson: (pathname: string) => Promise<CliForwardResult>;
  postJson: (pathname: string, body: unknown) => Promise<CliForwardResult>;
}

export interface CliBackendForwarderDeps {
  /** backend baseUrl 事实源（Runtime Controller 的 backendBaseUrl getter）。 */
  getBaseUrl: () => string | null | undefined;
  /** HTTP 实现；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const buildForwarder = (deps: CliBackendForwarderDeps): CliBackendForwarder => {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const requestJson = async (method: "GET" | "POST", pathname: string, body: unknown): Promise<CliForwardResult> => {
    const baseUrl = (deps.getBaseUrl() ?? "").trim();
    if (!baseUrl) {
      console.debug("[cli-forward] backend baseUrl 尚不可用，跳过转发", { pathname });
      return { ok: false, reason: "no_base_url", detail: "backend base url unavailable" };
    }
    let httpResponse: Response;
    try {
      httpResponse = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${pathname}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }
          : {}),
      });
    } catch (error: unknown) {
      console.debug("[cli-forward] backend 请求失败", { method, pathname, error: describeError(error) });
      return { ok: false, reason: "network_error", detail: describeError(error) };
    }
    if (!httpResponse.ok) {
      console.debug("[cli-forward] backend 返回非 2xx", { method, pathname, status: httpResponse.status });
      return {
        ok: false,
        reason: "http_error",
        status: httpResponse.status,
        detail: `backend responded ${httpResponse.status}`,
      };
    }
    const text = await httpResponse.text();
    try {
      return { ok: true, payload: JSON.parse(text) as unknown };
    } catch (error: unknown) {
      console.debug("[cli-forward] backend 响应不是合法 JSON", { pathname, error: describeError(error) });
      return { ok: false, reason: "bad_payload", detail: describeError(error) };
    }
  };

  return {
    getJson: (pathname) => requestJson("GET", pathname, undefined),
    postJson: (pathname, body) => requestJson("POST", pathname, body),
  };
};

export const createCliBackendForwarder = buildForwarder;

// ---------------------------------------------------------------------------
// 转发目标的响应形状解析（contracts 是可执行事实源，此处只组合不复制字段）
// ---------------------------------------------------------------------------

/**
 * 用给定 schema 校验后端响应。
 *
 * 泛型取 `z.output`（而不是让同一个 `T` 同时充当输入与输出）：契约里带 `.default(...)` 的
 * 字段（如模型条目的 `media_slots`）在**输入**侧可选、在**输出**侧必有；写成
 * `z.ZodType<T>` 会把输出侧也收成可选，与消费端实际读到的形状对不上。
 */
const parseOrDebug = <T,>(payload: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>, label: string): T | null => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.debug(`[cli-forward] ${label} 响应未通过契约校验`, { issue: parsed.error.message.slice(0, 200) });
    return null;
  }
  return parsed.data;
};

/** 可执行模型目录响应（GET /api/executable-model-catalog → { models }）。 */
export const parseExecutableModelCatalogPayload = (
  payload: unknown,
): { models: ExecutableModelDirectoryEntry[] } | null =>
  parseOrDebug(payload, ExecutableModelCatalogResponseSchema, "executable-model-catalog");

/** 单任务读取响应（GET /api/tasks/:id → { task }），任务状态按契约逐字段校验。 */
export const parseTaskByIdPayload = (payload: unknown): { task: RuntimeTaskView } | null =>
  parseOrDebug(payload, z.object({ task: RuntimeTaskViewSchema }).strict(), "task-by-id");

/**
 * 任务列表响应（GET /api/tasks）。先按既有 Hub 任务列表契约整体校验（真实形状的事实源），
 * 再把每条摘要投影为任务状态契约视图（RuntimeTaskView，供 CLI 响应承载）；
 * 单条投影失败只跳过该条并 debug 留痕，不让整张列表消失（跳过必须留痕）。
 */
export const parseTaskListPayload = (payload: unknown): { tasks: RuntimeTaskView[] } | null => {
  const parsed = parseOrDebug(payload, HubTaskListResponseSchema, "task-list");
  if (parsed === null) return null;
  const tasks: RuntimeTaskView[] = [];
  for (const entry of parsed.tasks) {
    const view = projectTaskSummaryToView(entry);
    if (view === null) {
      console.debug("[cli-forward] 任务列表条目投影为任务状态契约失败，跳过该条", {
        taskId: entry.taskId,
      });
      continue;
    }
    tasks.push(view);
  }
  return { tasks };
};

/**
 * Hub 任务摘要条目 → RuntimeTaskView 投影（列表摘要没有 request/metadata 字段，不虚构）。
 * progressPercent 恢复透传（spec CLI-034 任务列表可观测）：backend 列表端点已带
 * progress=progressPercent 投影（HubTaskSummaryItemSchema.progress），此处映射进任务状态
 * 契约视图；列表未写入进度的任务为 null，映射为字段缺省（契约 optional）。
 */
const projectTaskSummaryToView = (entry: HubTaskSummaryItem): RuntimeTaskView | null => {
  const candidate = {
    taskId: entry.taskId,
    status: entry.status,
    projectPath: entry.projectPath ?? "",
    ...(entry.sourceNodeId !== null ? { sourceNodeId: entry.sourceNodeId } : {}),
    ...(entry.targetNodeId !== null ? { targetNodeId: entry.targetNodeId } : {}),
    ...(entry.remoteRequestId !== null ? { remoteRequestId: entry.remoteRequestId } : {}),
    ...(entry.errorMessage !== null ? { errorMessage: entry.errorMessage } : {}),
    ...(entry.progress !== null ? { progressPercent: entry.progress } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  const parsed = RuntimeTaskViewSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

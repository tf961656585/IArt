import * as crypto from "node:crypto";
import * as http from "node:http";
import {
  CliCommandLogEntrySchema,
  CliCommandRequestSchema,
  CliCommandResponseSchema,
  type CliCommandLogEntry,
  type CliCommandName,
  type CliCommandRequest,
  type CliErrorCode,
} from "@iart/contracts/cli-contract";
import { readRecentProjects } from "../storage/editor-storage-recent-projects.cjs";
import { createCliCommandExecutors, type CliCommandExecutorDeps } from "./cli-command-executors.cjs";
import {
  deleteDiscoveryFileIfExists,
  resolveDefaultDiscoveryFilePath,
  writeDiscoveryFile,
} from "./cli-discovery.cjs";

/**
 * 本地控制服务（spec docs/integrations/CLI与本地Agent集成.md §6.2，Main 内嵌，CLI 唯一 API 面）。
 *
 * 安全边界（spec §7/§13，禁止项）：
 * - 只绑定 127.0.0.1；带 Origin 头的请求一律拒绝（浏览器网页不得触达）；不返回任何 CORS 响应头。
 * - 令牌鉴权：缺失/不匹配一律 401 auth_failed，不执行任何命令逻辑（CLI-002）；
 *   鉴权失败不记入命令日志（只 debug 留痕）。
 * - 命令日志与发现文件不记录密钥、凭证或提示词全文。
 *
 * 可测性：端口与发现文件路径可注入（生产入口用默认定位）；执行器注册表可整体注入
 * （生产入口传入真实依赖构造的注册表，测试注入假实现）；命令日志可读取
 * （供测试与后续设置页「命令行工具」子单元消费）。
 * 内部通信不设超时（仓库纪律）：命令处理不设任何超时时长。
 */

const CLI_COMMAND_PATH = "/cli/v1/command";
const CLI_TOKEN_HEADER = "x-iart-cli-token";
const CLI_DEFAULT_PORT = 47823;
const CLI_COMMAND_LOG_CAPACITY = 200;
/** 参数摘要单值截断长度（摘要性承载，禁止提示词全文）。 */
const PARAMS_SUMMARY_VALUE_MAX = 80;

export interface CliControlServiceOptions {
  /** 监听端口；缺省读 IART_CLI_PORT env（开发/测试注入），再缺省 47823，被占用回落 0（随机）。 */
  port?: number;
  /** 发现文件路径；缺省按应用数据根分流定位（与 recent-projects 同根）。 */
  discoveryFilePath?: string;
  /**
   * 命令执行器依赖（构造执行器注册表的数据源与执行后端）；缺省仅挂 project.list 的
   * 最小注册表（批次一骨架形态，供纯骨架测试使用）。
   */
  executorDeps?: CliCommandExecutorDeps;
  /**
   * 骨架注册表的 project.list 数据源（executorDeps 缺省时生效）；缺省读既有
   * recent-projects 注册表。保留供既有骨架测试注入临时注册表 fixture。
   */
  readProjects?: () => readonly ProjectRegistryEntryLite[];
  /** 应用版本（写入发现文件）；生产入口传 app.getVersion()。 */
  version?: string;
}

export interface CliControlServiceHandle {
  port: number;
  discoveryFilePath: string;
  /** 停止服务并删除发现文件（发现文件删除在同步段完成，will-quit 竞态安全）。 */
  stop: () => Promise<void>;
  /** 命令日志（内存环形，容量 200，不落盘、不跨重启保留）。 */
  getCommandLog: () => readonly CliCommandLogEntry[];
}

/**
 * 命令执行器。返回 { response, errorCode }：response 为完整响应对象（含 command/ok），
 * 出站统一经 CliCommandResponseSchema 校验；errorCode 供命令日志如实记录业务错误
 * （响应 ok:false 时非 null）。执行器抛出的未预期异常由服务兜底 internal_error。
 */
type CliCommandExecutor = (request: CliCommandRequest) => { response: unknown; errorCode: CliErrorCode | null } | Promise<{ response: unknown; errorCode: CliErrorCode | null }>;

/**
 * 最小骨架注册表（executorDeps 缺省时）：只挂 project.list（读 recent-projects 注册表投影），
 * 供批次一骨架形态的纯服务测试使用；生产入口经 executorDeps 注入完整注册表。
 */
const createSkeletonExecutorRegistry = (readProjects: () => readonly ProjectRegistryEntryLite[]): Map<CliCommandName, CliCommandExecutor> => {
  const registry = new Map<CliCommandName, CliCommandExecutor>();
  registry.set("project.list", () => ({
    response: {
      command: "project.list" as const,
      ok: true as const,
      projects: readProjects().map((entry) => ({
        name: entry.name,
        path: entry.path,
        last_opened_at: typeof entry.lastOpenedAt === "number" ? entry.lastOpenedAt : null,
      })),
    },
    errorCode: null,
  }));
  return registry;
};

type ProjectRegistryEntryLite = { name: string; path: string; lastOpenedAt?: number | null };

/** 错误响应统一 {code,message}（spec §9）；message 用用户视角业务语言，不暴露内部术语。 */
const buildErrorResponse = (command: CliCommandName, code: CliErrorCode, message: string): unknown => ({
  command,
  ok: false,
  error: { code, message },
});

/** 提示词类参数只记占位，禁止全文（spec §6.1/§11）。 */
const PROMPT_PARAM_KEYS = new Set<string>(["prompt"]);

const summarizeValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : summarizeValue(item)));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
};

/**
 * 构造命令日志的参数摘要：只记参数键与摘要值（截断），供诊断与设置页展示。
 * 导出供测试与后续设置页消费侧复用；输入是契约请求对象，无凭证类字段。
 */
export const buildParamsSummary = (request: CliCommandRequest): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(request)) {
    if (key === "command") continue;
    if (PROMPT_PARAM_KEYS.has(key) && typeof value === "string") {
      parts.push(`${key}=<prompt ${value.length} chars>`);
      continue;
    }
    const summarized = summarizeValue(value);
    parts.push(
      `${key}=${summarized.length <= PARAMS_SUMMARY_VALUE_MAX ? summarized : `${summarized.slice(0, PARAMS_SUMMARY_VALUE_MAX)}…`}`,
    );
  }
  return parts.join(", ");
};

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  // 注意：不返回任何 CORS 响应头（spec §6.2 禁止项）
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const sendText = (res: http.ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const resolveEnvPortOverride = (): number | null => {
  const raw = String(process.env["IART_CLI_PORT"] ?? "").trim();
  if (raw.length === 0) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
};

const listenOnPort = (server: http.Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

export const startCliControlService = async (options: CliControlServiceOptions = {}): Promise<CliControlServiceHandle> => {
  const token = crypto.randomBytes(32).toString("hex");
  const discoveryFilePath = options.discoveryFilePath ?? resolveDefaultDiscoveryFilePath();
  const executors =
    options.executorDeps !== undefined
      ? createCliCommandExecutors(options.executorDeps)
      : createSkeletonExecutorRegistry(options.readProjects ?? readRecentProjects);
  const version = options.version ?? "";
  /** 命令日志（内存环形，容量 200；不落盘、不跨重启保留——spec §6.2）。 */
  const commandLog: CliCommandLogEntry[] = [];

  const recordCommandLog = (
    request: CliCommandRequest,
    status: "success" | "error",
    durationMs: number,
    errorCode: CliErrorCode | null,
  ): void => {
    const entry: CliCommandLogEntry = {
      timestamp: new Date().toISOString(),
      command: request.command,
      paramsSummary: buildParamsSummary(request),
      status,
      durationMs,
      ...(errorCode !== null ? { errorCode } : {}),
    };
    const parsed = CliCommandLogEntrySchema.safeParse(entry);
    if (!parsed.success) {
      console.error("[cli-control] 命令日志条目未通过契约校验，跳过记录", parsed.error.message);
      return;
    }
    commandLog.push(parsed.data);
    if (commandLog.length > CLI_COMMAND_LOG_CAPACITY) {
      commandLog.splice(0, commandLog.length - CLI_COMMAND_LOG_CAPACITY);
    }
  };

  const server = http.createServer((req, res) => {
    // 客户端提前断开时静默，避免未处理的 error 事件
    res.on("error", () => {});
    void handleCommandRequest(req, res).catch((error: unknown) => {
      console.error("[cli-control] 请求处理异常", describeError(error));
      if (!res.headersSent) {
        sendJson(res, 500, { code: "internal_error", message: "控制服务内部错误。" });
      } else {
        res.destroy();
      }
    });
  });

  const handleCommandRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const routePath = (req.url ?? "").split("?")[0] ?? "";
    if (routePath !== CLI_COMMAND_PATH) {
      console.debug("[cli-control] 未登记路径", { method: req.method, path: routePath });
      sendText(res, 404, "Not Found");
      return;
    }
    if (req.method !== "POST") {
      console.debug("[cli-control] 契约外方法", { method: req.method });
      sendText(res, 405, "Method Not Allowed");
      return;
    }
    // 带 Origin 头的请求一律拒绝：CLI 客户端（非浏览器进程）不产生该头，
    // 浏览器网页不得触达本服务（spec §6.2/CLI-002）。
    if (req.headers.origin !== undefined) {
      console.debug("[cli-control] 拒绝带 Origin 头的请求（疑似浏览器来源）");
      sendJson(res, 401, { code: "auth_failed", message: "该服务不接受浏览器网页访问。" });
      return;
    }
    // 令牌鉴权（CLI-002）：缺失/不匹配一律拒绝，不执行任何命令逻辑；不记命令日志。
    const presentedToken = req.headers[CLI_TOKEN_HEADER];
    if (typeof presentedToken !== "string" || presentedToken !== token) {
      console.debug("[cli-control] 令牌缺失或不匹配，拒绝请求");
      sendJson(res, 401, { code: "auth_failed", message: "访问令牌缺失或不匹配。" });
      return;
    }

    const body = await readBody(req);
    let request: CliCommandRequest;
    try {
      const raw: unknown = JSON.parse(body);
      request = CliCommandRequestSchema.parse(raw);
    } catch (error: unknown) {
      const detail = describeError(error);
      console.debug("[cli-control] 请求体未通过契约校验", { detail: detail.slice(0, 200) });
      sendJson(res, 400, { code: "internal_error", message: `请求未通过命令契约校验：${detail.slice(0, 200)}` });
      return;
    }

    // 分派执行；不设超时（仓库纪律：内部通信不设超时时长）
    const startedAt = Date.now();
    const executor = executors.get(request.command);
    let response: unknown;
    let errorCode: CliErrorCode | null = null;
    if (executor === undefined) {
      console.debug("[cli-control] 命令路由未命中（该命令尚未接入）", { command: request.command });
      response = buildErrorResponse(request.command, "internal_error", "该命令暂未开放，请使用已支持的命令。");
      errorCode = "internal_error";
    } else {
      try {
        const result = await executor(request);
        response = result.response;
        errorCode = result.errorCode;
      } catch (error: unknown) {
        console.error("[cli-control] 命令执行异常", { command: request.command, error: describeError(error) });
        response = buildErrorResponse(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
        errorCode = "internal_error";
      }
    }

    // 出站校验（CLI-014）：校验原对象、发送原对象（不发送 parse 的返回值）
    const validated = CliCommandResponseSchema.safeParse(response);
    if (!validated.success) {
      console.error("[cli-control] 出站响应未通过契约校验", validated.error.message);
      sendJson(res, 500, buildErrorResponse(request.command, "internal_error", "控制服务响应组装异常。"));
      recordCommandLog(request, "error", Date.now() - startedAt, "internal_error");
      return;
    }
    sendJson(res, 200, response);
    recordCommandLog(request, errorCode === null ? "success" : "error", Date.now() - startedAt, errorCode);
  };

  const requestedPort = options.port ?? resolveEnvPortOverride() ?? CLI_DEFAULT_PORT;
  try {
    await listenOnPort(server, requestedPort);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code !== "EADDRINUSE") throw error;
    // 端口被占用回落 0（随机端口），无论何种端口都必须写出发现文件（spec §6.1）
    console.debug("[cli-control] 端口被占用，回落随机端口", { requestedPort });
    await listenOnPort(server, 0);
  }
  // 监听期错误只记录，避免未处理 error 事件导致进程崩溃
  server.on("error", (error: unknown) => {
    console.error("[cli-control] 服务运行期错误", describeError(error));
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("[cli-control] 监听地址异常，无法确定服务端口");
  }
  const port = address.port;

  writeDiscoveryFile(discoveryFilePath, {
    port,
    token,
    pid: process.pid,
    version,
    startedAt: new Date().toISOString(),
  });
  console.debug("[cli-control] 服务已启动", { port, discoveryFilePath });

  let stopped = false;
  return {
    port,
    discoveryFilePath,
    getCommandLog: () => [...commandLog],
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      // 发现文件删除在同步段完成：will-quit 以 fire-and-forget 调用 stop，删除不依赖异步时序
      const deleted = deleteDiscoveryFileIfExists(discoveryFilePath);
      console.debug("[cli-control] 服务停止", { port, discoveryFileDeleted: deleted });
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

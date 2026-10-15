import { randomUUID } from "node:crypto";
import {
  UNIFIED_GENERATION_RUNNING_STATUSES,
  CliCommandResponseSchema,
  CliErrorSchema,
  type CliCommandRequest,
  type CliCommandResponse,
  type CliCommandSuccessResponse,
  type CliError,
} from "@iart/contracts";
import { readDiscoveryFile, resolveDefaultDiscoveryFilePath, type CliDiscoveryFile } from "./cli-discovery.cjs";
import { CLI_USAGE_HINT, CLI_USAGE_TEXT, parseCliArgs } from "./cli-arg-parser.cjs";

/**
 * CLI 客户端（spec docs/integrations/CLI与本地Agent集成.md §4.1：薄的无状态转发层）。
 *
 * 纯模块、不 import electron：解析命令行 → 读发现文件 → 发请求 → 渲染结果。
 * 输出经返回值承载（runCliClient 返回 stdout/stderr 与退出码），由 cli-client-main
 * 负责真正写流——测试可直接断言返回值，不强制拦 stdout。
 *
 * 退出码三档（spec §5）：0 成功；1 命令级失败（响应 ok:false，含 not_running 与等待超时）；
 * 2 执行失败（响应 parse 失败、发现文件损坏、未知命令、参数解析失败等 CLI 自身层错误）。
 *
 * 等待语义（spec §5.4 task wait / generate --wait，批次三）：
 * - task.wait：客户端循环发 task.get（间隔 2 秒）至任务终态，再发一次 task.wait 取
 *   「终态 + 产物资产」的契约结果（产物资产的本地绝对路径只有 Main 侧存储投影能解析，
 *   task.get 响应形状不含产物，故终态结果经 task.wait 命令承载）。
 * - --timeout 缺省不设时限（内部通信治理：不设超时误杀长任务）；到期输出超时错误、
 *   退出码 1，运行域任务不受影响继续执行；轮询途中连接失败一律 not_running。
 * - generate --wait：受理成功即时输出受理回执（stderr，等待 flush 落定，CLI-026），拿到
 *   任务 id 列表后轮询至全部终态，逐任务取终态与产物，部分失败逐任务如实输出（CLI-009），
 *   不整体掩盖。
 *
 * 禁止项（spec §13）：生成提交不自动重试（传输层失败原样报错；CLI 自身自动生成幂等键——
 * 同键重提命中既有批次时幂等重放返回既有受理结果，不重复创建任务，spec §5.4 受理幂等键）；
 * CLI 不自动启动应用；连接失败一律按 not_running 处理，发现文件仅是线索非在役判据（CLI-004）。
 */

export interface CliClientDeps {
  /** 发现文件路径；缺省按应用数据根分流定位。 */
  discoveryFilePath?: string;
  /** HTTP 实现；缺省全局 fetch（Node/Electron main 均可用）。 */
  fetchImpl?: typeof fetch;
  /** 任务等待轮询间隔毫秒；生产 2000（spec §5.4），测试注入小值。 */
  pollIntervalMs?: number;
  /**
   * 受理回执即时写出通道（spec §5.4 / CLI-026）：generate --wait 受理成功后、轮询开始前
   * 以完整回执文本调用一次，调用方必须等待落定（flush 回调到达）再继续轮询——等待中途
   * 进程死亡时调用方至少拿到已受理的批次与任务标识，避免盲目重提造成重复任务。回执属
   * 进度信息走 stderr（stdout 是 --json 数据契约通道，只承载最终结果）；生产由
   * runCliClientMain 注入 writeCliOutput 序列，缺省不输出（保持纯函数返回值语义）。
   */
  emitWaitProgress?: (text: string) => Promise<void>;
}

export interface CliClientRunResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

const CONTROL_SERVICE_HOST = "127.0.0.1";
const CLI_COMMAND_PATH = "/cli/v1/command";
const CLI_TOKEN_HEADER = "x-iart-cli-token";
const NOT_RUNNING_MESSAGE = "IArtStudio 未在运行，请先启动应用后再使用 iart 命令。";
const DEFAULT_POLL_INTERVAL_MS = 2000;

const RUNNING_STATUS_SET: ReadonlySet<string> = new Set<string>(UNIFIED_GENERATION_RUNNING_STATUSES);

/** 人读失败原因截断上限（spec CLI-035）：首 200 字符 + 截断省略号，不整段倾倒堆栈文本。 */
const FAILURE_REASON_MAX_LENGTH = 200;

const truncateFailureReason = (text: string): string =>
  text.length > FAILURE_REASON_MAX_LENGTH
    ? `${text.slice(0, FAILURE_REASON_MAX_LENGTH)}…`
    : text;

/**
 * 任务终态失败的人读原因（spec CLI-035）：errorMessage 优先，缺省回落失败结构的人读链
 * （userMessage → message → backendMessage）。先截断到首 200 字符再拼错误码前缀。
 * 非失败任务或无原因返回空串。
 */
const readTaskFailureReason = (task: {
  status: string;
  errorMessage?: string | null | undefined;
  errorCode?: string | null | undefined;
  failure?: {
    code?: string | null | undefined;
    message?: string | null | undefined;
    userMessage?: string | null | undefined;
    backendMessage?: string | null | undefined;
  } | null | undefined;
}): string => {
  if (task.status !== "failed") return "";
  const reason =
    task.errorMessage !== undefined && task.errorMessage !== null && task.errorMessage !== ""
      ? task.errorMessage
      : task.failure?.userMessage ?? task.failure?.message ?? task.failure?.backendMessage ?? "";
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "";
  const truncated = truncateFailureReason(trimmed);
  const code = task.errorCode ?? task.failure?.code ?? null;
  return code !== null && code !== undefined && code.length > 0
    ? `，失败原因：[${code}] ${truncated}`
    : `，失败原因：${truncated}`;
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** --json 模式：一切机器可读输出（含错误）走 stdout；人读模式：结果走 stdout、错误走 stderr。 */
/** 解析/执行失败的本地错误（退出码 2）：stderr 只给错误信息 + 单行用法指引（spec CLI-041），不再全量倾倒用法提示。 */
const cliSelfErrorResult = (json: boolean, code: CliError["code"], message: string): CliClientRunResult => {
  if (json) {
    return {
      exitCode: 2,
      stdout: JSON.stringify({ ok: false, error: { code, message } }, null, 2),
      stderr: "",
    };
  }
  return { exitCode: 2, stdout: "", stderr: `${message}\n${CLI_USAGE_HINT}` };
};

/** not_running 是命令级失败（退出码 1），人读输出启动提示（CLI-004）。 */
const notRunningResult = (json: boolean): CliClientRunResult => {
  const error = { code: "not_running" as const, message: NOT_RUNNING_MESSAGE };
  if (json) {
    return { exitCode: 1, stdout: JSON.stringify({ ok: false, error }, null, 2), stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: NOT_RUNNING_MESSAGE };
};

/** 命令级失败（响应 ok:false，退出码 1）：人读输出 error.message，--json 输出完整错误对象。 */
const commandErrorResult = (json: boolean, error: CliError): CliClientRunResult => {
  if (json) {
    return { exitCode: 1, stdout: JSON.stringify({ ok: false, error }, null, 2), stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: error.message };
};

/** 等待超时（--timeout 到期，退出码 1；运行域任务不受影响继续执行，spec §5.4）。 */
const waitTimeoutResult = (json: boolean, timeoutSeconds: number): CliClientRunResult => {
  const error: CliError = {
    // 错误码 wait_timeout（spec §9；2026-10-07 场景 C 补码：--timeout 到期是可预期业务
    // 错误，与客户端本地判定进表的 not_running 同理，不再落 internal_error）。
    code: "wait_timeout",
    message: `等待任务超时（--timeout ${timeoutSeconds} 秒）：任务仍在后台继续执行，可稍后用 task get 查看结果。`,
  };
  if (json) {
    return { exitCode: 1, stdout: JSON.stringify({ ok: false, error }, null, 2), stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: error.message };
};

type SendOutcome =
  | { kind: "response"; response: CliCommandResponse }
  | { kind: "error"; error: CliError }
  | { kind: "not_running" }
  | { kind: "invalid"; httpStatus?: number };

/** 发送一条命令并经契约校验（CLI-014 客户端侧）；连接失败一律 not_running，不设超时、不自动重试。 */
const sendCommandRequest = async (
  fetchImpl: typeof fetch,
  discovery: CliDiscoveryFile,
  request: CliCommandRequest,
): Promise<SendOutcome> => {
  let httpResponse: Response;
  try {
    httpResponse = await fetchImpl(`http://${CONTROL_SERVICE_HOST}:${discovery.port}${CLI_COMMAND_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLI_TOKEN_HEADER]: discovery.token,
      },
      body: JSON.stringify(request),
    });
  } catch {
    return { kind: "not_running" };
  }

  const rawText = await httpResponse.text();
  if (httpResponse.status !== 200) {
    // 非 200：服务端契约外错误形状（{code,message}）经 CliErrorSchema 校验后按命令级失败呈现；
    // 形状仍非法则按执行失败（退出码 2）。
    const serverError = CliErrorSchema.safeParse(safeJsonParse(rawText));
    if (serverError.success) {
      return { kind: "error", error: serverError.data };
    }
    return { kind: "invalid", httpStatus: httpResponse.status };
  }

  const validated = CliCommandResponseSchema.safeParse(safeJsonParse(rawText));
  if (!validated.success) {
    return { kind: "invalid" };
  }
  return { kind: "response", response: validated.data };
};

const describeSendOutcome = (outcome: SendOutcome, json: boolean): CliClientRunResult => {
  switch (outcome.kind) {
    case "response":
      if (outcome.response.ok) {
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(outcome.response, null, 2) : renderHumanSuccess(outcome.response),
          stderr: "",
        };
      }
      return commandErrorResult(json, outcome.response.error);
    case "error":
      return commandErrorResult(json, outcome.error);
    case "not_running":
      return notRunningResult(json);
    case "invalid":
      return cliSelfErrorResult(
        json,
        "internal_error",
        outcome.httpStatus !== undefined
          ? `应用返回了无法识别的响应（HTTP ${outcome.httpStatus}），请确认应用为较新版本后重试`
          : "应用返回了无法识别的响应，请重试。",
      );
  }
};

/** 人读成功输出：每命令一个最小模板（命令名 + 关键结果字段，用户视角）。 */
const renderHumanSuccess = (response: CliCommandSuccessResponse): string => {
  switch (response.command) {
    case "project.list": {
      const lines = response.projects.map((project) => `- ${project.name} — ${project.path}`);
      return [`项目清单共 ${response.projects.length} 个：`, ...lines].join("\n");
    }
    case "project.status":
      return `项目 ${response.project.name}（${response.project.path}）：画布${response.window_open ? "已打开" : "未打开"}，${response.registered ? "已加入项目列表" : "未加入项目列表"}，进行中任务 ${response.active_task_count} 个`;
    case "project.create":
    case "project.open":
      return `项目 ${response.project.name}（${response.project.path}）已就绪`;
    case "project.close":
      return "画布窗口已关闭";
    case "project.delete":
      return "项目已从项目清单移除（磁盘文件未删除）";
    case "model.list": {
      const lines = response.models.map((model) => `- ${model.model_id}：${model.deployment.deployable ? "可执行" : "不可执行"}`);
      return [`可用模型共 ${response.models.length} 个：`, ...lines].join("\n");
    }
    case "model.get":
      return `模型 ${response.model.model_id}：${response.model.deployment.deployable ? "可执行" : "不可执行"}`;
    case "asset.list": {
      const lines = response.assets.map((asset) => {
        const fileName = asset.source_file_name !== undefined && asset.source_file_name !== null ? `，文件 ${asset.source_file_name}` : "";
        return `- ${asset.asset_id}（${asset.media_type}${fileName}）`;
      });
      return [`项目资产共 ${response.assets.length} 个：`, ...lines].join("\n");
    }
    case "asset.get": {
      const equivalents = response.equivalent_asset_ids;
      const equivalentNote = equivalents !== undefined && equivalents.length > 0 ? `；同内容其他资产标识：${equivalents.join("、")}` : "";
      const generationNote = response.generation !== undefined ? "；附生成档案（generation 字段，--json 查看）" : "";
      return `资产 ${response.asset.assetId}：本地文件 ${response.local_file_path}${equivalentNote}${generationNote}`;
    }
    case "canvas.nodes.list": {
      const lines = response.nodes.map((node) => `- ${node.node_id}（${node.node_type}）`);
      return [`画布节点共 ${response.nodes.length} 个：`, ...lines].join("\n");
    }
    case "canvas.group.create":
      return `组已创建：${response.group_node_id}`;
    case "canvas.group.dissolve":
      return `组已解散：${response.group_node_id}，${response.member_ids.length} 个成员保留在画布上`;
    case "canvas.node.move":
      return `节点 ${response.node_id} 已移动到 (${response.position.x}, ${response.position.y})`;
    case "canvas.node.delete":
      return `已删除 ${response.deleted_node_ids.length} 个节点`;
    case "canvas.layout":
      return `已整理 ${Object.keys(response.positions).length} 个节点位置`;
    case "generate": {
      if (response.task_results.length === 0) {
        const taskIds = response.tasks.map((task) => task.task_id).join("、");
        const idempotencyNote =
          response.client_request_id !== undefined ? `（幂等键 ${response.client_request_id}）` : "";
        if (response.replayed === true) {
          return `该幂等键此前已提交成功${idempotencyNote}，返回已受理批次、未重复创建：批次 ${response.batch_id}，任务 ${taskIds}`;
        }
        return `生成已受理${idempotencyNote}：批次 ${response.batch_id}，任务 ${taskIds}`;
      }
      const lines = response.task_results.map(
        (result) => `- ${result.task.taskId}：${result.task.status}，产物 ${result.assets.length} 个${readTaskFailureReason(result.task)}`,
      );
      const replayNote =
        response.replayed === true ? `（幂等键命中既有批次，未重复创建）` : "";
      return [`批次 ${response.batch_id} 已到终态${replayNote}：`, ...lines].join("\n");
    }
    case "task.list": {
      const lines = response.tasks.map((task) => `- ${task.taskId}：${task.status}${readTaskFailureReason(task)}`);
      return [`任务共 ${response.tasks.length} 个：`, ...lines].join("\n");
    }
    case "task.get": {
      const generationNote = response.generation !== undefined ? "；附生成档案（generation 字段，--json 查看）" : "";
      return `任务 ${response.task.taskId}：${response.task.status}${readTaskFailureReason(response.task)}${generationNote}`;
    }
    case "task.cancel":
      return `取消已受理：${response.task_id}`;
    case "task.wait":
      return `任务 ${response.task_result.task.taskId}：${response.task_result.task.status}，产物 ${response.task_result.assets.length} 个${readTaskFailureReason(response.task_result.task)}`;
    case "batch.get":
      return `生成档案（批次 ${response.generation.batch_id}）：模型 ${response.generation.model_id}，参考 ${response.generation.references.length} 个，任务 ${response.generation.task_ids.length} 个；提示词全文与完整内容用 --json 查看`;
    case "app.status": {
      const lines = response.opened_projects.map((project) => {
        const focusMark = project.focused ? "，持有焦点" : "";
        const selection =
          project.selection === null
            ? "画布加载中，选中态暂不可读"
            : `选中节点 ${project.selection.node_ids.length} 个、注释 ${project.selection.annotation_ids.length} 个`;
        return `- ${project.name}（${project.path}${focusMark}）：${selection}`;
      });
      return [`已打开 ${response.opened_projects.length} 个项目：`, ...lines].join("\n");
    }
  }
};

type WaitPollOutcome =
  | { ok: true }
  | { ok: false; result: CliClientRunResult };

/**
 * 轮询任务至终态（spec §5.4：客户端循环发 task.get，间隔 pollIntervalMs）。
 * 连接失败 → not_running；任务不存在等命令错误 → 原样呈现；--timeout 到期 → 超时失败
 * （运行域任务不受影响继续执行）。
 */
const pollTaskToTerminal = async (
  fetchImpl: typeof fetch,
  discovery: CliDiscoveryFile,
  json: boolean,
  project: string,
  taskId: string,
  pollIntervalMs: number,
  deadlineMs: number | null,
  timeoutSeconds: number | null,
): Promise<WaitPollOutcome> => {
  for (;;) {
    const outcome = await sendCommandRequest(fetchImpl, discovery, {
      command: "task.get",
      project,
      task_id: taskId,
    });
    if (outcome.kind === "response" && outcome.response.ok && outcome.response.command === "task.get") {
      if (!RUNNING_STATUS_SET.has(outcome.response.task.status)) {
        return { ok: true };
      }
    } else {
      return {
        ok: false,
        result: describeSendOutcome(outcome, json),
      };
    }
    if (deadlineMs !== null && Date.now() >= deadlineMs) {
      return {
        ok: false,
        result: waitTimeoutResult(json, timeoutSeconds ?? 0),
      };
    }
    await sleep(pollIntervalMs);
  }
};

/** task.wait：轮询至终态后取「终态 + 产物资产」契约结果（spec §5.4 / CLI-009）。 */
const runTaskWait = async (
  fetchImpl: typeof fetch,
  discovery: CliDiscoveryFile,
  json: boolean,
  request: Extract<CliCommandRequest, { command: "task.wait" }>,
  pollIntervalMs: number,
): Promise<CliClientRunResult> => {
  const deadlineMs = request.timeout !== undefined ? Date.now() + request.timeout * 1000 : null;
  const polled = await pollTaskToTerminal(
    fetchImpl,
    discovery,
    json,
    request.project,
    request.task_id,
    pollIntervalMs,
    deadlineMs,
    request.timeout ?? null,
  );
  if (!polled.ok) return polled.result;
  // 终态已确认：task.wait 命令读取终态与产物资产（本地绝对路径由 Main 侧存储投影解析）。
  const outcome = await sendCommandRequest(fetchImpl, discovery, {
    command: "task.wait",
    project: request.project,
    task_id: request.task_id,
  });
  return describeSendOutcome(outcome, json);
};

/**
 * generate --wait：受理成功后先即时写出受理回执并等待落定（spec §5.4 / CLI-026），再轮询
 * 全部任务至终态，逐任务取终态与产物资产，组装完整 generate 响应（部分失败逐任务如实输出，
 * CLI-009）。generate 无 --timeout 参数：默认不设时限（内部通信治理）。
 * 回执通道为 stderr：stdout 是 --json 数据契约通道只承载最终结果；--json 模式回执为与受理
 * 响应同形的 JSON 对象（消费方可按同一契约解析），人读模式为简要文本。
 */
const runGenerateWait = async (
  fetchImpl: typeof fetch,
  discovery: CliDiscoveryFile,
  json: boolean,
  request: Extract<CliCommandRequest, { command: "generate" }>,
  acceptance: Extract<CliCommandSuccessResponse, { command: "generate" }>,
  pollIntervalMs: number,
  emitWaitProgress?: (text: string) => Promise<void>,
): Promise<CliClientRunResult> => {
  if (emitWaitProgress !== undefined) {
    // 受理回执即时写出并等待 flush 完成（CLI-026）；await 到达即 writeCliOutput 回调已触发。
    const receipt = json ? `${JSON.stringify(acceptance, null, 2)}\n` : `${renderHumanSuccess(acceptance)}\n`;
    await emitWaitProgress(receipt);
  }
  const taskIds = acceptance.tasks.map((task) => task.task_id);
  const taskResults: Extract<CliCommandSuccessResponse, { command: "generate" }>["task_results"] = [];
  for (const taskId of taskIds) {
    const polled = await pollTaskToTerminal(fetchImpl, discovery, json, request.project, taskId, pollIntervalMs, null, null);
    if (!polled.ok) return polled.result;
    const outcome = await sendCommandRequest(fetchImpl, discovery, {
      command: "task.wait",
      project: request.project,
      task_id: taskId,
    });
    if (outcome.kind === "response" && outcome.response.ok && outcome.response.command === "task.wait") {
      taskResults.push(outcome.response.task_result);
    } else {
      return describeSendOutcome(outcome, json);
    }
  }
  const assembled: unknown = {
    command: "generate",
    ok: true,
    batch_id: acceptance.batch_id,
    tasks: acceptance.tasks,
    // 幂等键回显与重放标志原样随行（spec §5.4 受理幂等键 / CLI-033）：--wait 全量响应
    // 与受理回执保持同一幂等语义。
    ...(acceptance.client_request_id !== undefined ? { client_request_id: acceptance.client_request_id } : {}),
    ...(acceptance.replayed !== undefined ? { replayed: acceptance.replayed } : {}),
    task_results: taskResults,
  };
  // 组装后的完整响应同样过契约校验（CLI-014 客户端侧）；非法形状按执行失败呈现。
  const validated = CliCommandResponseSchema.safeParse(assembled);
  if (!validated.success || !validated.data.ok || validated.data.command !== "generate") {
    return cliSelfErrorResult(json, "internal_error", "没能读取生成的最终结果，请用 task get 查看任务状态。");
  }
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(validated.data, null, 2) : renderHumanSuccess(validated.data),
    stderr: "",
  };
};

export const runCliClient = async (argv: readonly string[], deps: CliClientDeps = {}): Promise<CliClientRunResult> => {
  // 1. 参数解析（含发送前契约校验：构造错误本地报，退出码 2，不发起请求）
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    if (parsed.reason === "help") {
      return { exitCode: 0, stdout: CLI_USAGE_TEXT, stderr: "" };
    }
    // --version 是客户端本地命令（spec §5.5 / CLI-042）：版本数据源是发现文件随应用启动
    // 写出的应用版本；读不到（应用未在运行等）如实输出未知 + 启动提示，命令仍成功。
    if (parsed.reason === "version") {
      const discovery = readDiscoveryFile(deps.discoveryFilePath ?? resolveDefaultDiscoveryFilePath());
      const version = discovery !== null && discovery.version.length > 0 ? discovery.version : null;
      if (version === null) {
        console.debug("[cli-client] --version 未能从发现文件读取应用版本");
      }
      if (parsed.json) {
        return { exitCode: 0, stdout: JSON.stringify({ version }, null, 2), stderr: "" };
      }
      return {
        exitCode: 0,
        stdout:
          version !== null
            ? `IARTStudio 版本：${version}`
            : "未能读取应用版本：IArtStudio 可能未在运行，请启动应用后再试。",
        stderr: "",
      };
    }
    return { exitCode: 2, stdout: "", stderr: `${parsed.message}\n${CLI_USAGE_HINT}` };
  }

  // 2. 发现文件：缺失/损坏一律按 not_running 处理（文件仅是线索，连接成功才算在役）
  const discovery = readDiscoveryFile(deps.discoveryFilePath ?? resolveDefaultDiscoveryFilePath());
  if (discovery === null) {
    return notRunningResult(parsed.json);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // 幂等键自动生成（spec §5.4 受理幂等键 / CLI-033）：generate 未显式传 --request-id 时
  // 自动生成 uuid 随请求携带，受理回执回显该键——进程崩溃后凭回执里的键即可
  // `task list --request-id` 对账（命中已有批次则安全重提同键幂等重放），不必盲目重提。
  let request = parsed.request;
  if (request.command === "generate") {
    request = { ...request, client_request_id: request.client_request_id ?? randomUUID() };
  }

  // 3. 等待型命令：客户端轮询语义（spec §5.4，批次三）
  if (request.command === "task.wait") {
    return runTaskWait(fetchImpl, discovery, parsed.json, request, pollIntervalMs);
  }

  // 4. 发送请求；连接失败（ECONNREFUSED 等）一律 not_running；不设超时、不自动重试
  const outcome = await sendCommandRequest(fetchImpl, discovery, request);
  if (
    request.command === "generate" &&
    request.wait === true &&
    outcome.kind === "response" &&
    outcome.response.ok &&
    outcome.response.command === "generate" &&
    outcome.response.task_results.length === 0
  ) {
    // generate --wait：受理成功（task_results 为空 = 未带终态），客户端继续轮询至全部终态。
    return runGenerateWait(
      fetchImpl,
      discovery,
      parsed.json,
      request,
      outcome.response,
      pollIntervalMs,
      deps.emitWaitProgress,
    );
  }
  return describeSendOutcome(outcome, parsed.json);
};

import { CliCommandRequestSchema, type CliCommandName, type CliCommandRequest } from "@iart/contracts/cli-contract";

/**
 * CLI 客户端参数解析（spec docs/integrations/CLI与本地Agent集成.md §5 命令面）。
 *
 * 纯模块、无 IO、不 import electron。职责：把 `iart <名词> <动作> [参数]` 的 argv
 * 解析为契约请求对象，**发送前经 CliCommandRequestSchema 校验**（CLI-014 客户端侧）。
 * 参数名到契约 params 字段（snake_case）的映射表显式承载在 FLAG_SPECS / 各命令构造分支中，
 * 字段事实源是 packages/contracts 的 cli-contract，此处只做映射不复制契约。
 *
 * 布尔 flag（--yes/--wait）与带值参数区分处理；未知参数报错；位置参数
 * （如 model get <model_id>、task get <taskId>）支持。
 */

/** 用法提示（--help 与参数错误时输出）。 */
export const CLI_USAGE_TEXT = `iart — 驱动 IARTStudio 的命令行入口（应用需在运行）

命令：
  iart project list|status|create|open|close|delete
  iart model list        iart model get <model_id>
  iart asset list [--query K] [--media-type image|video|audio] [--model M] [--limit N] [--offset O]
  iart asset get <assetId> --project P
  iart asset import --file <路径> [--file <路径> ...] --project P
  iart canvas nodes list --project P
  iart canvas group list --project P
  iart canvas group create --name N [--members id1,id2] --project P
  iart canvas group dissolve --group <组节点id> --project P
  iart canvas node move --node <节点id> --x N --y N --project P
  iart canvas node delete --nodes id1,id2 [--yes] --project P
  iart canvas layout --scope all|group:<id> [--columns N] [--order id1,id2] --project P
  iart generate --prompt T --model M [--count N] [--ref id1,id2] [--arg k=v,k2=v2] [--group 组名] [--request-id ID] [--wait] --project P
  iart task list --project P [--status submitting|generating|polling|downloading|succeeded|failed|cancelled] [--since ISO时间] [--request-id ID]
  iart task get <taskId> | task cancel <taskId> | task wait <taskId>
  iart batch get <batchId> --project P
  iart app status         查看应用状态：已打开项目、焦点与画布选中

通用参数：
  --project <路径或名称>   目标项目（需要项目上下文的命令必填）
  --yes                    危险操作显式确认（project delete 必需）
  --json                   输出机器可读 JSON
  --version                显示应用版本（iart --version）
  --help                   显示本用法提示

退出码：0 成功；1 命令失败（含应用未在运行）；2 用法/执行错误`;

/** 参数错误时的人读单行指引（不再全量倾倒用法提示，spec CLI-041）。 */
export const CLI_USAGE_HINT = "用法见 iart --help。";

/**
 * 解析结果三态（discriminated union，判别字段 reason 只在 ok:false 分支承载）：
 * help = --help 用法输出（退出码 0）；version = --version 客户端本地命令（退出码 0，
 * 不发起请求）；usage-error = 用法/参数错误（退出码 2，message 面向使用者定位问题）。
 */
export type CliArgParseResult =
  | { ok: true; request: CliCommandRequest; json: boolean }
  | { ok: false; reason: "help" }
  | { ok: false; reason: "version"; json: boolean }
  | { ok: false; reason: "usage-error"; message: string };

const failure = (message: string): CliArgParseResult => ({ ok: false, reason: "usage-error", message });

/** 参数解析用户可见错误（退出码 2 语义），由 parseCliArgs 统一捕获转 failure。 */
class CliArgError extends Error {}

type FlagKind = "string" | "number" | "numberAny" | "boolean" | "stringList" | "pathList" | "kvList" | "scope";

interface FlagSpec {
  /** 契约 params 字段名（snake_case）——CLI flag → 契约字段的显式映射。 */
  field: string;
  kind: FlagKind;
}

/** CLI flag → 契约 params 字段映射表（字段名以 packages/contracts cli-contract 为准）。 */
const FLAG_SPECS = new Map<string, FlagSpec>([
  ["--project", { field: "project", kind: "string" }],
  ["--name", { field: "name", kind: "string" }],
  ["--path", { field: "path", kind: "string" }],
  ["--prompt", { field: "prompt", kind: "string" }],
  ["--model", { field: "model", kind: "string" }],
  ["--query", { field: "query", kind: "string" }],
  ["--media-type", { field: "media_type", kind: "string" }],
  ["--limit", { field: "limit", kind: "number" }],
  ["--offset", { field: "offset", kind: "number" }],
  ["--count", { field: "count", kind: "number" }],
  ["--ref", { field: "ref", kind: "stringList" }],
  ["--arg", { field: "arg", kind: "kvList" }],
  ["--members", { field: "members", kind: "stringList" }],
  // --file 是文件路径列表（spec §5.3 / CLI-047）：完整路径可合法含逗号，按 pathList
  // 语义每次累积一项、不拆分（区别于 --members/--ref 的逗号拆分语义）。
  ["--file", { field: "file", kind: "pathList" }],
  ["--group", { field: "group", kind: "string" }],
  ["--node", { field: "node", kind: "string" }],
  ["--nodes", { field: "nodes", kind: "stringList" }],
  ["--order", { field: "order", kind: "stringList" }],
  ["--x", { field: "x", kind: "numberAny" }],
  ["--y", { field: "y", kind: "numberAny" }],
  ["--scope", { field: "scope", kind: "scope" }],
  ["--columns", { field: "columns", kind: "number" }],
  ["--yes", { field: "yes", kind: "boolean" }],
  ["--wait", { field: "wait", kind: "boolean" }],
  ["--timeout", { field: "timeout", kind: "number" }],
  ["--request-id", { field: "client_request_id", kind: "string" }],
  ["--status", { field: "status", kind: "string" }],
  ["--since", { field: "since", kind: "string" }],
]);

interface CommandSpec {
  command: CliCommandName;
  /** 位置参数到契约字段名的映射（如 model get <model_id>）。 */
  positionals: readonly string[];
}

/** 命令短语 → 契约命令名映射（先匹配三词短语，再两词，再单词）。 */
const COMMAND_SPECS = new Map<string, CommandSpec>([
  ["project list", { command: "project.list", positionals: [] }],
  ["project status", { command: "project.status", positionals: [] }],
  ["project create", { command: "project.create", positionals: [] }],
  ["project open", { command: "project.open", positionals: [] }],
  ["project close", { command: "project.close", positionals: [] }],
  ["project delete", { command: "project.delete", positionals: [] }],
  ["model list", { command: "model.list", positionals: [] }],
  ["model get", { command: "model.get", positionals: ["model_id"] }],
  ["asset list", { command: "asset.list", positionals: [] }],
  ["asset get", { command: "asset.get", positionals: ["asset_id"] }],
  ["asset import", { command: "asset.import", positionals: [] }],
  ["canvas nodes list", { command: "canvas.nodes.list", positionals: [] }],
  ["canvas group list", { command: "canvas.group.list", positionals: [] }],
  ["canvas group create", { command: "canvas.group.create", positionals: [] }],
  ["canvas group dissolve", { command: "canvas.group.dissolve", positionals: [] }],
  ["canvas node move", { command: "canvas.node.move", positionals: [] }],
  ["canvas node delete", { command: "canvas.node.delete", positionals: [] }],
  ["canvas layout", { command: "canvas.layout", positionals: [] }],
  ["generate", { command: "generate", positionals: [] }],
  ["task list", { command: "task.list", positionals: [] }],
  ["task get", { command: "task.get", positionals: ["task_id"] }],
  ["task cancel", { command: "task.cancel", positionals: ["task_id"] }],
  ["task wait", { command: "task.wait", positionals: ["task_id"] }],
  ["batch get", { command: "batch.get", positionals: ["batch_id"] }],
  ["app status", { command: "app.status", positionals: [] }],
]);

const splitList = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const parsePositiveInt = (flagName: string, raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new CliArgError(`${flagName} 需要正整数，收到：${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliArgError(`${flagName} 需要正整数，收到：${raw}`);
  }
  return parsed;
};

/** 非负整数（0 合法）——分页偏移等从 0 起的参数。 */
const parseNonNegativeInt = (flagName: string, raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new CliArgError(`${flagName} 需要非负整数，收到：${raw}`);
  }
  return Number.parseInt(raw, 10);
};

/** 任意有限数值（可负、可小数）——画布坐标等不受正整数约束的参数（spec CLI-028）。 */
const parseCoordinate = (flagName: string, raw: string): number => {
  if (raw.trim().length === 0 || !Number.isFinite(Number(raw))) {
    throw new CliArgError(`${flagName} 需要有限数值，收到：${raw}`);
  }
  return Number(raw);
};

/** `--scope all|group:<id>`：all 原样；group:<id> 映射为契约的 { group } 对象形态。 */
const parseScope = (raw: string): "all" | { group: string } => {
  if (raw === "all") return "all";
  const match = /^group:(.+)$/.exec(raw);
  const groupId = match?.[1];
  if (groupId !== undefined && groupId.length > 0) return { group: groupId };
  throw new CliArgError(`--scope 仅支持 all 或 group:<组标识>，收到：${raw}`);
};

const parseKvList = (raw: string): { key: string; value: string }[] =>
  splitList(raw).map((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliArgError(`--arg 需要 k=v 形式，收到：${pair}`);
    }
    return { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
  });

/** 解析主体：命令短语定位 + flag 收集 + 按命令构造请求草稿 + 契约校验；用户可见错误以 CliArgError 抛出。 */
const parseCliArgsInner = (argv: readonly string[]): CliArgParseResult => {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { ok: false, reason: "help" };
  }
  // --version 是客户端本地命令（spec §5.5 / CLI-042）：不发起请求，版本数据源是发现文件。
  if (argv[0] === "--version" || argv[0] === "-v") {
    return { ok: false, reason: "version", json: argv.includes("--json") };
  }

  const resolveCommandSpec = (): { spec: CommandSpec; rest: readonly string[] } | null => {
    const three = argv.slice(0, 3).join(" ");
    const threeSpec = COMMAND_SPECS.get(three);
    if (threeSpec) return { spec: threeSpec, rest: argv.slice(3) };
    const two = argv.slice(0, 2).join(" ");
    const twoSpec = COMMAND_SPECS.get(two);
    if (twoSpec) return { spec: twoSpec, rest: argv.slice(2) };
    const one = argv[0] ?? "";
    const oneSpec = COMMAND_SPECS.get(one);
    if (oneSpec) return { spec: oneSpec, rest: argv.slice(1) };
    return null;
  };

  const resolved = resolveCommandSpec();
  if (!resolved) {
    return failure(`无法识别的命令：${argv.slice(0, 3).join(" ")}`);
  }
  const { spec, rest } = resolved;

  // -- flag 收集：标量最后写入即生效但重复报错；列表 flag 可重复出现并按逗号拆分累积
  const scalarValues = new Map<string, string>();
  const listValues = new Map<string, string[]>();
  const booleanFlags = new Set<string>();
  const positionalValues: string[] = [];
  let json = false;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) break;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { ok: false, reason: "help" };
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const flagName = eq >= 0 ? token.slice(0, eq) : token;
      const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
      const flagSpec = FLAG_SPECS.get(flagName);
      if (flagSpec === undefined) {
        return failure(`未知参数：${flagName}`);
      }
      if (flagSpec.kind === "boolean") {
        if (inlineValue !== undefined) {
          return failure(`${flagName} 是开关参数，不接受值`);
        }
        if (booleanFlags.has(flagSpec.field)) {
          return failure(`参数 ${flagName} 重复`);
        }
        booleanFlags.add(flagSpec.field);
        continue;
      }
      let value = inlineValue;
      if (value === undefined) {
        const next = rest[index + 1];
        if (next === undefined || next.startsWith("--")) {
          return failure(`${flagName} 缺少值`);
        }
        value = next;
        index += 1;
      }
      if (flagSpec.kind === "string" || flagSpec.kind === "number" || flagSpec.kind === "numberAny" || flagSpec.kind === "scope") {
        if (scalarValues.has(flagSpec.field)) {
          return failure(`参数 ${flagName} 重复`);
        }
        scalarValues.set(flagSpec.field, value);
        continue;
      }
      // 列表 flag：重复出现累积；stringList 按逗号拆分，pathList/kvList 保留原值
      const accumulated = listValues.get(flagSpec.field) ?? [];
      if (flagSpec.kind === "stringList") {
        accumulated.push(...splitList(value));
      } else {
        // pathList：整项原样累积（路径可含逗号）；kvList：k=v 对整项原样累积
        accumulated.push(value);
      }
      listValues.set(flagSpec.field, accumulated);
      continue;
    }
    positionalValues.push(token);
  }

  const requireScalar = (field: string, flagName: string): string => {
    const value = scalarValues.get(field);
    if (value === undefined) {
      throw new CliArgError(`缺少必填参数 ${flagName}`);
    }
    return value;
  };
  const optionalNumber = (field: string, flagName: string): number | undefined => {
    const raw = scalarValues.get(field);
    return raw === undefined ? undefined : parsePositiveInt(flagName, raw);
  };
  const optionalStringList = (field: string): string[] | undefined => {
    const raw = listValues.get(field);
    return raw === undefined ? undefined : raw.flatMap((item) => splitList(item));
  };
  const requireStringList = (field: string, flagName: string): string[] => {
    const items = optionalStringList(field);
    if (items === undefined || items.length === 0) {
      throw new CliArgError(`缺少必填参数 ${flagName}（至少一项）`);
    }
    return items;
  };
  /** 未拆分列表取值（pathList 语义：完整路径可含逗号，不做任何拆分）。 */
  const requireRawStringList = (field: string, flagName: string): string[] => {
    const items = listValues.get(field);
    if (items === undefined || items.length === 0) {
      throw new CliArgError(`缺少必填参数 ${flagName}（至少一项）`);
    }
    return items;
  };
  const requirePositional = (position: number, fieldName: string): string => {
    const value = positionalValues[position];
    if (value === undefined) {
      throw new CliArgError(`缺少位置参数 ${fieldName}`);
    }
    return value;
  };

  if (positionalValues.length > spec.positionals.length) {
    return failure(`多余的位置参数：${positionalValues.slice(spec.positionals.length).join(" ")}`);
  }

  let draft: unknown;
  switch (spec.command) {
    case "project.list":
      draft = { command: "project.list" };
      break;
    case "project.status":
    case "project.open":
    case "project.close":
      draft = { command: spec.command, project: requireScalar("project", "--project") };
      break;
    case "project.create":
      draft = {
        command: "project.create",
        name: requireScalar("name", "--name"),
        path: requireScalar("path", "--path"),
      };
      break;
    case "project.delete":
      if (!booleanFlags.has("yes")) {
        throw new CliArgError("project delete 需要 --yes 显式确认");
      }
      draft = { command: "project.delete", project: requireScalar("project", "--project"), yes: true };
      break;
    case "model.list":
      draft = { command: "model.list" };
      break;
    case "model.get":
      draft = { command: "model.get", model_id: requirePositional(0, "model_id") };
      break;
    case "asset.list": {
      const query = scalarValues.get("query");
      const mediaTypeRaw = scalarValues.get("media_type");
      const model = scalarValues.get("model");
      const limit = optionalNumber("limit", "--limit");
      const offsetRaw = scalarValues.get("offset");
      if (mediaTypeRaw !== undefined && mediaTypeRaw !== "image" && mediaTypeRaw !== "video" && mediaTypeRaw !== "audio") {
        throw new CliArgError(`--media-type 需要 image|video|audio 之一，收到：${mediaTypeRaw}`);
      }
      draft = {
        command: "asset.list",
        project: requireScalar("project", "--project"),
        ...(query !== undefined ? { query } : {}),
        ...(mediaTypeRaw !== undefined ? { media_type: mediaTypeRaw } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offsetRaw !== undefined ? { offset: parseNonNegativeInt("--offset", offsetRaw) } : {}),
      };
      break;
    }
    case "asset.get":
      draft = {
        command: "asset.get",
        project: requireScalar("project", "--project"),
        asset_id: requirePositional(0, "asset_id"),
      };
      break;
    case "asset.import":
      // 本地媒体文件导入（spec §5.3 / CLI-047）：--file 每次一个完整路径、可重复累积，
      // 不按逗号拆分；文件存在性与媒体类型校验由画布窗口侧前置完成（主进程不预检）。
      draft = {
        command: "asset.import",
        project: requireScalar("project", "--project"),
        file: requireRawStringList("file", "--file"),
      };
      break;
    case "canvas.nodes.list":
      draft = { command: "canvas.nodes.list", project: requireScalar("project", "--project") };
      break;
    case "canvas.group.list":
      draft = { command: "canvas.group.list", project: requireScalar("project", "--project") };
      break;
    case "canvas.group.create":
      // --members 可选（spec §5.3 / CLI-044 空组建组）：缺省视为空成员清单。
      draft = {
        command: "canvas.group.create",
        project: requireScalar("project", "--project"),
        name: requireScalar("name", "--name"),
        members: optionalStringList("members") ?? [],
      };
      break;
    case "canvas.group.dissolve":
      draft = {
        command: "canvas.group.dissolve",
        project: requireScalar("project", "--project"),
        group: requireScalar("group", "--group"),
      };
      break;
    case "canvas.node.move": {
      const xRaw = requireScalar("x", "--x");
      const yRaw = requireScalar("y", "--y");
      draft = {
        command: "canvas.node.move",
        project: requireScalar("project", "--project"),
        node: requireScalar("node", "--node"),
        x: parseCoordinate("--x", xRaw),
        y: parseCoordinate("--y", yRaw),
      };
      break;
    }
    case "canvas.node.delete": {
      const yes = booleanFlags.has("yes");
      draft = {
        command: "canvas.node.delete",
        project: requireScalar("project", "--project"),
        nodes: requireStringList("nodes", "--nodes"),
        ...(yes ? { yes: true } : {}),
      };
      break;
    }
    case "canvas.layout": {
      const scopeRaw = requireScalar("scope", "--scope");
      const columns = optionalNumber("columns", "--columns");
      const order = optionalStringList("order");
      draft = {
        command: "canvas.layout",
        project: requireScalar("project", "--project"),
        scope: parseScope(scopeRaw),
        ...(columns !== undefined ? { columns } : {}),
        ...(order !== undefined ? { order } : {}),
      };
      break;
    }
    case "generate": {
      const count = optionalNumber("count", "--count");
      const ref = optionalStringList("ref");
      const argRaw = listValues.get("arg");
      const arg = argRaw === undefined ? undefined : argRaw.flatMap((item) => parseKvList(item));
      const clientRequestId = scalarValues.get("client_request_id");
      const group = scalarValues.get("group");
      draft = {
        command: "generate",
        project: requireScalar("project", "--project"),
        prompt: requireScalar("prompt", "--prompt"),
        model: requireScalar("model", "--model"),
        ...(count !== undefined ? { count } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(arg !== undefined ? { arg } : {}),
        ...(booleanFlags.has("wait") ? { wait: true } : {}),
        ...(clientRequestId !== undefined ? { client_request_id: clientRequestId } : {}),
        ...(group !== undefined ? { group } : {}),
      };
      break;
    }
    case "task.list": {
      const status = scalarValues.get("status");
      const since = scalarValues.get("since");
      const clientRequestId = scalarValues.get("client_request_id");
      draft = {
        command: "task.list",
        project: requireScalar("project", "--project"),
        ...(status !== undefined ? { status } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(clientRequestId !== undefined ? { client_request_id: clientRequestId } : {}),
      };
      break;
    }
    case "task.get":
      draft = {
        command: "task.get",
        project: requireScalar("project", "--project"),
        task_id: requirePositional(0, "task_id"),
      };
      break;
    case "task.cancel":
      draft = {
        command: "task.cancel",
        project: requireScalar("project", "--project"),
        task_id: requirePositional(0, "task_id"),
      };
      break;
    case "task.wait": {
      const timeout = optionalNumber("timeout", "--timeout");
      draft = {
        command: "task.wait",
        project: requireScalar("project", "--project"),
        task_id: requirePositional(0, "task_id"),
        ...(timeout !== undefined ? { timeout } : {}),
      };
      break;
    }
    case "batch.get":
      draft = {
        command: "batch.get",
        project: requireScalar("project", "--project"),
        batch_id: requirePositional(0, "batch_id"),
      };
      break;
    case "app.status":
      // 应用状态感知（spec §5.5）：无参数、全局只读。
      draft = { command: "app.status" };
      break;
  }

  // 发送前按契约校验请求（CLI-014 客户端侧）：构造错误本地报，不发起请求
  const parsed = CliCommandRequestSchema.safeParse(draft);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CliArgError(`参数组合不符合命令要求：${detail}`);
  }
  return { ok: true, request: parsed.data, json };
};

/**
 * CLI 参数解析唯一入口：缺失命令、无法识别的命令、未知参数、缺值、
 * 重复标量参数、多余位置参数与契约校验失败统一转为 failure（退出码 2 语义）。
 */
export const parseCliArgs = (argv: readonly string[]): CliArgParseResult => {
  if (argv.length === 0) {
    return failure("缺少命令。");
  }
  try {
    return parseCliArgsInner(argv);
  } catch (error: unknown) {
    if (error instanceof CliArgError) {
      return failure(error.message);
    }
    throw error;
  }
};

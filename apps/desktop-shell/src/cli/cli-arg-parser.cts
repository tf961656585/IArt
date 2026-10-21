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

/**
 * 帮助主题（--help 的解析结果身份）：
 * - top：`iart --help` 顶层命令总表；
 * - noun：`iart <名词> --help` 该名词下的子命令摘要（如 model / canvas）；
 * - command：`iart <命令短语> --help` 该命令自己的参数说明（如 task list）。
 */
export type CliHelpTopic =
  | { kind: "top" }
  | { kind: "noun"; noun: string }
  | { kind: "command"; phrase: string };

/** 参数错误时的人读单行指引（不再全量倾倒用法提示，spec CLI-041）。 */
export const CLI_USAGE_HINT = "用法见 iart --help。";

/**
 * 解析结果三态（discriminated union，判别字段 reason 只在 ok:false 分支承载）：
 * help = --help 帮助输出（退出码 0，topic 指明输出哪一层帮助）；version = --version
 * 客户端本地命令（退出码 0，不发起请求）；usage-error = 用法/参数错误（退出码 2，
 * message 面向使用者定位问题）。
 */
export type CliArgParseResult =
  | { ok: true; request: CliCommandRequest; json: boolean }
  | { ok: false; reason: "help"; topic: CliHelpTopic }
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
  /** 命令级帮助中的用法形态（布尔开关只显示 flag 名）。 */
  usage: string;
  /** 命令级帮助中的一句话说明（含默认值与合法值）。 */
  help: string;
}

/** CLI flag → 契约 params 字段映射与帮助说明（字段名以 packages/contracts cli-contract 为准）。 */
const FLAG_SPECS = new Map<string, FlagSpec>([
  ["--project", { field: "project", kind: "string", usage: "--project <路径或名称>", help: "目标项目（路径或项目名）" }],
  ["--name", { field: "name", kind: "string", usage: "--name <名称>", help: "名称：project create 为项目名，canvas group create 为组名" }],
  ["--path", { field: "path", kind: "string", usage: "--path <目录>", help: "项目所在父目录（不推断默认位置）" }],
  ["--prompt", { field: "prompt", kind: "string", usage: "--prompt <文本>", help: "生成提示词" }],
  ["--model", { field: "model", kind: "string", usage: "--model <模型id>", help: "模型标识（generate 必填；asset list 按生成模型过滤）" }],
  ["--query", { field: "query", kind: "string", usage: "--query <关键词>", help: "按原始文件名或提交提示词做大小写不敏感子串筛选" }],
  ["--media-type", { field: "media_type", kind: "string", usage: "--media-type <image|video|audio>", help: "按媒体类型过滤" }],
  ["--limit", { field: "limit", kind: "number", usage: "--limit <N>", help: "最多返回条数（正整数）" }],
  ["--offset", { field: "offset", kind: "number", usage: "--offset <N>", help: "跳过前 N 条（非负整数，缺省 0）" }],
  ["--count", { field: "count", kind: "number", usage: "--count <N>", help: "生成任务数（正整数）" }],
  ["--ref", { field: "ref", kind: "stringList", usage: "--ref <id>[:<用途>]", help: "引用资产标识（逗号分隔，须为项目内已存在资产）；用途取自 iart model get 的 media_slots[].slotId，省略则按模型能力自动归入" }],
  ["--arg", { field: "arg", kind: "kvList", usage: "--arg <k=v,k2=v2>", help: "模型参数键值对（逗号分隔，受该模型参数 schema 约束）" }],
  ["--members", { field: "members", kind: "stringList", usage: "--members <id1,id2>", help: "组成员节点标识（逗号分隔；group create 省略时创建空组，group add/remove 必填）" }],
  // --file 是文件路径列表（spec §5.3 / CLI-047）：完整路径可合法含逗号，按 pathList
  // 语义每次累积一项、不拆分（区别于 --members/--ref 的逗号拆分语义）。
  ["--file", { field: "file", kind: "pathList", usage: "--file <路径>", help: "要导入的本地媒体文件（可重复；每次一个完整路径，不按逗号拆分）" }],
  ["--group", { field: "group", kind: "string", usage: "--group <组名或组id>", help: "generate 为出生组组名；canvas group dissolve 为目标容器标识；canvas group add/remove 为目标组标识" }],
  ["--node", { field: "node", kind: "string", usage: "--node <节点id>", help: "目标节点标识" }],
  ["--nodes", { field: "nodes", kind: "stringList", usage: "--nodes <id1,id2>", help: "待删除节点标识（逗号分隔，至少一项）" }],
  ["--order", { field: "order", kind: "stringList", usage: "--order <id1,id2>", help: "显式摆放顺序（数组序即最高优先摆放序）" }],
  ["--x", { field: "x", kind: "numberAny", usage: "--x <数值>", help: "目标画布 X 坐标（可负、可小数）" }],
  ["--y", { field: "y", kind: "numberAny", usage: "--y <数值>", help: "目标画布 Y 坐标（可负、可小数）" }],
  ["--scope", { field: "scope", kind: "scope", usage: "--scope <all|containers|group:<id>>", help: "整理范围：all 全画布、containers 仅容器、group:<id> 指定组" }],
  ["--columns", { field: "columns", kind: "number", usage: "--columns <N>", help: "整理列数（正整数，缺省 1）" }],
  ["--yes", { field: "yes", kind: "boolean", usage: "--yes", help: "危险操作显式确认（project delete 必需；canvas node delete 命中 Agent 节点时必需）" }],
  ["--wait", { field: "wait", kind: "boolean", usage: "--wait", help: "受理后继续轮询直至全部任务终态" }],
  ["--timeout", { field: "timeout", kind: "number", usage: "--timeout <秒>", help: "等待超时秒数（缺省不设时限，到期后任务继续在后台执行）" }],
  ["--request-id", { field: "client_request_id", kind: "string", usage: "--request-id <ID>", help: "受理幂等键（generate 未传时自动生成；task list 按该键反查）" }],
  ["--status", { field: "status", kind: "string", usage: "--status <状态>", help: "按任务状态过滤：submitting|generating|polling|downloading|succeeded|failed|cancelled" }],
  ["--since", { field: "since", kind: "string", usage: "--since <ISO时间>", help: "仅列出创建时间不早于该时刻的任务" }],
]);

/** 命令接受的参数（name 必须是 FLAG_SPECS 的键；required 只影响帮助标注，解析必填仍由草稿分支裁定）。 */
interface CommandFlagSpec {
  name: string;
  required?: boolean;
}

interface CommandSpec {
  /** 命令短语（`iart ` 之后的部分）。 */
  phrase: string;
  command: CliCommandName;
  /** 位置参数的展示标签；数量即该命令允许的位置参数个数。 */
  positionals: readonly string[];
  /** 该命令接受的参数白名单（不含 --json/--help 通用项）——不属于白名单的 flag 按用法错误拒绝。 */
  flags: readonly CommandFlagSpec[];
  /** 一句话摘要（名词级帮助展示）。 */
  summary: string;
  /** 完整用法串（含默认值与合法值），顶层表与命令级帮助共同消费。 */
  syntax: string;
  /** 命令级帮助的补充说明。 */
  notes?: readonly string[];
}

const REQUIRED_PROJECT: CommandFlagSpec = { name: "--project", required: true };

/**
 * 命令面唯一事实源：短语 → 契约命令名、位置参数、参数白名单、摘要与用法串。
 * 顶层用法表、名词级帮助与命令级帮助全部由本表渲染，禁止另写命令/参数清单。
 */
const COMMAND_SPEC_LIST: readonly CommandSpec[] = [
  {
    phrase: "project list",
    command: "project.list",
    positionals: [],
    flags: [],
    summary: "列出项目注册表中的项目（名称、路径、最近打开时间）。",
    syntax: "iart project list",
  },
  {
    phrase: "project status",
    command: "project.status",
    positionals: [],
    flags: [REQUIRED_PROJECT],
    summary: "查看项目解析结果、在册状态、画布窗口状态与在途任务数。",
    syntax: "iart project status --project P",
  },
  {
    phrase: "project create",
    command: "project.create",
    positionals: [],
    flags: [
      { name: "--name", required: true },
      { name: "--path", required: true },
    ],
    summary: "在指定目录下创建项目（名称与目录均必填）。",
    syntax: "iart project create --name N --path D",
  },
  {
    phrase: "project open",
    command: "project.open",
    positionals: [],
    flags: [REQUIRED_PROJECT],
    summary: "打开项目并聚焦其画布窗口；已打开时幂等聚焦。",
    syntax: "iart project open --project P",
  },
  {
    phrase: "project close",
    command: "project.close",
    positionals: [],
    flags: [REQUIRED_PROJECT],
    summary: "关闭承载该项目的画布窗口；项目未打开时幂等成功。",
    syntax: "iart project close --project P",
  },
  {
    phrase: "project delete",
    command: "project.delete",
    positionals: [],
    flags: [REQUIRED_PROJECT, { name: "--yes", required: true }],
    summary: "把项目从项目注册表移除（不删除磁盘文件）。",
    syntax: "iart project delete --project P --yes",
    notes: ["只从项目注册表移除，磁盘上的项目文件不会被删除。"],
  },
  {
    phrase: "model list",
    command: "model.list",
    positionals: [],
    flags: [],
    summary: "列出可执行模型目录（模型标识、能力角色、可执行状态）。",
    syntax: "iart model list",
  },
  {
    phrase: "model get",
    command: "model.get",
    positionals: ["<model_id>"],
    flags: [],
    summary: "输出单个模型的完整信息，含参数 schema。",
    syntax: "iart model get <model_id>",
  },
  {
    phrase: "asset list",
    command: "asset.list",
    positionals: [],
    flags: [
      REQUIRED_PROJECT,
      { name: "--query" },
      { name: "--media-type" },
      { name: "--model" },
      { name: "--limit" },
      { name: "--offset" },
    ],
    summary: "列出项目资产（标识、媒体类型、生成来源摘要），支持筛选与分页。",
    syntax:
      "iart asset list --project P [--query K] [--media-type image|video|audio] [--model M] [--limit N] [--offset O]",
    notes: ["不带筛选与分页参数时输出全量；列表类命令中只有 asset list 支持分页。"],
  },
  {
    phrase: "asset get",
    command: "asset.get",
    positionals: ["<assetId>"],
    flags: [REQUIRED_PROJECT],
    summary: "输出单个资产详情（含本地文件绝对路径与同内容等价 id）。",
    syntax: "iart asset get <assetId> --project P",
  },
  {
    phrase: "asset import",
    command: "asset.import",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--file", required: true }],
    summary: "导入本地媒体文件并在画布创建素材节点（--file 可重复）。",
    syntax: "iart asset import --file <路径> [--file <路径> ...] --project P",
  },
  {
    phrase: "canvas nodes list",
    command: "canvas.nodes.list",
    positionals: [],
    flags: [REQUIRED_PROJECT],
    summary: "列出画布节点（标识、类型、位置、组归属与引用）。",
    syntax: "iart canvas nodes list --project P",
  },
  {
    phrase: "canvas group list",
    command: "canvas.group.list",
    positionals: [],
    flags: [REQUIRED_PROJECT],
    summary: "列出画布组与 Agent 容器（标识、名称、类型、成员数）。",
    syntax: "iart canvas group list --project P",
  },
  {
    phrase: "canvas group create",
    command: "canvas.group.create",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--name", required: true }, { name: "--members" }],
    summary: "创建组并加入成员；省略 --members 时创建空组。",
    syntax: "iart canvas group create --name N [--members id1,id2] --project P",
  },
  {
    phrase: "canvas group dissolve",
    command: "canvas.group.dissolve",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--group", required: true }],
    summary: "解散组或 Agent 容器；成员保留在画布上。",
    syntax: "iart canvas group dissolve --group <容器id> --project P",
  },
  {
    phrase: "canvas group add",
    command: "canvas.group.add",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--group", required: true },
      { name: "--members", required: true },
    ],
    summary: "把成员加入目标组；已在组内无操作，属于其他组时迁移过来。",
    syntax: "iart canvas group add --group <组id> --members id1,id2 --project P",
    notes: ["目标必须是节点组；Agent 容器的成员由会话管理，不接受加入/移出。"],
  },
  {
    phrase: "canvas group remove",
    command: "canvas.group.remove",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--group", required: true },
      { name: "--members", required: true },
    ],
    summary: "把成员移出目标组；成员保留在画布原位。",
    syntax: "iart canvas group remove --group <组id> --members id1,id2 --project P",
    notes: ["成员必须当前属于该组；任一成员不属于时整批拒绝。"],
  },
  {
    phrase: "canvas node move",
    command: "canvas.node.move",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--node", required: true },
      { name: "--x", required: true },
      { name: "--y", required: true },
    ],
    summary: "把单个节点移动到目标画布坐标。",
    syntax: "iart canvas node move --node <节点id> --x N --y N --project P",
  },
  {
    phrase: "canvas node delete",
    command: "canvas.node.delete",
    positionals: [],
    flags: [{ name: "--project", required: true }, { name: "--nodes", required: true }, { name: "--yes" }],
    summary: "删除一个或多个节点；直接命中 Agent 节点时需要 --yes 确认。",
    syntax: "iart canvas node delete --nodes id1,id2 [--yes] --project P",
  },
  {
    phrase: "canvas layout",
    command: "canvas.layout",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--scope", required: true },
      { name: "--columns" },
      { name: "--order" },
    ],
    summary: "整理画布、组或容器布局（--columns 缺省 1；--order 指定摆放顺序）。",
    syntax: "iart canvas layout --scope all|containers|group:<id> [--columns N] [--order id1,id2] --project P",
    notes: ["containers 作用域只消除容器之间的占位相交，不接受 --columns 与 --order。"],
  },
  {
    phrase: "generate",
    command: "generate",
    positionals: [],
    flags: [
      { name: "--project", required: true },
      { name: "--prompt", required: true },
      { name: "--model", required: true },
      { name: "--count" },
      { name: "--ref" },
      { name: "--arg" },
      { name: "--group" },
      { name: "--request-id" },
      { name: "--wait" },
    ],
    summary: "提交一次生成；--wait 时轮询至全部任务终态。",
    syntax:
      "iart generate --prompt T --model M [--count N] [--ref id[:用途],id2] [--arg k=v,k2=v2] [--group 组名] [--request-id ID] [--wait] --project P",
    notes: ["未传 --request-id 时客户端自动生成幂等键并在受理回执中回显。"],
  },
  {
    phrase: "task list",
    command: "task.list",
    positionals: [],
    flags: [REQUIRED_PROJECT, { name: "--status" }, { name: "--since" }, { name: "--request-id" }],
    summary: "列出运行域任务，可按状态、创建时间与受理幂等键过滤。",
    syntax:
      "iart task list --project P [--status submitting|generating|polling|downloading|succeeded|failed|cancelled] [--since ISO时间] [--request-id ID]",
  },
  {
    phrase: "task get",
    command: "task.get",
    positionals: ["<taskId>"],
    flags: [REQUIRED_PROJECT],
    summary: "输出单个任务的当前状态（含生成档案与画布投影身份）。",
    syntax: "iart task get <taskId> --project P",
  },
  {
    phrase: "task cancel",
    command: "task.cancel",
    positionals: ["<taskId>"],
    flags: [REQUIRED_PROJECT],
    summary: "取消任务。",
    syntax: "iart task cancel <taskId> --project P",
  },
  {
    phrase: "task wait",
    command: "task.wait",
    positionals: ["<taskId>"],
    flags: [REQUIRED_PROJECT, { name: "--timeout" }],
    summary: "等待任务至终态并输出结果；--timeout 缺省不设时限。",
    syntax: "iart task wait <taskId> [--timeout S] --project P",
    notes: ["缺省不设时限；--timeout 到期后任务仍在后台继续执行，可稍后用 task get 查看结果。"],
  },
  {
    phrase: "batch get",
    command: "batch.get",
    positionals: ["<batchId>"],
    flags: [REQUIRED_PROJECT],
    summary: "读取批次受理时冻结的生成档案（含提示词全文）。",
    syntax: "iart batch get <batchId> --project P",
  },
  {
    phrase: "app status",
    command: "app.status",
    positionals: [],
    flags: [],
    summary: "查看应用当前打开的项目、焦点与画布选中态。",
    syntax: "iart app status",
  },
];

const COMMAND_SPECS = new Map<string, CommandSpec>(COMMAND_SPEC_LIST.map((spec) => [spec.phrase, spec]));

/** 名词 → 一句话说明（仅用于名词级帮助标题，不构成命令事实源）。 */
const NOUN_SUMMARIES = new Map<string, string>([
  ["project", "项目生命周期"],
  ["model", "可用模型查询"],
  ["asset", "资产查询与导入"],
  ["canvas", "画布操作（节点、组与布局）"],
  ["task", "任务查询、等待与取消"],
  ["batch", "生成档案查询"],
  ["app", "应用状态感知"],
]);

const nounOf = (phrase: string): string => phrase.split(" ")[0] ?? phrase;

const renderFlagHelpLine = (flag: CommandFlagSpec): string => {
  const spec = FLAG_SPECS.get(flag.name);
  if (spec === undefined) return `  ${flag.name}`;
  const requiredNote = flag.required === true ? "（必填）" : "";
  return `  ${spec.usage}  ${spec.help}${requiredNote}`;
};

const renderCommandHelpText = (spec: CommandSpec): string => {
  const lines = [
    `iart ${spec.phrase} — ${spec.summary}`,
    "",
    "用法：",
    `  ${spec.syntax}`,
    "",
    "参数：",
    ...spec.flags.map(renderFlagHelpLine),
    "  --json  输出机器可读 JSON",
    "  --help  显示本命令帮助",
  ];
  if (spec.notes !== undefined && spec.notes.length > 0) {
    lines.push("", "说明：", ...spec.notes.map((note) => `  - ${note}`));
  }
  lines.push("", "顶层命令列表见 iart --help。");
  return lines.join("\n");
};

const renderNounHelpText = (noun: string): string => {
  const specs = COMMAND_SPEC_LIST.filter((spec) => nounOf(spec.phrase) === noun);
  if (specs.length === 0) return CLI_USAGE_TEXT;
  const lines = [
    `iart ${noun} — ${NOUN_SUMMARIES.get(noun) ?? "命令组"}`,
    "",
    "子命令：",
    ...specs.map((spec) => `  ${spec.syntax}\n      ${spec.summary}`),
    "",
    "查看单个命令的参数说明：iart <命令短语> --help",
  ];
  return lines.join("\n");
};

const buildTopLevelUsageText = (): string => {
  const lines = [
    "iart — 驱动 IARTStudio 的命令行入口（应用需在运行）",
    "",
    "命令：",
    ...COMMAND_SPEC_LIST.map((spec) => `  ${spec.syntax}`),
    "",
    "帮助：",
    "  iart <名词> --help        列出该名词下的子命令（如 iart model --help、iart canvas --help）",
    "  iart <命令短语> --help    查看该命令自己的参数说明（如 iart task list --help）",
    "",
    "通用参数：",
    "  --json                   输出机器可读 JSON",
    "  --version                显示应用版本（iart --version）",
    "  --help                   显示本用法提示",
    "",
    "退出码：0 成功；1 命令失败（含应用未在运行）；2 用法/执行错误",
  ];
  return lines.join("\n");
};

/** 顶层用法总表（`iart --help`），由 COMMAND_SPEC_LIST 渲染。 */
export const CLI_USAGE_TEXT = buildTopLevelUsageText();

/** 按解析出的帮助主题渲染帮助文本（顶层 / 名词级 / 命令级）。 */
export const renderCliHelpText = (topic: CliHelpTopic): string => {
  switch (topic.kind) {
    case "top":
      return CLI_USAGE_TEXT;
    case "noun":
      return renderNounHelpText(topic.noun);
    case "command": {
      const spec = COMMAND_SPECS.get(topic.phrase);
      return spec === undefined ? CLI_USAGE_TEXT : renderCommandHelpText(spec);
    }
  }
};

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

/** `--scope all|containers|group:<id>`：all/containers 原样；group:<id> 映射为契约的 { group } 对象形态。 */
const parseScope = (raw: string): "all" | "containers" | { group: string } => {
  if (raw === "all") return "all";
  if (raw === "containers") return "containers";
  const match = /^group:(.+)$/.exec(raw);
  const groupId = match?.[1];
  if (groupId !== undefined && groupId.length > 0) return { group: groupId };
  throw new CliArgError(`--scope 仅支持 all、containers 或 group:<组标识>，收到：${raw}`);
};

const parseKvList = (raw: string): { key: string; value: string }[] =>
  splitList(raw).map((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliArgError(`--arg 需要 k=v 形式，收到：${pair}`);
    }
    return { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
  });

/**
 * `--ref <素材标识>[:<用途>]` 条目（spec §5.4 引用用途）。
 *
 * 只按**第一个**冒号拆分：素材标识不含冒号，用途标识（素材位标识）同样不含，按首冒号
 * 拆分即可，且未来任一侧放宽都不会静默错位。缺省冒号即「调用方没表达用途」，落 `null`
 * 交由提交侧按设计文档 §8 存量兼容兜底——不在这里猜，避免 CLI 侧出现第二套用途判定。
 */
const parseRefList = (raw: string): { asset_id: string; slot_id: string | null }[] =>
  splitList(raw).map((item) => {
    const colon = item.indexOf(":");
    if (colon < 0) return { asset_id: item, slot_id: null };
    const assetId = item.slice(0, colon);
    const slotId = item.slice(colon + 1);
    if (assetId.length === 0) {
      throw new CliArgError(`--ref 的素材标识不能为空，收到：${item}（形状：<素材标识>[:<用途>]）`);
    }
    if (slotId.length === 0) {
      throw new CliArgError(`--ref 指定用途时用途标识不能为空，收到：${item}（形状：<素材标识>[:<用途>]）`);
    }
    return { asset_id: assetId, slot_id: slotId };
  });

/** 解析主体：命令短语定位 + flag 收集 + 按命令构造请求草稿 + 契约校验；用户可见错误以 CliArgError 抛出。 */
const parseCliArgsInner = (argv: readonly string[]): CliArgParseResult => {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { ok: false, reason: "help", topic: { kind: "top" } };
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
    // 名词级帮助：`iart <名词> --help`（如 iart model --help、iart canvas --help）。
    // 只在命令短语未命中时生效；已知命令短语（如 generate）走命令级帮助。
    const noun = argv[0] ?? "";
    const wantsHelp = argv[1] === "--help" || argv[1] === "-h";
    const isKnownNoun = COMMAND_SPEC_LIST.some((spec) => spec.phrase === noun || spec.phrase.startsWith(`${noun} `));
    if (wantsHelp && isKnownNoun) {
      return { ok: false, reason: "help", topic: { kind: "noun", noun } };
    }
    return failure(`无法识别的命令：${argv.slice(0, 3).join(" ")}`);
  }
  const { spec, rest } = resolved;
  const allowedFlagNames = new Set(spec.flags.map((flag) => flag.name));

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
      return { ok: false, reason: "help", topic: { kind: "command", phrase: spec.phrase } };
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const flagName = eq >= 0 ? token.slice(0, eq) : token;
      const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
      const flagSpec = FLAG_SPECS.get(flagName);
      if (flagSpec === undefined) {
        return failure(`未知参数：${flagName}`);
      }
      // 按命令参数白名单拒绝：全局已知但该命令不消费的 flag 不再静默丢弃。
      if (!allowedFlagNames.has(flagName)) {
        return failure(`参数 ${flagName} 不适用于命令 ${spec.phrase}。`);
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
    case "canvas.group.add":
    case "canvas.group.remove":
      // 成员加入/移出（spec §5.3 / CLI-049）：--members 必填（至少一项），逗号拆分累积。
      draft = {
        command: spec.command,
        project: requireScalar("project", "--project"),
        group: requireScalar("group", "--group"),
        members: requireStringList("members", "--members"),
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
      const refRaw = listValues.get("ref");
      const ref = refRaw === undefined ? undefined : refRaw.flatMap((item) => parseRefList(item));
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

import type { CliCommandName } from "@iart/contracts/cli-contract";
import { CANVAS_COMMAND_SPECS } from "./cli-canvas-command-specs.cjs";

/**
 * 命令目录与帮助渲染（命令面唯一事实源）。
 *
 * 从 cli-arg-parser 抽出（行数预算拆分，先例同 cli-canvas-command-specs /
 * cli-canvas-read-executors）：本文件承载 flag 映射表、命令短语表与顶层/名词级/命令级
 * 三层帮助渲染；解析流程仍留在 cli-arg-parser。解析与帮助消费同一份表，禁止另写命令清单。
 *
 * 名词帮助支持两级名词（`iart canvas nodes --help`）：`--help` 之前的 token 组成名词前缀，
 * 只要存在以 `<前缀> ` 开头的命令短语即可渲染该前缀下的子命令摘要；子命令行全部由命令表
 * 派生，名词摘要表只描述名词本身（不构成第二份命令事实源）。
 */

/** 帮助主题（--help 的解析结果身份）。 */
export type CliHelpTopic =
  | { kind: "top" }
  | { kind: "noun"; noun: string }
  | { kind: "command"; phrase: string };

type FlagKind =
  | "string"
  | "number"
  | "numberAny"
  | "boolean"
  | "booleanNegated"
  | "stringList"
  | "pathList"
  | "rawList"
  | "kvList"
  | "scope";

export interface FlagSpec {
  /** 契约 params 字段名（snake_case）——CLI flag → 契约字段的显式映射。 */
  field: string;
  kind: FlagKind;
  /** 命令级帮助中的用法形态（布尔开关只显示 flag 名）。 */
  usage: string;
  /** 命令级帮助中的一句话说明（含默认值与合法值）。 */
  help: string;
}

/** CLI flag → 契约 params 字段映射与帮助说明（字段名以 packages/contracts cli-contract 为准）。 */
export const FLAG_SPECS = new Map<string, FlagSpec>([
  ["--project", { field: "project", kind: "string", usage: "--project <路径或名称>", help: "目标项目（路径或项目名）" }],
  ["--name", { field: "name", kind: "string", usage: "--name <名称>", help: "名称：project create 为项目名，canvas group create/rename 为组名" }],
  ["--path", { field: "path", kind: "string", usage: "--path <目录>", help: "项目所在父目录（不推断默认位置）" }],
  ["--prompt", { field: "prompt", kind: "string", usage: "--prompt <文本>", help: "生成提示词" }],
  ["--model", { field: "model", kind: "string", usage: "--model <模型id>", help: "模型标识（generate 必填；asset list 按生成模型过滤）" }],
  ["--query", { field: "query", kind: "string", usage: "--query <关键词>", help: "按原始文件名或提交提示词做大小写不敏感子串筛选" }],
  ["--media-type", { field: "media_type", kind: "string", usage: "--media-type <image|video|audio>", help: "按媒体类型过滤" }],
  ["--on-canvas", { field: "on_canvas", kind: "string", usage: "--on-canvas <true|false>", help: "按是否已被画布节点引用过滤（true 只看已上画布，false 只看未上画布）" }],
  ["--asset", { field: "asset", kind: "string", usage: "--asset <资产id>", help: "要放回画布的项目资产标识" }],
  ["--limit", { field: "limit", kind: "number", usage: "--limit <N>", help: "最多返回条数（正整数）" }],
  ["--offset", { field: "offset", kind: "number", usage: "--offset <N>", help: "跳过前 N 条（非负整数，缺省 0）" }],
  ["--count", { field: "count", kind: "number", usage: "--count <N>", help: "生成任务数（正整数，1–10；越界按业务拒绝）" }],
  ["--ref", { field: "ref", kind: "stringList", usage: "--ref <id>[:<用途>]", help: "引用资产标识（逗号分隔，须为项目内已存在资产）；用途取自 iart model get 的 media_slots[].slotId，省略则按模型能力自动归入" }],
  ["--arg", { field: "arg", kind: "kvList", usage: "--arg <k=v,k2=v2>", help: "模型参数键值对（逗号分隔，受该模型参数 schema 约束）" }],
  ["--members", { field: "members", kind: "stringList", usage: "--members <id1,id2>", help: "组成员节点标识（逗号分隔；group create 省略时创建空组，group add/remove 必填）" }],
  // --file 是文件路径列表（spec §5.3 / CLI-047）：完整路径可合法含逗号，按 pathList
  // 语义每次累积一项、不拆分（区别于 --members/--ref 的逗号拆分语义）。
  ["--file", { field: "file", kind: "pathList", usage: "--file <路径>", help: "要导入的本地媒体文件（可重复；每次一个完整路径，不按逗号拆分）" }],
  ["--group", { field: "group", kind: "string", usage: "--group <组名或组id>", help: "generate 为出生组组名（仅匹配节点组）；canvas group dissolve/rename/move 为目标容器标识；canvas group add/remove 为目标节点组标识；canvas inspect 为只看该容器及后代；canvas node create 为目标节点组标识" }],
  ["--node", { field: "node", kind: "string", usage: "--node <节点id>", help: "目标节点标识" }],
  ["--nodes", { field: "nodes", kind: "stringList", usage: "--nodes <id1,id2>", help: "节点标识（逗号分隔，至少一项）：node delete 为待删节点，nodes move 为相对位移目标" }],
  ["--positions", { field: "positions", kind: "rawList", usage: "--positions <节点id>=<x>,<y>", help: "绝对坐标族（可重复，每个节点一条；与 --nodes/--dx/--dy 互斥）" }],
  ["--order", { field: "order", kind: "stringList", usage: "--order <id1,id2>", help: "显式摆放顺序（数组序即最高优先摆放序，优先于 --order-mode；id 必须在该次整理范围内）" }],
  ["--order-mode", { field: "order_mode", kind: "string", usage: "--order-mode <position|created|insertion>", help: "排序模式：position 视觉阅读序（缺省）、created 创建时间序、insertion 现状插入序；--pack 下 created 不支持（改用 --order）" }],
  ["--x", { field: "x", kind: "numberAny", usage: "--x <数值>", help: "目标画布 X 坐标（可负、可小数）" }],
  ["--y", { field: "y", kind: "numberAny", usage: "--y <数值>", help: "目标画布 Y 坐标（可负、可小数）" }],
  ["--scope", { field: "scope", kind: "scope", usage: "--scope <all|containers|group:<id>>", help: "整理范围：all 全画布自由散点（容器及其成员不动）、containers 仅容器（不重排成员）、group:<id> 指定组（与 --plan 互斥，二选一）" }],
  ["--plan", { field: "plan_path", kind: "string", usage: "--plan <路径>", help: "计划文件路径（JSON；一次提交多组网格 + 整版容器排布 + 显式坐标，与 --scope 族互斥）" }],
  ["--columns", { field: "columns", kind: "number", usage: "--columns <N>", help: "整理列数（正整数，缺省 1；--pack 时缺省按容器数开方推导）" }],
  ["--pack", { field: "pack", kind: "boolean", usage: "--pack", help: "把顶层容器按渲染框排成行列看板（仅 --scope containers，spec CLI-055）" }],
  ["--gap", { field: "gap", kind: "number", usage: "--gap <N>", help: "格子内间距（非负整数，缺省 120；scope all/group 与 --pack 均可用）" }],
  ["--dx", { field: "dx", kind: "numberAny", usage: "--dx <数值>", help: "相对位移 X（可负、可小数）；与 --x/--y 绝对落点互斥" }],
  ["--dy", { field: "dy", kind: "numberAny", usage: "--dy <数值>", help: "相对位移 Y（可负、可小数）；与 --x/--y 绝对落点互斥" }],
  ["--dry-run", { field: "dry_run", kind: "boolean", usage: "--dry-run", help: "只输出计划位置，不写入画布、不产生撤销记录" }],
  ["--full", { field: "full", kind: "boolean", usage: "--full", help: "canvas inspect：返回嵌套资产完整摘要与完整提示词（缺省只给紧凑摘要）" }],
  ["--prompt-limit", { field: "prompt_limit", kind: "number", usage: "--prompt-limit <N>", help: "canvas inspect：提示词截断长度（非负整数；0=不输出；缺省 compact 200、full 不截断）" }],
  ["--no-unplaced", { field: "include_unplaced", kind: "booleanNegated", usage: "--no-unplaced", help: "canvas inspect：不输出未落画布资产（缺省输出）" }],
  ["--operation", { field: "operation", kind: "string", usage: "--operation <操作id>", help: "要撤销的 CLI 操作标识（写命令响应中的 operation_id）" }],
  ["--yes", { field: "yes", kind: "boolean", usage: "--yes", help: "危险操作显式确认（project delete 必需；canvas node delete 命中 Agent 节点时必需）" }],
  ["--wait", { field: "wait", kind: "boolean", usage: "--wait", help: "受理后继续轮询直至全部任务终态" }],
  ["--timeout", { field: "timeout", kind: "number", usage: "--timeout <秒>", help: "等待超时秒数（缺省不设时限，到期后任务继续在后台执行）" }],
  ["--request-id", { field: "client_request_id", kind: "string", usage: "--request-id <ID>", help: "受理幂等键（generate 未传时自动生成；task list 按该键反查）" }],
  ["--status", { field: "status", kind: "string", usage: "--status <状态>", help: "按任务状态过滤：submitting|generating|polling|downloading|succeeded|failed|cancelled" }],
  ["--since", { field: "since", kind: "string", usage: "--since <ISO时间>", help: "仅列出创建时间不早于该时刻的任务" }],
]);

/** 命令接受的参数（name 必须是 FLAG_SPECS 的键；required 只影响帮助标注，解析必填仍由草稿分支裁定）。 */
export interface CommandFlagSpec {
  name: string;
  required?: boolean;
}

export interface CommandSpec {
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

export const REQUIRED_PROJECT: CommandFlagSpec = { name: "--project", required: true };

/**
 * 命令面唯一事实源：短语 → 契约命令名、位置参数、参数白名单、摘要与用法串。
 * 顶层用法表、名词级帮助与命令级帮助全部由本表渲染，禁止另写命令/参数清单。
 */
export const COMMAND_SPEC_LIST: readonly CommandSpec[] = [
  {
    phrase: "project list",
    command: "project.list",
    positionals: [],
    flags: [{ name: "--limit" }, { name: "--offset" }],
    summary: "列出项目注册表中的项目（名称、路径、最近打开时间），支持分页。",
    syntax: "iart project list [--limit N] [--offset O]",
    notes: ["按注册表既有顺序输出，分页在其后切片；不带分页参数时输出全量。"],
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
      { name: "--on-canvas" },
      { name: "--model" },
      { name: "--limit" },
      { name: "--offset" },
    ],
    summary: "列出项目资产（标识、媒体类型、生成来源摘要、画布引用），支持筛选与分页。",
    syntax:
      "iart asset list --project P [--query K] [--media-type image|video|audio] [--on-canvas true|false] [--model M] [--limit N] [--offset O]",
    notes: [
      "不带筛选与分页参数时输出全量；集合可能无限增长的列表命令均可分页（asset list / project list）。",
      "每个条目带 node_ids（引用该资产的画布节点）与 batch_id（生成来源批次，导入素材为 null）。",
    ],
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
  // 画布子命令短语表拆到 ./cli-canvas-command-specs（行数预算拆分，符号级等价搬运）：
  // 顶层用法表 / 名词级帮助 / 命令级帮助仍由本表统一渲染，禁止另写命令清单。
  ...CANVAS_COMMAND_SPECS,
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

export const COMMAND_SPECS = new Map<string, CommandSpec>(COMMAND_SPEC_LIST.map((spec) => [spec.phrase, spec]));

/** 名词 → 一句话说明（仅用于名词级帮助标题，不构成命令事实源）。 */
const NOUN_SUMMARIES = new Map<string, string>([
  ["project", "项目生命周期"],
  ["model", "可用模型查询"],
  ["asset", "资产查询与导入"],
  ["canvas", "画布操作（节点、组与布局）"],
  ["canvas nodes", "画布节点清单与批量移动"],
  ["canvas node", "单个画布节点的移动、删除与资产回填"],
  ["canvas group", "画布组与 Agent 容器的创建、解散、重命名与成员管理"],
  ["task", "任务查询、等待与取消"],
  ["batch", "生成档案查询"],
  ["app", "应用状态感知"],
]);

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

/** 名词前缀的直接下级名词（如 canvas → nodes/node/group；命令短语的下一段之后还有 token 时成立）。 */
const directSubNouns = (prefix: string, specs: readonly CommandSpec[]): string[] => {
  const names: string[] = [];
  for (const spec of specs) {
    const rest = spec.phrase.slice(prefix.length + 1);
    if (!rest.includes(" ")) continue;
    const next = rest.split(" ")[0];
    if (next !== undefined && next.length > 0 && !names.includes(next)) names.push(next);
  }
  return names;
};

/**
 * 名词级帮助：列出以 `<前缀> ` 开头的全部命令短语（由命令表派生）。
 *
 * 两级名词（如 canvas nodes）只列其自身下级命令；单级名词（如 canvas）额外列出下级名词
 * 入口（`iart canvas nodes --help`），既有「列出全部子命令」的语义不丢。
 */
const renderNounHelpText = (prefix: string): string => {
  const specs = COMMAND_SPEC_LIST.filter((spec) => spec.phrase.startsWith(`${prefix} `));
  if (specs.length === 0) return CLI_USAGE_TEXT;
  const subNouns = directSubNouns(prefix, specs);
  const lines = [
    `iart ${prefix} — ${NOUN_SUMMARIES.get(prefix) ?? "命令组"}`,
    "",
    ...(subNouns.length > 0
      ? [
          "下级名词：",
          ...subNouns.map(
            (subNoun) =>
              `  iart ${prefix} ${subNoun} --help\n      ${NOUN_SUMMARIES.get(`${prefix} ${subNoun}`) ?? "命令组"}`,
          ),
          "",
        ]
      : []),
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
    "  iart <名词> --help        列出该名词下的子命令（如 iart model --help、iart canvas --help、iart canvas nodes --help）",
    "  iart <命令短语> --help    查看该命令自己的参数说明（如 iart task list --help）",
    "",
    "通用参数：",
    "  --json                   输出机器可读 JSON",
    "  --version                显示发现文件中的应用版本（不验证应用是否在役）",
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

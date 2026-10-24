import * as path from "node:path";

import { CliCommandRequestSchema, type CliCommandRequest } from "@iart/contracts/cli-contract";
import {
  COMMAND_SPECS,
  COMMAND_SPEC_LIST,
  FLAG_SPECS,
  type CliHelpTopic,
  type CommandSpec,
} from "./cli-command-catalog.cjs";

// 帮助主题与三层帮助渲染承载在 cli-command-catalog（行数预算拆分）：解析与帮助消费同一份
// 命令表；此处 re-export 保持既有取用面（cli-client / 测试仍从 parser 取用）。
export { renderCliHelpText, CLI_USAGE_TEXT } from "./cli-command-catalog.cjs";
export type { CliHelpTopic, CommandFlagSpec, CommandSpec } from "./cli-command-catalog.cjs";

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

/**
 * `--positions <节点id>=<x>,<y>` 条目（可重复）。
 *
 * 每次一个节点：只按**第一个** `=` 拆分节点标识与坐标，坐标再按逗号拆两段；
 * 形状不合法、x/y 非有限数值、节点标识重复都按用法错误拒绝（退出码 2）。
 */
const parsePositionAssignments = (
  rawValues: readonly string[],
): { node_id: string; x: number; y: number }[] => {
  const seen = new Set<string>();
  return rawValues.map((raw) => {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new CliArgError(`--positions 需要 <节点id>=<x>,<y> 形式，收到：${raw}`);
    }
    const nodeId = raw.slice(0, eq).trim();
    const coords = raw.slice(eq + 1).split(",");
    const xRaw = coords[0]?.trim() ?? "";
    const yRaw = coords[1]?.trim() ?? "";
    if (nodeId.length === 0 || coords.length !== 2 || xRaw.length === 0 || yRaw.length === 0) {
      throw new CliArgError(`--positions 需要 <节点id>=<x>,<y> 形式，收到：${raw}`);
    }
    if (seen.has(nodeId)) {
      throw new CliArgError(`--positions 节点标识重复：${nodeId}`);
    }
    seen.add(nodeId);
    return {
      node_id: nodeId,
      x: parseCoordinate("--positions 的 x", xRaw),
      y: parseCoordinate("--positions 的 y", yRaw),
    };
  });
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
    // 名词级帮助（支持两级名词）：`iart <名词前缀> --help`，如 iart model --help、
    // iart canvas --help、iart canvas nodes --help。规则：`--help` 之前的全部 token 组成
    // 名词前缀；它不是某条完整命令短语、但存在以 `<前缀> ` 开头的命令短语即渲染名词帮助。
    // 只在命令短语未命中时生效；已知命令短语（如 generate、task list）走命令级帮助。
    const helpIndex = argv.findIndex((token) => token === "--help" || token === "-h");
    if (helpIndex > 0) {
      const noun = argv.slice(0, helpIndex).join(" ");
      const isNounPrefix = COMMAND_SPEC_LIST.some((spec) => spec.phrase.startsWith(`${noun} `));
      if (isNounPrefix) {
        return { ok: false, reason: "help", topic: { kind: "noun", noun } };
      }
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
      if (flagSpec.kind === "boolean" || flagSpec.kind === "booleanNegated") {
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
    case "project.list": {
      // 分页参数与 asset list 同形（limit 正整数缺省 null、offset 非负整数缺省 0）；
      // 在既有排序之后切片，响应不新增 total（spec §5.1）。
      const limit = optionalNumber("limit", "--limit");
      const offsetRaw = scalarValues.get("offset");
      draft = {
        command: "project.list",
        ...(limit !== undefined ? { limit } : {}),
        ...(offsetRaw !== undefined ? { offset: parseNonNegativeInt("--offset", offsetRaw) } : {}),
      };
      break;
    }
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
      const onCanvasRaw = scalarValues.get("on_canvas");
      if (onCanvasRaw !== undefined && onCanvasRaw !== "true" && onCanvasRaw !== "false") {
        throw new CliArgError(`--on-canvas 需要 true 或 false，收到：${onCanvasRaw}`);
      }
      draft = {
        command: "asset.list",
        project: requireScalar("project", "--project"),
        ...(query !== undefined ? { query } : {}),
        ...(mediaTypeRaw !== undefined ? { media_type: mediaTypeRaw } : {}),
        ...(onCanvasRaw !== undefined ? { on_canvas: onCanvasRaw === "true" } : {}),
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
    case "canvas.inspect": {
      // 场景图查询参数（批次 1a）：--full / --group / --prompt-limit / --no-unplaced。
      // 缺省值（compact、含未落画布资产）由执行侧按字段缺失兜底，解析器只传显式给出的值。
      const group = scalarValues.get("group");
      const promptLimitRaw = scalarValues.get("prompt_limit");
      draft = {
        command: "canvas.inspect",
        project: requireScalar("project", "--project"),
        ...(booleanFlags.has("full") ? { full: true } : {}),
        ...(group !== undefined ? { group } : {}),
        ...(promptLimitRaw !== undefined
          ? { prompt_limit: parseNonNegativeInt("--prompt-limit", promptLimitRaw) }
          : {}),
        ...(booleanFlags.has("include_unplaced") ? { include_unplaced: false } : {}),
      };
      break;
    }
    case "canvas.group.create":
      // --members 可选（spec §5.3 / CLI-044 空组建组）：缺省视为空成员清单。
      draft = {
        command: "canvas.group.create",
        project: requireScalar("project", "--project"),
        name: requireScalar("name", "--name"),
        members: optionalStringList("members") ?? [],
      };
      break;
    case "canvas.group.rename": {
      // 组名去首尾空白后必须非空（spec §5.3）；Agent 容器标题由会话管理，由执行侧拒绝。
      const name = requireScalar("name", "--name").trim();
      if (name.length === 0) {
        throw new CliArgError("--name 不能为空：组名去除首尾空白后必须至少包含一个字符。");
      }
      draft = {
        command: "canvas.group.rename",
        project: requireScalar("project", "--project"),
        group: requireScalar("group", "--group"),
        name,
      };
      break;
    }
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
        ...(booleanFlags.has("dry_run") ? { dry_run: true } : {}),
      };
      break;
    }
    case "canvas.nodes.move": {
      // 绝对坐标族（--positions，可重复）与相对位移族（--nodes/--dx/--dy）互斥（批次 1a）。
      // 互斥与「两族都没给」在解析器先按用法错误拒绝；执行侧另有 command_rejected 兜底。
      const positionsRaw = listValues.get("positions");
      const nodesRaw = listValues.get("nodes");
      const dxRaw = scalarValues.get("dx");
      const dyRaw = scalarValues.get("dy");
      const hasRelative = nodesRaw !== undefined || dxRaw !== undefined || dyRaw !== undefined;
      if (positionsRaw !== undefined && hasRelative) {
        throw new CliArgError("--positions（绝对坐标）与 --nodes/--dx/--dy（相对位移）不能同时使用，请只选一种。");
      }
      if (positionsRaw === undefined && !hasRelative) {
        throw new CliArgError(
          "请给出 --positions <节点id>=<x>,<y>（绝对坐标）或 --nodes/--dx/--dy（相对位移）中的一族。",
        );
      }
      draft =
        positionsRaw !== undefined
          ? {
              command: "canvas.nodes.move",
              project: requireScalar("project", "--project"),
              positions: parsePositionAssignments(positionsRaw),
              ...(booleanFlags.has("dry_run") ? { dry_run: true } : {}),
            }
          : {
              command: "canvas.nodes.move",
              project: requireScalar("project", "--project"),
              nodes: requireStringList("nodes", "--nodes"),
              dx: parseCoordinate("--dx", requireScalar("dx", "--dx")),
              dy: parseCoordinate("--dy", requireScalar("dy", "--dy")),
              ...(booleanFlags.has("dry_run") ? { dry_run: true } : {}),
            };
      break;
    }
    case "canvas.group.move": {
      const dxRaw = scalarValues.get("dx");
      const dyRaw = scalarValues.get("dy");
      const xRaw = scalarValues.get("x");
      const yRaw = scalarValues.get("y");
      const hasRelative = dxRaw !== undefined || dyRaw !== undefined;
      const hasAbsolute = xRaw !== undefined || yRaw !== undefined;
      // 两族互斥（spec §5.3 / CLI-052）：同时出现按用法错误拒绝（执行侧另有 command_rejected 兜底）。
      if (hasRelative && hasAbsolute) {
        throw new CliArgError("--dx/--dy（相对位移）与 --x/--y（绝对落点）不能同时使用，请只选一种。");
      }
      if (!hasRelative && !hasAbsolute) {
        throw new CliArgError("请给出 --dx/--dy（相对位移）或 --x/--y（绝对落点）中的至少一项。");
      }
      draft = {
        command: "canvas.group.move",
        project: requireScalar("project", "--project"),
        group: requireScalar("group", "--group"),
        ...(dxRaw !== undefined ? { dx: parseCoordinate("--dx", dxRaw) } : {}),
        ...(dyRaw !== undefined ? { dy: parseCoordinate("--dy", dyRaw) } : {}),
        ...(xRaw !== undefined ? { x: parseCoordinate("--x", xRaw) } : {}),
        ...(yRaw !== undefined ? { y: parseCoordinate("--y", yRaw) } : {}),
        ...(booleanFlags.has("dry_run") ? { dry_run: true } : {}),
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
    case "canvas.node.create": {
      const xRaw = scalarValues.get("x");
      const yRaw = scalarValues.get("y");
      // 两轴必须成对（spec §5.3 / CLI-056）：只给一个轴按用法错误拒绝（退出码 2）；
      // 执行侧另有 command_rejected 兜底（代理通道可被直接调用，不假定经过解析器）。
      if ((xRaw === undefined) !== (yRaw === undefined)) {
        throw new CliArgError("--x 与 --y 必须同时给出或同时省略：只给一个轴无法确定落点。");
      }
      const group = scalarValues.get("group");
      draft = {
        command: "canvas.node.create",
        project: requireScalar("project", "--project"),
        asset: requireScalar("asset", "--asset"),
        ...(group !== undefined ? { group } : {}),
        ...(xRaw !== undefined && yRaw !== undefined
          ? { x: parseCoordinate("--x", xRaw), y: parseCoordinate("--y", yRaw) }
          : {}),
        ...(booleanFlags.has("dry_run") ? { dry_run: true } : {}),
      };
      break;
    }
    case "canvas.layout": {
      // 两种模式二选一（批次 1b）：--scope 族（逐次整理）或 --plan（计划文件）。
      // 互斥与「两者都缺」在解析器先按用法错误拒绝（退出码 2）；执行侧另有 command_rejected 兜底。
      const planRaw = scalarValues.get("plan_path");
      const scopeRaw = scalarValues.get("scope");
      const columnsRaw = scalarValues.get("columns");
      const orderRaw = listValues.get("order");
      const gapRaw = scalarValues.get("gap");
      const orderModeRaw = scalarValues.get("order_mode");
      const hasScopeFamily =
        scopeRaw !== undefined ||
        columnsRaw !== undefined ||
        orderRaw !== undefined ||
        orderModeRaw !== undefined ||
        gapRaw !== undefined ||
        booleanFlags.has("pack");
      if (planRaw === undefined && !hasScopeFamily) {
        throw new CliArgError("请给出 --scope all|containers|group:<id>（逐次整理）或 --plan <路径>（计划文件）中的一种。");
      }
      if (planRaw !== undefined) {
        if (hasScopeFamily) {
          throw new CliArgError(
            "--plan 不能与 --scope/--columns/--order/--order-mode/--gap/--pack 同时使用：计划文件自成一套，请只给出 --plan。",
          );
        }
        if (planRaw.trim().length === 0) {
          throw new CliArgError("--plan 需要非空文件路径。");
        }
        // 计划文件只支持磁盘路径：`-`（标准输入）不是文件路径，按用法错误拒绝。
        if (planRaw === "-") {
          throw new CliArgError("--plan 不接受 -（标准输入）：请给出计划文件路径。");
        }
        draft = {
          command: "canvas.layout",
          project: requireScalar("project", "--project"),
          // 解析器只做路径归一（绝对路径），不读文件、不校验内容（纯模块无 IO）。
          plan_path: path.resolve(planRaw),
          ...(booleanFlags.has("dry_run") ? { dry_run: true } : {}),
        };
        break;
      }
      const columns = optionalNumber("columns", "--columns");
      const order = optionalStringList("order");
      // 排序模式（批次 1a）：非法枚举值按用法错误拒绝（退出码 2），不依赖契约 parse 兜底。
      if (
        orderModeRaw !== undefined &&
        orderModeRaw !== "position" &&
        orderModeRaw !== "created" &&
        orderModeRaw !== "insertion"
      ) {
        throw new CliArgError(`--order-mode 需要 position、created 或 insertion 之一，收到：${orderModeRaw}`);
      }
      draft = {
        command: "canvas.layout",
        project: requireScalar("project", "--project"),
        scope: parseScope(requireScalar("scope", "--scope")),
        ...(columns !== undefined ? { columns } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(orderModeRaw !== undefined ? { order_mode: orderModeRaw } : {}),
        // --gap 非负整数（0 合法）：scope all/group 与 --pack 都生效，缺省由执行侧按 120 兜底。
        ...(gapRaw !== undefined ? { gap: parseNonNegativeInt("--gap", gapRaw) } : {}),
        ...(booleanFlags.has("pack") ? { pack: true } : {}),
        ...(booleanFlags.has("dry_run") ? { dry_run: true } : {}),
      };
      break;
    }
    case "canvas.undo": {
      draft = {
        command: "canvas.undo",
        project: requireScalar("project", "--project"),
        operation: requireScalar("operation", "--operation"),
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

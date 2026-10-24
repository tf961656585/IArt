import { readFileSync } from "node:fs";

import { CliCanvasLayoutPlanSchema } from "@iart/contracts";
import type { CliCanvasLayoutPlan, CliCommandRequest, CliErrorCode, CliLayoutScope } from "@iart/contracts";

import type { CliCommandExecutor, CliCommandExecutorDeps, CliExecutorResult } from "./cli-command-executors.cjs";
import type { CliProxyDispatchOutcome } from "./cli-proxy-dispatcher.cjs";

/**
 * 画布写原语执行器（批次二）：`canvas.nodes.move` / `canvas.group.move` / `canvas.undo`。
 *
 * 从 cli-command-executors 抽出（行数预算拆分，先例同 cli-canvas-read-executors /
 * cli-canvas-inspect-executor）：三条命令与既有 canvas.node.move / canvas.layout 同一分派规则
 * （spec §4.2：画布写命令要求项目已打开，经代理执行通道交给画布窗口，不做任何降级）。
 * 本文件只做「解析项目 → 项目已打开守卫 → 代理分发 → 响应直通」，命令语义全部在画布窗口侧。
 */

type ProjectResolution =
  | { ok: true; project: { path: string } }
  | { ok: false; result: CliExecutorResult };

export interface CanvasWriteExecutorParams {
  registry: Map<CliCommandRequest["command"], CliCommandExecutor>;
  deps: CliCommandExecutorDeps;
  resolveProjectOrFail: (request: CliCommandRequest) => ProjectResolution;
  guardProjectOpenOrFail: (
    command: CliCommandRequest["command"],
    projectPath: string,
  ) => CliExecutorResult | null;
  proxyOutcomeToResult: (
    command: CliCommandRequest["command"],
    outcome: CliProxyDispatchOutcome,
    noWindowMessage: string,
  ) => CliExecutorResult;
  errorResult: (command: CliCommandRequest["command"], code: CliErrorCode, message: string) => CliExecutorResult;
}

const WINDOW_CLOSED_MESSAGE = "画布窗口刚刚被关闭，请先在应用中打开项目后再试。";

const INTERNAL_ERROR_MESSAGE = "命令执行出现内部错误，请稍后重试。";

const CONTAINERS_NON_PACK_UNSUPPORTED_MESSAGE =
  "scope=containers 不带 --pack 时只消除容器之间的相交，不接受 --columns、--order、--order-mode 与 --gap。";

const PACK_CREATED_UNSUPPORTED_MESSAGE =
  "--pack 时不支持按创建时间排序：请用 --order 显式指定容器顺序。";

const PLAN_MIXED_WITH_SCOPE_MESSAGE =
  "--plan 与 --scope/--columns/--order/--order-mode/--gap/--pack 不能同时使用。";

const SCOPE_OR_PLAN_MISSING_MESSAGE = "请给出 --scope 或 --plan。";

/** 读取并校验计划文件；失败时返回可直接下发的拒绝消息（调用方包成 command_rejected）。 */
const readLayoutPlanOrFail = (
  planPath: string,
): { ok: true; plan: CliCanvasLayoutPlan } | { ok: false; message: string } => {
  let raw: string;
  try {
    raw = readFileSync(planPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.debug("[cli-canvas-write] layout plan rejected: read failed", { planPath, reason });
    return { ok: false, message: `读不到计划文件：${planPath}（${reason}）。` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.debug("[cli-canvas-write] layout plan rejected: invalid json", { planPath, reason });
    return { ok: false, message: `计划文件不是合法 JSON：${planPath}（${reason}）。` };
  }
  const validated = CliCanvasLayoutPlanSchema.safeParse(parsed);
  if (!validated.success) {
    const first = validated.error.issues[0];
    const fieldPath = first !== undefined ? first.path.join(".") : "";
    const issueMessage = first !== undefined ? first.message : "未知问题";
    console.debug("[cli-canvas-write] layout plan rejected: schema mismatch", {
      planPath,
      issues: validated.error.issues.length,
      firstPath: fieldPath,
    });
    return {
      ok: false,
      message: `计划文件格式不正确：${planPath}（${fieldPath}: ${issueMessage}）。`,
    };
  }
  return { ok: true, plan: validated.data };
};

const isContainerNodeType = (nodeType: string): boolean => nodeType === "group" || nodeType === "agent";

interface LayoutOrderNode {
  id: string;
  type: string;
  groupId: string | null;
  createdAt: number | null;
  /** 存储序（payload 数组序），无创建时间时的稳定兜底键。 */
  index: number;
}

const readFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * 解析单个节点的创建时间（内容创建时间，不是落画布时间）。
 *
 * 数据源复用既有读取链，不新建第二事实源：
 * - 任务节点：payload `data.createdAt`；
 * - 资产/素材节点：资产 `lifecycle.createdAt`，缺失回落其产出任务创建时间
 *  （生成来源索引里随任务行一并读出的 `taskCreatedAt`）；
 * - 其余节点：payload 无创建时间 → null（调用方按存储序稳定兜底）。
 */
const readLayoutNodeCreatedAt = (params: {
  data: { createdAt?: unknown; assetId?: unknown; sourceTaskId?: unknown } | null;
  type: string;
  assetCreatedAtByAssetId: ReadonlyMap<string, number>;
  assetTaskIdByAssetId: ReadonlyMap<string, string>;
  taskCreatedAtByTaskId: ReadonlyMap<string, number>;
}): number | null => {
  const dataCreatedAt = params.data !== null ? readFiniteNumber(params.data.createdAt) : null;
  if (params.type === "task") return dataCreatedAt;
  const assetId = params.data !== null ? readNonEmptyString(params.data.assetId) : null;
  if (assetId !== null) {
    const assetCreatedAt = params.assetCreatedAtByAssetId.get(assetId);
    if (assetCreatedAt !== undefined) return assetCreatedAt;
  }
  const sourceTaskId = params.data !== null ? readNonEmptyString(params.data.sourceTaskId) : null;
  const taskId = sourceTaskId ?? (assetId !== null ? params.assetTaskIdByAssetId.get(assetId) ?? null : null);
  if (taskId !== null) {
    const taskCreatedAt = params.taskCreatedAtByTaskId.get(taskId);
    if (taskCreatedAt !== undefined) return taskCreatedAt;
  }
  return dataCreatedAt;
};

/**
 * `--order-mode created` 主进程侧解析：把创建时间序解析成显式 `order` 数组。
 *
 * 参与节点口径与画布窗口侧一致：
 * - scope=all：自由叶节点（非容器且不归属任何组）；
 * - scope=group:<id>：该组直接成员（非组节点，groupId 指向该组；含嵌套 Agent 容器）。
 *
 * 缺失创建时间的节点排在有时刻节点之后，按存储序稳定兜底；完全相同创建时间也按存储序。
 */
const resolveCreatedOrder = (params: {
  deps: CliCommandExecutorDeps;
  projectPath: string;
  scope: Exclude<CliLayoutScope, "containers">;
}): string[] => {
  const assets = params.deps.storage.readMediaAssets(params.projectPath);
  const assetCreatedAtByAssetId = new Map(assets.map((asset) => [asset.assetId, asset.lifecycle.createdAt] as const));
  const generationIndex = params.deps.storage.readAssetGenerationIndex(params.projectPath);
  const taskCreatedAtByTaskId = new Map<string, number>();
  const assetTaskIdByAssetId = new Map<string, string>();
  for (const [assetId, generation] of generationIndex) {
    assetTaskIdByAssetId.set(assetId, generation.taskId);
    if (generation.taskCreatedAt !== null && !taskCreatedAtByTaskId.has(generation.taskId)) {
      taskCreatedAtByTaskId.set(generation.taskId, generation.taskCreatedAt);
    }
  }

  const rows: LayoutOrderNode[] = [];
  params.deps.storage.readCanvasNodePayloads(params.projectPath).forEach((payload, index) => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    const raw = payload as { id?: unknown; type?: unknown; groupId?: unknown; data?: unknown };
    const id = readNonEmptyString(raw.id);
    const type = readNonEmptyString(raw.type);
    if (id === null || type === null) {
      console.debug("[cli-canvas-write] created 排序：节点载荷缺 id/type，跳过", { index });
      return;
    }
    const groupId = readNonEmptyString(raw.groupId);
    const data =
      raw.data !== null && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? (raw.data as { createdAt?: unknown; assetId?: unknown; sourceTaskId?: unknown })
        : null;
    const inScope =
      params.scope === "all"
        ? !isContainerNodeType(type) && groupId === null
        : type !== "group" && groupId === params.scope.group;
    if (!inScope) return;
    rows.push({
      id,
      type,
      groupId,
      createdAt: readLayoutNodeCreatedAt({
        data,
        type,
        assetCreatedAtByAssetId,
        assetTaskIdByAssetId,
        taskCreatedAtByTaskId,
      }),
      index,
    });
  });

  rows.sort((left, right) => {
    if (left.createdAt !== null && right.createdAt !== null && left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    if (left.createdAt !== null && right.createdAt === null) return -1;
    if (left.createdAt === null && right.createdAt !== null) return 1;
    return left.index - right.index;
  });
  return rows.map((row) => row.id);
};

export const registerCanvasWriteExecutors = (params: CanvasWriteExecutorParams): void => {
  const { registry, deps, resolveProjectOrFail, guardProjectOpenOrFail, proxyOutcomeToResult, errorResult } = params;

  registry.set("asset.import", async (request) => {
    if (request.command !== "asset.import") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path);
    if (guard !== null) return guard;
    // --file 路径清单原样进代理候选；文件存在性/媒体类型校验不在主进程做（spec §5.3 / CLI-047），
    // 由画布窗口侧前置校验产生 file_not_found / unsupported_file_type，经 error 分支透传。
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "asset.import",
      file: request.file,
    });
    return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.group.create", async (request) => {
    if (request.command !== "canvas.group.create") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.group.create",
      name: request.name,
      members: request.members,
    });
    return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.group.rename", async (request) => {
    if (request.command !== "canvas.group.rename") {
      return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    }
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail("canvas.group.rename", resolution.project.path);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.group.rename",
      group: request.group,
      name: request.name,
    });
    return proxyOutcomeToResult("canvas.group.rename", outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.group.dissolve", async (request) => {
    if (request.command !== "canvas.group.dissolve") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.group.dissolve",
      group: request.group,
    });
    return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
  });

  for (const membershipCommand of ["canvas.group.add", "canvas.group.remove"] as const) {
    registry.set(membershipCommand, async (request) => {
      if (request.command !== "canvas.group.add" && request.command !== "canvas.group.remove") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
      const resolution = resolveProjectOrFail(request);
      if (!resolution.ok) return resolution.result;
      const guard = guardProjectOpenOrFail(membershipCommand, resolution.project.path);
      if (guard !== null) return guard;
      const fields = { group: request.group, members: request.members };
      const candidate = membershipCommand === "canvas.group.add"
        ? { command: "canvas.group.add" as const, ...fields }
        : { command: "canvas.group.remove" as const, ...fields };
      const outcome = await deps.proxy.dispatch(resolution.project.path, candidate);
      return proxyOutcomeToResult(membershipCommand, outcome, WINDOW_CLOSED_MESSAGE);
    });
  }

  registry.set("canvas.node.move", async (request) => {
    if (request.command !== "canvas.node.move") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.node.move",
      node: request.node,
      x: request.x,
      y: request.y,
      ...(request.dry_run !== undefined ? { dry_run: request.dry_run } : {}),
    });
    return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.node.delete", async (request) => {
    if (request.command !== "canvas.node.delete") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.node.delete",
      nodes: request.nodes,
      ...(request.yes !== undefined ? { yes: request.yes } : {}),
    });
    return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.node.create", async (request) => {
    if (request.command !== "canvas.node.create") {
      return errorResult(request.command, "internal_error", INTERNAL_ERROR_MESSAGE);
    }
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail("canvas.node.create", resolution.project.path);
    if (guard !== null) return guard;

    // 两轴必须成对（spec §5.3 / CLI-056）：解析器已按用法错误拒绝一次，此处兜代理通道直调。
    const hasX = request.x !== undefined;
    const hasY = request.y !== undefined;
    if (hasX !== hasY) {
      console.debug("[cli-canvas-write] node.create rejected: only one axis given", {
        asset: request.asset,
      });
      return errorResult(
        request.command,
        "command_rejected",
        "--x 与 --y 必须同时给出或同时省略：只给一个轴无法确定落点。",
      );
    }

    // 资产必须存在于项目媒体资产（整批拒绝、零副作用；画布窗口侧不重复判定资产存在性）。
    const asset = deps.storage.readMediaAssetById(resolution.project.path, request.asset);
    if (asset === null) {
      console.debug("[cli-canvas-write] node.create rejected: asset not found", { asset: request.asset });
      return errorResult(
        request.command,
        "asset_not_found",
        `没有找到这个资产：${request.asset}。请确认资产标识属于该项目（可用 asset list 查询）。`,
      );
    }
    // mediaType 由 RuntimeMediaAssetViewSchema 静态收敛为 image/video/audio（契约层已校验），
    // 无需运行时再判一次；此处保留分支说明，避免后续放宽媒体类型时静默放行。

    // 生成来源摘要由主进程反查（画布窗口没有资产→任务溯源读通道）；导入素材无来源，
    // 缺省三个字段由画布侧落空串（AssetNodeData 的 source* 字段是非空 string）。
    const generation = deps.storage.readAssetGenerationIndex(resolution.project.path).get(request.asset);
    console.debug("[cli-canvas-write] node.create dispatching", {
      asset: request.asset,
      mediaType: asset.mediaType,
      hasGenerationSource: generation !== undefined,
    });
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.node.create",
      asset: request.asset,
      ...(request.group !== undefined ? { group: request.group } : {}),
      ...(request.x !== undefined && request.y !== undefined ? { x: request.x, y: request.y } : {}),
      ...(request.dry_run !== undefined ? { dry_run: request.dry_run } : {}),
      ...(generation?.batchId != null ? { source_batch_id: generation.batchId } : {}),
      ...(generation !== undefined ? { source_task_id: generation.taskId } : {}),
      ...(generation?.modelId != null ? { source_model_id: generation.modelId } : {}),
    });
    return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.layout", async (request) => {
    if (request.command !== "canvas.layout") return errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail(request.command, resolution.project.path);
    if (guard !== null) return guard;

    // --plan 模式（批次 1b）：计划文件自成一套参数，与 scope 族互斥
    // （解析器先按用法错误拒绝；代理通道可被直调，执行侧兜 command_rejected）。
    if (request.plan_path !== undefined) {
      const mixedWithScope =
        request.scope !== undefined ||
        request.columns !== undefined ||
        request.order !== undefined ||
        request.order_mode !== undefined ||
        request.pack !== undefined ||
        request.gap !== undefined;
      if (mixedWithScope) {
        console.debug("[cli-canvas-write] layout rejected: plan mixed with scope params", {
          planPath: request.plan_path,
          scope: request.scope,
        });
        return errorResult(request.command, "command_rejected", PLAN_MIXED_WITH_SCOPE_MESSAGE);
      }
      const planRead = readLayoutPlanOrFail(request.plan_path);
      if (!planRead.ok) {
        return errorResult(request.command, "command_rejected", planRead.message);
      }
      const outcome = await deps.proxy.dispatch(resolution.project.path, {
        command: "canvas.layout",
        plan: planRead.plan,
        ...(request.dry_run === true ? { dry_run: true } : {}),
      });
      return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
    }

    const scope = request.scope;
    if (scope === undefined) {
      console.debug("[cli-canvas-write] layout rejected: neither scope nor plan given");
      return errorResult(request.command, "command_rejected", SCOPE_OR_PLAN_MISSING_MESSAGE);
    }
    const packRequested = request.pack === true;
    const explicitOrder = request.order;
    let orderMode = request.order_mode;

    // scope=containers 非 pack：容器按整组平移，不重排成员；携带排布参数按业务拒绝
    // （画布零改动；解析器不负责业务语义，执行侧兜住代理通道直调）。
    if (scope === "containers" && !packRequested) {
      const unsupported =
        request.columns !== undefined ||
        explicitOrder !== undefined ||
        orderMode !== undefined ||
        request.gap !== undefined;
      if (unsupported) {
        console.debug("[cli-canvas-write] layout rejected: containers without pack carried layout flags", {
          columns: request.columns,
          hasOrder: explicitOrder !== undefined,
          orderMode,
          gap: request.gap,
        });
        return errorResult(request.command, "command_rejected", CONTAINERS_NON_PACK_UNSUPPORTED_MESSAGE);
      }
    }

    // spec 只承诺 all/group 的 created 排序；--pack + created 无法在主进程解析容器创建时间，
    // 明确拒绝并指向 --order（显式顺序优先于排序模式，带了 order 就按显式顺序执行）。
    if (scope === "containers" && packRequested && orderMode === "created" && explicitOrder === undefined) {
      console.debug("[cli-canvas-write] layout rejected: containers pack with created order mode");
      return errorResult(request.command, "command_rejected", PACK_CREATED_UNSUPPORTED_MESSAGE);
    }

    let order = explicitOrder;
    if (orderMode === "created" && explicitOrder === undefined && scope !== "containers") {
      // 主进程把创建时间序解析成显式 order，再以 insertion 下发（画布窗口只消费显式数组，
      // 不再自算时间序）：一次解析、一处事实源。
      const resolvedOrder = resolveCreatedOrder({
        deps,
        projectPath: resolution.project.path,
        scope: scope === "all" ? "all" : scope,
      });
      console.debug("[cli-canvas-write] layout created order resolved", {
        scope,
        resolved: resolvedOrder.length,
      });
      if (resolvedOrder.length > 0) order = resolvedOrder;
      orderMode = "insertion";
    }

    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.layout",
      scope,
      ...(request.columns !== undefined ? { columns: request.columns } : {}),
      ...(order !== undefined ? { order } : {}),
      ...(orderMode !== undefined ? { order_mode: orderMode } : {}),
      ...(request.pack !== undefined ? { pack: request.pack } : {}),
      ...(request.gap !== undefined ? { gap: request.gap } : {}),
      ...(request.dry_run !== undefined ? { dry_run: request.dry_run } : {}),
    });
    return proxyOutcomeToResult(request.command, outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.nodes.move", async (request) => {
    if (request.command !== "canvas.nodes.move") {
      return errorResult(request.command, "internal_error", INTERNAL_ERROR_MESSAGE);
    }
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail("canvas.nodes.move", resolution.project.path);
    if (guard !== null) return guard;

    // 绝对坐标族与相对位移族互斥（解析器先拒一次；代理通道可被直调，执行侧兜 command_rejected）。
    const hasAbsolute = request.positions !== undefined;
    const hasRelative =
      request.nodes !== undefined || request.dx !== undefined || request.dy !== undefined;
    if (hasAbsolute && hasRelative) {
      console.debug("[cli-canvas-write] nodes.move rejected: absolute and relative families both given");
      return errorResult(
        request.command,
        "command_rejected",
        "--positions（绝对坐标）与 --nodes/--dx/--dy（相对位移）不能同时使用，请只选一种。",
      );
    }
    if (!hasAbsolute && !hasRelative) {
      console.debug("[cli-canvas-write] nodes.move rejected: no position family given");
      return errorResult(
        request.command,
        "command_rejected",
        "请给出 --positions <节点id>=<x>,<y>（绝对坐标）或 --nodes/--dx/--dy（相对位移）中的一族。",
      );
    }

    if (hasAbsolute) {
      const outcome = await deps.proxy.dispatch(resolution.project.path, {
        command: "canvas.nodes.move",
        positions: request.positions,
        ...(request.dry_run !== undefined ? { dry_run: request.dry_run } : {}),
      });
      return proxyOutcomeToResult("canvas.nodes.move", outcome, WINDOW_CLOSED_MESSAGE);
    }
    if (request.nodes === undefined || request.dx === undefined || request.dy === undefined) {
      console.debug("[cli-canvas-write] nodes.move rejected: relative family incomplete", {
        hasNodes: request.nodes !== undefined,
        hasDx: request.dx !== undefined,
        hasDy: request.dy !== undefined,
      });
      return errorResult(
        request.command,
        "command_rejected",
        "相对位移需要同时给出 --nodes、--dx 与 --dy（缺省轴按 0 处理请显式写 0）。",
      );
    }
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.nodes.move",
      nodes: request.nodes,
      dx: request.dx,
      dy: request.dy,
      ...(request.dry_run !== undefined ? { dry_run: request.dry_run } : {}),
    });
    return proxyOutcomeToResult("canvas.nodes.move", outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.group.move", async (request) => {
    if (request.command !== "canvas.group.move") {
      return errorResult(request.command, "internal_error", INTERNAL_ERROR_MESSAGE);
    }
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail("canvas.group.move", resolution.project.path);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.group.move",
      group: request.group,
      ...(request.dx !== undefined ? { dx: request.dx } : {}),
      ...(request.dy !== undefined ? { dy: request.dy } : {}),
      ...(request.x !== undefined ? { x: request.x } : {}),
      ...(request.y !== undefined ? { y: request.y } : {}),
      ...(request.dry_run !== undefined ? { dry_run: request.dry_run } : {}),
    });
    return proxyOutcomeToResult("canvas.group.move", outcome, WINDOW_CLOSED_MESSAGE);
  });

  registry.set("canvas.undo", async (request) => {
    if (request.command !== "canvas.undo") {
      return errorResult(request.command, "internal_error", INTERNAL_ERROR_MESSAGE);
    }
    const resolution = resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const guard = guardProjectOpenOrFail("canvas.undo", resolution.project.path);
    if (guard !== null) return guard;
    const outcome = await deps.proxy.dispatch(resolution.project.path, {
      command: "canvas.undo",
      operation: request.operation,
    });
    return proxyOutcomeToResult("canvas.undo", outcome, WINDOW_CLOSED_MESSAGE);
  });
};

export { WINDOW_CLOSED_MESSAGE };

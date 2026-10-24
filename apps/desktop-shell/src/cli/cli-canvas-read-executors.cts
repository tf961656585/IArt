import type { CliCanvasNodeEntry, CliCommandRequest, CliErrorCode } from "@iart/contracts";

import { projectCanvasGroupSummaries, projectCanvasNodePayload } from "./cli-canvas-projection.cjs";
import type { CliCommandExecutor, CliExecutorResult } from "./cli-command-executors.cjs";

/**
 * 画布只读清单执行器（`canvas.nodes.list` / `canvas.group.list`）。
 *
 * 从 cli-command-executors 抽出（行数预算拆分，行为符号级等价搬运，先例同
 * cli-task-result-projection / cli-generation-archive）：两条命令都是「解析项目 → 存储只读
 * 投影 → 契约条目」的薄编排，项目未打开也可用（spec §5.2）。
 */

type ProjectResolution =
  | { ok: true; project: { path: string } }
  | { ok: false; result: CliExecutorResult };

export interface CanvasReadExecutorParams {
  registry: Map<CliCommandRequest["command"], CliCommandExecutor>;
  resolveProjectOrFail: (request: CliCommandRequest) => ProjectResolution;
  okResult: (command: CliCommandRequest["command"], payload: object) => CliExecutorResult;
  errorResult: (command: CliCommandRequest["command"], code: CliErrorCode, message: string) => CliExecutorResult;
  readCanvasNodePayloads: (projectPath: string) => readonly unknown[];
}

const INTERNAL_ERROR_MESSAGE = "命令执行出现内部错误，请稍后重试。";

export const registerCanvasReadExecutors = (params: CanvasReadExecutorParams): void => {
  params.registry.set("canvas.nodes.list", (request) => {
    if (request.command !== "canvas.nodes.list") {
      return params.errorResult(request.command, "internal_error", INTERNAL_ERROR_MESSAGE);
    }
    const resolution = params.resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    // 项目未打开也可读（spec §5.2 只读可、写入拒）：统一走存储只读投影，不经画布窗口。
    const payloads = params.readCanvasNodePayloads(resolution.project.path);
    const nodes: CliCanvasNodeEntry[] = [];
    for (const payload of payloads) {
      const entry = projectCanvasNodePayload(payload);
      if (entry === null) continue;
      nodes.push(entry);
    }
    return params.okResult(request.command, { nodes });
  });

  params.registry.set("canvas.group.list", (request) => {
    if (request.command !== "canvas.group.list") {
      return params.errorResult(request.command, "internal_error", INTERNAL_ERROR_MESSAGE);
    }
    const resolution = params.resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    // 组/容器清单走存储只读投影（spec §5.2 / CLI-045）：与 canvas nodes list 同通道定位，
    // 项目未打开也可读。聚合（成员计数）在投影函数内完成，执行器只做编排。
    const payloads = params.readCanvasNodePayloads(resolution.project.path);
    return params.okResult(request.command, { groups: projectCanvasGroupSummaries(payloads) });
  });
};

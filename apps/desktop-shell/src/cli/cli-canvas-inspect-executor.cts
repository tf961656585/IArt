import {
  CliCanvasGeometrySnapshotSchema,
  CliCanvasInspectResultSchema,
  type CliCanvasGeometrySnapshot,
  type CliCommandRequest,
  type CliErrorCode,
} from "@iart/contracts";

import type { CliCommandExecutor, CliCommandExecutorDeps, CliExecutorResult } from "./cli-command-executors.cjs";
import { buildCanvasInspectResult } from "./cli-canvas-inspect-projection.cjs";
import { readCliCanvasAnnotations } from "./cli-storage-queries.cjs";

/**
 * `canvas.inspect` 执行器（整张画布场景图，只读）。
 *
 * 分派定位与 canvas.nodes.list 同级（spec §5.2 只读查询）：先由存储只读投影构建 derived
 * 场景图，项目画布窗口打开时再经代理通道 `canvas.geometry.get` 取窗口内精确几何合并为
 * exact。代理失败绝不让命令失败——catch 后 debug 留痕并返回 derived（内部通信不设超时，
 * 亦不重试、不降级为其他数据源）。
 */

type ProjectResolution =
  | { ok: true; project: { path: string } }
  | { ok: false; result: CliExecutorResult };

export interface CanvasInspectExecutorParams {
  registry: Map<CliCommandRequest["command"], CliCommandExecutor>;
  deps: CliCommandExecutorDeps;
  resolveProjectOrFail: (request: CliCommandRequest) => ProjectResolution;
  okResult: (command: CliCommandRequest["command"], payload: object) => CliExecutorResult;
  errorResult: (command: CliCommandRequest["command"], code: CliErrorCode, message: string) => CliExecutorResult;
}

const readExactGeometry = async (
  deps: CliCommandExecutorDeps,
  projectPath: string,
): Promise<CliCanvasGeometrySnapshot | null> => {
  try {
    const outcome = await deps.proxy.dispatch(projectPath, { command: "canvas.geometry.get" });
    if (!outcome.ok) {
      console.debug("[cli-canvas-inspect] 窗口几何代理分发未成功，回落 derived", {
        projectPath,
        reason: outcome.reason,
        detail: outcome.detail,
      });
      return null;
    }
    const response = outcome.response;
    if ("error" in response) {
      console.debug("[cli-canvas-inspect] 窗口几何查询返回错误，回落 derived", {
        projectPath,
        code: response.error.code,
      });
      return null;
    }
    if (response.command !== "canvas.geometry.get") {
      console.debug("[cli-canvas-inspect] 窗口几何响应命令不符，回落 derived", {
        projectPath,
        command: response.command,
      });
      return null;
    }
    // 快照按契约 schema 再收窄一次（消费端 Zod parse 纪律）。
    const parsed = CliCanvasGeometrySnapshotSchema.safeParse({
      sizes: response.sizes,
      containers: response.containers,
      viewport: response.viewport,
      selection: response.selection,
    });
    if (!parsed.success) {
      console.debug("[cli-canvas-inspect] 窗口几何响应未通过契约校验，回落 derived", {
        projectPath,
        issues: parsed.error.issues.length,
      });
      return null;
    }
    return parsed.data;
  } catch (error: unknown) {
    console.debug("[cli-canvas-inspect] 窗口几何查询异常，回落 derived", {
      projectPath,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

export const registerCanvasInspectExecutor = (params: CanvasInspectExecutorParams): void => {
  params.registry.set("canvas.inspect", async (request) => {
    if (request.command !== "canvas.inspect") {
      return params.errorResult(request.command, "internal_error", "命令执行出现内部错误，请稍后重试。");
    }
    const resolution = params.resolveProjectOrFail(request);
    if (!resolution.ok) return resolution.result;
    const projectPath = resolution.project.path;

    const payloads = params.deps.storage.readCanvasNodePayloads(projectPath);
    const annotations =
      params.deps.storage.readCanvasAnnotations?.(projectPath) ?? readCliCanvasAnnotations(projectPath);
    const assets = params.deps.storage.readMediaAssets(projectPath);
    const generationIndex = params.deps.storage.readAssetGenerationIndex(projectPath);

    let exact: CliCanvasGeometrySnapshot | null = null;
    if (params.deps.windows.hasOpenWindow(projectPath)) {
      exact = await readExactGeometry(params.deps, projectPath);
    } else {
      console.debug("[cli-canvas-inspect] 项目画布窗口未打开，仅输出派生几何", { projectPath });
    }

    const outcome = buildCanvasInspectResult({
      projectPath,
      payloads,
      annotations,
      assets,
      generationIndex,
      exact,
      full: request.full === true,
      promptLimit: request.prompt_limit ?? null,
      group: request.group ?? null,
      includeUnplaced: request.include_unplaced !== false,
    });
    if (!outcome.ok) {
      return params.errorResult(
        request.command,
        "group_not_found",
        `画布上找不到这个容器：${request.group ?? ""}。请确认容器标识后重试。`,
      );
    }
    const result = CliCanvasInspectResultSchema.parse(outcome.result);
    return params.okResult(request.command, result);
  });
};

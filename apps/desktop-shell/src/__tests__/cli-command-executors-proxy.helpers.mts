// @vitest-environment node
//
// cli-command-executors-proxy 系列测试的共享夹具（主文件与 batch 1a 拆分文件共用）。
// 只承载「加载编译产物执行器 + 构造注入 deps」的测试脚手架，不写断言。
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliCommandRequestSchema, CliCommandResponseSchema } from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const executorsEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-command-executors.cjs`;

export type ExecutorResult = { response: unknown; errorCode: string | null };
export type Executor = (request: unknown) => ExecutorResult | Promise<ExecutorResult>;
export type Registry = Map<string, Executor>;
export type DispatcherOutcome =
  | { ok: true; response: unknown }
  | { ok: false; reason: string; detail: string };

export type ProxyCall = { projectPath: string; candidate: Record<string, unknown> };

export type GenerationWarning = {
  code: string;
  message: string;
  requested_size: string;
  actual_sizes: string[];
};

export type GenerationWarningAsset = {
  asset: {
    mediaType: string;
    original: { width?: number | null; height?: number | null };
  };
};

export type ExecutorModule = {
  createCliCommandExecutors: (deps: Record<string, unknown>) => Registry;
  buildGenerationWarnings: (
    task: { request?: Record<string, unknown> | null },
    assets: readonly GenerationWarningAsset[],
  ) => GenerationWarning[];
};

export const loadExecutorModule = (): ExecutorModule => requireDesktop(executorsEntry) as ExecutorModule;

export const parseResponse = (result: ExecutorResult) =>
  CliCommandResponseSchema.parse(result.response);

export const runExecutor = async (
  registry: Registry,
  command: string,
  request: unknown,
): Promise<ExecutorResult> => {
  const executor = registry.get(command);
  if (executor === undefined) throw new Error(`executor missing: ${command}`);
  return await executor(CliCommandRequestSchema.parse(request));
};

export const PROJECT_PATH = join(tmpdir(), `cli-proxy-exec-proj-${process.pid}`);

export const buildRegistry = (overrides: {
  windowOpen?: boolean;
  dispatchOutcome?: DispatcherOutcome;
  postJsonPayload?: { ok: boolean; payload?: unknown; reason?: string; status?: number; detail?: string };
  openProjects?: Array<{ projectPath: string; focused: boolean; canvasLoading: boolean }>;
  canvasPayloads?: readonly unknown[];
  generationIndex?: ReadonlyMap<
    string,
    {
      taskId: string;
      batchId: string | null;
      modelId: string | null;
      prompt: string | null;
      taskCreatedAt: number | null;
    }
  >;
  mediaAssets?: readonly unknown[];
} = {}): { registry: Registry; proxyCalls: ProxyCall[]; postCalls: Array<{ pathname: string; body: unknown }> } => {
  const proxyCalls: ProxyCall[] = [];
  const postCalls: Array<{ pathname: string; body: unknown }> = [];
  const dispatchOutcome: DispatcherOutcome =
    overrides.dispatchOutcome !== undefined
      ? overrides.dispatchOutcome
      : { ok: true, response: { command: "canvas.group.create", request_id: "ignored", group_node_id: "g-new", member_ids: [], operation_id: "op-create" } };
  const mod = loadExecutorModule();
  const registry = mod.createCliCommandExecutors({
    readProjects: () => [
      { nodeGraphId: "ng-1", name: "demo", path: PROJECT_PATH, createdAt: 1, savedAt: 2, lastOpenedAt: 3 },
    ],
    windows: {
      openOrFocus: async () => ({ ok: true }),
      hasOpenWindow: () => overrides.windowOpen ?? true,
      closeByProjectPath: () => true,
      listOpenEditorProjects: () => overrides.openProjects ?? [],
    },
    forwarder: {
      getJson: async () => ({ ok: true, payload: {} }),
      postJson: async (pathname: string, body: unknown) => {
        postCalls.push({ pathname, body });
        const injected = overrides.postJsonPayload;
        if (injected !== undefined) {
          return injected.ok
            ? { ok: true, payload: injected.payload }
            : {
                ok: false,
                reason: injected.reason ?? "http_error",
                ...(injected.status !== undefined ? { status: injected.status } : {}),
                detail: injected.detail ?? "x",
              };
        }
        return { ok: true, payload: {} };
      },
    },
    storage: {
      createProject: () => ({ projectPath: PROJECT_PATH }),
      deleteProject: () => undefined,
      touchProjectOpenedAt: () => undefined,
      readMediaAssets: () => overrides.mediaAssets ?? [],
      readMediaAssetById: () => null,
      readAssetTaskIndex: () => new Map(),
      readAssetGenerationIndex: () => overrides.generationIndex ?? new Map(),
      readTaskOutputAssets: () => [],
      readCanvasNodePayloads: () => overrides.canvasPayloads ?? [],
    },
    proxy: {
      dispatch: async (projectPath: string, candidate: Record<string, unknown>) => {
        proxyCalls.push({ projectPath, candidate });
        return dispatchOutcome;
      },
    },
  });
  return { registry, proxyCalls, postCalls };
};

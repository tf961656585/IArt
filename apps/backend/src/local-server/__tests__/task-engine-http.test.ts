import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
  setConnectionCredential,
} from "../provider-connection/connection-store.cts";
import {
  clearCacheForTest as clearActiveRouteCache,
  setActiveDeployment,
} from "../provider-connection/active-route-store.cts";
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from "../provider-connection/custom-generation-model-store.cts";
import { setCredentialForConnection } from "../provider-connection/credential-store.cts";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

type ExecuteHttpTask = (
  record: unknown,
  controller: AbortController,
) => Promise<unknown>;

const loadExecuteHttpTask = async (): Promise<ExecuteHttpTask> => {
  const imported = await import("../task-engine-http.cts");
  const importedModule = imported as {
    default?: unknown;
    "module.exports"?: unknown;
    executeHttpTask?: unknown;
  };
  const defaultExport =
    importedModule.default ?? importedModule["module.exports"] ?? imported;
  const exportRecord =
    defaultExport && typeof defaultExport === "object"
      ? (defaultExport as { executeHttpTask?: unknown })
      : importedModule;
  const executeHttpTask = exportRecord.executeHttpTask;
  if (typeof executeHttpTask !== "function") {
    throw new Error("executeHttpTask export missing");
  }
  return executeHttpTask as ExecuteHttpTask;
};

const writeModelPackage = (
  packageRoot: string,
  packageId: string,
  modelId: string,
) => {
  const packageDir = path.join(packageRoot, packageId);
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: packageId,
    entry_model: {
      model_id: modelId,
      relative_path: "runtime_model.json",
    },
    node_definition: {
      relative_path: "node_definition.json",
    },
    locales: [
      { locale: "zh-CN", relative_path: "locales/zh-CN.json" },
      { locale: "en", relative_path: "locales/en.json" },
    ],
    resources: [],
  });
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), {
    Prompt: "Prompt",
  });
  writeJson(path.join(packageDir, "locales", "en.json"), {
    Prompt: "Prompt",
  });
  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: `node.${packageId}`,
    group_key: "video",
    input_ports: [],
    output_ports: [],
  });
  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: modelId,
    provider_id: "openai",
    capability: {
      input_modalities: ["text"],
      output_modalities: ["video"],
      supports_async_task: true,
    },
    parameter_schema: {
      fields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
        },
      ],
      required_fields: ["prompt"],
    },
    runtime: {
      provider_id: "openai",
      execution_driver: "http_formal_task",
      api_defaults: {
        endpoint: "/v1/async-submit",
        method: "POST",
        contentType: "application/json",
      },
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/async-submit",
      method: "POST",
    },
    result_rule: {
      mode: "sync",
      submit_response_id_path: "/id",
    },
    result_output_mapping: {
      response_mode: "structured_payload",
      output_mapping_rules: [],
    },
  });
};

const buildAsyncTaskRecord = (modelId: string) => ({
  id: "task-async-polling",
  type: "http",
  status: "submitting",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  request: {
    url: "https://provider.example/v1/async-submit",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { prompt: "hello" },
  },
  metadata: {
    modelId,
    model_id: modelId,
    taskExecutionPlan: {
      polling_strategy: {
        request: {
          url_template: "https://provider.example/v1/polling/generate/{id}",
          method: "GET",
        },
        polling: {
          intervalMs: 1,
          maxAttempts: 3,
          successPath: "/data/task_result/videos/0/url",
          statusFieldPaths: ["data.task_status"],
          failureStatuses: ["failed"],
        },
      },
      result_rule: {
        mode: "async",
        submit_response_id_path: "/data/task_id",
      },
      result_output_mapping: {
        response_mode: "structured_payload",
        output_mapping_rules: [
          {
            target: "output.video_url",
            source: {
              kind: "response",
              path: "data.task_result.videos",
            },
            required: false,
            default_value: null,
          },
        ],
      },
    },
  },
});

void test("executeHttpTask: 提交响应任务号在 /data/task_id 时启动轮询，并只对轮询最终响应进入结果物化阶段", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-http-async-"));
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-http-async";
  writeModelPackage(packageRoot, "pkg-http-async", modelId);
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;

  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  const mockFetch: typeof fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url === "https://provider.example/v1/async-submit") {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { task_id: "remote-123", task_status: "submitted" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://provider.example/v1/polling/generate/remote-123") {
      return new Response(
        JSON.stringify({
          data: {
            task_status: "succeed",
            task_result: {
              videos: [{ url: "https://cdn.example.com/video.mp4" }],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  globalThis.fetch = mockFetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const executeHttpTask = await loadExecuteHttpTask();
  const result = await executeHttpTask(
    buildAsyncTaskRecord(modelId),
    new AbortController(),
  );

  assert.deepEqual(fetchCalls, []);
  assert.equal((result as { status?: unknown }).status, "failed");
  assert.equal((result as { error?: { code?: unknown } }).error?.code, "no_active_deployment");
});

void test("executeHttpTask: 有 polling_strategy 但无法按 result_rule 解析远端任务号时失败在轮询启动阶段", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-http-blocked-"));
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-http-blocked";
  writeModelPackage(packageRoot, "pkg-http-blocked", modelId);
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;

  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  const mockFetch: typeof fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url === "https://provider.example/v1/async-submit") {
      return new Response(
        JSON.stringify({
          id: "should-not-be-used",
          code: 0,
          data: { task_status: "submitted" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  globalThis.fetch = mockFetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const executeHttpTask = await loadExecuteHttpTask();
  const result = await executeHttpTask(
    buildAsyncTaskRecord(modelId),
    new AbortController(),
  );

  assert.deepEqual(fetchCalls, []);
  assert.equal((result as { status?: unknown }).status, "failed");
  assert.equal((result as { error?: { code?: unknown } }).error?.code, "no_active_deployment");
});

void test("executeHttpTask: fetch 抛出网络异常时任务失败，error 包含 userMessage、retryable、message 字段", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "task-http-network-err-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-http-network-err";
  writeModelPackage(packageRoot, "pkg-http-network-err", modelId);
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;

  const originalFetch = globalThis.fetch;
  const mockFetch: typeof fetch = async () => {
    throw new TypeError("terminated");
  };
  globalThis.fetch = mockFetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const executeHttpTask = await loadExecuteHttpTask();
  const record = buildAsyncTaskRecord(modelId);
  const result = await executeHttpTask(record, new AbortController());

  const resultRecord = result as {
    status?: unknown;
    error?: {
      code?: unknown;
      userMessage?: unknown;
      retryable?: unknown;
      message?: unknown;
    };
  };

  assert.equal(resultRecord.status, "failed");
  assert.equal(resultRecord.error?.code, "no_active_deployment");
  assert.equal(resultRecord.error?.userMessage, undefined);
  assert.equal(resultRecord.error?.retryable, undefined);
  assert.equal(
    resultRecord.error?.message,
    "model model-http-network-err has no active access target",
    "error.message 应明确说明缺少 active 接入目标（2026-10-19 部署载体退场，措辞随语义改）",
  );
});

void test("executeHttpTask: fetch 抛出非网络异常时任务失败，error 不包含 userMessage 和 retryable（向后兼容）", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "task-http-non-net-err-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-http-non-net-err";
  writeModelPackage(packageRoot, "pkg-http-non-net-err", modelId);
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;

  const originalFetch = globalThis.fetch;
  const mockFetch: typeof fetch = async () => {
    throw new Error("Internal error");
  };
  globalThis.fetch = mockFetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const executeHttpTask = await loadExecuteHttpTask();
  const record = buildAsyncTaskRecord(modelId);
  const result = await executeHttpTask(record, new AbortController());

  const resultRecord = result as {
    status?: unknown;
    error?: {
      code?: unknown;
      userMessage?: unknown;
      retryable?: unknown;
      message?: unknown;
    };
  };

  assert.equal(resultRecord.status, "failed");
  assert.equal(resultRecord.error?.code, "no_active_deployment");
  assert.equal(
    resultRecord.error?.message,
    "model model-http-non-net-err has no active access target",
    `error.message 应明确说明缺少 active 接入目标，实际为: ${String(resultRecord.error?.message)}`,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      resultRecord.error ?? {},
      "userMessage",
    ),
    false,
    "配置阻断 error 不应包含 userMessage 字段",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      resultRecord.error ?? {},
      "retryable",
    ),
    false,
    "配置阻断 error 不应包含 retryable 字段",
  );
});

const seedActiveGenerationModel = async (modelId: string) => {
  const connection = createConnection({
    display_name: "task-http-network",
    base_url: "https://snapshot.example.invalid/v1",
  });
  const credential = await setCredentialForConnection(
    connection.connection_id,
    "sk-task-http-network",
  );
  assert.ok(credential, "credential should be stored");
  if (!credential) throw new Error("credential setup failed");
  setConnectionCredential(
    connection.connection_id,
    credential.credentialRef,
    credential.version,
    true,
  );
  const record = addCustomGenerationModel({
    model_id: modelId,
    connection_id: connection.connection_id,
    family_adapter_id: "openai-image-v1",
    remote_model_id: `remote-${modelId}`,
  });
  assert.equal(record.ok, true, "generation model record should be created");
  if (!record.ok) throw new Error("model setup failed");
  assert.equal(
    setActiveDeployment(modelId, record.model.record_id),
    record.model.record_id,
    "active route should point at the seeded record",
  );
};

void test("executeHttpTask: 网络失败读取 cause 分类，且只发一次请求（不自动重试）", async (t) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-http-net-cause-"));
  const previousRoot = process.env["IART_STORAGE_ROOT"];
  process.env["IART_STORAGE_ROOT"] = storageRoot;
  clearConnectionCache();
  clearActiveRouteCache();
  clearCustomGenerationModelCache();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousRoot === undefined) delete process.env["IART_STORAGE_ROOT"];
    else process.env["IART_STORAGE_ROOT"] = previousRoot;
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomGenerationModelCache();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const modelId = "model-http-net-cause";
  await seedActiveGenerationModel(modelId);
  const executeHttpTask = await loadExecuteHttpTask();
  const result = await executeHttpTask(
    {
      id: "task-http-net-cause",
      type: "http",
      status: "submitting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: {
        url: "https://snapshot.example.invalid/v1/images/generations",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { prompt: "hello" },
      },
      metadata: { modelId, model_id: modelId },
    },
    new AbortController(),
  );

  const resultRecord = result as {
    status?: unknown;
    progress?: { phase?: unknown };
    error?: {
      code?: unknown;
      userMessage?: unknown;
      retryable?: unknown;
      message?: unknown;
    };
  };

  assert.equal(fetchCalls, 1, "网络失败不得自动重试");
  assert.equal(resultRecord.status, "failed");
  assert.equal(resultRecord.error?.code, "task_execution_failed");
  assert.equal(
    resultRecord.error?.userMessage,
    "服务商地址拒绝连接，请检查地址与端口是否正确后重新提交",
  );
  assert.equal(resultRecord.error?.retryable, true);
  assert.equal(resultRecord.progress?.phase, null, "失败任务 progressPhase 必须归零");
  assert.match(
    String(resultRecord.error?.message),
    /ECONNREFUSED|fetch failed/,
    "backend message 保留原始错误细节",
  );
});

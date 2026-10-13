import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("router_tasks_post_server_address_unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: http.Server) => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

const writeModelPackage = (packageRoot: string) => {
  const packageId = "pkg-router-tasks-post";
  const modelId = "router-tasks-post-model";
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
    node_type: "node.router-tasks-post",
    group_key: "image",
    input_ports: [],
    output_ports: [],
  });

  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: modelId,
    provider_id: "openai",
    capability: {
      input_modalities: ["text"],
      output_modalities: ["image"],
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
        endpoint: "/v1/router-tasks-post/generate",
        method: "POST",
        contentType: "application/json",
      },
      payload_rules: {},
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/router-tasks-post/generate",
      method: "POST",
    },
    polling_strategy: {
      request: {
        url_template: "/v1/router-tasks-post/generate/{id}",
        method: "GET",
      },
      polling: {
        intervalMs: 1000,
        maxAttempts: 20,
        statusFieldPaths: ["/status"],
        successStatuses: ["succeeded"],
        failureStatuses: ["failed"],
      },
    },
    result_rule: {
      mode: "async",
      submit_response_id_path: "/id",
    },
    result_output_mapping: {
      response_mode: "structured_payload",
      output_mapping_rules: [
        {
          target: "output.image_url",
          source: { kind: "response", path: "output.image_url" },
          required: false,
          default_value: null,
        },
        {
          target: "output.image_url",
          source: { kind: "response", path: "image_url" },
          required: false,
          default_value: null,
        },
      ],
    },
  });

  return modelId;
};

type TaskCreatePayload = {
  taskId?: unknown;
  message?: unknown;
  error?: unknown;
};

const readTaskCreatePayload = async (
  response: Response,
): Promise<TaskCreatePayload> => {
  const payload: unknown = await response.json();
  return payload && typeof payload === "object"
    ? (payload as TaskCreatePayload)
    : {};
};

void test("router: POST /api/tasks 保留组装后的 formal execution plan，正常执行链请求返回 2xx", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-tasks-post-"));
  const packageRoot = path.join(tempDir, "packages");
  const modelId = writeModelPackage(packageRoot);
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://provider.example/v1/router-tasks-post/generate") {
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({ id: "remote-router-task-1", status: "queued" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const { createRequestHandler } = await import("../router.cts");
  const server = http.createServer(createRequestHandler());
  const baseUrl = await listen(server);

  t.after(async () => {
    await closeServer(server);
    globalThis.fetch = originalFetch;
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model_id: modelId,
      prebuilt_payload: {
        api: {
          endpoint: "https://provider.example/v1/router-tasks-post/generate",
          method: "POST",
          contentType: "application/json",
        },
        body: {
          prompt: "hello task",
        },
      },
      metadata: {
        nodeGraphId: "graph-router-tasks-post",
        sourceNodeId: "node-router-tasks-post",
        executionId: "exec-router-tasks-post",
        modelId: modelId,
      },
    }),
  });

  assert.equal(response.status, 200);
  const payload = await readTaskCreatePayload(response);
  assert.equal(typeof payload.taskId, "string");
  assert.match(String(payload.taskId), /^task_/);
});

void test("router: POST /api/tasks 非法请求保留可读 4xx 原因", async (t) => {
  const { createRequestHandler } = await import("../router.cts");
  const server = http.createServer(createRequestHandler());
  const baseUrl = await listen(server);

  t.after(async () => {
    await closeServer(server);
  });

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prebuilt_payload: {
        body: {
          prompt: "missing model id",
        },
      },
    }),
  });

  assert.equal(response.status, 400);
  const payload = await readTaskCreatePayload(response);
  assert.equal(payload.message ?? payload.error, "Missing model_id");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareModelInputForRequest } from "../model-input-preparation/model-input-preparation.cts";

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

const writeModelPackage = (
  packageRoot: string,
  modelId: string,
  runtimePatch: object,
) => {
  const packageId = `pkg-${modelId}`;
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
    Images: "Images",
    Audio: "Audio",
    Reference: "Reference",
  });
  writeJson(path.join(packageDir, "locales", "en.json"), {
    Images: "Images",
    Audio: "Audio",
    Reference: "Reference",
  });
  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: `node.${modelId}`,
    group_key: "test",
    input_ports: [],
    output_ports: [],
  });
  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: modelId,
    provider_id: "openai",
    capability: {
      input_modalities: ["text", "image"],
      output_modalities: ["image"],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [
        {
          field_key: "images",
          label: "Images",
          component: "imageUpload",
          required: false,
        },
        {
          field_key: "audio",
          label: "Audio",
          component: "file",
          required: false,
        },
        {
          field_key: "reference",
          label: "Reference",
          component: "imageUpload",
          required: false,
        },
      ],
      required_fields: [],
    },
    runtime: {
      provider_id: "openai",
      execution_driver: "http_formal_task",
      api_defaults: {
        endpoint: "/v1/model-input-preparation",
        method: "POST",
        contentType: "application/json",
      },
      ...runtimePatch,
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/model-input-preparation",
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

const withPackageRoot = (t: test.TestContext, packageRoot: string) => {
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  t.after(() =>
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot),
  );
};

void test("ModelInputPreparation: public URL 字段统一消费 MediaRefPlaceholder、data URL 与裸 base64", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "model-input-prep-public-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-input-prep-public-url";
  writeModelPackage(packageRoot, modelId, {
    url_input_upload_mode: "public_relay",
    url_input_upload_target_type: "self_hosted_image_public_url",
    payload_rules: {
      "body.images": {
        kind: "field",
        field_key: "images",
        media_target: "public_url",
        transforms: ["extractUrls"],
      },
    },
  });
  withPackageRoot(t, packageRoot);

  const previousEndpoint =
    process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"];
  process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"] =
    "https://upload.example.com/relay";
  const originalFetch = globalThis.fetch;
  let uploadCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://upload.example.com/relay");
    uploadCount += 1;
    return new Response(
      JSON.stringify({
        success: true,
        url: `https://cdn.example.com/input-${uploadCount}.png`,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(
      "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT",
      previousEndpoint,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: tempDir,
    body: {
      images: [
        {
          __media_ref__: true,
          source: { kind: "inline_data", data: "aGVsbG8=", mimeType: "image/png" },
          mimeType: "image/png",
          filename: "media-ref.png",
          fieldPath: "body.images",
        },
        "data:image/png;base64,aGVsbG8=",
        Buffer.from("raw-base64-source").toString("base64"),
      ],
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  assert.equal(uploadCount, 3);
  assert.deepEqual((prepared.body as { images?: unknown }).images, [
    "https://cdn.example.com/input-1.png",
    "https://cdn.example.com/input-2.png",
    "https://cdn.example.com/input-3.png",
  ]);
  assert.equal(
    prepared.events.filter(
      (event) => event.type === "task.input_upload_succeeded",
    ).length,
    3,
  );
});

void test("ModelInputPreparation: 音频 public URL 字段通过 Cloudflare relay 准备", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "model-input-prep-audio-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-input-prep-audio-url";
  writeModelPackage(packageRoot, modelId, {
    url_input_upload_mode: "public_relay",
    url_input_upload_target_type: "cloudflare_image_public_url",
    payload_rules: {
      "body.input.audio_url": {
        kind: "field",
        field_key: "audio",
        media_target: "public_url",
        transforms: ["extractFirstUrl"],
      },
    },
  });
  withPackageRoot(t, packageRoot);

  const previousEndpoint =
    process.env["IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT"];
  process.env["IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT"] =
    "https://upload.example.com/cloudflare";
  const originalFetch = globalThis.fetch;
  let uploadCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://upload.example.com/cloudflare");
    uploadCount += 1;
    return new Response(
      JSON.stringify({
        success: true,
        url: "https://cdn.example.com/input-audio.mp3",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(
      "IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT",
      previousEndpoint,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: tempDir,
    body: {
      input: {
        audio_url: {
          __media_ref__: true,
          source: { kind: "inline_data", data: "YXVkaW8=", mimeType: "audio/mpeg" },
          mimeType: "audio/mpeg",
          filename: "audio.mp3",
          fieldPath: "body.input.audio_url",
        },
      },
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  assert.equal(uploadCount, 1);
  assert.deepEqual((prepared.body as { input?: { audio_url?: unknown } }).input, {
    audio_url: "https://cdn.example.com/input-audio.mp3",
  });
});

void test("ModelInputPreparation: public relay endpoint 不可用时本地失败且不产出最终请求", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "model-input-prep-missing-endpoint-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-input-prep-missing-endpoint";
  writeModelPackage(packageRoot, modelId, {
    url_input_upload_mode: "public_relay",
    url_input_upload_target_type: "self_hosted_image_public_url",
    payload_rules: {
      "body.images": {
        kind: "field",
        field_key: "images",
        media_target: "public_url",
        transforms: ["extractUrls"],
      },
    },
  });
  withPackageRoot(t, packageRoot);

  const previousEndpoint =
    process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"];
  process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"] =
    "not-a-url";
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}");
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(
      "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT",
      previousEndpoint,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const prepared = await prepareModelInputForRequest({
    modelId,
    projection: {
      model_id: modelId,
      runtime: {
        url_input_upload_mode: "public_relay",
        url_input_upload_target_type: "self_hosted_image_public_url",
        payload_rules: {
          "body.images": {
            kind: "field",
            field_key: "images",
            media_target: "public_url",
            transforms: ["extractUrls"],
          },
        },
      },
    },
    body: {
      images: ["data:image/png;base64,aGVsbG8="],
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.equal(prepared.error.code, "public_relay_target_endpoint_invalid");
  }
  assert.equal(fetchCalled, false);
});

void test("ModelInputPreparation: multipart 模型不被 public URL guard 误伤", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "model-input-prep-multipart-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-input-prep-multipart";
  writeModelPackage(packageRoot, modelId, {
    payload_format: "multipart",
    payload_rules: {
      "body.input_reference": {
        kind: "field",
        field_key: "reference",
        media_target: "multipart_file",
        transforms: ["extractFirstFile"],
      },
    },
  });
  withPackageRoot(t, packageRoot);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const body = {
    __formData: {
      fields: [{ name: "model", value: "multipart-model" }],
      files: [
        {
          name: "input_reference",
          filename: "reference.png",
          contentType: "image/png",
          dataBase64: Buffer.from("mock-image").toString("base64"),
        },
      ],
    },
  };
  const prepared = await prepareModelInputForRequest({ modelId, body } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.body, body);
});

void test("task engine: prebuilt payload 远端请求前仍经过模型输入准备层", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "model-input-prep-engine-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "model-input-prep-engine";
  writeModelPackage(packageRoot, modelId, {
    url_input_upload_mode: "public_relay",
    url_input_upload_target_type: "self_hosted_image_public_url",
    payload_rules: {
      "body.images": {
        kind: "field",
        field_key: "images",
        media_target: "public_url",
        transforms: ["extractUrls"],
      },
    },
  });
  withPackageRoot(t, packageRoot);

  const previousEndpoint =
    process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"];
  process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"] =
    "https://upload.example.com/relay";
  const originalFetch = globalThis.fetch;
  let remoteRequestBody: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://upload.example.com/relay") {
      return new Response(
        JSON.stringify({
          success: true,
          url: "https://cdn.example.com/prebuilt.png",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url === "https://gateway.example.com/v1/model-input-preparation") {
      remoteRequestBody =
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(
      "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT",
      previousEndpoint,
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeHttpTask } = await import("../task-engine.cts");
  const result = await executeHttpTask(
    {
      id: "task-prebuilt-model-input-prep",
      type: "http",
      status: "submitting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      request: {
        url: "https://gateway.example.com/v1/model-input-preparation",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          prompt: "prebuilt payload",
          images: ["data:image/png;base64,aGVsbG8="],
        },
      },
      metadata: {
        modelId,
        model_id: modelId,
      },
    },
    new AbortController(),
  );

  assert.equal((result as { status?: unknown }).status, "failed");
  assert.equal(
    (result as { error?: { code?: unknown } }).error?.code,
    "no_active_deployment",
  );
  assert.equal(remoteRequestBody, null);
});

// ---------------------------------------------------------------------------
// 回归测试：payload_format_rule 求值
//
// gpt-image-2 等合并节点只声明 payload_format_rule（无静态 payload_format），
// 输入准备期必须求值此规则才能正确判定 multipart vs json。
// 修复前 resolveModelInputPolicy 只读静态 runtime.payload_format，忽略
// payload_format_rule，导致图生图场景永远 fallback 到 json，multipart 不生效。
// 使用 inline projection 直接测试 resolveModelInputPolicy 的规则求值逻辑，
// 避免依赖 catalog 加载环境。
// ---------------------------------------------------------------------------

const buildPayloadFormatRuleProjection = (modelId: string) => ({
  model_id: modelId,
  runtime: {
    payload_format_rule: {
      kind: "when" as const,
      condition: { op: "ne" as const, field: "image", value: [] },
      truthy: { kind: "literal" as const, value: "multipart" },
      falsy: { kind: "literal" as const, value: "json" },
    },
    payload_rules: {
      "body.image": {
        kind: "field",
        field_key: "image",
        media_target: "multipart_file",
        transforms: ["extractFirstFile"],
      },
    },
  },
});

void test("ModelInputPreparation: payload_format_rule 图生图场景求值为 multipart", async () => {
  const modelId = "model-input-prep-rule-multipart";
  const body = {
    model: modelId,
    prompt: "一只小猫",
    image: [
      {
        __media_ref__: true,
        source: {
          kind: "inline_data",
          data: Buffer.from("fake-png").toString("base64"),
          mimeType: "image/png",
        },
        transport: "multipart_file",
        fieldPath: "body.image",
      },
    ],
  };
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: undefined,
    projection: buildPayloadFormatRuleProjection(modelId),
    body,
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const preparedBody = prepared.body as {
      __formData?: {
        files: Array<{ name: string; dataBase64: string }>;
        fields: Array<{ name: string; value: string }>;
      };
    };
    assert.ok(
      preparedBody.__formData,
      "图生图场景 body 应被序列化为 __formData（multipart）",
    );
    assert.ok(
      preparedBody.__formData && preparedBody.__formData.files.length > 0,
      "image 字段应作为 file part 存在",
    );
  }
});

void test("ModelInputPreparation: payload_format_rule 文生图场景求值为 json", async () => {
  const modelId = "model-input-prep-rule-json";
  const body = {
    model: modelId,
    prompt: "一只小猫",
    image: [],
  };
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: undefined,
    projection: buildPayloadFormatRuleProjection(modelId),
    body,
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const preparedBody = prepared.body as { __formData?: unknown };
    assert.equal(
      preparedBody.__formData,
      undefined,
      "文生图场景 body 不应被序列化为 __formData（json）",
    );
  }
});

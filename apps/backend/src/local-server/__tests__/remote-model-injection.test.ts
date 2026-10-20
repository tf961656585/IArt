import assert from "node:assert/strict";
import test from "node:test";

import { applyRemoteModelInjection } from "../provider-connection/remote-model-injection.cts";
import { buildRequestBody } from "../task-engine-request.cts";
import { isSerializedFormDataBody } from "@iart/contracts";
import { ExecutionSnapshotSchema } from "@iart/contracts";

const buildSnapshot = (adapterId: string, remoteModelId: string) =>
  ExecutionSnapshotSchema.parse({
    snapshot_id: `snap_test_${adapterId}`,
    model_id: "gpt-image-2",
    model_version: "1.0.0",
    deployment_id: `up_dep_${adapterId.replace(/[^a-z0-9-_]/g, "-")}`,
    connection_id: "up_conn_test",
    connection_revision: 1,
    adapter_id: adapterId,
    adapter_version: "1.0.0",
    base_url: "https://provider.example",
    remote_model_id: remoteModelId,
    credential_ref: "cred_up_conn_test",
    credential_version: 1,
    resolved_endpoint: "https://provider.example/v1/placeholder",
    created_at: new Date().toISOString(),
  });

// i2i multipart 场景（PromptDock 引用图片 → /v1/images/edits）：prepared body 是
// SerializedFormDataBody，model 以 __formData.fields 表单字段上 wire。回归背景：
// 注入层曾只改 plain object 顶层 model 属性，buildRequestBody 的 multipart 分支
// 只读 __formData，导致远端收到产品 model_id 而非 remote_model_id（429 事故 2026-09-04）。
void test("openai-image-v1 multipart body：model 表单字段注入 remote_model_id，替换产品 model_id 字面量", () => {
  const snapshot = buildSnapshot("openai-image-v1", "gpt-image-2-c");
  const preparedBody = {
    __formData: {
      fields: [
        { name: "model", value: "gpt-image-2" },
        { name: "prompt", value: "换成小狗吃鱼" },
        { name: "size", value: "auto" },
      ],
      files: [
        {
          name: "image[0]",
          dataBase64: "aGVsbG8=",
          contentType: "application/octet-stream",
          filename: "file",
        },
      ],
    },
  };
  const injected = applyRemoteModelInjection({
    snapshot,
    url: "/v1/images/edits",
    body: preparedBody,
  });
  assert.equal(injected.url, "/v1/images/edits");
  assert.ok(isSerializedFormDataBody(injected.body));
  if (!isSerializedFormDataBody(injected.body)) return;
  assert.deepEqual(
    injected.body.__formData.fields,
    [
      { name: "model", value: "gpt-image-2-c" },
      { name: "prompt", value: "换成小狗吃鱼" },
      { name: "size", value: "auto" },
    ],
  );
  // 文件 part 原样保留，注入不触碰媒体数据。
  assert.equal(injected.body.__formData.files.length, 1);
  assert.equal(injected.body.__formData.files[0]?.name, "image[0]");
  // 注入不回写原 prepared body（不写回能力包 payload 语义）。
  assert.equal(
    preparedBody.__formData.fields.find((field) => field.name === "model")?.value,
    "gpt-image-2",
  );
});

void test("openai-image-v1 multipart body：fields 缺失 model 字段时补插，fields 运行时缺失时兜底", () => {
  const snapshot = buildSnapshot("openai-image-v1", "gpt-image-2-c");
  const withoutModelField = applyRemoteModelInjection({
    snapshot,
    url: "/v1/images/edits",
    body: {
      __formData: {
        fields: [{ name: "prompt", value: "hi" }],
        files: [],
      },
    },
  });
  assert.ok(isSerializedFormDataBody(withoutModelField.body));
  if (!isSerializedFormDataBody(withoutModelField.body)) return;
  assert.deepEqual(withoutModelField.body.__formData.fields, [
    { name: "model", value: "gpt-image-2-c" },
    { name: "prompt", value: "hi" },
  ]);

  // isSerializedFormDataBody 允许 fields 数组运行时缺失（只要求 fields 或 files 存在），
  // 注入不得抛错，且必须产出含 model 的 fields。
  const missingFields = applyRemoteModelInjection({
    snapshot,
    url: "/v1/images/edits",
    body: { __formData: { files: [] } },
  });
  assert.ok(isSerializedFormDataBody(missingFields.body));
  if (!isSerializedFormDataBody(missingFields.body)) return;
  assert.deepEqual(missingFields.body.__formData.fields, [
    { name: "model", value: "gpt-image-2-c" },
  ]);
});

void test("openai-image-v1 JSON body（t2i）：顶层 model 注入不回归", () => {
  const snapshot = buildSnapshot("openai-image-v1", "gpt-image-2-c");
  const injected = applyRemoteModelInjection({
    snapshot,
    url: "/v1/images/generations",
    body: { model: "gpt-image-2", prompt: "hello", size: "auto" },
  });
  assert.deepEqual(injected.body, { model: "gpt-image-2-c", prompt: "hello", size: "auto" });
});

void test("openai-image-v1 非 JSON 且非 multipart body：阻断并报错（不静默降级）", () => {
  const snapshot = buildSnapshot("openai-image-v1", "gpt-image-2-c");
  assert.throws(
    () => applyRemoteModelInjection({ snapshot, url: "/v1/images/edits", body: "raw-string" }),
    /requires a JSON object body/,
  );
});

// 集成断言：注入结果经 buildRequestBody 构造的 wire FormData，model 必须是 remote_model_id。
void test("openai-image-v1 i2i 全链：注入后 buildRequestBody 产出的 FormData model = remote_model_id", async () => {
  const snapshot = buildSnapshot("openai-image-v1", "gpt-image-2-c");
  const injected = applyRemoteModelInjection({
    snapshot,
    url: "/v1/images/edits",
    body: {
      __formData: {
        fields: [
          { name: "model", value: "gpt-image-2" },
          { name: "prompt", value: "换成小狗吃鱼" },
        ],
        files: [
          {
            name: "image[0]",
            dataBase64: Buffer.from("fake-png").toString("base64"),
            contentType: "application/octet-stream",
            filename: "file",
          },
        ],
      },
    },
  });
  const headers = new Headers();
  const wireBody = buildRequestBody(injected.body, headers);
  assert.ok(wireBody instanceof FormData);
  assert.equal(wireBody.get("model"), "gpt-image-2-c");
  assert.equal(wireBody.get("prompt"), "换成小狗吃鱼");
  assert.ok(wireBody.get("image[0]") instanceof Blob);
});

// 可灵新标准（2026-10-19 拆成三个提交端点）：模型身份在 URL path，请求体**没有**模型字段。
// 三个 id 都必须归 URL 模板类——归入 body 类会向上游多注入一个其契约未定义的顶层 model。
void test("可灵三个适配器：请求体不注入 model（模型身份在 URL path）", () => {
  for (const adapterId of ["kling-text2video-v1", "kling-image2video-v1", "kling-omni-video-v1"]) {
    const snapshot = buildSnapshot(adapterId, "kling-v3");
    const injected = applyRemoteModelInjection({
      snapshot,
      url: "/text-to-video/kling-3.0",
      body: { prompt: "hello", settings: { duration: 5 } },
    });
    assert.deepEqual(
      injected.body,
      { prompt: "hello", settings: { duration: 5 } },
      `${adapterId} 的请求体不得被注入 model 字段`,
    );
    // 非对象 body 也不得报「requires a JSON object body」——它们根本不在 body 注入类里。
    assert.deepEqual(applyRemoteModelInjection({ snapshot, url: "/tasks?task_ids=x", body: "raw" }).body, "raw");
  }
});

void test("可灵三个适配器：URL 无 {model} 占位时替换是惰性的（分类事实仍成立）", () => {
  for (const [adapterId, url, expected] of [
    ["kling-text2video-v1", "https://provider.example/text-to-video/kling-3.0", "https://provider.example/text-to-video/kling-3.0"],
    ["kling-image2video-v1", "https://provider.example/image-to-video/kling-3.0", "https://provider.example/image-to-video/kling-3.0"],
    ["kling-omni-video-v1", "https://provider.example/omni-video/kling-3.0-omni", "https://provider.example/omni-video/kling-3.0-omni"],
  ] as const) {
    const snapshot = buildSnapshot(adapterId, "kling-v3");
    const injected = applyRemoteModelInjection({ snapshot, url, body: {} });
    assert.equal(injected.url, expected, `${adapterId} 当前路径不含占位符，替换惰性`);
  }

  // 分类事实可验证：同一适配器拿到含 {model} 的模板时替换立即生效。
  const veoSnapshot = buildSnapshot("veo-v1", "veo-3.1-generate");
  assert.equal(
    applyRemoteModelInjection({
      snapshot: veoSnapshot,
      url: "https://provider.example/v1beta/models/{model}:predictLongRunning",
      body: {},
    }).url,
    "https://provider.example/v1beta/models/veo-3.1-generate:predictLongRunning",
  );
});

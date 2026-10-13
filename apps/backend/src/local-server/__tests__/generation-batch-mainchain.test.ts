import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionSnapshotSchema,
  ExecutableModelCatalogResponseSchema,
  PromptDockBatchSubmitResponseSchema,
  TaskCancelAcceptedResponseSchema,
  UNIFIED_GENERATION_RUNNING_STATUSES,
  UNIFIED_GENERATION_STATUSES,
} from "@iart/contracts";
import { applyRemoteModelInjection } from "../provider-connection/remote-model-injection.cts";
import { createTaskRecordFromFormalSpec } from "../task-store.cts";
import {
  buildCancelRecord,
  isUnsettledCancelRecord,
  readCancelRecord,
} from "../task-cancel-service.cts";

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

void test("PromptDock 主链新契约：cancelled 状态、取消响应、目录 DTO、批次原子校验与四类 adapter remote_model_id 注入", () => {
  // A: 状态集合同源（cancelled 现役终态；运行态集合不含它）。
  assert.ok(UNIFIED_GENERATION_STATUSES.includes("cancelled"));
  assert.ok(UNIFIED_GENERATION_STATUSES.includes("submitting"));
  assert.ok(UNIFIED_GENERATION_RUNNING_STATUSES.includes("submitting"));
  assert.ok(!(UNIFIED_GENERATION_RUNNING_STATUSES as readonly string[]).includes("cancelled"));

  // A: 批次受理响应在 tasks 数量 != snapshot task_count 时必须被 schema 拒绝（原子受理）。
  const intent = {
    batch_id: "batch_1",
    model_id: "gpt-image-2",
    model_version: "1.0.0",
    prompt: "hi",
    params: { size: "auto" },
    task_count: 2,
    task_ids: ["task_1", "task_2"],
    created_at: new Date().toISOString(),
  };
  const mismatchBatch = PromptDockBatchSubmitResponseSchema.safeParse({
    batch_id: "batch_1",
    intent_snapshot: intent,
    tasks: [{ task_id: "task_1", task_index: 0 }],
  });
  assert.equal(mismatchBatch.success, false);
  const okBatch = PromptDockBatchSubmitResponseSchema.safeParse({
    batch_id: "batch_1",
    intent_snapshot: intent,
    tasks: [
      { task_id: "task_1", task_index: 0 },
      { task_id: "task_2", task_index: 1 },
    ],
  });
  assert.equal(okBatch.success, true);

  // C: 取消命令 accepted 响应 DTO parse。
  const cancelAccepted = TaskCancelAcceptedResponseSchema.parse({
    accepted: true,
    task_id: "task_1",
    cancelled_at: new Date().toISOString(),
  });
  assert.equal(cancelAccepted.accepted, true);

  // C: 取消记录强类型 + 未结算判定（backend 本地，恢复路径据此先结算 cancelled）。
  const cancelRecord = buildCancelRecord("task_1", new Date().toISOString());
  assert.equal(cancelRecord.settledAt, null);
  assert.equal(readCancelRecord({ taskCancelRecord: cancelRecord })?.taskId, "task_1");
  assert.equal(isUnsettledCancelRecord({ taskCancelRecord: cancelRecord }), true);
  assert.equal(isUnsettledCancelRecord({ taskCancelRecord: { ...cancelRecord, settledAt: new Date().toISOString() } }), false);
  assert.equal(isUnsettledCancelRecord({}), false);

  // D: 可执行目录 DTO（camelCase）可 parse；不泄露凭证、Seedance 2.5 不外显由路由过滤。
  const catalog = ExecutableModelCatalogResponseSchema.parse({
    models: [
      {
        model_id: "gpt-image-2",
        model_version: "1.0.0",
        default_task_type: "image",
        display_order: 100,
        capability: {
          input_modalities: ["text", "image"],
          output_modalities: ["image"],
          supports_multi_image: true,
          supports_reference_media: true,
        },
        parameter_schema: {
          fields: [
            { fieldKey: "prompt", label: "Prompt", component: "textarea", required: true },
            {
              fieldKey: "size",
              label: "Size",
              component: "select",
              required: false,
              enumOptions: [{ value: "1024x1024" }, { value: "auto", label: "Auto" }],
            },
          ],
          required_fields: ["prompt"],
          default_values: { size: "auto" },
        },
        deployment: {
          has_active_deployment: true,
          active_deployment_id: "up_dep_openai_image",
          deployable: true,
          failure_code: "none",
        },
      },
    ],
  });
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]?.parameter_schema.fields.length, 2);

  // B: openai-image-v1 —— body 顶层 model 注入 remote_model_id（不是产品 model_id）。
  const openaiSnapshot = buildSnapshot("openai-image-v1", "gpt-image-2-custom");
  const openaiInjected = applyRemoteModelInjection({
    snapshot: openaiSnapshot,
    url: "/v1/images/generations",
    body: { prompt: "hello", model: "gpt-image-2" },
  });
  assert.equal(openaiInjected.url, "/v1/images/generations");
  assert.deepEqual(openaiInjected.body, { prompt: "hello", model: "gpt-image-2-custom" });

  // B: gemini-image-interactions-v1 —— Interactions 端点 `/v1beta/interactions` 无 `{model}` 占位符，
  // 产品模型身份由请求体顶层 `model` 承载，注入 remote_model_id 而非 URL 编码替换。
  const geminiSnapshot = buildSnapshot("gemini-image-interactions-v1", "gemini/3.1-flash-image");
  const geminiInjected = applyRemoteModelInjection({
    snapshot: geminiSnapshot,
    url: "/v1beta/interactions",
    body: { model: "gemini-3.1-flash-image", input: "hi" },
  });
  assert.equal(geminiInjected.url, "/v1beta/interactions");
  assert.deepEqual(geminiInjected.body, {
    model: "gemini/3.1-flash-image",
    input: "hi",
  });

  // B: veo-v1 —— URL 模板 {model} 替换（predictLongRunning 路径）。
  const veoSnapshot = buildSnapshot("veo-v1", "veo-3.1-generate-preview");
  const veoInjected = applyRemoteModelInjection({
    snapshot: veoSnapshot,
    url: "/v1beta/models/{model}:predictLongRunning",
    body: { instances: [{ prompt: "video" }] },
  });
  assert.equal(veoInjected.url, "/v1beta/models/veo-3.1-generate-preview:predictLongRunning");
  assert.deepEqual(veoInjected.body, { instances: [{ prompt: "video" }] });

  // B: seedance-2-0-v1 —— body 顶层 model 注入 remote_model_id（Seedance 2.0 创建任务契约）。
  const seedanceSnapshot = buildSnapshot("seedance-2-0-v1", "doubao-seedance-2-0-260128");
  const seedanceInjected = applyRemoteModelInjection({
    snapshot: seedanceSnapshot,
    url: "/api/v3/contents/generations/tasks",
    body: { content: [{ type: "text", text: "video" }] },
  });
  assert.equal(seedanceInjected.url, "/api/v3/contents/generations/tasks");
  assert.deepEqual(seedanceInjected.body, {
    model: "doubao-seedance-2-0-260128",
    content: [{ type: "text", text: "video" }],
  });
});

void test("batch 受理：调用方显式铸造的 taskId 必须原样落库（受理响应 = 投影唯一事实源，通知不得换 ID）", () => {
  const spec = {
    request: { url: "https://provider.example/v1/images/generations", method: "POST", headers: {} },
    type: "http",
    polling: null,
    metadata: {
      modelId: "gpt-image-2",
      model_id: "gpt-image-2",
      batchId: "batch_idfork",
      batch_id: "batch_idfork",
      taskIndex: 0,
      projectPath: "/tmp/idfork.iartproj",
    },
    autoStart: true,
  };
  const assignedTaskId = "task_deterministic-from-accept-response";
  const record = createTaskRecordFromFormalSpec(spec, {
    actionId: undefined,
    actionName: "runtime.batch.task.created",
    actionClass: "business_async",
    compatMode: "generation_batch_accept",
    submissionTransport: "http",
    preserveLegacyTaskId: false,
    taskId: assignedTaskId,
  });
  assert.ok(record);
  assert.equal(record.taskId, assignedTaskId);
  assert.equal(record.metadata.taskId, assignedTaskId);

  // 对照：调用方未显式提供 taskId（compat /api/tasks 路径）时仍铸造新 ID，零回归。
  const legacy = createTaskRecordFromFormalSpec(spec, {
    actionId: undefined,
    actionName: "runtime.task.created",
    actionClass: "business_async",
    compatMode: "formal_task_submit",
    submissionTransport: "http",
    preserveLegacyTaskId: false,
    taskId: undefined,
  });
  assert.ok(legacy);
  assert.notEqual(legacy.taskId, assignedTaskId);
  assert.match(legacy.taskId, /^task_/);
});

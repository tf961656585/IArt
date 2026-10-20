/**
 * openai-image 族的 t2i / i2i wire 双链测试（backend 侧）。
 *
 * 覆盖 editor 侧无法触达的两段真实主链：
 * 1. t2i JSON wire 的 remote_model_id 注入：族模板 payload_rules → 生产 evaluateRule
 *    求值出 body → openai-image-v1 注入 remote_model_id → buildRequestBody 产出 wire JSON
 *    （model 被替换、output_format 在、format 不在、quality 透传）；edits multipart
 *    prepared form 同链验证表单字段级注入（429 事故回归面）。
 *
 * 历史：本用例原从磁盘上的两个真实能力包加载 runtime_model。2026-10-20 模型能力包退场、
 * 包目录删除后，同样的链路由 **openai-image 族模板 + 记录级参数覆盖** 承载：`xhigh`/`max` 正是「模型个性档位不入族模板、由记录收窄/扩档」的典型用法
 * （见 generation-family-templates.openai-image.cts 的 quality 字段注释），因此这里用参数覆盖
 * 把 quality 档位扩到 xhigh/max——覆盖的是同一条记录 → 模板 → 投影 → 求值 → 注入链。
 *
 * 目录投影不再单独断言「包 → 目录」：模型来源唯一是用户记录（spec 03 PC-15），投影在本用例
 * 中作为求值输入的来源出现（`projectFamilyTemplate`），不做独立断言。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionSnapshotSchema, isSerializedFormDataBody } from "@iart/contracts";
import { applyRemoteModelInjection } from "../provider-connection/remote-model-injection.cts";
import { evaluateRule } from "../request-assembler-runtime.cts";
import type { EvaluateState } from "../request-assembler-shared.cts";
import { buildRequestBody } from "../task-engine-request.cts";
import {
  OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID,
} from "../generation-family-templates.openai-image.cts";
import { buildFamilyTemplateSources } from "../generation-family-templates.registry.cts";
import type { CatalogProjection } from "../model-package-catalog.types.cts";
import { projectFamilyTemplateSources } from "./family-template-projection-test-helpers";

// 族模板不接受素材位时是纯 t2i 形态（静态 json）；本用例的 t2i 求值走该形态。
const T2I_MODEL_ID = "declared-openai-image-t2i-wire";

/** 记录级参数覆盖：把 quality 枚举扩到该型号的个性档位（xhigh / max）。 */
const qualityOverride = (quality: "xhigh" | "max") => ({
  official: [
    {
      field_key: "quality",
      enum_options: ["auto", "xhigh", "max"],
      default_value: quality,
    },
  ],
  custom: [],
});

/** 取一条记录 × 族模板合成后的投影（记录侧只有参数覆盖，不带素材位）。 */
const buildT2iProjection = (modelId: string, quality: "xhigh" | "max"): CatalogProjection => {
  const built = buildFamilyTemplateSources(OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID, modelId, {
    acceptedMediaSlots: [],
    parameterOverrides: qualityOverride(quality),
  });
  assert.equal(built.kind, "ready");
  if (built.kind !== "ready") throw new Error("unreachable_family_not_ready");
  // 已合成的 sources 直接投影（含记录覆盖），不再走一次基础模板构建。
  return projectFamilyTemplateSources({
    familyAdapterId: OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID,
    modelId,
    sources: built.sources,
  }).projection;
};

const QUALITY_CASES: Array<{ quality: "xhigh" | "max" }> = [
  { quality: "xhigh" },
  { quality: "max" },
];

const buildSnapshot = (modelId: string, remoteModelId: string) =>
  ExecutionSnapshotSchema.parse({
    snapshot_id: `snap_real_${modelId.replace(/[^a-z0-9-_]/g, "-")}`,
    model_id: modelId,
    model_version: "1.0.0",
    deployment_id: "up_dep_openai_image",
    connection_id: "up_conn_test",
    connection_revision: 1,
    adapter_id: "openai-image-v1",
    adapter_version: "1.0.0",
    base_url: "https://provider.example",
    remote_model_id: remoteModelId,
    credential_ref: "cred_up_conn_test",
    credential_version: 1,
    resolved_endpoint: "https://provider.example/v1/images/generations",
    created_at: new Date().toISOString(),
  });

/** 用投影后的 payload_rules + 生产 evaluateRule 求值 t2i JSON body（image 为空路径）。 */
const evaluateT2iBody = async (
  projection: CatalogProjection,
  quality: string,
): Promise<Record<string, unknown>> => {
  const payloadRules = projection.runtime.payload_rules;
  assert.ok(payloadRules !== undefined, "投影必须携带 runtime.payload_rules");
  const state: EvaluateState = {
    fields: {
      __prompt: "  a quiet studio  ",
      image: [],
      size: "auto",
      quality,
      format: "jpeg",
      moderation: "auto",
    },
    runtime: {},
    projection: {},
    currentItem: undefined,
    projectPath: null,
  };
  const body: Record<string, unknown> = {};
  const bodyRuleKeys = Object.keys(payloadRules)
    .filter((key) => key.startsWith("body."))
    .sort();
  assert.ok(bodyRuleKeys.includes("body.model"));
  assert.ok(bodyRuleKeys.includes("body.output_format"));
  assert.ok(!bodyRuleKeys.includes("body.format"), "body.format 规则不得回归");
  for (const ruleKey of bodyRuleKeys) {
    const value = await evaluateRule(payloadRules[ruleKey] ?? null, state);
    if (value === undefined) continue;
    body[ruleKey.slice("body.".length)] = value;
  }
  return body;
};

void test("t2i JSON wire：族模板规则求值 → openai-image-v1 注入 remote_model_id → buildRequestBody", async () => {
  for (const { quality } of QUALITY_CASES) {
    const modelId = `${T2I_MODEL_ID}-${quality}`;
    const projection = buildT2iProjection(modelId, quality);
    const body = await evaluateT2iBody(projection, quality);

    // 注入前：body.model 字面量是产品 model_id（注入点占位）
    assert.equal(body["model"], modelId);
    assert.equal(body["quality"], quality);
    assert.equal(body["output_format"], "jpeg");
    assert.equal(body["format"], undefined, "wire 不得出现 OpenAI 未定义的 format");
    assert.equal(body["n"], 1);
    assert.equal(body["prompt"], "a quiet studio");

    const remoteModelId = `${modelId}-remote-2026-09-08`;
    const snapshot = buildSnapshot(modelId, remoteModelId);
    const injected = applyRemoteModelInjection({
      snapshot,
      url: "/v1/images/generations",
      body,
    });
    const headers = new Headers();
    const wire = buildRequestBody(injected.body, headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.ok(typeof wire === "string", "t2i wire body 必须是 JSON 字符串");
    if (typeof wire !== "string") return;

    const wireJson = JSON.parse(wire) as Record<string, unknown>;
    // model 被 deployment 冻结的 remote_model_id 覆盖，产品 model_id 不上 wire
    assert.equal(wireJson["model"], remoteModelId);
    assert.notEqual(wireJson["model"], modelId);
    // output_format 在、format 不在、quality 透传
    assert.equal(wireJson["output_format"], "jpeg");
    assert.equal(wireJson["format"], undefined);
    assert.equal(wireJson["quality"], quality);
    assert.equal(wireJson["prompt"], "a quiet studio");
  }
});

void test("edits multipart wire：族模板标量规则物化为表单字段，model 字段注入 remote_model_id", async () => {
  for (const { quality } of QUALITY_CASES) {
    const modelId = `${T2I_MODEL_ID}-${quality}`;
    const projection = buildT2iProjection(modelId, quality);
    const body = await evaluateT2iBody(projection, quality);

    // multipart 上 wire 的标量表单字段来自 body.* 规则求值结果（image 走文件 part）
    const fields = Object.entries(body)
      .filter(
        ([, value]) =>
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean",
      )
      .map(([name, value]) => ({ name, value: String(value) }));
    assert.ok(fields.some((field) => field.name === "model"));
    assert.ok(fields.some((field) => field.name === "output_format"));
    assert.ok(!fields.some((field) => field.name === "format"));

    const remoteModelId = `${modelId}-remote-2026-09-08`;
    const snapshot = buildSnapshot(modelId, remoteModelId);
    const injected = applyRemoteModelInjection({
      snapshot,
      url: "/v1/images/edits",
      body: {
        __formData: {
          fields,
          files: [
            {
              name: "image[0]",
              dataBase64: Buffer.from("fake-png").toString("base64"),
              contentType: "image/png",
              filename: "reference.png",
            },
          ],
        },
      },
    });
    assert.ok(isSerializedFormDataBody(injected.body));
    if (!isSerializedFormDataBody(injected.body)) return;
    assert.equal(
      injected.body.__formData.fields.find((field) => field.name === "model")
        ?.value,
      remoteModelId,
    );
    assert.equal(
      injected.body.__formData.fields.find(
        (field) => field.name === "output_format",
      )?.value,
      "jpeg",
    );

    const headers = new Headers();
    const wire = buildRequestBody(injected.body, headers);
    assert.ok(wire instanceof FormData, "edits wire body 必须是 FormData");
    if (!(wire instanceof FormData)) return;
    assert.equal(wire.get("model"), remoteModelId);
    assert.equal(wire.get("output_format"), "jpeg");
    assert.equal(wire.get("format"), null);
    assert.equal(wire.get("quality"), quality);
    assert.ok(wire.get("image[0]") instanceof Blob);
  }
});

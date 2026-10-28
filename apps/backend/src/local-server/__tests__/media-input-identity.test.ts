import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMediaInputBuckets } from "../media-input-bucket-normalizer.cts";
import { evaluateRule } from "../request-assembler-runtime.cts";
import type { EvaluateState } from "../request-assembler-shared.cts";

/**
 * 媒体身份链：提交体（media_inputs）→ 分桶草稿 → 占位符。
 *
 * 覆盖「档案把出网文件对回资产与用途」的上游半段。下游半段（占位符 → 序列化文件描述、
 * 摘要、CLI 档案）分别由 model-input-multipart-serialization.test.ts、
 * task-payload-builder.test.ts 与 cli-generation-archive-seam.test.mts 覆盖。
 */

const PROJECTION = {
  parameter_schema: {
    fields: [{ field_key: "referenceImage", component: "imageUpload", required: false }],
    required_fields: [],
  },
  capability: { input_modalities: ["text", "image"], output_modalities: ["video"] },
  runtime: {},
};

/** 与 openai-video 族模板参考图规则同形（when + allUploadFiles + multipart_file + repeated）。 */
const MULTI_FILE_RULE = {
  kind: "when",
  condition: { op: "ne", field: "referenceImage", value: [] },
  truthy: {
    kind: "field",
    field_key: "referenceImage",
    transforms: ["allUploadFiles"],
    media_target: "multipart_file",
    multipart_array_naming: "repeated",
  },
  falsy: { kind: "literal", value: null },
};

void test("media identity: 提交体的 asset_id/slot_id 进入分桶草稿", async () => {
  const buckets = await normalizeMediaInputBuckets(
    [
      {
        media_kind: "image",
        source_kind: "base64",
        value: Buffer.from("image-bytes").toString("base64"),
        mime_type: "image/png",
        filename: null,
        field_key: "referenceImage",
        asset_id: "asset-example-1",
        slot_id: "reference_image",
      },
    ],
    PROJECTION,
    null,
  );
  const bucket = buckets["referenceImage"];
  assert.ok(Array.isArray(bucket));
  const draft = bucket[0] as { assetId?: unknown; slotId?: unknown; kind?: unknown };
  assert.equal(draft.assetId, "asset-example-1");
  assert.equal(draft.slotId, "reference_image");
  assert.equal(draft.kind, "inline_data");
});

void test("media identity: 多文件规则把身份带到占位符，传输形态仍是 multipart_file", async () => {
  const state: EvaluateState = {
    fields: {
      referenceImage: [
        {
          kind: "inline_data",
          data: Buffer.from("image-bytes").toString("base64"),
          mimeType: "image/png",
          filename: "",
          assetId: "asset-example-1",
          slotId: "reference_image",
        },
      ],
    },
    runtime: {},
    projection: {},
    currentItem: undefined,
    projectPath: null,
  };

  const result = await evaluateRule(MULTI_FILE_RULE, state);

  assert.ok(Array.isArray(result));
  const candidates = result as unknown[];
  const placeholder = candidates[0] as {
    __media_ref__?: unknown;
    assetId?: unknown;
    slotId?: unknown;
    transport?: unknown;
  };
  assert.equal(placeholder.__media_ref__, true);
  assert.equal(placeholder.assetId, "asset-example-1");
  assert.equal(placeholder.slotId, "reference_image");
  assert.equal(placeholder.transport, "multipart_file");
});

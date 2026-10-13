import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRule } from "../request-assembler-runtime.cts";
import type { EvaluateState } from "../request-assembler-shared.cts";

/**
 * extractUrls transform 的 transport 决策修复测试。
 *
 * 背景：seedance 式 pack 的 body.referenceBlobs 顶层是 coalesce compute 规则（无顶层
 * media_target），media_target 声明在嵌套的 map_array.source 的
 * field.extractUrls 规则上。extractUrls handler 必须优先用嵌套规则传入的
 * options.mediaTarget 推导 transport，而不是只看顶层 uploadOptions
 * （顶层无 media_target 时 uploadOptions.uploadMode=undefined → 退化成 inline_data）。
 */

const makeState = (fields: Record<string, unknown>): EvaluateState => ({
  fields,
  runtime: {},
  projection: {},
  currentItem: undefined,
  projectPath: null,
});

/** seedance 式：顶层 coalesce，media_target 声明在嵌套 map_array.source 上 */
const NESTED_PROJECTION = {
  model_id: "seedance-test-model",
  runtime: {
    payload_format: "json",
    payload_rules: {
      "body.referenceBlobs": {
        kind: "compute",
        operator: "coalesce",
        args: [
          {
            kind: "compute",
            operator: "map_array",
            media_target: "multipart_file",
            options: {
              source: {
                kind: "field",
                field_key: "reference_images",
                transforms: ["extractUrls"],
                media_target: "multipart_file",
              },
              item: { kind: "item" },
              skip_if_empty: true,
            },
          },
        ],
      },
    },
  },
};

/** 顶层 field 规则直接带 media_target */
const TOP_LEVEL_PROJECTION = {
  model_id: "top-level-test-model",
  runtime: {
    payload_format: "json",
    payload_rules: {
      "body.referenceBlobs": {
        kind: "field",
        field_key: "reference_images",
        transforms: ["extractUrls"],
        media_target: "multipart_file",
      },
    },
  },
};

const referenceBlobsRule = (projection: {
  runtime: { payload_rules: Record<string, unknown> };
}) => projection.runtime.payload_rules["body.referenceBlobs"];

const readTransportValues = (
  result: unknown,
): Array<string | undefined> => {
  assert.ok(Array.isArray(result));
  const placeholders = result as Array<Record<string, unknown>>;
  return placeholders.map((item) =>
    typeof item["transport"] === "string"
      ? (item["transport"] as string)
      : undefined,
  );
};

void test("extractUrls: 嵌套 media_target=multipart_file 生成 multipart_file transport（seedance 式）", async () => {
  const state = makeState({
    reference_images: ["local-media://ref-a.png", "local-media://ref-b.png"],
  });
  const result = await evaluateRule(
    referenceBlobsRule(NESTED_PROJECTION),
    state,
    {
      // 顶层 coalesce 无 media_target，resolveUploadUrlOptions 返回 uploadMode=undefined
      uploadOptions: {
        fieldPath: "body.referenceBlobs",
        uploadMode: undefined,
        targetType: undefined,
      },
      item: undefined,
      targetPath: undefined,
      preRequestOutputs: undefined,
    },
  );

  const transports = readTransportValues(result);
  assert.deepEqual(transports, ["multipart_file", "multipart_file"]);
  // fieldPath 仍来自 uploadOptions，不被 mediaTarget 路径丢失
  const placeholders = result as Array<Record<string, unknown>>;
  for (const placeholder of placeholders) {
    assert.equal(placeholder["fieldPath"], "body.referenceBlobs");
  }
});

void test("extractUrls: 顶层 media_target=multipart_file transport 保持 multipart_file", async () => {
  const state = makeState({
    reference_images: ["local-media://ref-a.png"],
  });
  const result = await evaluateRule(
    referenceBlobsRule(TOP_LEVEL_PROJECTION),
    state,
    {
      uploadOptions: {
        fieldPath: "body.referenceBlobs",
        uploadMode: "multipart_file",
        targetType: undefined,
      },
      item: undefined,
      targetPath: undefined,
      preRequestOutputs: undefined,
    },
  );

  const transports = readTransportValues(result);
  assert.deepEqual(transports, ["multipart_file"]);
});

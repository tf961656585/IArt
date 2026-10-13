import assert from "node:assert/strict";
import test from "node:test";

import { extractMappedTaskOutputs } from "../task-result-output-mapping.cts";

const buildTaskRecord = (target: string) => ({
  metadata: {
    taskExecutionPlan: {
      result_output_mapping: {
        response_mode: "structured_payload",
        output_mapping_rules: [
          {
            target,
            source: { kind: "response", path: "choices[].message.content" },
          },
        ],
      },
    },
  },
});

void test("result output mapping: output.image_url 从 Grok-style Markdown 图片中提取多个 image 输出", () => {
  const outputs = extractMappedTaskOutputs({
    taskRecord: buildTaskRecord("output.image_url"),
    responseBody: {
      choices: [
        {
          message: {
            content:
              "![first](https://cdn.example.com/a.png)\n" +
              "![second](https://cdn.example.com/b.png)\n" +
              "![duplicate](https://cdn.example.com/a.png)",
          },
        },
      ],
    },
  });

  assert.deepEqual(outputs, [
    {
      mediaType: "image",
      url: "https://cdn.example.com/a.png",
      textValue: undefined,
      sourceTarget: "output.image_url",
    },
    {
      mediaType: "image",
      url: "https://cdn.example.com/b.png",
      textValue: undefined,
      sourceTarget: "output.image_url",
    },
  ]);
});

void test("result output mapping: output.image_url 遇到无图片 Markdown 不产出 image 输出", () => {
  const outputs = extractMappedTaskOutputs({
    taskRecord: buildTaskRecord("output.image_url"),
    responseBody: {
      choices: [
        {
          message: {
            content: "普通说明文本和 [普通链接](https://example.com/page)",
          },
        },
      ],
    },
  });

  assert.deepEqual(outputs, []);
});

void test("result output mapping: output.text 保留 Markdown 文本且不转成 image 输出", () => {
  const outputs = extractMappedTaskOutputs({
    taskRecord: buildTaskRecord("output.text"),
    responseBody: {
      choices: [
        {
          message: {
            content: "![first](https://cdn.example.com/a.png)",
          },
        },
      ],
    },
  });

  assert.deepEqual(outputs, [
    {
      mediaType: "text",
      textValue: "![first](https://cdn.example.com/a.png)",
      url: undefined,
      sourceTarget: "output.text",
    },
  ]);
});

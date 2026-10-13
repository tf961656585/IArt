import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assembleGenerationTaskRequest } from "../request-assembler.cts";
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

/**
 * 创建一个 Gemini 风格的模型包，使用 build_content_blocks operator
 * payload_rules 中 body.contents 使用 build_content_blocks 构建 inline_data
 */
const writeGeminiModelPackage = (
  packageRoot: string,
  modelId: string,
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
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), { Images: "图片", Prompt: "提示词" });
  writeJson(path.join(packageDir, "locales", "en.json"), { Images: "Images", Prompt: "Prompt" });
  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: `node.${modelId}`,
    group_key: "test",
    input_ports: [],
    output_ports: [],
  });
  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: modelId,
    provider_id: "google",
    capability: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
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
      ],
      required_fields: [],
    },
    // 提示词走保留键 `__prompt`（不进参数表单），由 request-assembler 从提交体顶层 prompt 归一注入。
    prompt_field: {
      field_key: "__prompt",
      required: false,
      validation_rules: [],
    },
    runtime: {
      provider_id: "google",
      execution_driver: "http_formal_task",
      api_defaults: {
        endpoint: "/v1beta/models/gemini:generateContent",
        method: "POST",
        contentType: "application/json",
      },
      payload_format: "json",
      payload_rules: {
        "body.contents": {
          kind: "compute",
          operator: "build_content_blocks",
          media_target: "inline_data",
          options: {
            parts: [
              {
                part_kind: "inline_data",
                value: {
                  kind: "field",
                  field_key: "images",
                  transforms: ["extractUrls"],
                },
                multiple: true,
              },
              {
                part_kind: "text",
                value: {
                  kind: "field",
                  field_key: "__prompt",
                },
              },
            ],
            role: "user",
          },
        },
      },
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1beta/models/gemini:generateContent",
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

/**
 * Gemini Interactions 风格模型包：body.input 使用 build_content_blocks +
 * output_shape=interactions_input，产出扁平 `[{type:"text",text} | {type:"image",mime_type,data}]`。
 */
const writeInteractionsModelPackage = (
  packageRoot: string,
  modelId: string,
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
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), { Image: "图片", Prompt: "提示词" });
  writeJson(path.join(packageDir, "locales", "en.json"), { Image: "Image", Prompt: "Prompt" });
  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: `node.${modelId}`,
    group_key: "test",
    input_ports: [],
    output_ports: [],
  });
  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: modelId,
    provider_id: "google",
    capability: {
      input_modalities: ["text", "image"],
      output_modalities: ["image"],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [
        {
          field_key: "image",
          label: "Image",
          component: "imageUpload",
          required: false,
        },
      ],
      required_fields: [],
    },
    prompt_field: {
      field_key: "__prompt",
      required: false,
      validation_rules: [],
    },
    runtime: {
      provider_id: "google",
      execution_driver: "http_formal_task",
      api_defaults: {
        endpoint: "/v1beta/interactions",
        method: "POST",
        contentType: "application/json",
      },
      payload_format: "json",
      payload_rules: {
        "body.model": {
          kind: "literal",
          value: modelId,
        },
        "body.input": {
          kind: "compute",
          operator: "build_content_blocks",
          media_target: "inline_data",
          options: {
            output_shape: "interactions_input",
            parts: [
              {
                part_kind: "text",
                value: {
                  kind: "field",
                  field_key: "__prompt",
                  transforms: ["trim"],
                },
              },
              {
                part_kind: "inline_data",
                value: {
                  kind: "field",
                  field_key: "image",
                  transforms: ["extractUrls"],
                  media_target: "inline_data",
                },
                multiple: true,
                max_items: 14,
              },
            ],
          },
        },
      },
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1beta/interactions",
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

void test("Gemini 端到端: media_inputs(source_kind=url) + Gemini projection -> body 含 inline_data", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "media-pipeline-e2e-inline-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "gemini-e2e-test";

  writeGeminiModelPackage(packageRoot, modelId);
  withPackageRoot(t, packageRoot);

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      prompt: "What do you see in this image?",
      arguments: {},
      media_inputs: [
        {
          media_kind: "image",
          source_kind: "base64",
          value: "data:image/png;base64,aW1hZ2VEYXRh",
          mime_type: "image/png",
          filename: null,
        },
      ],
    },
    { projectPath: null, baseDir: null },
  );

  // result 格式: { projection, executionPlan: { submit_request: { body } } }
  const execResult = result as { executionPlan: Record<string, unknown> };
  const executionPlan = execResult.executionPlan;
  assert.ok(executionPlan !== undefined, "executionPlan should exist");
  const submitRequest = executionPlan["submit_request"] as Record<string, unknown>;
  assert.ok(submitRequest !== undefined, "submit_request should exist");
  const body = submitRequest["body"] as Record<string, unknown>;
  assert.ok(body !== undefined, "body should exist");
  const contents = body["contents"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(contents), "body.contents should be an array");
  assert.ok(contents.length > 0, "body.contents should have at least one entry");

  // 验证 contents[0] 有 role: "user" 和 parts
  const firstContent = contents[0];
  if (firstContent === undefined) throw new Error("firstContent is undefined");
  assert.equal(firstContent["role"], "user");
  const parts = firstContent["parts"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parts), "parts should be an array");

  // 应该有 inline_data part 和 text part
  const hasInlineData = parts.some((part) => part["inline_data"] !== undefined);
  assert.ok(hasInlineData, "parts should contain an inline_data entry");

  const hasText = parts.some(
    (part) => part["text"] === "What do you see in this image?",
  );
  assert.ok(hasText, "parts should contain the PromptDock top-level prompt as a text entry");
});

void test("Gemini 端到端: 无 media_inputs -> 只有 text part 不报错", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "media-pipeline-e2e-text-only-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "gemini-e2e-text-only-test";

  writeGeminiModelPackage(packageRoot, modelId);
  withPackageRoot(t, packageRoot);

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      prompt: "Hello, how are you?",
      arguments: {},
      media_inputs: undefined,
    },
    { projectPath: null, baseDir: null },
  );

  // result 格式: { projection, executionPlan: { submit_request: { body } } }
  const execResult = result as { executionPlan: Record<string, unknown> };
  const executionPlan = execResult.executionPlan;
  assert.ok(executionPlan !== undefined, "executionPlan should exist");
  const submitRequest = executionPlan["submit_request"] as Record<string, unknown>;
  assert.ok(submitRequest !== undefined, "submit_request should exist");
  const body = submitRequest["body"] as Record<string, unknown>;
  assert.ok(body !== undefined, "body should exist");
  const contents = body["contents"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(contents), "body.contents should be an array");

  // 无 media_inputs -> images 字段为空 -> build_content_blocks 中 inline_data part 跳过
  // 只有 text part
  const firstContent = contents[0];
  if (firstContent === undefined) throw new Error("firstContent is undefined");
  const parts = firstContent["parts"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parts), "parts should be an array");

  // 只应有 text part（无 inline_data）
  const textParts = parts.filter((part) => typeof part["text"] === "string");
  assert.ok(textParts.length > 0, "should have at least one text part");
  assert.ok(
    textParts.some((part) => part["text"] === "Hello, how are you?"),
    "text part should carry the PromptDock top-level prompt",
  );
});

void test("Gemini Interactions 端到端: body.input 扁平条目 + base64 内联 + 输入准备层通过", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "media-pipeline-e2e-interactions-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  const modelId = "gemini-interactions-e2e-test";

  writeInteractionsModelPackage(packageRoot, modelId);
  withPackageRoot(t, packageRoot);

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = (await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      prompt: "turn this into watercolor",
      arguments: {},
      media_inputs: [
        {
          media_kind: "image",
          source_kind: "base64",
          value: "data:image/png;base64,aW1hZ2VEYXRh",
          mime_type: "image/png",
          filename: null,
        },
      ],
    },
    { projectPath: null, baseDir: null },
  )) as {
    projection: unknown;
    executionPlan: Record<string, unknown>;
  };

  const submitRequest = result.executionPlan["submit_request"] as Record<string, unknown>;
  assert.ok(submitRequest !== undefined, "submit_request should exist");
  // body.input 出现 MediaRefPlaceholder 即说明请求构造期未物化
  const body = submitRequest["body"] as { input: unknown[]; model: string };
  assert.equal(body.model, modelId);
  assert.ok(Array.isArray(body.input), "body.input should be an array");
  // 扁平结构：没有 role/parts 容器，也没有嵌套子数组
  assert.equal(body.input.length, 2);
  assert.deepEqual(body.input[0], { type: "text", text: "turn this into watercolor" });
  assert.deepEqual(body.input[1], {
    type: "image",
    mime_type: "image/png",
    data: "aW1hZ2VEYXRh",
  });

  // 输入准备层必须接受该 body（无残留占位符、guard 通过）
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: null,
    projection: result.projection,
    body,
  } as Parameters<typeof prepareModelInputForRequest>[0]);
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.deepEqual(prepared.body, body);
  }
});

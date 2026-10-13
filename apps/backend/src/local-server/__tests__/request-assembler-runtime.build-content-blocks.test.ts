import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluateRule } from "../request-assembler-runtime.cts";

import type { EvaluateState } from "../request-assembler-shared.cts";

const makeMinimalState = (): EvaluateState => ({
  fields: {},
  runtime: {},
  projection: {},
  currentItem: undefined,
  projectPath: null,
});

/**
 * build_content_blocks 通过 evaluateRule 间接调用：
 * 规则格式: { kind: "compute", operator: "build_content_blocks", options: { parts, role } }
 * parts 中每个 part 可以是:
 *   { part_kind: "text", value: { kind: "literal", value: "prompt" } }
 *   { part_kind: "inline_data", value: { kind: "literal", value: <media> }, multiple: true }
 */

void test("build_content_blocks: 纯文本 part 生成 { text: 'prompt' }", async () => {
  const result = await evaluateRule(
    {
      kind: "compute",
      operator: "build_content_blocks",
      options: {
        parts: [
          {
            part_kind: "text",
            value: { kind: "literal", value: "describe this image" },
          },
        ],
        role: "user",
      },
    },
    makeMinimalState(),
  );

  assert.ok(Array.isArray(result));
  const contentBlock = (result as Array<Record<string, unknown>>)[0];
  if (contentBlock === undefined) throw new Error("contentBlock is undefined");
  assert.equal(contentBlock["role"], "user");
  const parts = contentBlock["parts"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.length, 1);
  const firstPart = parts[0];
  if (firstPart === undefined) throw new Error("parts[0] is undefined");
  assert.equal(firstPart["text"], "describe this image");
});

void test("build_content_blocks: inline_data part + 已有 inline_data 值", async () => {
  const result = await evaluateRule(
    {
      kind: "compute",
      operator: "build_content_blocks",
      options: {
        parts: [
          {
            part_kind: "inline_data",
            value: {
              kind: "literal",
              value: { kind: "inline_data", data: "aGVsbG8=", mimeType: "image/png" },
            },
          },
        ],
      },
    },
    makeMinimalState(),
  );

  assert.ok(Array.isArray(result));
  const contentBlock = (result as Array<Record<string, unknown>>)[0];
  if (contentBlock === undefined) throw new Error("contentBlock is undefined");
  const parts = contentBlock["parts"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.length, 1);
  const firstPart = parts[0];
  if (firstPart === undefined) throw new Error("parts[0] is undefined");
  const inlinePart = firstPart["inline_data"] as { mime_type: string; data: string };
  if (inlinePart === undefined) throw new Error("inline_data is undefined");
  assert.equal(inlinePart.mime_type, "image/png");
  assert.equal(inlinePart.data, "aGVsbG8=");
});

void test("build_content_blocks: 空值 part 被 skip_if_empty 跳过不报错", async () => {
  const result = await evaluateRule(
    {
      kind: "compute",
      operator: "build_content_blocks",
      options: {
        parts: [
          {
            part_kind: "text",
            value: { kind: "literal", value: undefined },
          },
        ],
      },
    },
    makeMinimalState(),
  );

  // 所有 parts 为空 -> 返回 undefined
  assert.equal(result, undefined);
});

void test("build_content_blocks: inline_data part 不可转换的字符串抛出错误", async () => {
  await assert.rejects(
    async () => {
      await evaluateRule(
        {
          kind: "compute",
          operator: "build_content_blocks",
          options: {
            parts: [
              {
                part_kind: "inline_data",
                value: {
                  kind: "literal",
                  value: "https://example.com/image.png",
                },
              },
            ],
          },
        },
        makeMinimalState(),
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("inline_data") || error.message.includes("Cannot convert");
      }
      return false;
    },
  );
});

void test("build_content_blocks: 混合 text + inline_data parts", async () => {
  const result = await evaluateRule(
    {
      kind: "compute",
      operator: "build_content_blocks",
      options: {
        parts: [
          {
            part_kind: "text",
            value: { kind: "literal", value: "What do you see?" },
          },
          {
            part_kind: "inline_data",
            value: {
              kind: "literal",
              value: { kind: "inline_data", data: "aW1hZ2U=", mimeType: "image/jpeg" },
            },
          },
        ],
      },
    },
    makeMinimalState(),
  );

  assert.ok(Array.isArray(result));
  const contentBlock = (result as Array<Record<string, unknown>>)[0];
  if (contentBlock === undefined) throw new Error("contentBlock is undefined");
  const parts = contentBlock["parts"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parts));
  assert.equal(parts.length, 2);

  // 第一个 part 是 text
  const textPart = parts[0];
  if (textPart === undefined) throw new Error("parts[0] is undefined");
  assert.equal(textPart["text"], "What do you see?");

  // 第二个 part 是 inline_data
  const secondPart = parts[1];
  if (secondPart === undefined) throw new Error("parts[1] is undefined");
  const inlinePart = secondPart["inline_data"] as { mime_type: string; data: string };
  if (inlinePart === undefined) throw new Error("inline_data is undefined");
  assert.equal(inlinePart.mime_type, "image/jpeg");
  assert.equal(inlinePart.data, "aW1hZ2U=");
});

void test("build_content_blocks: 所有 parts 为空返回 undefined", async () => {
  const result = await evaluateRule(
    {
      kind: "compute",
      operator: "build_content_blocks",
      options: {
        parts: [
          { part_kind: "text", value: { kind: "literal", value: null } },
          { part_kind: "text", value: { kind: "literal", value: "" } },
        ],
      },
    },
    makeMinimalState(),
  );

  assert.equal(result, undefined);
});

void test("build_content_blocks: inline_data part with url source (remote) throws error", async () => {
  await assert.rejects(
    async () => {
      await evaluateRule(
        {
          kind: "compute",
          operator: "build_content_blocks",
          options: {
            parts: [
              {
                part_kind: "inline_data",
                value: {
                  kind: "literal",
                  value: "https://example.com/image.png",
                },
              },
            ],
          },
        },
        makeMinimalState(),
      );
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("Cannot convert") || error.message.includes("inline_data");
      }
      return false;
    },
  );
});

void test("build_content_blocks: inline_data part with local-media url source reads local file", async () => {
  // 创建临时项目目录结构
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcc-local-media-"));
  const mediaDir = path.join(tmpDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  // 创建 manifest.json 使目录被识别为有效项目
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), "{}");
  // 创建测试图片文件
  const testImageContent = Buffer.from("fake-png-content");
  fs.writeFileSync(path.join(mediaDir, "test.png"), testImageContent);

  try {
    // 注册 project scope，构造带 scope 的 local-media:// URL（无 scope 形态不再被解析器接受）
    const { registerRuntimeProjectScope, resolveLocalMediaUrl } =
      await import("../project-media-scope.cts");
    const registered = registerRuntimeProjectScope(tmpDir);
    assert.ok(registered, "project scope should register");
    const localMediaUrl = resolveLocalMediaUrl(registered.projectRef, "test.png");
    assert.ok(localMediaUrl, "local-media URL should be generated");

    const state: EvaluateState = {
      fields: {},
      runtime: {},
      projection: {},
      currentItem: undefined,
      projectPath: tmpDir,
    };

    const result = await evaluateRule(
      {
        kind: "compute",
        operator: "build_content_blocks",
        options: {
          parts: [
            {
              part_kind: "inline_data",
              value: {
                kind: "literal",
                value: localMediaUrl,
              },
            },
          ],
        },
      },
      state,
    );

    assert.ok(Array.isArray(result));
    const contentBlock = (result as Array<Record<string, unknown>>)[0];
    if (contentBlock === undefined) throw new Error("contentBlock is undefined");
    const parts = contentBlock["parts"] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(parts));
    assert.equal(parts.length, 1);
    const firstPart = parts[0];
    if (firstPart === undefined) throw new Error("parts[0] is undefined");
    const inlinePart = firstPart["inline_data"] as { mime_type: string; data: string };
    if (inlinePart === undefined) throw new Error("inline_data is undefined");
    assert.equal(inlinePart.mime_type, "image/png");
    // 验证 base64 解码后与原文件内容一致
    const decoded = Buffer.from(inlinePart.data, "base64");
    assert.deepEqual(decoded, testImageContent);
  } finally {
    const { clearRuntimeProjectScopesForTest } = await import("../project-media-scope.cts");
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test("build_content_blocks: output_shape=interactions_input 产出扁平 {type,mime_type,data} 条目", async () => {
  const result = await evaluateRule(
    {
      kind: "compute",
      operator: "build_content_blocks",
      options: {
        output_shape: "interactions_input",
        parts: [
          {
            part_kind: "text",
            value: { kind: "literal", value: "draw a cat" },
          },
          {
            part_kind: "inline_data",
            value: {
              kind: "literal",
              value: { kind: "inline_data", data: "aW1hZ2U=", mimeType: "image/png" },
            },
          },
        ],
      },
    },
    makeMinimalState(),
  );

  assert.ok(Array.isArray(result));
  const entries = result as Array<Record<string, unknown>>;
  // 扁平数组，没有 role/parts 容器
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.["type"], "text");
  assert.equal(entries[0]?.["text"], "draw a cat");
  assert.equal(entries[0]?.["role"], undefined);
  assert.equal(entries[1]?.["type"], "image");
  assert.equal(entries[1]?.["mime_type"], "image/png");
  assert.equal(entries[1]?.["data"], "aW1hZ2U=");
  assert.equal(entries[1]?.["inline_data"], undefined);
});

void test("build_content_blocks: output_shape=interactions_input 按 mime 前缀推断条目 type", async () => {
  const result = await evaluateRule(
    {
      kind: "compute",
      operator: "build_content_blocks",
      options: {
        output_shape: "interactions_input",
        parts: [
          {
            part_kind: "inline_data",
            value: {
              kind: "literal",
              value: { kind: "inline_data", data: "YXVkaW8=", mimeType: "audio/mpeg" },
            },
          },
        ],
      },
    },
    makeMinimalState(),
  );

  assert.ok(Array.isArray(result));
  const entries = result as Array<Record<string, unknown>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.["type"], "audio");
  assert.equal(entries[0]?.["mime_type"], "audio/mpeg");
  assert.equal(entries[0]?.["data"], "YXVkaW8=");
});

void test("build_content_blocks: output_shape=interactions_input 本地媒体 -> base64 内联", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcc-interactions-local-"));
  const mediaDir = path.join(tmpDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), "{}");
  const testImageContent = Buffer.from("interactions-local-png");
  fs.writeFileSync(path.join(mediaDir, "scene.png"), testImageContent);

  try {
    const { registerRuntimeProjectScope, resolveLocalMediaUrl } =
      await import("../project-media-scope.cts");
    const registered = registerRuntimeProjectScope(tmpDir);
    assert.ok(registered, "project scope should register");
    const localMediaUrl = resolveLocalMediaUrl(registered.projectRef, "scene.png");
    assert.ok(localMediaUrl, "local-media URL should be generated");

    const state: EvaluateState = {
      fields: {},
      runtime: {},
      projection: {},
      currentItem: undefined,
      projectPath: tmpDir,
    };

    const result = await evaluateRule(
      {
        kind: "compute",
        operator: "build_content_blocks",
        options: {
          output_shape: "interactions_input",
          parts: [
            {
              part_kind: "inline_data",
              value: { kind: "literal", value: localMediaUrl },
            },
          ],
        },
      },
      state,
    );

    assert.ok(Array.isArray(result));
    const entries = result as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.["type"], "image");
    assert.equal(entries[0]?.["mime_type"], "image/png");
    const decoded = Buffer.from(String(entries[0]?.["data"] ?? ""), "base64");
    assert.deepEqual(decoded, testImageContent);
  } finally {
    const { clearRuntimeProjectScopesForTest } = await import("../project-media-scope.cts");
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

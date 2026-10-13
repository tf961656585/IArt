import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareModelInputForRequest } from "../model-input-preparation/model-input-preparation.cts";

// ---------------------------------------------------------------------------
// inline_data 一等物化目标：本地媒体引用 → { inline_data: { mime_type, data } }
//
// 覆盖两种包内形状：
// - 顶层/嵌套字段直接持有 MediaRefPlaceholder（Veo instances[].image / lastFrame /
//   referenceImages[].image）；
// - 占位符来源为 url（本地媒体文件）或已是 inline_data。
// ---------------------------------------------------------------------------

const makeInlineDataPlaceholder = (
  data: string,
  mimeType: string,
  fieldPath: string | undefined,
) => ({
  __media_ref__: true as const,
  source: { kind: "inline_data" as const, data, mimeType },
  mimeType,
  transport: "inline_data" as const,
  filename: "media.png",
  fieldPath,
});

const makeUrlPlaceholder = (
  url: string,
  mimeType: string | undefined,
  fieldPath: string | undefined,
) => ({
  __media_ref__: true as const,
  source: { kind: "url" as const, url },
  mimeType,
  transport: "inline_data" as const,
  fieldPath,
});

/** Veo 式：body.instances 下嵌套声明 media_target=inline_data */
const buildVeoStyleProjection = (modelId: string) => ({
  model_id: modelId,
  runtime: {
    payload_format: "json",
    payload_rules: {
      "body.instances": {
        kind: "compute",
        operator: "array",
        args: [
          {
            kind: "compute",
            operator: "compact_object",
            entries: {
              prompt: { kind: "field", field_key: "__prompt" },
              image: {
                kind: "field",
                field_key: "firstFrameImage",
                transforms: ["extractFirstUrl"],
                media_target: "inline_data",
              },
              lastFrame: {
                kind: "field",
                field_key: "lastFrameImage",
                transforms: ["extractFirstUrl"],
                media_target: "inline_data",
              },
              referenceImages: {
                kind: "compute",
                operator: "map_array",
                media_target: "inline_data",
                options: {
                  source: {
                    kind: "field",
                    field_key: "referenceImages",
                    transforms: ["extractUrls"],
                    media_target: "inline_data",
                  },
                  item: {
                    kind: "compute",
                    operator: "object",
                    entries: {
                      image: { kind: "item" },
                      referenceType: { kind: "literal", value: "asset" },
                    },
                  },
                  max_items: 3,
                  skip_if_empty: true,
                },
              },
            },
          },
        ],
      },
    },
  },
});

/** 顶层字段直接声明 media_target=inline_data */
const buildFlatProjection = (modelId: string) => ({
  model_id: modelId,
  runtime: {
    payload_format: "json",
    payload_rules: {
      "body.image": {
        kind: "field",
        field_key: "image",
        transforms: ["extractFirstUrl"],
        media_target: "inline_data",
      },
    },
  },
});

/**
 * 建立临时项目 + media 文件，注册 project scope 并返回 local-media:// URL。
 * 调用方负责在 t.after 中清理。
 */
const setupProjectWithMedia = async (
  t: test.TestContext,
  files: Record<string, Buffer>,
): Promise<{ projectPath: string; resolveLocalMediaUrl: (fileKey: string) => string }> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inline-data-project-"));
  fs.writeFileSync(path.join(tempDir, "manifest.json"), "{}");
  const mediaDir = path.join(tempDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(mediaDir, name), content);
  }
  const { registerRuntimeProjectScope, resolveLocalMediaUrl, clearRuntimeProjectScopesForTest } =
    await import("../project-media-scope.cts");
  const registered = registerRuntimeProjectScope(tempDir);
  assert.ok(registered, "project scope should register");
  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return {
    projectPath: tempDir,
    resolveLocalMediaUrl: (fileKey: string): string => {
      const url = resolveLocalMediaUrl(registered.projectRef, fileKey);
      if (!url) throw new Error(`local-media URL should be generated for ${fileKey}`);
      return url;
    },
  };
};

void test("inline_data 物化: 已有 inline_data 占位符 → { inline_data: { mime_type, data } }", async () => {
  const modelId = "inline-data-flat-inline-source";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/project.iartproj",
    projection: buildFlatProjection(modelId),
    body: {
      image: makeInlineDataPlaceholder("aGVsbG8=", "image/png", "body.image"),
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const body = prepared.body as { image: unknown };
    assert.deepEqual(body.image, {
      inline_data: { mime_type: "image/png", data: "aGVsbG8=" },
    });
  }
});

void test("inline_data 物化: 本地媒体 url 占位符 → 读取文件并 base64 内联", async (t) => {
  const fileContent = Buffer.from("inline-local-png-bytes");
  const { projectPath, resolveLocalMediaUrl } = await setupProjectWithMedia(t, {
    "frame.png": fileContent,
  });

  const modelId = "inline-data-flat-url-source";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath,
    projection: buildFlatProjection(modelId),
    body: {
      image: makeUrlPlaceholder(resolveLocalMediaUrl("frame.png"), "image/png", "body.image"),
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const body = prepared.body as { image: { inline_data: { mime_type: string; data: string } } };
    assert.equal(body.image.inline_data.mime_type, "image/png");
    assert.deepEqual(Buffer.from(body.image.inline_data.data, "base64"), fileContent);
  }
});

void test("inline_data 物化: Veo 式嵌套 instances 全部占位符被物化且 guard 通过", async (t) => {
  const firstFrameContent = Buffer.from("veo-first-frame");
  const refContent = Buffer.from("veo-reference");
  const { projectPath, resolveLocalMediaUrl } = await setupProjectWithMedia(t, {
    "first.png": firstFrameContent,
    "ref.png": refContent,
  });

  const modelId = "inline-data-veo-instances";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath,
    projection: buildVeoStyleProjection(modelId),
    body: {
      instances: [
        {
          prompt: "a cat surfing",
          image: makeUrlPlaceholder(resolveLocalMediaUrl("first.png"), "image/png", "body.instances"),
          lastFrame: makeInlineDataPlaceholder("bGFzdA==", "image/jpeg", "body.instances"),
          referenceImages: [
            {
              image: makeUrlPlaceholder(resolveLocalMediaUrl("ref.png"), "image/png", "body.instances"),
              referenceType: "asset",
            },
          ],
        },
      ],
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const body = prepared.body as {
      instances: Array<{
        prompt: string;
        image: { inline_data: { mime_type: string; data: string } };
        lastFrame: { inline_data: { mime_type: string; data: string } };
        referenceImages: Array<{
          image: { inline_data: { mime_type: string; data: string } };
          referenceType: string;
        }>;
      }>;
    };
    const instance = body.instances[0];
    if (instance === undefined) assert.fail("instances[0] missing");
    assert.equal(instance.prompt, "a cat surfing");
    assert.deepEqual(Buffer.from(instance.image.inline_data.data, "base64"), firstFrameContent);
    assert.equal(instance.image.inline_data.mime_type, "image/png");
    assert.deepEqual(instance.lastFrame.inline_data, {
      mime_type: "image/jpeg",
      data: "bGFzdA==",
    });
    const reference = instance.referenceImages[0];
    if (reference === undefined) assert.fail("referenceImages[0] missing");
    assert.equal(reference.referenceType, "asset");
    assert.deepEqual(Buffer.from(reference.image.inline_data.data, "base64"), refContent);
  }
});

void test("inline_data 物化: 远端 url 源无法内联时返回结构化错误", async () => {
  const modelId = "inline-data-remote-url";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/project.iartproj",
    projection: buildFlatProjection(modelId),
    body: {
      image: makeUrlPlaceholder("https://example.com/remote.png", "image/png", "body.image"),
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.equal(prepared.error.code, "inline_data_preparation_error");
    assert.match(prepared.error.message, /remote URL cannot be converted to inline_data/);
  }
});

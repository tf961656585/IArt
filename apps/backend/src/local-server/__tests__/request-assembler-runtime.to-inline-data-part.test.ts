import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { toInlineDataPart } from "../request-assembler-runtime.cts";
import { MEDIA_REF_TRANSPORT, type MediaRefPlaceholder } from "@iart/contracts";

import type { EvaluateState } from "../request-assembler-shared.cts";

/**
 * toInlineDataPart 接收 EvaluateState 和 UploadOptions 参数。
 * voidState 用于不需要 projectPath 的测试场景。
 */
const voidState: EvaluateState = { fields: {}, runtime: {}, projection: {}, currentItem: undefined, projectPath: null };
const voidOptions = { uploadMode: undefined, targetType: undefined, fieldPath: undefined };

const MEDIA_REF_MARKER = { __media_ref__: true as const };

void test("toInlineDataPart: MediaRefPlaceholder inline_data -> 正确返回 inline_data 对象", () => {
  const item: MediaRefPlaceholder = {
    ...MEDIA_REF_MARKER,
    source: { kind: "inline_data", data: "aGVsbG8=", mimeType: "image/png" },
    mimeType: "image/png",
    transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
    filename: undefined,
    fieldPath: undefined,
  };

  const result = toInlineDataPart(item, voidState, voidOptions);

  assert.deepEqual(result, {
    inline_data: { mime_type: "image/png", data: "aGVsbG8=" },
  });
});

void test("toInlineDataPart: MediaRefPlaceholder url source (remote) -> 抛出错误", () => {
  const item: MediaRefPlaceholder = {
    ...MEDIA_REF_MARKER,
    source: { kind: "url", url: "https://example.com/image.png" },
    transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
    filename: undefined,
    fieldPath: undefined,
  };

  assert.throws(
    () => {
      toInlineDataPart(item, voidState, voidOptions);
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("Cannot convert MediaRefPlaceholder with remote url source to inline_data");
      }
      return false;
    },
  );
});

void test("toInlineDataPart: MediaRefPlaceholder inline_data 无显式 mimeType -> 使用 item.mimeType", () => {
  const item: MediaRefPlaceholder = {
    ...MEDIA_REF_MARKER,
    source: { kind: "inline_data", data: "aGVsbG8=", mimeType: "" },
    mimeType: "image/jpeg",
    transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
    filename: undefined,
    fieldPath: undefined,
  };

  const result = toInlineDataPart(item, voidState, voidOptions);

  assert.deepEqual(result, {
    inline_data: { mime_type: "image/jpeg", data: "aGVsbG8=" },
  });
});

void test("toInlineDataPart: url source + 本地文件 -> 返回 inline_data 格式", async () => {
  // 创建临时项目目录结构
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tidp-local-"));
  const mediaDir = path.join(tmpDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), "{}");

  // 创建测试图片文件
  const testImageContent = Buffer.from("test-image-bytes");
  fs.writeFileSync(path.join(mediaDir, "photo.png"), testImageContent);

  try {
    // 注册 project scope，构造带 scope 的 local-media:// URL
    const { registerRuntimeProjectScope, resolveLocalMediaUrl } =
      await import("../project-media-scope.cts");
    const registered = registerRuntimeProjectScope(tmpDir);
    assert.ok(registered, "project scope should register");
    const localMediaUrl = resolveLocalMediaUrl(registered.projectRef, "photo.png");
    assert.ok(localMediaUrl, "local-media URL should be generated");

    const state: EvaluateState = {
      fields: {},
      runtime: {},
      projection: {},
      currentItem: undefined,
      projectPath: tmpDir,
    };

    const item: MediaRefPlaceholder = {
      ...MEDIA_REF_MARKER,
      source: { kind: "url", url: localMediaUrl },
      mimeType: "image/png",
      transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
      filename: undefined,
      fieldPath: undefined,
    };

    const result = toInlineDataPart(item, state, voidOptions);

    assert.ok("inline_data" in result);
    const inlinePart = result as { inline_data: { mime_type: string; data: string } };
    assert.equal(inlinePart.inline_data.mime_type, "image/png");
    const decoded = Buffer.from(inlinePart.inline_data.data, "base64");
    assert.deepEqual(decoded, testImageContent);
  } finally {
    const { clearRuntimeProjectScopesForTest } = await import("../project-media-scope.cts");
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test("toInlineDataPart: url source + 本地文件 + 无 mimeType -> 从路径推断", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tidp-mime-"));
  const mediaDir = path.join(tmpDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), "{}");

  const testContent = Buffer.from("test-jpeg-bytes");
  fs.writeFileSync(path.join(mediaDir, "photo.jpg"), testContent);

  try {
    // 注册 project scope，构造带 scope 的 local-media:// URL
    const { registerRuntimeProjectScope, resolveLocalMediaUrl } =
      await import("../project-media-scope.cts");
    const registered = registerRuntimeProjectScope(tmpDir);
    assert.ok(registered, "project scope should register");
    const localMediaUrl = resolveLocalMediaUrl(registered.projectRef, "photo.jpg");
    assert.ok(localMediaUrl, "local-media URL should be generated");

    const state: EvaluateState = {
      fields: {},
      runtime: {},
      projection: {},
      currentItem: undefined,
      projectPath: tmpDir,
    };

    const item: MediaRefPlaceholder = {
      ...MEDIA_REF_MARKER,
      source: { kind: "url", url: localMediaUrl },
      mimeType: undefined,
      transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
      filename: undefined,
      fieldPath: undefined,
    };

    const result = toInlineDataPart(item, state, voidOptions);

    const inlinePart = result as { inline_data: { mime_type: string; data: string } };
    assert.equal(inlinePart.inline_data.mime_type, "image/jpeg");
  } finally {
    const { clearRuntimeProjectScopesForTest } = await import("../project-media-scope.cts");
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test("toInlineDataPart: url source + 远程 URL -> 抛出错误", () => {
  const item: MediaRefPlaceholder = {
    ...MEDIA_REF_MARKER,
    source: { kind: "url", url: "https://cdn.example.com/media/image.png" },
    transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
    filename: undefined,
    fieldPath: undefined,
  };

  assert.throws(
    () => {
      toInlineDataPart(item, voidState, voidOptions);
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("Cannot convert MediaRefPlaceholder with remote url source to inline_data");
      }
      return false;
    },
  );
});

void test("toInlineDataPart: url source + 文件不存在 -> 抛出错误", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tidp-missing-"));
  const mediaDir = path.join(tmpDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), "{}");

  try {
    // 注册 project scope 后用带 scope 的 URL 指向不存在的文件，触发 FILE_NOT_FOUND
    const { registerRuntimeProjectScope, resolveLocalMediaUrl } =
      await import("../project-media-scope.cts");
    const registered = registerRuntimeProjectScope(tmpDir);
    assert.ok(registered, "project scope should register");
    const missingUrl = resolveLocalMediaUrl(registered.projectRef, "nonexistent.png");
    assert.ok(missingUrl, "local-media URL should be generated");

    const state: EvaluateState = {
      fields: {},
      runtime: {},
      projection: {},
      currentItem: undefined,
      projectPath: tmpDir,
    };

    const item: MediaRefPlaceholder = {
      ...MEDIA_REF_MARKER,
      source: { kind: "url", url: missingUrl },
      mimeType: "image/png",
      transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
      filename: undefined,
      fieldPath: undefined,
    };

    assert.throws(
      () => {
        toInlineDataPart(item, state, voidOptions);
      },
      (error: unknown) => {
        if (error instanceof Error) {
          return error.message.includes("FILE_NOT_FOUND") || error.message.includes("not found");
        }
        return false;
      },
    );
  } finally {
    const { clearRuntimeProjectScopesForTest } = await import("../project-media-scope.cts");
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

void test("toInlineDataPart: url source + projectPath 为 null -> 抛出错误", () => {
  const item: MediaRefPlaceholder = {
    ...MEDIA_REF_MARKER,
    source: { kind: "url", url: "local-media://test.png" },
    mimeType: "image/png",
    transport: MEDIA_REF_TRANSPORT.INLINE_DATA,
    filename: undefined,
    fieldPath: undefined,
  };

  assert.throws(
    () => {
      toInlineDataPart(item, voidState, voidOptions);
    },
    (error: unknown) => {
      if (error instanceof Error) {
        return error.message.includes("projectPath");
      }
      return false;
    },
  );
});

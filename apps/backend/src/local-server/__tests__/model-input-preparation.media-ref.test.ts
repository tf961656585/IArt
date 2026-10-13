import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareModelInputForRequest } from "../model-input-preparation/model-input-preparation.cts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

const SELF_HOSTED_ENDPOINT_ENV =
  "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT";

const CLOUDFLARE_ENDPOINT_ENV =
  "IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT";

/**
 * Install a globalThis.fetch mock that responds to relay uploads with
 * sequential URLs from the provided array.
 */
const installRelayMock = (
  t: test.TestContext,
  relayEndpoint: string,
  urls: string[],
): { getUploadCount: () => number } => {
  const previousEndpoint =
    relayEndpoint.includes("cloudflare")
      ? process.env[CLOUDFLARE_ENDPOINT_ENV]
      : process.env[SELF_HOSTED_ENDPOINT_ENV];
  const envKey =
    relayEndpoint.includes("cloudflare")
      ? CLOUDFLARE_ENDPOINT_ENV
      : SELF_HOSTED_ENDPOINT_ENV;
  process.env[envKey] = relayEndpoint;

  const originalFetch = globalThis.fetch;
  let uploadCount = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    const url = urls[uploadCount] ?? urls.at(-1) ?? "https://cdn.example.com/input.png";
    uploadCount += 1;
    return new Response(JSON.stringify({ success: true, url }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(envKey, previousEndpoint);
  });

  return { getUploadCount: () => uploadCount };
};

const buildPublicUrlProjection = (
  modelId: string,
  payloadRules: Record<string, unknown>,
  targetType: string = "self_hosted_image_public_url",
) => ({
  model_id: modelId,
  runtime: {
    url_input_upload_mode: "public_relay",
    url_input_upload_target_type: targetType,
    payload_rules: payloadRules,
  },
});

const buildMultipartProjection = (
  modelId: string,
  payloadRules: Record<string, unknown>,
) => ({
  model_id: modelId,
  runtime: {
    payload_format: "multipart",
    payload_rules: payloadRules,
  },
});

const makeInlineDataPlaceholder = (
  data: string,
  mimeType: string,
  filename: string | undefined,
  fieldPath: string | undefined,
) => ({
  __media_ref__: true as const,
  source: { kind: "inline_data" as const, data, mimeType },
  mimeType,
  filename,
  fieldPath,
});

const makeUrlPlaceholder = (
  url: string,
  mimeType: string | undefined,
  filename: string | undefined,
  fieldPath: string | undefined,
) => ({
  __media_ref__: true as const,
  source: { kind: "url" as const, url },
  mimeType,
  filename,
  fieldPath,
});

// ---------------------------------------------------------------------------
// Test 1: publicUrl + inline_data happy path
// ---------------------------------------------------------------------------

void test("MediaRef pipeline: publicUrl + inline_data happy path", async (t) => {
  const { getUploadCount } = installRelayMock(
    t,
    "https://upload.example.com/relay",
    ["https://cdn.example.com/inline-image.png"],
  );
  const modelId = "media-ref-public-inline";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/project.iartproj",
    projection: buildPublicUrlProjection(modelId, {
      "body.image": {
        kind: "field",
        field_key: "image",
        media_target: "public_url",
        transforms: ["extractFirstUrl"],
      },
    }),
    body: {
      image: makeInlineDataPlaceholder(
        "aGVsbG8=",
        "image/png",
        "photo.png",
        "body.image",
      ),
      prompt: "describe this image",
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  assert.equal(getUploadCount(), 1);
  if (prepared.ok) {
    const body = prepared.body as { image: unknown; prompt: unknown };
    assert.equal(body.image, "https://cdn.example.com/inline-image.png");
    assert.equal(body.prompt, "describe this image");
    assert.equal(
      prepared.events.filter(
        (event) => event.type === "task.input_upload_succeeded",
      ).length,
      1,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 2: publicUrl + url happy path
// ---------------------------------------------------------------------------

void test("MediaRef pipeline: publicUrl + url source reads file then uploads", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "media-ref-url-source-"),
  );
  // Create valid project structure so resolveImageProcessingSource can resolve
  fs.writeFileSync(path.join(tempDir, "project.sqlite"), "");
  const mediaDir = path.join(tempDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaFile = path.join(mediaDir, "local-image.png");
  fs.writeFileSync(mediaFile, Buffer.from("local-png-content"));

  // 注册 project scope，构造带 scope 的 local-media:// URL（无 scope 形态不再被解析器接受）
  const { registerRuntimeProjectScope, resolveLocalMediaUrl, clearRuntimeProjectScopesForTest } =
    await import("../project-media-scope.cts");
  const registered = registerRuntimeProjectScope(tempDir);
  assert.ok(registered, "project scope should register");
  const localImageUrl = resolveLocalMediaUrl(registered.projectRef, "local-image.png");
  assert.ok(localImageUrl, "local-media URL should be generated");

  const { getUploadCount } = installRelayMock(
    t,
    "https://upload.example.com/relay",
    ["https://cdn.example.com/url-image.png"],
  );

  const modelId = "media-ref-public-url";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: tempDir,
    projection: buildPublicUrlProjection(modelId, {
      "body.image": {
        kind: "field",
        field_key: "image",
        media_target: "public_url",
        transforms: ["extractFirstUrl"],
      },
    }),
    body: {
      image: makeUrlPlaceholder(
        localImageUrl,
        "image/png",
        "local-image.png",
        "body.image",
      ),
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  assert.equal(prepared.ok, true);
  assert.equal(getUploadCount(), 1);
  if (prepared.ok) {
    const body = prepared.body as { image: unknown };
    assert.equal(body.image, "https://cdn.example.com/url-image.png");
  }
});

// ---------------------------------------------------------------------------
// Test 3: multipart + inline_data happy path
// ---------------------------------------------------------------------------

void test("MediaRef pipeline: multipart + inline_data -> Buffer replacement", async () => {
  const modelId = "media-ref-multipart-inline";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/project.iartproj",
    projection: buildMultipartProjection(modelId, {
      "body.file": {
        kind: "field",
        field_key: "file",
        media_target: "multipart_file",
        transforms: ["extractFirstFile"],
      },
    }),
    body: {
      file: makeInlineDataPlaceholder(
        "SGVsbG8gV29ybGQ=",
        "application/octet-stream",
        "data.bin",
        "body.file",
      ),
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    // multipart converts body to __formData serialized form
    const body = prepared.body as {
      __formData: {
        fields: Array<{ name: string; value: string }>;
        files: Array<{ name: string; dataBase64: string; contentType: string; filename: string }>;
      };
    };
    assert.ok(body.__formData, "body should be serialized formData");
    assert.equal(body.__formData.files.length, 1);
    const file0 = body.__formData.files[0];
    if (file0 === undefined) {
      assert.fail("expected files[0] to exist");
    }
    assert.equal(file0.name, "file");
    assert.equal(
      file0.dataBase64,
      "SGVsbG8gV29ybGQ=",
    );
  }
});

// ---------------------------------------------------------------------------
// Test 4: multipart + url happy path
// ---------------------------------------------------------------------------

void test("MediaRef pipeline: multipart + url source reads file -> Buffer", async (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "media-ref-multipart-url-"),
  );
  // Create valid project structure so resolveImageProcessingSource can resolve
  fs.writeFileSync(path.join(tempDir, "project.sqlite"), "");
  const mediaDir = path.join(tempDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaFile = path.join(mediaDir, "reference.jpg");
  const fileContent = Buffer.from("jpeg-binary-content");
  fs.writeFileSync(mediaFile, fileContent);

  // 注册 project scope，构造带 scope 的 local-media:// URL
  const { registerRuntimeProjectScope, resolveLocalMediaUrl, clearRuntimeProjectScopesForTest } =
    await import("../project-media-scope.cts");
  const registered = registerRuntimeProjectScope(tempDir);
  assert.ok(registered, "project scope should register");
  const referenceUrl = resolveLocalMediaUrl(registered.projectRef, "reference.jpg");
  assert.ok(referenceUrl, "local-media URL should be generated");

  const modelId = "media-ref-multipart-url";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: tempDir,
    projection: buildMultipartProjection(modelId, {
      "body.reference": {
        kind: "field",
        field_key: "reference",
        media_target: "multipart_file",
        transforms: ["extractFirstFile"],
      },
    }),
    body: {
      reference: makeUrlPlaceholder(
        referenceUrl,
        "image/jpeg",
        "reference.jpg",
        "body.reference",
      ),
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  t.after(() => {
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    const body = prepared.body as {
      __formData: {
        fields: Array<{ name: string; value: string }>;
        files: Array<{ name: string; dataBase64: string; contentType: string; filename: string }>;
      };
    };
    assert.ok(body.__formData, "body should be serialized formData");
    assert.equal(body.__formData.files.length, 1);
    const file0 = body.__formData.files[0];
    if (file0 === undefined) {
      assert.fail("expected files[0] to exist");
    }
    assert.equal(file0.name, "reference");
    assert.equal(
      file0.dataBase64,
      fileContent.toString("base64"),
    );
  }
});

// ---------------------------------------------------------------------------
// Test 5: source resolution failure
// ---------------------------------------------------------------------------

void test("MediaRef pipeline: source resolution failure returns structured error", async (t) => {
  // multipart with url source pointing to a nonexistent file
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "media-ref-source-fail-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const modelId = "media-ref-source-fail";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: tempDir,
    projection: buildMultipartProjection(modelId, {
      "body.file": {
        kind: "field",
        field_key: "file",
        media_target: "multipart_file",
        transforms: ["extractFirstFile"],
      },
    }),
    body: {
      file: makeUrlPlaceholder(
        "local-media://project-media/nonexistent-file.png",
        "image/png",
        "missing.png",
        "body.file",
      ),
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.equal(prepared.error.code, "multipart_file_resolve_failed");
    assert.match(
      prepared.error.message,
      /local file not found|failed to read local file/,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 6: mixed scenario — placeholders and plain values coexist
// ---------------------------------------------------------------------------

void test("MediaRef pipeline: mixed body with placeholders and plain strings", async (t) => {
  const { getUploadCount } = installRelayMock(
    t,
    "https://upload.example.com/relay",
    [
      "https://cdn.example.com/placeholder-image.png",
    ],
  );

  const modelId = "media-ref-mixed";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/project.iartproj",
    projection: buildPublicUrlProjection(modelId, {
      "body.images": {
        kind: "field",
        field_key: "images",
        media_target: "public_url",
        transforms: ["extractUrls"],
      },
    }),
    body: {
      images: [
        makeInlineDataPlaceholder(
          "aGVsbG8=",
          "image/png",
          "ref.png",
          "body.images",
        ),
        "https://already-public.example.com/photo.jpg",
        "not a media reference!",
      ],
      prompt: "generate something",
      temperature: 0.7,
    },
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  assert.equal(getUploadCount(), 1);
  if (prepared.ok) {
    const body = prepared.body as {
      images: unknown[];
      prompt: unknown;
      temperature: unknown;
    };
    assert.equal(body.images.length, 3);
    // First: placeholder resolved to CDN URL
    assert.equal(
      body.images[0],
      "https://cdn.example.com/placeholder-image.png",
    );
    // Second: already remote URL, kept as-is
    assert.equal(
      body.images[1],
      "https://already-public.example.com/photo.jpg",
    );
    // Third: plain string, kept as-is
    assert.equal(body.images[2], "not a media reference!");
    // Other fields untouched
    assert.equal(body.prompt, "generate something");
    assert.equal(body.temperature, 0.7);
  }
});

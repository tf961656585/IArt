import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isMediaRefPlaceholder } from "@iart/contracts";
import { prepareMultipartFileSubtree } from "../model-input-preparation/model-input-multipart-file.cts";

const makeContext = (projectPath: string = "/tmp/project.iartproj") => ({
  projectPath,
});

// ---------------------------------------------------------------------------
// Test 1: data URL string -> Buffer
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: data URL string -> Buffer with correct length", async () => {
  // "hello" in base64 is "aGVsbG8="
  const dataUrl = "data:image/png;base64,aGVsbG8=";
  const result = await prepareMultipartFileSubtree(
    makeContext(),
    dataUrl,
    "body.file",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Buffer.isBuffer(result.value), true);
    if (Buffer.isBuffer(result.value)) {
      assert.equal(result.value.length, 5); // "hello" is 5 bytes
      assert.equal(result.value.toString("utf-8"), "hello");
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: plain string passes through
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: plain string passes through unchanged", async () => {
  const result = await prepareMultipartFileSubtree(
    makeContext(),
    "hello",
    "body.file",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(typeof result.value, "string");
    assert.equal(result.value, "hello");
  }
});

// ---------------------------------------------------------------------------
// Test 3: empty string passes through
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: empty string passes through", async () => {
  const result = await prepareMultipartFileSubtree(
    makeContext(),
    "",
    "body.file",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, "");
  }
});

// ---------------------------------------------------------------------------
// Test 4: remote URL passes through as string
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: remote URL string passes through", async () => {
  const result = await prepareMultipartFileSubtree(
    makeContext(),
    "https://example.com/image.png",
    "body.file",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(typeof result.value, "string");
    assert.equal(result.value, "https://example.com/image.png");
  }
});

// ---------------------------------------------------------------------------
// Test 5: MediaRefPlaceholder (inline_data) -> Buffer
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: MediaRefPlaceholder inline_data -> Buffer", async () => {
  // "test-image" in base64 is "dGVzdC1pbWFnZQ=="
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: "dGVzdC1pbWFnZQ==",
      mimeType: "image/png",
    },
  };

  assert.equal(isMediaRefPlaceholder(placeholder), true);

  const result = await prepareMultipartFileSubtree(
    makeContext(),
    placeholder,
    "body.image",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Buffer.isBuffer(result.value), true);
    if (Buffer.isBuffer(result.value)) {
      assert.equal(result.value.toString("utf-8"), "test-image");
    }
  }
});

// ---------------------------------------------------------------------------
// Test 12: prepareMultipartFileSubtree: MediaRefPlaceholder inline_data empty data -> error
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: MediaRefPlaceholder inline_data empty data -> error", async () => {
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: "",
      mimeType: "image/png",
    },
  };

  const result = await prepareMultipartFileSubtree(
    makeContext(),
    placeholder,
    "body.image",
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.message.includes("empty data") || result.message.includes("empty"),
      `Expected message to mention empty data, got: ${result.message}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 13: prepareMultipartFileSubtree: MediaRefPlaceholder url local file -> Buffer
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: MediaRefPlaceholder url local file -> Buffer", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multipart-test-"));
  const projectDir = path.join(tmpDir, "test.iartproj");
  const mediaDir = path.join(projectDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "manifest.json"),
    JSON.stringify({ version: 1, name: "test" }),
    "utf-8",
  );
  const fileContent = "local-file-content";
  const fileKey = "test-image.png";
  fs.writeFileSync(path.join(mediaDir, fileKey), fileContent);

  try {
    const { registerRuntimeProjectScope, resolveLocalMediaUrl } =
      await import("../project-media-scope.cts");
    const registered = registerRuntimeProjectScope(projectDir);
    assert.ok(registered, "project scope should register");
    const localMediaUrl = resolveLocalMediaUrl(registered.projectRef, fileKey);
    assert.ok(localMediaUrl, "local-media URL should be generated");

    const placeholder = {
      __media_ref__: true as const,
      source: {
        kind: "url" as const,
        url: localMediaUrl,
      },
    };

    const result = await prepareMultipartFileSubtree(
      makeContext(projectDir),
      placeholder,
      "body.image",
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(Buffer.isBuffer(result.value), true);
      if (Buffer.isBuffer(result.value)) {
        assert.equal(result.value.toString("utf-8"), fileContent);
      }
    }
  } finally {
    const { clearRuntimeProjectScopesForTest } = await import("../project-media-scope.cts");
    clearRuntimeProjectScopesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// Test 14: prepareMultipartFileSubtree: MediaRefPlaceholder url remote -> error
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: MediaRefPlaceholder url remote URL -> error", async () => {
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "url" as const,
      url: "https://example.com/image.png",
    },
  };

  const result = await prepareMultipartFileSubtree(
    makeContext(),
    placeholder,
    "body.image",
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.message.includes("remote URL") || result.message.includes("remote"),
      `Expected message to mention remote URL, got: ${result.message}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 15: prepareMultipartFileSubtree: array of MediaRefPlaceholders -> array of Buffers
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: array of MediaRefPlaceholders -> array of Buffers", async () => {
  const placeholder1 = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: Buffer.from("first-image").toString("base64"),
      mimeType: "image/png",
    },
  };
  const placeholder2 = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: Buffer.from("second-image").toString("base64"),
      mimeType: "image/jpeg",
    },
  };

  const result = await prepareMultipartFileSubtree(
    makeContext(),
    [placeholder1, placeholder2],
    "body.images",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Array.isArray(result.value), true);
    if (Array.isArray(result.value)) {
      assert.equal(result.value.length, 2);
      assert.equal(Buffer.isBuffer(result.value[0]), true);
      assert.equal(Buffer.isBuffer(result.value[1]), true);
      if (Buffer.isBuffer(result.value[0]) && Buffer.isBuffer(result.value[1])) {
        assert.equal(result.value[0].toString("utf-8"), "first-image");
        assert.equal(result.value[1].toString("utf-8"), "second-image");
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Test 25: prepareMultipartFileSubtree: MediaRefPlaceholder url nonexistent local file -> error
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: MediaRefPlaceholder url nonexistent local file -> error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multipart-test-"));
  const projectDir = path.join(tmpDir, "test.iartproj");
  const mediaDir = path.join(projectDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "manifest.json"),
    JSON.stringify({ version: 1, name: "test" }),
    "utf-8",
  );

  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "url" as const,
      url: "local-media://nonexistent-file.png",
    },
  };

  const result = await prepareMultipartFileSubtree(
    makeContext(projectDir),
    placeholder,
    "body.image",
  );

  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(
      result.message.includes("not found") || result.message.includes("Failed"),
      `Expected message about file not found, got: ${result.message}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 26: prepareMultipartFileSubtree: nested object with MediaRefPlaceholder
// ---------------------------------------------------------------------------

void test("prepareMultipartFileSubtree: nested object containing MediaRefPlaceholder -> resolved", async () => {
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: Buffer.from("nested-image").toString("base64"),
      mimeType: "image/png",
    },
  };

  const result = await prepareMultipartFileSubtree(
    makeContext(),
    { type: "image", data: placeholder },
    "body.contents",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(typeof result.value, "object");
    if (result.value !== null && typeof result.value === "object") {
      const obj = result.value as Record<string, unknown>;
      assert.equal(obj["type"], "image");
      assert.equal(Buffer.isBuffer(obj["data"]), true);
      if (Buffer.isBuffer(obj["data"])) {
        assert.equal(obj["data"].toString("utf-8"), "nested-image");
      }
    }
  }
});

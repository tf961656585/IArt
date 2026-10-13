import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isMediaRefPlaceholder,
  type MediaRefPlaceholder,
} from "@iart/contracts";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const createRuntimeModelPackage = (
  rootDir: string,
  modelId: string,
  payloadRules: Record<string, unknown>,
) => {
  const packagesRoot = path.join(rootDir, "packages");
  const packageDir = path.join(packagesRoot, modelId);
  fs.mkdirSync(packageDir, { recursive: true });

  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: modelId,
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

  writeJson(path.join(packageDir, "locales", "zh-CN.json"), {
    Reference: "Reference",
    Shots: "Shots",
    Images: "Images",
    File: "File",
  });
  writeJson(path.join(packageDir, "locales", "en.json"), {
    Reference: "Reference",
    Shots: "Shots",
    Images: "Images",
    File: "File",
  });

  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: `model.test.${modelId}`,
    group_key: "test",
    input_ports: [],
    output_ports: [],
  });

  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: modelId,
    provider_id: "openai",
    capability: {
      input_modalities: ["text", "image"],
      output_modalities: ["image"],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [
        { field_key: "reference", label: "Reference", component: "textarea" },
        { field_key: "shots", label: "Shots", component: "textarea" },
        { field_key: "images", label: "Images", component: "imageUpload" },
        { field_key: "file", label: "File", component: "file" },
      ],
    },
    runtime: {
      provider_id: "openai",
      model_id: `${modelId}-key`,
      execution_driver: "http_formal_task",
      payload_format: "multipart",
      api_defaults: {
        endpoint: "/v1/tasks",
        method: "POST",
        contentType: "application/json",
      },
      payload_rules: payloadRules,
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/tasks",
      method: "POST",
    },
    result_rule: {
      mode: "sync",
      submit_response_id_path: "/id",
    },
    result_output_mapping: {
      response_mode: "structured_payload",
      output_mapping_rules: [
        {
          target: "output.image_url",
          source: { kind: "response", path: "image_url" },
          required: false,
          default_value: null,
        },
      ],
    },
  });

  return packagesRoot;
};

void test("assembleGenerationTaskRequest: extractFirstFile 与 firstUploadFile transform 可在 backend 执行", async (t) => {
  const { assembleGenerationTaskRequest } =
    await import("../local-server/request-assembler.cts");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assembler-transform-files-"),
  );
  const previousPackagesDir = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const modelId = "backend-transform-file-model";
  const packagesRoot = createRuntimeModelPackage(tempDir, modelId, {
    "body.input_reference": {
      kind: "field",
      field_key: "reference",
      media_target: "multipart_file",
      transforms: ["extractFirstFile"],
    },
    "body.backup_reference": {
      kind: "field",
      field_key: "reference",
      media_target: "multipart_file",
      transforms: ["firstUploadFile"],
    },
  });

  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packagesRoot;
  t.after(() => {
    if (previousPackagesDir == null) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackagesDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const assembled = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      arguments: {
        reference: ["data:image/png;base64,YWJjZGVmZ2hpamtsbW5vcA=="],
      },
    },
    { projectPath: null, baseDir: process.cwd() },
  );

  const body = assembled.executionPlan.submit_request.body as Record<
    string,
    unknown
  >;
  const primaryValue = body["input_reference"];
  const backupValue = body["backup_reference"];
  assert.equal(isMediaRefPlaceholder(primaryValue), true);
  assert.equal(isMediaRefPlaceholder(backupValue), true);
  const primaryRef = primaryValue as MediaRefPlaceholder;
  const backupRef = backupValue as MediaRefPlaceholder;
  assert.equal(primaryRef.source.kind, "inline_data");
  assert.equal(backupRef.source.kind, "inline_data");
});

void test("assembleGenerationTaskRequest: shotListToTimeline 与 timelineToScript transform 可在 backend 执行", async (t) => {
  const { assembleGenerationTaskRequest } =
    await import("../local-server/request-assembler.cts");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assembler-transform-timeline-"),
  );
  const previousPackagesDir = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const modelId = "backend-transform-timeline-model";
  const packagesRoot = createRuntimeModelPackage(tempDir, modelId, {
    "body.timeline": {
      kind: "field",
      field_key: "shots",
      transforms: ["shotListToTimeline"],
    },
    "body.timelineScript": {
      kind: "field",
      field_key: "shots",
      transforms: ["shotListToTimeline", "timelineToScript"],
    },
  });

  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packagesRoot;
  t.after(() => {
    if (previousPackagesDir == null) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackagesDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const assembled = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      arguments: {
        shots: [
          {
            title: "Opening city",
            description: "Wide skyline",
            durationSeconds: 4,
            cameraMotion: "orbit",
          },
          {
            title: "Hero close-up",
            prompt: "Lead shares a line",
            durationSeconds: 3,
            cameraMotion: "static",
          },
        ],
      },
    },
    { projectPath: null, baseDir: process.cwd() },
  );

  const body = assembled.executionPlan.submit_request.body as Record<
    string,
    unknown
  >;
  const timeline = body["timeline"] as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(timeline), true);
  assert.equal(timeline[0]?.["title"], "Opening city");
  assert.equal(timeline[0]?.["startAtSeconds"], 0);
  assert.equal(timeline[1]?.["startAtSeconds"], 4);
  assert.equal(timeline[1]?.["durationSeconds"], 3);
  assert.equal(typeof body["timelineScript"], "string");
  assert.match(String(body["timelineScript"]), /1\./);
  assert.match(String(body["timelineScript"]), /Opening city/);
});

// ---------------------------------------------------------------------------
// multipart_file 模式 + extractUrls / extractFirstFile transform
// ---------------------------------------------------------------------------

void test("assembleGenerationTaskRequest: extractUrls + multipart_file + inline_data input -> MediaRefPlaceholder source.kind=inline_data", async (t) => {
  const { assembleGenerationTaskRequest } =
    await import("../local-server/request-assembler.cts");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assembler-multipart-extractUrls-inline-"),
  );
  const previousPackagesDir = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const modelId = "backend-multipart-extractUrls-inline";
  const packagesRoot = createRuntimeModelPackage(tempDir, modelId, {
    "body.images": {
      kind: "field",
      field_key: "images",
      media_target: "multipart_file",
      transforms: ["extractUrls"],
    },
  });

  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packagesRoot;
  t.after(() => {
    if (previousPackagesDir == null) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackagesDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const assembled = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      arguments: {
        images: [
          { kind: "inline_data", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    },
    { projectPath: null, baseDir: process.cwd() },
  );

  const body = assembled.executionPlan.submit_request.body as Record<
    string,
    unknown
  >;
  const images = body["images"] as unknown[];
  assert.equal(Array.isArray(images), true);
  assert.equal(images.length, 1);

  const first = images[0];
  assert.equal(isMediaRefPlaceholder(first), true);
  const placeholder = first as MediaRefPlaceholder;
  assert.equal(placeholder.source.kind, "inline_data");
});

void test("assembleGenerationTaskRequest: extractUrls + multipart_file + data URL string input -> MediaRefPlaceholder source.kind=inline_data", async (t) => {
  const { assembleGenerationTaskRequest } =
    await import("../local-server/request-assembler.cts");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assembler-multipart-extractUrls-dataurl-"),
  );
  const previousPackagesDir = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const modelId = "backend-multipart-extractUrls-dataurl";
  const packagesRoot = createRuntimeModelPackage(tempDir, modelId, {
    "body.images": {
      kind: "field",
      field_key: "images",
      media_target: "multipart_file",
      transforms: ["extractUrls"],
    },
  });

  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packagesRoot;
  t.after(() => {
    if (previousPackagesDir == null) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackagesDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const assembled = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      arguments: {
        images: ["data:image/png;base64,aGVsbG8="],
      },
    },
    { projectPath: null, baseDir: process.cwd() },
  );

  const body = assembled.executionPlan.submit_request.body as Record<
    string,
    unknown
  >;
  const images = body["images"] as unknown[];
  assert.equal(Array.isArray(images), true);
  assert.equal(images.length, 1);

  const first = images[0];
  assert.equal(isMediaRefPlaceholder(first), true);
  const placeholder = first as MediaRefPlaceholder;
  assert.equal(placeholder.source.kind, "inline_data");
  if (placeholder.source.kind === "inline_data") {
    assert.equal(placeholder.source.data, "aGVsbG8=");
    assert.equal(placeholder.source.mimeType, "image/png");
  }
});

void test("assembleGenerationTaskRequest: extractUrls + multipart_file + remote URL string input -> MediaRefPlaceholder source.kind=url", async (t) => {
  const { assembleGenerationTaskRequest } =
    await import("../local-server/request-assembler.cts");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assembler-multipart-extractUrls-remote-"),
  );
  const previousPackagesDir = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const modelId = "backend-multipart-extractUrls-remote";
  const packagesRoot = createRuntimeModelPackage(tempDir, modelId, {
    "body.images": {
      kind: "field",
      field_key: "images",
      media_target: "multipart_file",
      transforms: ["extractUrls"],
    },
  });

  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packagesRoot;
  t.after(() => {
    if (previousPackagesDir == null) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackagesDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const assembled = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      arguments: {
        images: ["https://example.com/image.png"],
      },
    },
    { projectPath: null, baseDir: process.cwd() },
  );

  const body = assembled.executionPlan.submit_request.body as Record<
    string,
    unknown
  >;
  const images = body["images"] as unknown[];
  assert.equal(Array.isArray(images), true);
  assert.equal(images.length, 1);

  const first = images[0];
  assert.equal(isMediaRefPlaceholder(first), true);
  const placeholder = first as MediaRefPlaceholder;
  assert.equal(placeholder.source.kind, "url");
  if (placeholder.source.kind === "url") {
    assert.equal(placeholder.source.url, "https://example.com/image.png");
  }
});

void test("assembleGenerationTaskRequest: extractFirstFile + multipart_file + inline_data input -> MediaRefPlaceholder source.kind=inline_data", async (t) => {
  const { assembleGenerationTaskRequest } =
    await import("../local-server/request-assembler.cts");

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assembler-multipart-extractFirst-inline-"),
  );
  const previousPackagesDir = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const modelId = "backend-multipart-extractFirst-inline";
  const packagesRoot = createRuntimeModelPackage(tempDir, modelId, {
    "body.file": {
      kind: "field",
      field_key: "file",
      media_target: "multipart_file",
      transforms: ["extractFirstFile"],
    },
  });

  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packagesRoot;
  t.after(() => {
    if (previousPackagesDir == null) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackagesDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const assembled = await assembleGenerationTaskRequest(
    {
      model_id: modelId,
      arguments: {
        file: ["data:image/png;base64,YWJjZGVmZ2hpamtsbW5vcA=="],
      },
    },
    { projectPath: null, baseDir: process.cwd() },
  );

  const body = assembled.executionPlan.submit_request.body as Record<
    string,
    unknown
  >;
  const fileValue = body["file"];
  assert.equal(isMediaRefPlaceholder(fileValue), true);
  const placeholder = fileValue as MediaRefPlaceholder;
  assert.equal(placeholder.source.kind, "inline_data");
});

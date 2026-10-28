import assert from "node:assert/strict";
import test from "node:test";

import { guardPreparedModelInput } from "../model-input-preparation/model-input-final-guard.cts";
import { convertBodyToSerializedFormData } from "../model-input-preparation/model-input-multipart-file.cts";
import { prepareModelInputForRequest } from "../model-input-preparation/model-input-preparation.cts";
import { buildFormDataFromSerialized } from "../task-engine-request.cts";

// ---------------------------------------------------------------------------
// Test 6: convertBodyToSerializedFormData with Buffer -> files array non-empty
// ---------------------------------------------------------------------------

void test("convertBodyToSerializedFormData: body with Buffer produces files entry", () => {
  const buffer = Buffer.from("file-content");
  const body = {
    prompt: "edit this image",
    image: buffer,
  };

  const result = convertBodyToSerializedFormData(body);

  assert.equal(typeof result.__formData, "object");
  assert.equal(Array.isArray(result.__formData.fields), true);
  assert.equal(Array.isArray(result.__formData.files), true);
  assert.equal(result.__formData.files.length, 1);
  const fileEntry = result.__formData.files[0];
  assert.ok(fileEntry);
  assert.equal(fileEntry.name, "image");
  assert.equal(fileEntry.dataBase64, buffer.toString("base64"));
  assert.equal(result.__formData.fields.length, 1);
  const fieldEntry = result.__formData.fields[0];
  assert.ok(fieldEntry);
  assert.equal(fieldEntry.name, "prompt");
  assert.equal(fieldEntry.value, "edit this image");
});

// ---------------------------------------------------------------------------
// Test 7: convertBodyToSerializedFormData with nested Buffer
// ---------------------------------------------------------------------------

void test("convertBodyToSerializedFormData: nested object with Buffer", () => {
  const buffer = Buffer.from("nested-file");
  const body = {
    contents: [
      { type: "text", text: "hello" },
      { type: "image", image: buffer },
    ],
  };

  const result = convertBodyToSerializedFormData(body);

  assert.equal(result.__formData.files.length, 1);
  const fileEntry = result.__formData.files[0];
  assert.ok(fileEntry);
  assert.equal(fileEntry.name, "contents[1].image");
  assert.equal(
    fileEntry.dataBase64,
    buffer.toString("base64"),
  );
});

// ---------------------------------------------------------------------------
// Test 8: multipart guard rejects unresolved MediaRefPlaceholder
// ---------------------------------------------------------------------------

void test("guardPreparedModelInput: rejects body containing unresolved MediaRefPlaceholder for multipart policy", () => {
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: "dGVzdA==",
      mimeType: "image/png",
    },
  };

  const body = {
    prompt: "edit this",
    image: placeholder,
  };

  const result = guardPreparedModelInput({
    body,
    policy: {
      modelId: "test-model",
      projection: {},
      payloadFormat: "multipart",
      publicUrl: null,
      multipartFiles: {
        fields: [
          { targetPath: "body.image", requestBodyPath: "image", multipartArrayNaming: undefined },
        ],
      },
      inlineData: null,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "model_input_unresolved_placeholder");
    assert.ok(result.message.includes("image"));
  }
});

// ---------------------------------------------------------------------------
// Test 9: multipart guard accepts resolved Buffer
// ---------------------------------------------------------------------------

void test("guardPreparedModelInput: accepts body with resolved Buffer for multipart policy", () => {
  const body = {
    prompt: "edit this",
    image: Buffer.from("resolved-buffer"),
  };

  const result = guardPreparedModelInput({
    body,
    policy: {
      modelId: "test-model",
      projection: {},
      payloadFormat: "multipart",
      publicUrl: null,
      multipartFiles: {
        fields: [
          { targetPath: "body.image", requestBodyPath: "image", multipartArrayNaming: undefined },
        ],
      },
      inlineData: null,
    },
  });

  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Test 10: buildFormDataFromSerialized throws when all files skipped
// ---------------------------------------------------------------------------

void test("buildFormDataFromSerialized: throws when all file entries are invalid", () => {
  const payload = {
    fields: [],
    files: [
      { name: "", dataBase64: "dGVzdA==", contentType: "image/png", filename: "file.png" },
    ],
  };

  assert.throws(
    () => buildFormDataFromSerialized(payload),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("all 1 file(s) were skipped"));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 11: buildFormDataFromSerialized succeeds with valid files
// ---------------------------------------------------------------------------

void test("buildFormDataFromSerialized: returns FormData with valid file entries", () => {
  const buffer = Buffer.from("valid-content");
  const payload = {
    fields: [{ name: "prompt", value: "edit this" }],
    files: [
      {
        name: "image",
        dataBase64: buffer.toString("base64"),
        contentType: "image/png",
        filename: "image.png",
      },
    ],
  };

  const form = buildFormDataFromSerialized(payload);

  assert.ok(form instanceof FormData);
});

// ---------------------------------------------------------------------------
// Test 16: convertBodyToSerializedFormData: unresolved MediaRefPlaceholder -> not in files
// ---------------------------------------------------------------------------

void test("convertBodyToSerializedFormData: unresolved MediaRefPlaceholder produces no file entries", () => {
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: "dGVzdA==",
      mimeType: "image/png",
    },
  };

  const body = {
    model: "gpt-image-2",
    prompt: "test",
    image: placeholder,
  };

  const result = convertBodyToSerializedFormData(body);

  // unresolved placeholder is a plain object, not a Buffer, so it should NOT appear in files.
  // Instead, its nested properties get flattened into fields (e.g. image.__media_ref__, image.source.kind).
  assert.equal(result.__formData.files.length, 0);
  assert.ok(result.__formData.fields.length > 0);
  // Verify model and prompt fields are present as plain fields
  const modelField = result.__formData.fields.find((f: { name: string }) => f.name === "model");
  assert.ok(modelField, "Expected model field to be present in fields");
  assert.equal(modelField.value, "gpt-image-2");
  const promptField = result.__formData.fields.find((f: { name: string }) => f.name === "prompt");
  assert.ok(promptField, "Expected prompt field to be present in fields");
  assert.equal(promptField.value, "test");
  // Verify placeholder sub-properties were flattened into fields (not files)
  const mediaRefField = result.__formData.fields.find((f: { name: string }) => f.name === "image.__media_ref__");
  assert.ok(mediaRefField, "Expected image.__media_ref__ to be flattened into fields");
});

// ---------------------------------------------------------------------------
// Test 17: convertBodyToSerializedFormData: array of Buffers -> multiple file entries
// ---------------------------------------------------------------------------

void test("convertBodyToSerializedFormData: array of Buffers produces multiple file entries", () => {
  const buffer1 = Buffer.from("file-1");
  const buffer2 = Buffer.from("file-2");
  const body = {
    prompt: "edit these",
    images: [buffer1, buffer2],
  };

  const result = convertBodyToSerializedFormData(body);

  assert.equal(result.__formData.files.length, 2);
  const file0 = result.__formData.files[0];
  const file1 = result.__formData.files[1];
  assert.ok(file0);
  assert.ok(file1);
  assert.equal(file0.name, "images[0]");
  assert.equal(file1.name, "images[1]");
  assert.equal(file0.dataBase64, buffer1.toString("base64"));
  assert.equal(file1.dataBase64, buffer2.toString("base64"));
  assert.equal(result.__formData.fields.length, 1);
  const field0 = result.__formData.fields[0];
  assert.ok(field0);
  assert.equal(field0.name, "prompt");
  assert.equal(field0.value, "edit these");
});

// ---------------------------------------------------------------------------
// Test 17b: convertBodyToSerializedFormData: repeated naming -> 同名重复 part
// 当 input_reference 声明 multipart_array_naming=repeated 时，数组展开为
// 同名重复的 input_reference part（而非 input_reference[0]/[1]/[2]）。
// ---------------------------------------------------------------------------

void test("convertBodyToSerializedFormData: repeated naming produces same-name duplicate parts", () => {
  const buffer1 = Buffer.from("file-1");
  const buffer2 = Buffer.from("file-2");
  const buffer3 = Buffer.from("file-3");
  const body = {
    model: "veo-3.1-generate-preview",
    prompt: "edit these",
    input_reference: [buffer1, buffer2, buffer3],
  };

  const result = convertBodyToSerializedFormData(body, new Set(["input_reference"]));

  // 3 个文件 part 全部同名 input_reference（不附索引）
  assert.equal(result.__formData.files.length, 3);
  const [ref0, ref1, ref2] = result.__formData.files;
  assert.ok(ref0);
  assert.ok(ref1);
  assert.ok(ref2);
  assert.equal(ref0.name, "input_reference");
  assert.equal(ref1.name, "input_reference");
  assert.equal(ref2.name, "input_reference");
  assert.equal(ref0.dataBase64, buffer1.toString("base64"));
  assert.equal(ref1.dataBase64, buffer2.toString("base64"));
  assert.equal(ref2.dataBase64, buffer3.toString("base64"));
  // 非数组字段不受影响
  assert.equal(result.__formData.fields.length, 2);
  const modelField = result.__formData.fields.find((f) => f.name === "model");
  const promptField = result.__formData.fields.find((f) => f.name === "prompt");
  assert.ok(modelField);
  assert.ok(promptField);
  assert.equal(modelField.value, "veo-3.1-generate-preview");
  assert.equal(promptField.value, "edit these");
});

// ---------------------------------------------------------------------------
// Test 17c: convertBodyToSerializedFormData: repeated 只影响声明字段，其余数组仍 indexed
// ---------------------------------------------------------------------------

void test("convertBodyToSerializedFormData: repeated naming only affects declared field", () => {
  const buffer1 = Buffer.from("file-1");
  const buffer2 = Buffer.from("file-2");
  const body = {
    // images 未声明 repeated -> 维持 indexed
    images: [buffer1, buffer2],
    // input_reference 声明 repeated -> 同名重复
    input_reference: [buffer1, buffer2],
  };

  const result = convertBodyToSerializedFormData(body, new Set(["input_reference"]));

  const imageNames = result.__formData.files
    .filter((f) => f.name.startsWith("images"))
    .map((f) => f.name);
  const refNames = result.__formData.files
    .filter((f) => f.name === "input_reference")
    .map((f) => f.name);

  assert.deepEqual(imageNames.sort(), ["images[0]", "images[1]"]);
  assert.equal(refNames.length, 2);
});

// ---------------------------------------------------------------------------
// Test 17d: 占位符身份 → 文件描述（出网值不变、审计值留痕）
// 出网值 filename/contentType 必须保持 file / application/octet-stream（线上形态不变）；
// 来源身份 assetId/slotId/sourceFilename/mimeType 只进文件描述，供档案溯源。
// ---------------------------------------------------------------------------

void test("multipart materialization: placeholder identity recorded without changing wire shape", async () => {
  const buffer = Buffer.from("image-bytes");
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: buffer.toString("base64"),
      mimeType: "image/png",
    },
    mimeType: "image/png",
    filename: "media.png",
    fieldPath: "body.reference_image",
    assetId: "asset-example-1",
    slotId: "reference_image",
    transport: "multipart_file" as const,
  };
  const modelId = "media-ref-multipart-identity";
  // 走真实入口（prepareModelInputForRequest → materializeSubtree → 序列化）。
  // 直接调用物化函数会绕过策略与序列化接线，测试绿而真机身份丢失。
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/example-project",
    projection: {
      model_id: modelId,
      runtime: {
        payload_format: "multipart",
        payload_rules: {
          "body.reference_image": {
            kind: "field",
            field_key: "referenceImage",
            transforms: ["allUploadFiles"],
            media_target: "multipart_file",
            multipart_array_naming: "repeated",
          },
        },
      },
    },
    body: { reference_image: [placeholder, placeholder] },
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;

  const body = prepared.body as {
    __formData: {
      fields: Array<{ name: string; value: string }>;
      files: Array<{
        name: string;
        dataBase64: string;
        contentType: string;
        filename: string;
        sourceFilename?: string;
        mimeType?: string;
        assetId?: string;
        slotId?: string;
      }>;
    };
  };
  assert.equal(body.__formData.files.length, 2);
  const file = body.__formData.files[0];
  assert.ok(file);
  // 出网值：与裸 Buffer 路径完全一致（wire 形态未变）。
  assert.equal(file.name, "reference_image");
  assert.equal(file.filename, "file");
  assert.equal(file.contentType, "application/octet-stream");
  assert.equal(file.dataBase64, buffer.toString("base64"));
  // 审计值：来源身份与真实媒体类型。
  assert.equal(file.sourceFilename, "media.png");
  assert.equal(file.mimeType, "image/png");
  assert.equal(file.assetId, "asset-example-1");
  assert.equal(file.slotId, "reference_image");

  // 真实发送链只读 filename/contentType：生成的 part 仍是 file / octet-stream。
  const form = buildFormDataFromSerialized(body.__formData);
  const entries = [...form.entries()];
  assert.equal(entries.length, 2);
  const part = entries[0]?.[1];
  assert.ok(part instanceof Blob);
  assert.equal((part as File).name, "file");
  assert.equal((part as File).type, "application/octet-stream");
});

// ---------------------------------------------------------------------------
// Test 18: buildFormDataFromSerialized: fields-only, no files -> FormData with fields
// ---------------------------------------------------------------------------

void test("buildFormDataFromSerialized: fields-only payload produces FormData with appended fields", () => {
  const payload = {
    fields: [
      { name: "model", value: "gpt-image-2" },
      { name: "prompt", value: "test prompt" },
    ],
    files: [] as Array<{ name: string; dataBase64: string; contentType: string; filename: string }>,
  };

  const form = buildFormDataFromSerialized(payload);

  assert.ok(form instanceof FormData);
  // Verify fields are appended
  const entries = [...form.entries()];
  assert.equal(entries.length, 2);
  const entry0 = entries[0];
  const entry1 = entries[1];
  assert.ok(entry0);
  assert.ok(entry1);
  assert.equal(entry0[0], "model");
  assert.equal(entry0[1], "gpt-image-2");
  assert.equal(entry1[0], "prompt");
  assert.equal(entry1[1], "test prompt");
});

// ---------------------------------------------------------------------------
// Test 19: buildFormDataFromSerialized: invalid base64 data -> throws (all files skipped)
// ---------------------------------------------------------------------------

void test("buildFormDataFromSerialized: non-base64 string still produces a file entry (Node.js tolerant decode)", () => {
  // Node.js Buffer.from(str, "base64") does NOT throw for non-base64 input;
  // it silently decodes what it can and produces a buffer. So the file is NOT skipped.
  // This test verifies the function does not throw and returns a FormData.
  const payload = {
    fields: [] as Array<{ name: string; value: string }>,
    files: [
      { name: "image", dataBase64: "!!!not-valid-base64!!!", contentType: "image/png", filename: "test.png" },
    ],
  };

  const form = buildFormDataFromSerialized(payload);

  assert.ok(form instanceof FormData);
  const entries = [...form.entries()];
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.ok(entry);
  assert.equal(entry[0], "image");
});

// ---------------------------------------------------------------------------
// Test 20: buildFormDataFromSerialized: empty file name -> file skipped, throw
// ---------------------------------------------------------------------------

void test("buildFormDataFromSerialized: file with empty name is skipped and throws", () => {
  const buffer = Buffer.from("some-data");
  const payload = {
    fields: [] as Array<{ name: string; value: string }>,
    files: [
      { name: "", dataBase64: buffer.toString("base64"), contentType: "image/png", filename: "test.png" },
    ],
  };

  assert.throws(
    () => buildFormDataFromSerialized(payload),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes("file(s) were skipped"),
        `Expected 'file(s) were skipped' in message, got: ${error.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Test 21: guardPreparedModelInput: null multipart field value -> ok
// ---------------------------------------------------------------------------

void test("guardPreparedModelInput: null multipart field value -> ok", () => {
  const body = {
    prompt: "test",
    image: null,
  };

  const result = guardPreparedModelInput({
    body,
    policy: {
      modelId: "test-model",
      projection: {},
      payloadFormat: "multipart",
      publicUrl: null,
      multipartFiles: {
        fields: [
          { targetPath: "body.image", requestBodyPath: "image", multipartArrayNaming: undefined },
        ],
      },
      inlineData: null,
    },
  });

  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Test 22: guardPreparedModelInput: undefined multipart field value -> ok
// ---------------------------------------------------------------------------

void test("guardPreparedModelInput: undefined multipart field value -> ok", () => {
  const body = {
    prompt: "test",
  };

  const result = guardPreparedModelInput({
    body,
    policy: {
      modelId: "test-model",
      projection: {},
      payloadFormat: "multipart",
      publicUrl: null,
      multipartFiles: {
        fields: [
          { targetPath: "body.image", requestBodyPath: "image", multipartArrayNaming: undefined },
        ],
      },
      inlineData: null,
    },
  });

  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Test 23: guardPreparedModelInput: array containing unresolved placeholder -> error
// ---------------------------------------------------------------------------

void test("guardPreparedModelInput: array containing unresolved MediaRefPlaceholder -> error", () => {
  const placeholder = {
    __media_ref__: true as const,
    source: {
      kind: "inline_data" as const,
      data: "dGVzdA==",
      mimeType: "image/png",
    },
  };

  const body = {
    prompt: "test",
    images: [Buffer.from("resolved"), placeholder],
  };

  const result = guardPreparedModelInput({
    body,
    policy: {
      modelId: "test-model",
      projection: {},
      payloadFormat: "multipart",
      publicUrl: null,
      multipartFiles: {
        fields: [
          { targetPath: "body.images", requestBodyPath: "images", multipartArrayNaming: undefined },
        ],
      },
      inlineData: null,
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "model_input_unresolved_placeholder");
  }
});

// ---------------------------------------------------------------------------
// Test 24: guardPreparedModelInput: array of resolved Buffers -> ok
// ---------------------------------------------------------------------------

void test("guardPreparedModelInput: array of resolved Buffers -> ok", () => {
  const body = {
    prompt: "test",
    images: [Buffer.from("image-1"), Buffer.from("image-2")],
  };

  const result = guardPreparedModelInput({
    body,
    policy: {
      modelId: "test-model",
      projection: {},
      payloadFormat: "multipart",
      publicUrl: null,
      multipartFiles: {
        fields: [
          { targetPath: "body.images", requestBodyPath: "images", multipartArrayNaming: undefined },
        ],
      },
      inlineData: null,
    },
  });

  assert.equal(result.ok, true);
});

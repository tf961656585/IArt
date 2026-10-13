import assert from "node:assert/strict";
import test from "node:test";

import { guardPreparedModelInput } from "../model-input-preparation/model-input-final-guard.cts";
import { prepareModelInputForRequest } from "../model-input-preparation/model-input-preparation.cts";

const SELF_HOSTED_ENDPOINT_ENV =
  "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT";

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

const buildMessagesPublicUrlProjection = (modelId: string) => ({
  model_id: modelId,
  runtime: {
    url_input_upload_mode: "public_relay",
    url_input_upload_target_type: "self_hosted_image_public_url",
    payload_rules: {
      "body.messages": {
        kind: "compute",
        operator: "array",
        args: [
          {
            kind: "field",
            field_key: "images",
            transforms: ["extractUrls"],
            media_target: "public_url",
          },
        ],
      },
    },
  },
});

const installRelayMock = (
  t: test.TestContext,
  urls: string[],
): { getUploadCount: () => number } => {
  const previousEndpoint = process.env[SELF_HOSTED_ENDPOINT_ENV];
  process.env[SELF_HOSTED_ENDPOINT_ENV] = "https://upload.example.com/relay";
  const originalFetch = globalThis.fetch;
  let uploadCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), "https://upload.example.com/relay");
    const url = urls[uploadCount] ?? urls.at(-1) ?? "https://cdn.example.com/input.png";
    uploadCount += 1;
    return new Response(JSON.stringify({ success: true, url }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(SELF_HOSTED_ENDPOINT_ENV, previousEndpoint);
  });

  return { getUploadCount: () => uploadCount };
};

void test("ModelInputPreparation: public_url 声明子树只有 prompt 文本时保持 messages 结构且不上传", async (t) => {
  const modelId = "public-url-subtree-text-only";
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("{}");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const body = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "make a quiet studio portrait" }],
      },
    ],
  };
  const prepared = await prepareModelInputForRequest({
    modelId,
    projection: buildMessagesPublicUrlProjection(modelId),
    body,
  } as Parameters<typeof prepareModelInputForRequest>[0]);

  assert.equal(prepared.ok, true);
  assert.equal(fetchCalled, false);
  assert.deepEqual(prepared.body, body);
});

void test("ModelInputPreparation: public_url 声明子树只替换 image_url.url MediaRefPlaceholder 叶子", async (t) => {
  const { getUploadCount } = installRelayMock(t, [
    "https://cdn.example.com/token-image.png",
  ]);
  const modelId = "public-url-subtree-token";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/project.iartproj",
    projection: buildMessagesPublicUrlProjection(modelId),
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "keep this as text" },
            {
              type: "image_url",
              image_url: {
                url: {
                  __media_ref__: true,
                  source: { kind: "inline_data", data: "aGVsbG8=", mimeType: "image/png" },
                  mimeType: "image/png",
                  filename: "token.png",
                  fieldPath: "body.messages[0].content[1].image_url.url",
                },
              },
            },
          ],
        },
      ],
    },
  });

  assert.equal(prepared.ok, true);
  assert.equal(getUploadCount(), 1);
  assert.deepEqual(prepared.body, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "keep this as text" },
          {
            type: "image_url",
            image_url: { url: "https://cdn.example.com/token-image.png" },
          },
        ],
      },
    ],
  });
});

void test("ModelInputPreparation: public_url 声明子树只替换 image_url.url data URL 叶子", async (t) => {
  const { getUploadCount } = installRelayMock(t, [
    "https://cdn.example.com/data-url-image.png",
  ]);
  const modelId = "public-url-subtree-data-url";
  const prepared = await prepareModelInputForRequest({
    modelId,
    projectPath: "/tmp/project.iartproj",
    projection: buildMessagesPublicUrlProjection(modelId),
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "text survives recursion" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=" },
            },
          ],
        },
      ],
    },
  });

  assert.equal(prepared.ok, true);
  assert.equal(getUploadCount(), 1);
  assert.deepEqual(prepared.body, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "text survives recursion" },
          {
            type: "image_url",
            image_url: { url: "https://cdn.example.com/data-url-image.png" },
          },
        ],
      },
    ],
  });
});

void test("ModelInputPreparation: final guard 拦截声明子树内残留 data URL", () => {
  const guarded = guardPreparedModelInput({
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "text is allowed" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aGVsbG8=" },
            },
          ],
        },
      ],
    },
    policy: {
      modelId: "public-url-subtree-guard",
      projection: {},
      payloadFormat: "json",
      publicUrl: {
        mode: "public_relay",
        targetType: "self_hosted_image_public_url",
        fields: [{ targetPath: "body.messages", requestBodyPath: "messages" }],
      },
      multipartFiles: null,
      inlineData: null,
    },
  });

  assert.equal(guarded.ok, false);
  if (!guarded.ok) {
    assert.match(guarded.message, /data_url/);
  }
});

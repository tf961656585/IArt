import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadModelPackageCatalog } from "../local-server/model-package-catalog.cts";

// 公共中转端点不再内置默认（用户自带语义）：本文件用例只关心 payload_rules 形状与
// compute operator，统一在文件级自带一个合法端点，避免夹具包先被「未配置中转」过滤掉。
const CLOUDFLARE_ENDPOINT_ENV = "IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT";
process.env[CLOUDFLARE_ENDPOINT_ENV] = "https://relay.example.com/upload";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const writeLocaleFixtures = (packageDir: string) => {
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), {
    Prompt: "Prompt",
    Images: "Images",
    SoundEndSec: "SoundEndSec",
    Script: "Script",
    Quality: "Quality",
    AudioFile: "AudioFile",
    AutoAudio: "AutoAudio",
  });
  writeJson(path.join(packageDir, "locales", "en.json"), {
    Prompt: "Prompt",
    Images: "Images",
    SoundEndSec: "SoundEndSec",
    Script: "Script",
    Quality: "Quality",
    AudioFile: "AudioFile",
    AutoAudio: "AutoAudio",
  });
};

const manifestLocales = () => [
  { locale: "zh-CN", relative_path: "locales/zh-CN.json" },
  { locale: "en", relative_path: "locales/en.json" },
];

const assertPlainObject = (value: unknown, label: string): Record<string, unknown> => {
  assert.equal(typeof value, "object", `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  assert.equal(Array.isArray(value), false, `${label} should not be an array`);
  return value as Record<string, unknown>;
};

void test("loadModelPackageCatalog: 扩展 runtime payload_rules compute operator 可通过 catalog 并保留 options", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-operators-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const packageRoot = path.join(tempDir, "packages");
  const packageId = "operator-regression";
  const packageDir = path.join(packageRoot, packageId);
  fs.mkdirSync(packageDir, { recursive: true });

  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: packageId,
    entry_model: {
      model_id: "operator-regression-model",
      relative_path: "runtime_model.json",
    },
    node_definition: {
      relative_path: "node_definition.json",
    },
    resources: [],
    locales: manifestLocales(),
  });
  writeLocaleFixtures(packageDir);

  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: "model.operator.regression",
    group_key: "regression",
    input_ports: [],
    output_ports: [],
  });

  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: "operator-regression-model",
    provider_id: "openai",
    capability: {
      input_modalities: ["text"],
      output_modalities: ["image"],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
        },
        {
          field_key: "soundEndSec",
          label: "SoundEndSec",
          component: "text",
          required: false,
        },
        {
          field_key: "referenceImages",
          label: "Images",
          component: "imageUpload",
          required: false,
        },
        {
          field_key: "script",
          label: "Script",
          component: "textarea",
          required: false,
        },
        {
          field_key: "quality",
          label: "Quality",
          component: "text",
          required: false,
        },
        {
          field_key: "audioFile",
          label: "AudioFile",
          component: "file",
          required: false,
        },
        {
          field_key: "autoAudio",
          label: "AutoAudio",
          component: "switch",
          required: false,
        },
      ],
    },
    runtime: {
      provider_id: "openai",
      model_id: "operator-regression-key",
      execution_driver: "http_formal_task",
      payload_format: "json",
      url_input_upload_mode: "public_relay",
      url_input_upload_target_type: "cloudflare_image_public_url",
      payload_rules: {
        "body.prompt": {
          kind: "compute",
          operator: "assert_non_empty",
          args: [
            {
              kind: "field",
              field_key: "prompt",
              transforms: ["trim"],
            },
          ],
          options: {
            message: "prompt is required",
          },
        },
        "meta.sound_end_ms": {
          kind: "compute",
          operator: "scale_number",
          args: [
            {
              kind: "field",
              field_key: "soundEndSec",
              transforms: ["toNumber"],
            },
          ],
          options: {
            factor: 1000,
            round: "round",
          },
        },
        "body.content": {
          kind: "compute",
          operator: "map_array",
          options: {
            source: {
              kind: "field",
              field_key: "referenceImages",
              media_target: "public_url",
              transforms: ["extractUrls"],
            },
            item: {
              kind: "compute",
              operator: "object",
              entries: {
                type: {
                  kind: "literal",
                  value: "image_url",
                },
                image_url: {
                  kind: "compute",
                  operator: "object",
                  entries: {
                    url: {
                      kind: "item",
                    },
                  },
                },
              },
            },
            prepend: [
              {
                kind: "compute",
                operator: "object",
                entries: {
                  type: {
                    kind: "literal",
                    value: "text",
                  },
                  text: {
                    kind: "field",
                    field_key: "prompt",
                  },
                },
              },
            ],
            skip_if_empty: true,
          },
        },
        "body.contents": {
          kind: "compute",
          operator: "build_content_blocks",
          options: {
            role: "user",
            parts: [
              {
                part_kind: "text",
                value: {
                  kind: "field",
                  field_key: "prompt",
                },
              },
              {
                part_kind: "inline_data",
                value: {
                  kind: "field",
                  field_key: "referenceImages",
                  media_target: "file_data_uri",
                  transforms: ["extractFirstBase64DataUrl"],
                },
                max_items: 2,
              },
            ],
          },
        },
        "meta.length_checked": {
          kind: "compute",
          operator: "assert_array_length",
          args: [
            {
              kind: "field",
              field_key: "referenceImages",
              transforms: ["ensureArray"],
            },
          ],
          options: {
            min_items: 1,
          },
        },
        "meta.parsed_pairs": {
          kind: "compute",
          operator: "parse_line_pairs",
          args: [
            {
              kind: "field",
              field_key: "script",
            },
          ],
          options: {
            left_key: "time",
            right_key: "text",
          },
        },
        "meta.clamped": {
          kind: "compute",
          operator: "clamp_number",
          args: [
            {
              kind: "field",
              field_key: "quality",
              transforms: ["toNumber"],
            },
          ],
          options: {
            min: 0,
            max: 1,
          },
        },
        "body.audio_url": {
          kind: "compute",
          operator: "prepare_audio_url",
          options: {
            source: {
              kind: "field",
              field_key: "audioFile",
              transforms: ["firstUploadFileOrUrl"],
            },
            allowed_mime_types: ["audio/mpeg"],
          },
        },
        "body.auto_audio": {
          kind: "compute",
          operator: "resolve_auto_audio_flag",
          options: {
            audio_source: {
              kind: "field",
              field_key: "audioFile",
              transforms: ["firstUploadFileOrUrl"],
            },
            auto_audio: {
              kind: "field",
              field_key: "autoAudio",
            },
          },
        },
      },
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/operator-regression",
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

  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  try {
    const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });
    assert.equal(catalog.diagnostics.length, 0);
    assert.equal(catalog.projections.length, 1);

    const projection = assertPlainObject(catalog.projections[0], "projection");
    const runtime = assertPlainObject(projection["runtime"], "projection.runtime");
    const payloadRules = assertPlainObject(runtime["payload_rules"], "projection.runtime.payload_rules");
    const getPayloadRule = (key: string) => assertPlainObject(payloadRules[key], `payload_rules.${key}`);

    const promptRule = getPayloadRule("body.prompt");
    const soundEndRule = getPayloadRule("meta.sound_end_ms");
    const soundEndOptions = assertPlainObject(soundEndRule["options"], "payload_rules.meta.sound_end_ms.options");
    const contentRule = getPayloadRule("body.content");
    const contentOptions = assertPlainObject(contentRule["options"], "payload_rules.body.content.options");
    const contentItem = assertPlainObject(contentOptions["item"], "payload_rules.body.content.options.item");
    const contentItemEntries = assertPlainObject(contentItem["entries"], "payload_rules.body.content.options.item.entries");
    const imageUrl = assertPlainObject(contentItemEntries["image_url"], "payload_rules.body.content.options.item.entries.image_url");
    const imageUrlEntries = assertPlainObject(imageUrl["entries"], "payload_rules.body.content.options.item.entries.image_url.entries");
    const imageUrlEntryUrl = assertPlainObject(imageUrlEntries["url"], "payload_rules.body.content.options.item.entries.image_url.entries.url");
    const contentsRule = getPayloadRule("body.contents");
    const contentsOptions = assertPlainObject(contentsRule["options"], "payload_rules.body.contents.options");
    const contentsParts = contentsOptions["parts"];
    assert.ok(Array.isArray(contentsParts), "payload_rules.body.contents.options.parts should be an array");
    const inlineDataPart = assertPlainObject(contentsParts[1], "payload_rules.body.contents.options.parts[1]");

    assert.equal(projection["model_id"], "operator-regression-model");
    assert.equal("display_name" in projection, false);
    assert.equal(runtime["payload_format"], "json");
    assert.equal(runtime["url_input_upload_mode"], "public_relay");
    assert.equal(runtime["url_input_upload_target_type"], "cloudflare_image_public_url");
    assert.equal(promptRule["operator"], "assert_non_empty");
    assert.equal(soundEndOptions["factor"], 1000);
    assert.equal(contentRule["operator"], "map_array");
    assert.equal(imageUrlEntryUrl["kind"], "item");
    assert.equal(contentsRule["operator"], "build_content_blocks");
    assert.equal(inlineDataPart["part_kind"], "inline_data");
    assert.equal(getPayloadRule("body.audio_url")["operator"], "prepare_audio_url");
    assert.equal(getPayloadRule("body.auto_audio")["operator"], "resolve_auto_audio_flag");
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
});

void test("loadModelPackageCatalog: legacy payloadFormat 会被拒绝", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-payload-format-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const packageRoot = path.join(tempDir, "packages");
  const packageId = "legacy-payload-format";
  const packageDir = path.join(packageRoot, packageId);
  fs.mkdirSync(packageDir, { recursive: true });

  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: packageId,
    entry_model: {
      model_id: "legacy-payload-format-model",
      relative_path: "runtime_model.json",
    },
    node_definition: {
      relative_path: "node_definition.json",
    },
    resources: [],
    locales: manifestLocales(),
  });
  writeLocaleFixtures(packageDir);

  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: "model",
    group_key: "regression",
    input_ports: [],
    output_ports: [],
  });

  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: "legacy-payload-format-model",
    provider_id: "openai",
    capability: {
      input_modalities: ["text"],
      output_modalities: ["image"],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
        },
      ],
    },
    runtime: {
      provider_id: "openai",
      model_id: "legacy-payload-format-model",
      execution_driver: "http_formal_task",
      payloadFormat: "multipart",
      payload_rules: {
        "body.prompt": {
          kind: "field",
          field_key: "prompt",
        },
      },
    },
  });

  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  try {
    const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });
    assert.equal(catalog.projections.length, 0);
    assert.equal(catalog.diagnostics.length, 1);
    assert.match(catalog.diagnostics[0]?.message ?? "", /payload_format_legacy_key_not_allowed/);
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
});

void test("loadModelPackageCatalog: 非法、缺失或错误落位的 url_input_upload target_type 会产出坏包诊断", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-url-upload-mode-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const packageRoot = path.join(tempDir, "packages");
  const invalidCases = [
    {
      packageId: "invalid-mode",
      modelId: "invalid-mode-model",
      runtime: {
        url_input_upload_mode: "public_relay",
        url_input_upload_target_type: "invalid_target",
      },
      expected: /url_input_upload_target_type_invalid/,
    },
    {
      packageId: "missing-target-type",
      modelId: "missing-target-type-model",
      runtime: {
        url_input_upload_mode: "public_relay",
      },
      expected: /url_input_upload_target_type_missing/,
    },
    {
      packageId: "wrong-location",
      modelId: "wrong-location-model",
      runtime: {
        capabilities: {
          url_input_upload_target_type: "cloudflare_image_public_url",
        },
      },
      expected: /url_input_upload_target_type_wrong_location/,
    },
  ];

  invalidCases.forEach(({ packageId, modelId, runtime }) => {
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
      resources: [],
      locales: manifestLocales(),
    });
    writeLocaleFixtures(packageDir);

    writeJson(path.join(packageDir, "node_definition.json"), {
      node_type: "model",
      group_key: "regression",
      input_ports: [],
      output_ports: [],
    });

    writeJson(path.join(packageDir, "runtime_model.json"), {
      model_id: modelId,
      provider_id: "openai",
      capability: {
        input_modalities: ["image"],
        output_modalities: ["image"],
        supports_async_task: false,
      },
      parameter_schema: {
        fields: [
          {
            field_key: "images",
            label: "Images",
            component: "textarea",
            required: false,
          },
        ],
      },
      runtime: {
        provider_id: "openai",
        model_id: modelId,
        execution_driver: "http_formal_task",
        payload_rules: {
          "body.images": {
            kind: "field",
            field_key: "images",
            media_target: "public_url",
            transforms: ["extractUrls"],
          },
        },
        ...runtime,
      },
    });
  });

  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  try {
    const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });
    assert.equal(catalog.projections.length, 0);
    assert.equal(catalog.diagnostics.length, 3);
    const [invalidMode, missingTargetType, wrongLocation] = invalidCases;
    assert.ok(invalidMode);
    assert.ok(missingTargetType);
    assert.ok(wrongLocation);
    assert.match(catalog.diagnostics[0]?.message ?? "", invalidMode.expected);
    assert.match(catalog.diagnostics[1]?.message ?? "", missingTargetType.expected);
    assert.match(catalog.diagnostics[2]?.message ?? "", wrongLocation.expected);
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
});

void test("loadModelPackageCatalog: 仓库模型包不再出现 payload_rules_compute_operator_unknown", () => {
  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  try {
    const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });
    const operatorUnknownDiagnostics = catalog.diagnostics.filter((item) => item.code === "bad_package" && typeof item.message === "string" && item.message.includes("payload_rules_compute_operator_unknown"));

    assert.equal(operatorUnknownDiagnostics.length, 0, `unexpected operator_unknown diagnostics: ${JSON.stringify(operatorUnknownDiagnostics, null, 2)}`);
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
});

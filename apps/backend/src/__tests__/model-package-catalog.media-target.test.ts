import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadModelPackageCatalog } from "../local-server/model-package-catalog.cts";

// 公共中转端点不再内置默认（用户自带语义）：本文件用例只关心媒体字段目标形态契约，
// 统一在文件级自带一个合法端点，避免夹具包先被「未配置中转」过滤掉。
const SELF_HOSTED_ENDPOINT_ENV = "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT";
process.env[SELF_HOSTED_ENDPOINT_ENV] = "https://relay.example.com/upload";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const manifestLocales = () => [
  { locale: "zh-CN", relative_path: "locales/zh-CN.json" },
  { locale: "en", relative_path: "locales/en.json" },
];

const writeLocaleFixtures = (packageDir: string) => {
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), { Images: "Images" });
  writeJson(path.join(packageDir, "locales", "en.json"), { Images: "Images" });
};

type MediaTargetCase = {
  packageId: string;
  modelId: string;
  runtime: Record<string, unknown>;
  expected: RegExp;
};

const writeCasePackage = (packageRoot: string, item: MediaTargetCase) => {
  const packageDir = path.join(packageRoot, item.packageId);
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: item.packageId,
    entry_model: { model_id: item.modelId, relative_path: "runtime_model.json" },
    node_definition: { relative_path: "node_definition.json" },
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
    model_id: item.modelId,
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
          component: "imageUpload",
          required: false,
        },
      ],
    },
    runtime: {
      provider_id: "openai",
      execution_driver: "http_formal_task",
      ...item.runtime,
    },
  });
};

void test("loadModelPackageCatalog: 媒体字段目标形态契约阻断隐式或矛盾配置", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-media-target-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const cases: MediaTargetCase[] = [
    {
      packageId: "missing-media-target",
      modelId: "missing-media-target-model",
      runtime: {
        url_input_upload_mode: "public_relay",
        url_input_upload_target_type: "self_hosted_image_public_url",
        payload_rules: {
          "body.images": {
            kind: "field",
            field_key: "images",
            transforms: ["extractUrls"],
          },
        },
      },
      expected: /payload_rules_media_target_missing/,
    },
    {
      packageId: "multipart-file-on-json",
      modelId: "multipart-file-on-json-model",
      runtime: {
        payload_format: "json",
        payload_rules: {
          "body.image": {
            kind: "field",
            field_key: "images",
            media_target: "multipart_file",
            transforms: ["extractFirstFile"],
          },
        },
      },
      expected: /payload_rules_multipart_file_payload_format_invalid/,
    },
    {
      packageId: "public-url-missing-mode",
      modelId: "public-url-missing-mode-model",
      runtime: {
        payload_rules: {
          "body.images": {
            kind: "field",
            field_key: "images",
            media_target: "public_url",
            transforms: ["extractUrls"],
          },
        },
      },
      expected: /payload_rules_public_url_upload_mode_missing/,
    },
    {
      packageId: "reserved-input-uploads",
      modelId: "reserved-input-uploads-model",
      runtime: {
        payload_rules: {
          "body.input_uploads": {
            kind: "literal",
            value: {},
          },
        },
      },
      expected: /payload_rules_input_uploads_reserved/,
    },
  ];

  const packageRoot = path.join(tempDir, "packages");
  cases.forEach((item) => writeCasePackage(packageRoot, item));

  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  try {
    const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });
    assert.equal(catalog.projections.length, 0);
    assert.equal(catalog.diagnostics.length, cases.length);
    cases.forEach((item, index) => {
      assert.match(catalog.diagnostics[index]?.message ?? "", item.expected);
    });
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
});

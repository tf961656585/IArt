import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadModelPackageCatalog } from "../local-server/model-package-catalog.cts";

const SELF_HOSTED_ENV = "IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

const writePublicRelayPackage = (packageRoot: string, packageId: string, modelId: string) => {
  const packageDir = path.join(packageRoot, packageId);
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: packageId,
    entry_model: { model_id: modelId, relative_path: "runtime_model.json" },
    node_definition: { relative_path: "node_definition.json" },
    locales: [
      { locale: "zh-CN", relative_path: "locales/zh-CN.json" },
      { locale: "en", relative_path: "locales/en.json" },
    ],
    resources: [],
  });
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), { Images: "Images" });
  writeJson(path.join(packageDir, "locales", "en.json"), { Images: "Images" });
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
          component: "imageUpload",
          required: false,
        },
      ],
    },
    runtime: {
      provider_id: "openai",
      execution_driver: "http_formal_task",
      url_input_upload_mode: "public_relay",
      url_input_upload_target_type: "self_hosted_image_public_url",
      payload_rules: {
        "body.images": {
          kind: "field",
          field_key: "images",
          media_target: "public_url",
          transforms: ["extractUrls"],
        },
      },
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/public-relay-test",
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
};

void test("loadModelPackageCatalog: public relay target 可用时进入投影", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-public-relay-ok-"));
  const packageRoot = path.join(tempDir, "packages");
  writePublicRelayPackage(packageRoot, "pkg-relay-ok", "model-relay-ok");
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const previousSelfHosted = process.env[SELF_HOSTED_ENV];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  // 端点不再内置默认：可用路径显式经 env 自带端点（与「用户自带」语义一致）。
  process.env[SELF_HOSTED_ENV] = "https://relay.example.com/upload";
  t.after(() => {
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot);
    restoreEnv(SELF_HOSTED_ENV, previousSelfHosted);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });

  assert.equal(catalog.projections.length, 1);
  assert.equal(catalog.projections[0]?.model_id, "model-relay-ok");
  assert.equal(catalog.diagnostics.length, 0);
});

void test("loadModelPackageCatalog: public relay target 不可用时过滤并输出坏包诊断", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-public-relay-bad-"));
  const packageRoot = path.join(tempDir, "packages");
  writePublicRelayPackage(packageRoot, "pkg-relay-bad", "model-relay-bad");
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  const previousSelfHosted = process.env[SELF_HOSTED_ENV];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  process.env[SELF_HOSTED_ENV] = "not-a-url";
  t.after(() => {
    restoreEnv("IART_MODEL_ASSET_PACKAGES_DIR", previousPackageRoot);
    restoreEnv(SELF_HOSTED_ENV, previousSelfHosted);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });

  assert.equal(catalog.projections.length, 0);
  assert.equal(catalog.diagnostics.length, 1);
  assert.equal(catalog.diagnostics[0]?.package_id, "pkg-relay-bad");
  assert.equal(catalog.diagnostics[0]?.model_id, "model-relay-bad");
  assert.match(
    catalog.diagnostics[0]?.code ?? "",
    /runtime_model\.runtime\.public_relay_target_endpoint_invalid:self_hosted_image_public_url/,
  );
});

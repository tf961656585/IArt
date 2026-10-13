import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadModelPackageCatalog } from "../local-server/model-package-catalog.cts";
import type { CatalogProjection } from "../local-server/model-package-catalog.types.cts";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const manifestLocales = () => [
  { locale: "zh-CN", relative_path: "locales/zh-CN.json" },
  { locale: "en", relative_path: "locales/en.json" },
];

const collectLocaleKeys = (input: FixturePackageInput): string[] => {
  const keys = new Set<string>();
  for (const field of input.parameterFields) {
    const label = typeof field["label"] === "string" ? field["label"] : "";
    if (label) keys.add(label);
    const description =
      typeof field["description"] === "string" ? field["description"] : "";
    if (description) keys.add(description);
  }
  for (const port of input.nodeInputPorts) {
    const name = typeof port["name"] === "string" ? port["name"] : "";
    if (name) keys.add(name);
    const description =
      typeof port["description"] === "string" ? port["description"] : "";
    if (description) keys.add(description);
  }
  return Array.from(keys);
};

const writeLocaleFixtures = (packageDir: string, keys: string[]) => {
  const dictionary: Record<string, string> = {};
  for (const key of keys) {
    dictionary[key] = key;
  }
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), dictionary);
  writeJson(path.join(packageDir, "locales", "en.json"), dictionary);
};

interface FixturePackageInput {
  packageId: string;
  modelId: string;
  /** manifest.protocol_format（接口格式声明）；缺省 = 不声明 */
  protocolFormat?: string;
  /** parameter_schema.default_values（表级默认值）；缺省 = 不声明 */
  defaultValues?: Record<string, unknown>;
  parameterFields: Array<Record<string, unknown>>;
  nodeInputPorts: Array<Record<string, unknown>>;
}

const writeFixturePackage = (
  packageRoot: string,
  input: FixturePackageInput,
): void => {
  const packageDir = path.join(packageRoot, input.packageId);
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: input.packageId,
    entry_model: { model_id: input.modelId, relative_path: "runtime_model.json" },
    node_definition: { relative_path: "node_definition.json" },
    resources: [],
    locales: manifestLocales(),
    ...(input.protocolFormat !== undefined
      ? { protocol_format: input.protocolFormat }
      : {}),
  });
  writeLocaleFixtures(packageDir, collectLocaleKeys(input));
  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: "model",
    group_key: "datasource-test",
    input_ports: input.nodeInputPorts,
    output_ports: [],
  });
  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: input.modelId,
    provider_id: "openai",
    capability: {
      input_modalities: ["text"],
      output_modalities: ["image"],
      supports_async_task: false,
    },
    parameter_schema: {
      fields: input.parameterFields,
      ...(input.defaultValues !== undefined
        ? { default_values: input.defaultValues }
        : {}),
    },
    runtime: {
      provider_id: "openai",
      execution_driver: "http_formal_task",
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/test",
      method: "POST",
      header_rules: [],
      body_rules: [],
      query_rules: [],
    },
    result_rule: {
      mode: "sync",
      submit_response_id_path: "/id",
    },
  });
};

const withTempCatalogRoot = (
  body: (packageRoot: string) => void,
): void => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "catalog-data-source-"),
  );
  const packageRoot = path.join(tempDir, "packages");
  fs.mkdirSync(packageRoot, { recursive: true });
  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  try {
    body(packageRoot);
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const loadProjection = (packageRoot: string, packageId: string): CatalogProjection => {
  void packageRoot;
  const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });
  assert.equal(catalog.diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(catalog.diagnostics)}`);
  const projection = catalog.projections.find((p) => p.package_id === packageId);
  assert.ok(projection !== undefined, `projection for ${packageId} missing`);
  return projection;
};

// -----------------------------------------------------------------------------
// Test 1: data_source: "both" 同时生成端口和保留表单字段
// -----------------------------------------------------------------------------
void test('data_source "both": 字段同时生成端口与保留表单字段', () => {
  withTempCatalogRoot((packageRoot) => {
    writeFixturePackage(packageRoot, {
      packageId: "ds-both-fixture",
      modelId: "ds-both-fixture-model",
      parameterFields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
          data_source: "both",
        },
      ],
      nodeInputPorts: [],
    });

    const projection = loadProjection(packageRoot, "ds-both-fixture");

    // 端口生成
    assert.equal(projection.ports.inputs.length, 1);
    const port = projection.ports.inputs[0];
    assert.ok(port !== undefined);
    assert.equal(port.id, "prompt");
    assert.equal(port.field_key, "prompt");
    assert.equal(port.data_type, "text");
    assert.equal(port.required, true);
    assert.equal(port.multiple, false);

    // 表单字段保留
    const formField = projection.parameter_schema.fields.find(
      (f) => f.field_key === "prompt",
    );
    assert.ok(formField !== undefined);
    assert.equal(formField.data_source, "both");
  });
});

// -----------------------------------------------------------------------------
// Test 2: data_source: "form" 只生成表单，不生成端口
// -----------------------------------------------------------------------------
void test('data_source "form": 字段只生成表单字段，不生成端口', () => {
  withTempCatalogRoot((packageRoot) => {
    writeFixturePackage(packageRoot, {
      packageId: "ds-form-fixture",
      modelId: "ds-form-fixture-model",
      parameterFields: [
        // 引导推导路径：声明一个 "connection" 字段保证 derivedPorts.length > 0
        // 从而走推导分支
        {
          field_key: "image",
          label: "Image",
          component: "imageUpload",
          required: true,
          data_source: "connection",
        },
        {
          field_key: "seed",
          label: "Seed",
          component: "number",
          required: false,
          data_source: "form",
        },
      ],
      nodeInputPorts: [],
    });

    const projection = loadProjection(packageRoot, "ds-form-fixture");

    // 端口只有 image，没有 seed
    const portFieldKeys = projection.ports.inputs.map((p) => p.field_key).sort();
    assert.deepEqual(portFieldKeys, ["image"]);

    // seed 字段仍在 parameter_schema.fields
    const seedField = projection.parameter_schema.fields.find(
      (f) => f.field_key === "seed",
    );
    assert.ok(seedField !== undefined);
    assert.equal(seedField.data_source, "form");
  });
});

// -----------------------------------------------------------------------------
// Test 3: data_source: "connection" 只生成端口
// -----------------------------------------------------------------------------
void test('data_source "connection": 字段只生成端口', () => {
  withTempCatalogRoot((packageRoot) => {
    writeFixturePackage(packageRoot, {
      packageId: "ds-connection-fixture",
      modelId: "ds-connection-fixture-model",
      parameterFields: [
        {
          field_key: "referenceImage",
          label: "Reference Image",
          component: "imageUpload",
          required: false,
          data_source: "connection",
        },
      ],
      nodeInputPorts: [],
    });

    const projection = loadProjection(packageRoot, "ds-connection-fixture");

    // 端口存在
    assert.equal(projection.ports.inputs.length, 1);
    const port = projection.ports.inputs[0];
    assert.ok(port !== undefined);
    assert.equal(port.id, "referenceImage");
    assert.equal(port.data_type, "image");

    // data_source 字段在 parameter_schema 仍可见（消费端通过 data_source 判断不在属性面板显示）
    const field = projection.parameter_schema.fields.find(
      (f) => f.field_key === "referenceImage",
    );
    assert.ok(field !== undefined);
    assert.equal(field.data_source, "connection");
  });
});

// -----------------------------------------------------------------------------
// Test 4: 推导出的端口属性与旧 node_definition.json 显式声明一致
// -----------------------------------------------------------------------------
void test("推导端口属性与旧 input_ports 显式声明完全一致", () => {
  withTempCatalogRoot((packageRoot) => {
    // 包 A: 旧声明（无 data_source，走旧路径）
    writeFixturePackage(packageRoot, {
      packageId: "ds-legacy-explicit",
      modelId: "ds-legacy-explicit-model",
      parameterFields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
        },
        {
          field_key: "image",
          label: "Image",
          component: "imageUpload",
          required: false,
          component_props: { maxFiles: 4 },
        },
      ],
      nodeInputPorts: [
        {
          id: "prompt",
          name: "Prompt",
          data_type: "text",
          field_key: "prompt",
          required: true,
          multiple: false,
        },
        {
          id: "image",
          name: "Image",
          data_type: "image",
          field_key: "image",
          required: false,
          multiple: true,
          max_connections: 4,
        },
      ],
    });

    // 包 B: 通过 data_source 推导
    writeFixturePackage(packageRoot, {
      packageId: "ds-derived",
      modelId: "ds-derived-model",
      parameterFields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
          data_source: "both",
        },
        {
          field_key: "image",
          label: "Image",
          component: "imageUpload",
          required: false,
          data_source: "both",
          component_props: { maxFiles: 4 },
        },
      ],
      nodeInputPorts: [],
    });

    const legacyProjection = loadProjection(packageRoot, "ds-legacy-explicit");
    const derivedProjection = loadProjection(packageRoot, "ds-derived");

    const sortByFieldKey = <T extends { field_key: string }>(arr: T[]): T[] =>
      [...arr].sort((a, b) => a.field_key.localeCompare(b.field_key));

    const legacyPorts = sortByFieldKey(legacyProjection.ports.inputs);
    const derivedPorts = sortByFieldKey(derivedProjection.ports.inputs);

    assert.equal(derivedPorts.length, legacyPorts.length);
    for (let i = 0; i < derivedPorts.length; i += 1) {
      const expected = legacyPorts[i];
      const actual = derivedPorts[i];
      assert.ok(expected !== undefined && actual !== undefined);
      assert.equal(actual.id, expected.id);
      assert.equal(actual.field_key, expected.field_key);
      assert.equal(actual.data_type, expected.data_type);
      assert.equal(actual.required, expected.required);
      assert.equal(actual.multiple, expected.multiple);
      assert.equal(actual.max_connections, expected.max_connections);
    }
  });
});

// -----------------------------------------------------------------------------
// Test 5: 缺少 data_source 时默认行为（向后兼容）：
//         字段不会被推导为端口；只有 node_definition.json 的 input_ports 决定端口。
// -----------------------------------------------------------------------------
void test("缺少 data_source 时默认为 form：字段不进入推导端口列表（向后兼容）", () => {
  withTempCatalogRoot((packageRoot) => {
    writeFixturePackage(packageRoot, {
      packageId: "ds-default-fixture",
      modelId: "ds-default-fixture-model",
      parameterFields: [
        // 不声明 data_source；按默认应当被视为 form
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
        },
        {
          field_key: "seed",
          label: "Seed",
          component: "number",
          required: false,
        },
      ],
      nodeInputPorts: [
        // 旧路径声明 prompt 端口；推导未触发，应保留这一条
        {
          id: "prompt",
          name: "Prompt",
          data_type: "text",
          field_key: "prompt",
          required: true,
          multiple: false,
        },
      ],
    });

    const projection = loadProjection(packageRoot, "ds-default-fixture");

    // 没有任何字段声明 data_source = connection|both，所以走 legacy 路径
    assert.equal(projection.ports.inputs.length, 1);
    const port = projection.ports.inputs[0];
    assert.ok(port !== undefined);
    assert.equal(port.field_key, "prompt");

    // 字段 data_source 在 parameter_schema 投影中为 undefined（未声明）
    const promptField = projection.parameter_schema.fields.find(
      (f) => f.field_key === "prompt",
    );
    assert.ok(promptField !== undefined);
    assert.equal(promptField.data_source, undefined);
    const seedField = projection.parameter_schema.fields.find(
      (f) => f.field_key === "seed",
    );
    assert.ok(seedField !== undefined);
    assert.equal(seedField.data_source, undefined);
  });
});

// -----------------------------------------------------------------------------
// Test N+1: manifest.protocol_format 透传至目录投影
// -----------------------------------------------------------------------------
void test('protocol_format 声明后透传至投影，未声明保持 undefined', () => {
  withTempCatalogRoot((packageRoot) => {
    writeFixturePackage(packageRoot, {
      packageId: "pf-declared-fixture",
      modelId: "pf-declared-fixture-model",
      protocolFormat: "openai-image",
      parameterFields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
          data_source: "both",
        },
      ],
      nodeInputPorts: [],
    });
    writeFixturePackage(packageRoot, {
      packageId: "pf-undeclared-fixture",
      modelId: "pf-undeclared-fixture-model",
      parameterFields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
          data_source: "both",
        },
      ],
      nodeInputPorts: [],
    });

    const declared = loadProjection(packageRoot, "pf-declared-fixture");
    assert.equal(declared.protocol_format, "openai-image");

    const undeclared = loadProjection(packageRoot, "pf-undeclared-fixture");
    assert.equal(undeclared.protocol_format, undefined);
  });
});

// -----------------------------------------------------------------------------
// Test N+2: manifest.protocol_format 非法值判坏包并留痕
// -----------------------------------------------------------------------------
void test('protocol_format 非法值产生 bad_package 诊断且不进投影', () => {
  withTempCatalogRoot((packageRoot) => {
    writeFixturePackage(packageRoot, {
      packageId: "pf-invalid-fixture",
      modelId: "pf-invalid-fixture-model",
      protocolFormat: "Bad Format!",
      parameterFields: [
        {
          field_key: "prompt",
          label: "Prompt",
          component: "textarea",
          required: true,
          data_source: "both",
        },
      ],
      nodeInputPorts: [],
    });

    const catalog = loadModelPackageCatalog({ baseDir: process.cwd() });
    const diagnostic = catalog.diagnostics.find(
      (d) => d.package_id === "pf-invalid-fixture",
    );
    assert.ok(diagnostic !== undefined, "expected diagnostic for invalid package");
    assert.equal(diagnostic.code, "bad_package");
    assert.ok(
      diagnostic.message.includes("protocol_format_invalid"),
      `unexpected message: ${diagnostic.message}`,
    );
    assert.ok(
      !catalog.projections.some((p) => p.package_id === "pf-invalid-fixture"),
      "invalid package must not enter projections",
    );
  });
});

// -----------------------------------------------------------------------------
// Test: default_values 透传不裁剪（回归）：
//       setDefaultValueByFieldKey 曾按手写键名单裁剪默认值，quality/format 等
//       名单外字段键的默认值被静默丢弃，PromptDock 参数栏因此无默认值可回填。
//       现约定：字段键默认值一律透传（`__prompt` 保留键除外）。
// -----------------------------------------------------------------------------
void test("default_values 透传：名单外字段键的表级与字段级默认值都进入投影", () => {
  withTempCatalogRoot((packageRoot) => {
    writeFixturePackage(packageRoot, {
      packageId: "dv-passthrough-fixture",
      modelId: "dv-passthrough-fixture-model",
      // 表级 default_values 只声明 format；quality 走字段级 default_value 回退
      defaultValues: { format: "jpeg" },
      parameterFields: [
        {
          field_key: "quality",
          label: "Quality",
          component: "select",
          required: false,
          default_value: "auto",
          enum_options: [{ value: "auto" }, { value: "high" }],
        },
        {
          field_key: "format",
          label: "Format",
          component: "select",
          required: false,
          enum_options: [{ value: "jpeg" }, { value: "png" }],
        },
      ],
      nodeInputPorts: [],
    });

    const projection = loadProjection(packageRoot, "dv-passthrough-fixture");

    assert.deepEqual(projection.parameter_schema.default_values, {
      format: "jpeg",
      quality: "auto",
    });
  });
});

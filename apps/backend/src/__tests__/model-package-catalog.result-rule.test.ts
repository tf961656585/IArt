import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadModelPackageCatalog } from "../local-server/model-package-catalog.cts";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const assertPlainObject = (value: unknown, label: string): Record<string, unknown> => {
  assert.equal(typeof value, "object", `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  assert.equal(Array.isArray(value), false, `${label} should not be an array`);
  return value as Record<string, unknown>;
};

void test("loadModelPackageCatalog: result_rule 保留失败条件与错误映射规则", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-result-rule-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const packageRoot = path.join(tempDir, "packages");
  const packageId = "result-rule-regression";
  const packageDir = path.join(packageRoot, packageId);
  fs.mkdirSync(packageDir, { recursive: true });

  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: packageId,
    entry_model: {
      model_id: "result-rule-regression-model",
      relative_path: "runtime_model.json",
    },
    node_definition: {
      relative_path: "node_definition.json",
    },
    resources: [],
    locales: [
      { locale: "zh-CN", relative_path: "locales/zh-CN.json" },
      { locale: "en", relative_path: "locales/en.json" },
    ],
  });

  writeJson(path.join(packageDir, "locales", "zh-CN.json"), {
    Prompt: "Prompt",
  });
  writeJson(path.join(packageDir, "locales", "en.json"), {
    Prompt: "Prompt",
  });

  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: "model.result-rule.regression",
    group_key: "regression",
    input_ports: [],
    output_ports: [],
  });

  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: "result-rule-regression-model",
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
      model_id: "result-rule-regression-key",
      execution_driver: "http_formal_task",
      payload_rules: {
        "body.prompt": {
          kind: "field",
          field_key: "prompt",
        },
      },
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/result-rule-regression",
      method: "POST",
    },
    result_rule: {
      mode: "sync",
      submit_response_id_path: "/id",
      failure_condition: {
        op: "any",
        children: [
          { op: "not_empty", path: "error.code" },
          { op: "not_empty", path: "error.message" },
        ],
      },
      error_mapping_rules: [
        {
          target: "code",
          source: { kind: "response", path: "error.code" },
          required: false,
        },
        {
          target: "message",
          source: { kind: "response", path: "error.message" },
          required: false,
        },
      ],
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
    const taskExecutionPlan = assertPlainObject(
      projection["task_execution_plan"],
      "projection.task_execution_plan",
    );
    const resultRule = assertPlainObject(
      taskExecutionPlan["result_rule"],
      "projection.task_execution_plan.result_rule",
    );
    const failureCondition = assertPlainObject(
      resultRule["failure_condition"],
      "projection.task_execution_plan.result_rule.failure_condition",
    );
    const failureChildren = failureCondition["children"];
    const errorMappingRules = resultRule["error_mapping_rules"];

    assert.equal(failureCondition["op"], "any");
    assert.ok(Array.isArray(failureChildren), "failure_condition.children should be an array");
    assert.equal(failureChildren.length, 2);
    assert.ok(Array.isArray(errorMappingRules), "error_mapping_rules should be an array");
    assert.equal(errorMappingRules.length, 2);
    assert.deepEqual(errorMappingRules[0], {
      target: "code",
      source: { kind: "response", path: "error.code" },
      required: false,
    });
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
});

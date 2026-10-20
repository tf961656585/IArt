import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listBindableModelsForApiKeyPolicy,
  loadModelPackageCatalog,
} from "../local-server/model-package-catalog.cts";
import { GENERATION_FAMILY_TEMPLATE_REGISTRY } from "../local-server/generation-family-templates.registry.cts";

const writeJson = (filePath: string, value: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
};

const writeLocaleFixtures = (packageDir: string) => {
  writeJson(path.join(packageDir, "locales", "zh-CN.json"), { Title: "标题" });
  writeJson(path.join(packageDir, "locales", "en.json"), { Title: "Title" });
};

type VariantPackageSpec = {
  packageId: string;
  modelId: string;
  groupKey: string;
  order: number;
  /** 覆盖 parameter_schema，用于构造组内一致性失败场景。 */
  fields?: Array<Record<string, unknown>>;
};

const DEFAULT_FIELDS = [
  { field_key: "prompt", label: "Title", component: "textarea", required: true },
];

/**
 * 写一个参与变体组的合成模型能力包。
 *
 * 变体组机制当前没有生产包使用（官方直连模型包各自独立），
 * 因此用合成包固定机制契约，避免测试随生产包增删而失效。
 */
const writeVariantPackage = (packageRoot: string, spec: VariantPackageSpec) => {
  const packageDir = path.join(packageRoot, spec.packageId);
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "manifest.json"), {
    package_id: spec.packageId,
    entry_model: { model_id: spec.modelId, relative_path: "runtime_model.json" },
    node_definition: { relative_path: "node_definition.json" },
    resources: [],
    locales: [
      { locale: "zh-CN", relative_path: "locales/zh-CN.json" },
      { locale: "en", relative_path: "locales/en.json" },
    ],
  });
  writeLocaleFixtures(packageDir);
  writeJson(path.join(packageDir, "node_definition.json"), {
    node_type: "model",
    group_key: "variant-contract",
    input_ports: [],
    output_ports: [],
  });
  writeJson(path.join(packageDir, "runtime_model.json"), {
    model_id: spec.modelId,
    provider_id: "openai",
    mode: "video",
    role: "generator",
    capability: {
      input_modalities: ["text"],
      output_modalities: ["video"],
      supports_async_task: true,
      supports_streaming: false,
      supports_multi_image: false,
      supports_reference_media: false,
      constraints: [],
    },
    parameter_schema: {
      schema_type: "object",
      fields: spec.fields ?? DEFAULT_FIELDS,
    },
    display: {
      visible: true,
      order: 100,
      variant_group: spec.groupKey,
      variant_order: spec.order,
    },
    runtime: {
      provider_id: "openai",
      execution_driver: "http_formal_task",
      payload_format: "json",
      payload_rules: {
        "api.endpoint": { kind: "literal", value: "/v1/videos" },
        "api.method": { kind: "literal", value: "POST" },
        "body.prompt": { kind: "field", field_key: "prompt" },
      },
    },
    request_strategy: {
      request_stage: "submit",
      protocol: "http",
      endpoint: "/v1/videos",
      method: "POST",
    },
    result_rule: {
      mode: "async",
      submit_response_id_path: "/id",
    },
    result_output_mapping: {
      response_mode: "structured_payload",
      output_mapping_rules: [
        {
          target: "output.video_url",
          source: { kind: "response", path: "video_url" },
          required: false,
          default_value: null,
        },
      ],
    },
  });
};

const withPackageRoot = (packageRoot: string, run: () => void): void => {
  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
};

void test("变体组契约：组壳投影承载默认项与完整变体列表，变体 model_id 不进组壳", (t) => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-variant-group-"));
  t.after(() => {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  });

  writeVariantPackage(packageRoot, {
    packageId: "synth-video-main",
    modelId: "synth-video",
    groupKey: "SYNTH_VIDEO",
    order: 100,
  });
  writeVariantPackage(packageRoot, {
    packageId: "synth-video-fast",
    modelId: "synth-video-fast",
    groupKey: "SYNTH_VIDEO",
    order: 110,
  });
  writeVariantPackage(packageRoot, {
    packageId: "synth-video-pro",
    modelId: "synth-video-pro",
    groupKey: "SYNTH_VIDEO",
    order: 120,
  });

  withPackageRoot(packageRoot, () => {
    const catalog = loadModelPackageCatalog({ baseDir: packageRoot });
    assert.deepEqual(
      catalog.diagnostics,
      [],
      `unexpected diagnostics: ${JSON.stringify(catalog.diagnostics)}`,
    );

    const shellProjection = catalog.projections.find(
      (projection) => projection.model_id === "variant-group:SYNTH_VIDEO",
    );
    assert.ok(shellProjection, "missing_variant_group_shell_projection");
    assert.equal(shellProjection.shell_model_id, "variant-group:SYNTH_VIDEO");
    assert.equal(shellProjection.display_label, "SYNTH_VIDEO");
    assert.equal(shellProjection.variant_group?.group_key, "SYNTH_VIDEO");
    assert.equal(shellProjection.variant_group?.default_model_id, "synth-video");
    assert.deepEqual(
      shellProjection.variant_group?.variants.map((variant) => variant.model_id),
      ["synth-video", "synth-video-fast", "synth-video-pro"],
    );
    assert.deepEqual(
      shellProjection.variant_group?.variants.map((variant) => variant.order),
      [100, 110, 120],
    );
    assert.ok(
      shellProjection.variant_group?.variants.every(
        (variant) =>
          variant.shell_model_id === "variant-group:SYNTH_VIDEO" &&
          variant.label === variant.model_id,
      ),
      "variant_shell_or_label_mismatch",
    );

    // 组内成员折叠进组壳，不再各自成条投影；变体清单只经 variant_group.variants 暴露。
    assert.deepEqual(
      catalog.projections.map((projection) => projection.model_id),
      ["variant-group:SYNTH_VIDEO"],
    );

    const bindableModelIds = new Set(
      listBindableModelsForApiKeyPolicy({ baseDir: packageRoot }).map(
        (item) => item.modelId,
      ),
    );
    ["synth-video", "synth-video-fast", "synth-video-pro"].forEach((modelId) => {
      assert.equal(bindableModelIds.has(modelId), true, `missing_bindable_model:${modelId}`);
    });
    assert.equal(
      bindableModelIds.has("variant-group:SYNTH_VIDEO"),
      false,
      "variant_shell_must_not_be_bindable",
    );
  });
});

void test("变体组契约：组内结构不一致时降级为独立展示并留诊断", (t) => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-variant-mismatch-"));
  t.after(() => {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  });

  writeVariantPackage(packageRoot, {
    packageId: "synth-mismatch-a",
    modelId: "synth-mismatch-a",
    groupKey: "SYNTH_MISMATCH",
    order: 100,
  });
  writeVariantPackage(packageRoot, {
    packageId: "synth-mismatch-b",
    modelId: "synth-mismatch-b",
    groupKey: "SYNTH_MISMATCH",
    order: 110,
    fields: [
      { field_key: "prompt", label: "Title", component: "textarea", required: true },
      { field_key: "duration", label: "Title", component: "select", required: false },
    ],
  });

  withPackageRoot(packageRoot, () => {
    const catalog = loadModelPackageCatalog({ baseDir: packageRoot });
    assert.equal(
      catalog.projections.some(
        (projection) => projection.model_id === "variant-group:SYNTH_MISMATCH",
      ),
      false,
      "inconsistent_group_must_not_produce_shell",
    );
    assert.deepEqual(
      catalog.projections.map((projection) => projection.model_id).sort(),
      ["synth-mismatch-a", "synth-mismatch-b"],
    );
    assert.ok(
      catalog.diagnostics.some(
        (diagnostic) => diagnostic.code === "variant_group_consistency_failed",
      ),
      `missing_consistency_diagnostic:${JSON.stringify(catalog.diagnostics)}`,
    );
    assert.ok(
      catalog.projections.every((projection) => projection.variant_meta === undefined),
      "degraded_projections_must_clear_variant_meta",
    );
  });
});

/**
 * 已退役变体字段不得回流。
 *
 * 2026-10-20 起样本来源由仓库真实包目录（源与产物两侧）改为**族模板产出的 sources**：
 * 包目录已整体删除，模板是现在唯一生产 sources 的地方。不变量本身不变——
 * `variant_label` / `variant_default`（display 内）与 `modelSnapshot`（runtime_model 顶层）
 * 都已退役，变体组机制只用 `variant_group` + `variant_order`；回流会让投影侧读到已删语义。
 */
void test("族模板产出的 sources 不残留已退役的变体字段", () => {
  let checkedFamilies = 0;

  for (const [familyAdapterId, entry] of Object.entries(
    GENERATION_FAMILY_TEMPLATE_REGISTRY,
  )) {
    if (entry.status !== "ready") continue;
    checkedFamilies += 1;

    // 空素材位与全素材位两种形态都查：变体字段若被写进某个素材分支，只有对应形态能暴露。
    for (const acceptedMediaSlots of [[], entry.supportsMediaSlots]) {
      const sources = entry.buildBaseSources(
        `declared-${familyAdapterId}-variant`,
        { acceptedMediaSlots },
      );
      const runtimeModel = sources.runtimeModel;
      const displayRaw = runtimeModel["display"];
      const display =
        displayRaw !== null &&
        displayRaw !== undefined &&
        typeof displayRaw === "object"
          ? (displayRaw as Record<string, unknown>)
          : {};

      assert.ok(
        !("variant_label" in display),
        `variant_label_should_be_removed:${familyAdapterId}`,
      );
      assert.ok(
        !("variant_default" in display),
        `variant_default_should_be_removed:${familyAdapterId}`,
      );
      assert.ok(
        !("modelSnapshot" in runtimeModel),
        `modelSnapshot_should_be_removed:${familyAdapterId}`,
      );
    }
  }

  assert.ok(
    checkedFamilies > 0,
    "至少要有 1 个 ready 族（否则本用例退化成空循环恒绿）",
  );
});

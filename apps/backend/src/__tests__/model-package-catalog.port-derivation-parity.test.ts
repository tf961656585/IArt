import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { derivePortDataTypeFromComponent } from "@iart/contracts/model-asset-contract/port-data-type-mapping";
import { resetBackendConfigForTest } from "../local-server/config-store.cts";
import { loadModelPackageCatalog } from "../local-server/model-package-catalog.cts";

// 公共中转端点是运行时用户配置事实（用户自带语义，spec
// docs/runtime/public-relay-capability.md）：测试自置占位端点并重载后端配置单例，
// 保证测试不依赖开发机 .env / 本机 backend.json（干净环境与 CI 同样成立）。
process.env["IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT"] = "https://relay.example.com/upload";
process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"] = "https://image-relay.example.com/api/upload";
resetBackendConfigForTest();

interface LegacyPortRaw {
  id: string | undefined;
  data_type: string | undefined;
  field_key: string | undefined;
}

interface RuntimeFieldRaw {
  field_key: string | undefined;
  data_source: string | undefined;
  component: string | undefined;
  required: boolean | undefined;
  maxFiles: number | undefined;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const toLegacyPort = (raw: unknown): LegacyPortRaw | undefined => {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  return {
    id: isString(record["id"]) ? record["id"] : undefined,
    data_type: isString(record["data_type"]) ? record["data_type"] : undefined,
    field_key: isString(record["field_key"]) ? record["field_key"] : undefined,
  };
};

const toRuntimeField = (raw: unknown): RuntimeFieldRaw | undefined => {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const componentProps =
    record["component_props"] !== undefined &&
    record["component_props"] !== null &&
    typeof record["component_props"] === "object"
      ? (record["component_props"] as Record<string, unknown>)
      : undefined;
  const maxFiles =
    componentProps !== undefined && isFiniteNumber(componentProps["maxFiles"])
      ? componentProps["maxFiles"]
      : undefined;
  return {
    field_key: isString(record["field_key"]) ? record["field_key"] : undefined,
    data_source: isString(record["data_source"])
      ? record["data_source"]
      : undefined,
    component: isString(record["component"]) ? record["component"] : undefined,
    required: isBoolean(record["required"]) ? record["required"] : undefined,
    maxFiles,
  };
};

const findRepoRoot = (start: string): string => {
  let current = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`unable_to_locate_repo_root_from:${start}`);
};

void test("逐包验证：45 个模型包推导后的 input_ports 与推导规则一致，且覆盖旧 field_key 集合", () => {
  const repoRoot = findRepoRoot(__dirname);
  const packageRoot = path.join(repoRoot, ".model-assets", "packages");
  assert.ok(
    fs.existsSync(packageRoot),
    `packages_root_missing:${packageRoot}`,
  );

  const previous = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
  process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;
  try {
    const catalog = loadModelPackageCatalog({ baseDir: repoRoot });
    assert.equal(
      catalog.diagnostics.length,
      0,
      `unexpected diagnostics: ${JSON.stringify(catalog.diagnostics)}`,
    );

    const packageDirs = fs
      .readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    // variant 聚合后，变体包不再有独立顶层 projection，而是通过 variantModelToMain
    // 反向索引解析到组壳投影。因此不再断言 projections.length === packageDirs.length，
    // 而是断言每个包目录都能解析到投影（顶层或变体组反向索引）。
    const resolveProjectionForPackage = (packageId: string) => {
      const direct = catalog.projections.find((p) => p.package_id === packageId);
      if (direct !== undefined) return direct;
      const variantEntry = catalog.variantModelToMain.get(packageId);
      if (variantEntry !== undefined) return variantEntry.projection;
      return undefined;
    };

    let comparedPackages = 0;
    for (const packageId of packageDirs) {
      const projection = resolveProjectionForPackage(packageId);
      assert.ok(
        projection !== undefined,
        `projection_missing:${packageId}`,
      );

      const manifestPath = path.join(packageRoot, packageId, "manifest.json");
      const manifestRaw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        node_definition: { relative_path: string };
        entry_model: { relative_path: string };
      };
      const nodeDefPath = path.join(
        packageRoot,
        packageId,
        manifestRaw.node_definition.relative_path,
      );
      const nodeDefRaw = JSON.parse(
        fs.readFileSync(nodeDefPath, "utf-8"),
      ) as { input_ports: unknown[] };
      const legacyPortsRaw = Array.isArray(nodeDefRaw.input_ports)
        ? nodeDefRaw.input_ports
        : [];
      const legacyPorts = legacyPortsRaw
        .map(toLegacyPort)
        .filter((port): port is LegacyPortRaw => port !== undefined);
      const legacyFieldKeys = new Set(
        legacyPorts
          .map((p) => p.field_key)
          .filter((key): key is string => key !== undefined),
      );

      const runtimePath = path.join(
        packageRoot,
        packageId,
        manifestRaw.entry_model.relative_path,
      );
      const runtimeRaw = JSON.parse(
        fs.readFileSync(runtimePath, "utf-8"),
      ) as { parameter_schema: { fields: unknown[] } | undefined };
      const runtimeFields = Array.isArray(
        runtimeRaw.parameter_schema !== undefined
          ? runtimeRaw.parameter_schema.fields
          : undefined,
      )
        ? (runtimeRaw.parameter_schema as { fields: unknown[] }).fields
            .map(toRuntimeField)
            .filter((f): f is RuntimeFieldRaw => f !== undefined)
        : [];

      const fieldByKey = new Map<string, RuntimeFieldRaw>();
      for (const field of runtimeFields) {
        if (field.field_key !== undefined) {
          fieldByKey.set(field.field_key, field);
        }
      }
      const derivedFieldKeys = new Set(
        runtimeFields
          .filter(
            (f) =>
              f.field_key !== undefined &&
              (f.data_source === "connection" || f.data_source === "both"),
          )
          .map((f) => {
            const key = f.field_key;
            if (key === undefined) {
              throw new Error("unreachable_field_key_undefined");
            }
            return key;
          }),
      );

      const projectionPorts = projection.ports.inputs;
      const projectionFieldKeys = new Set(
        projectionPorts.map((p) => p.field_key),
      );

      // 1. 覆盖旧 field_key 集合：旧 input_ports 的每个 field_key 都必须在推导结果中
      for (const legacyKey of legacyFieldKeys) {
        assert.ok(
          projectionFieldKeys.has(legacyKey),
          `legacy_field_key_missing_in_projection:${packageId}:${legacyKey}`,
        );
      }

      // 2. 推导端口集合不超过 (legacy ∪ data_source 字段)；同时也必须包含 data_source 集合
      const expectedKeys = new Set<string>(legacyFieldKeys);
      for (const key of derivedFieldKeys) {
        expectedKeys.add(key);
      }
      assert.equal(
        projectionPorts.length,
        expectedKeys.size,
        `port_count_mismatch:${packageId} actual=${projectionPorts.length} expected=${expectedKeys.size}`,
      );
      for (const key of derivedFieldKeys) {
        assert.ok(
          projectionFieldKeys.has(key),
          `data_source_field_missing_in_projection:${packageId}:${key}`,
        );
      }

      // 3. 对 data_source 推导路径的端口：data_type / required / multiple / id 应来自推导规则
      for (const port of projectionPorts) {
        if (!derivedFieldKeys.has(port.field_key)) {
          // 走 legacy 兼容路径的端口，跳过推导规则断言
          continue;
        }
        const field = fieldByKey.get(port.field_key);
        assert.ok(
          field !== undefined,
          `derived_port_field_missing:${packageId}:${port.field_key}`,
        );
        if (field.component !== undefined) {
          const expectedType = derivePortDataTypeFromComponent(field.component);
          assert.equal(
            port.data_type,
            expectedType,
            `derived_data_type_mismatch:${packageId}:${port.field_key} expected=${expectedType} actual=${port.data_type}`,
          );
        }
        const expectedRequired = field.required === true;
        assert.equal(
          port.required,
          expectedRequired,
          `derived_required_mismatch:${packageId}:${port.field_key} expected=${String(expectedRequired)} actual=${String(port.required)}`,
        );
        const expectedMultiple =
          field.maxFiles !== undefined && field.maxFiles > 1;
        assert.equal(
          port.multiple,
          expectedMultiple,
          `derived_multiple_mismatch:${packageId}:${port.field_key} expected=${String(expectedMultiple)} actual=${String(port.multiple)}`,
        );
        assert.equal(
          port.id,
          port.field_key,
          `derived_port_id_should_equal_field_key:${packageId}:${port.field_key} actual=${port.id}`,
        );
      }
      comparedPackages += 1;
    }

    assert.equal(
      comparedPackages,
      packageDirs.length,
      `not_all_packages_compared: ${comparedPackages} vs ${packageDirs.length}`,
    );
  } finally {
    if (previous === undefined) {
      delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
    } else {
      process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previous;
    }
  }
});

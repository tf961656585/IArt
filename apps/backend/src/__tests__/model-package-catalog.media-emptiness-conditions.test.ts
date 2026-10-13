import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 媒体字段判空必须用 `ne []`，不得用 `truthy`。
 *
 * DSL 的 `truthy` / `falsy` 沿用 JavaScript `Boolean` 语义（见
 * `packages/model-asset-runtime/__tests__/evaluator.test.ts`），而媒体字段的表单默认值是
 * 空数组，`Boolean([])` 恒为 true。用 `truthy` 判空会让「未选择任何图」被当成「已选择」：
 * 轻则请求体里出现无 url 的媒体块，重则条件分支永不可达。
 */
const readArrayDefaultedFields = (runtimeModel: Record<string, unknown>): Set<string> => {
  const parameterSchema = runtimeModel["parameter_schema"];
  const fields =
    parameterSchema !== null &&
    parameterSchema !== undefined &&
    typeof parameterSchema === "object" &&
    Array.isArray((parameterSchema as Record<string, unknown>)["fields"])
      ? ((parameterSchema as Record<string, unknown>)["fields"] as unknown[])
      : [];
  const keys = new Set<string>();
  for (const field of fields) {
    if (field === null || typeof field !== "object") continue;
    const record = field as Record<string, unknown>;
    const key = record["field_key"];
    if (typeof key === "string" && Array.isArray(record["default_value"])) {
      keys.add(key);
    }
  }
  return keys;
};

type Offence = { path: string; field: string };

const collectTruthyOnArrayFields = (
  value: unknown,
  arrayFields: Set<string>,
  trail: string,
  offences: Offence[],
): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectTruthyOnArrayFields(item, arrayFields, `${trail}[${index}]`, offences),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const op = record["op"];
  const field = record["field"];
  if ((op === "truthy" || op === "falsy") && typeof field === "string" && arrayFields.has(field)) {
    offences.push({ path: trail, field });
  }
  for (const [key, child] of Object.entries(record)) {
    collectTruthyOnArrayFields(child, arrayFields, `${trail}.${key}`, offences);
  }
};

void test("媒体字段判空不得用 truthy/falsy，须用 ne []", () => {
  const repoRoot = path.join(__dirname, "..", "..", "..", "..");
  for (const rootName of ["sources", "packages"]) {
    const root = path.join(repoRoot, ".model-assets", rootName);
    const packageIds = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const packageId of packageIds) {
      const runtimeModelPath = path.join(root, packageId, "runtime_model.json");
      if (!fs.existsSync(runtimeModelPath)) continue;
      const runtimeModel = JSON.parse(
        fs.readFileSync(runtimeModelPath, "utf-8"),
      ) as Record<string, unknown>;

      const arrayFields = readArrayDefaultedFields(runtimeModel);
      if (arrayFields.size === 0) continue;

      const offences: Offence[] = [];
      collectTruthyOnArrayFields(
        runtimeModel["runtime"] ?? {},
        arrayFields,
        `${rootName}/${packageId}/runtime_model.json`,
        offences,
      );
      assert.deepEqual(
        offences,
        [],
        `数组字段判空必须改用 ne []:${JSON.stringify(offences)}`,
      );
    }
  }
});

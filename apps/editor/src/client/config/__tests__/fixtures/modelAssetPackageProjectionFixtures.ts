import fs from "node:fs";
import path from "node:path";
import type {
  ModelAssetLocalizationBundle,
  ModelAssetNodeProjection,
} from "@iart/contracts/model-asset-contract";

type PackageManifest = {
  package_id: string;
  entry_model: { relative_path: string };
  node_definition: { relative_path: string };
  locales?: Array<{ locale?: string; relative_path?: string }>;
};

type ModelAssetPackageCatalogFixture = {
  projections: ModelAssetNodeProjection[];
  localization_bundles: ModelAssetLocalizationBundle[];
  diagnostics: [];
};

const PACKAGES_ROOT = path.join(process.cwd(), ".model-assets", "packages");
let catalogCache: ModelAssetPackageCatalogFixture | null = null;

const readJsonFile = <T,>(filePath: string): T => {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as T;
};

const cloneUnknown = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneUnknown(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        cloneUnknown(item),
      ]),
    );
  }
  return value;
};

export const cloneModelAssetFixtureValue = <T,>(value: T): T =>
  cloneUnknown(value) as T;

const normalizeString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const toNamespace = (packageId: string): string => `model-asset/${packageId}`;

const toProjectedKey = (packageId: string, key: string): string =>
  `${toNamespace(packageId)}:${key}`;

const rewriteOptionalKey = (
  packageId: string,
  value: string | undefined,
): string | undefined => {
  const normalized = normalizeString(value);
  return normalized ? toProjectedKey(packageId, normalized) : undefined;
};

const rewriteChoiceOptions = (
  packageId: string,
  options: unknown,
): unknown => {
  if (!Array.isArray(options)) return options;
  const optionItems: unknown[] = options;
  return optionItems.map((item): unknown => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const option = item as Record<string, unknown>;
    const label = normalizeString(option["label"]);
    const description = normalizeString(option["description"]);
    return {
      ...option,
      ...(label ? { label: toProjectedKey(packageId, label) } : {}),
      ...(description
        ? {
            description: toProjectedKey(
              packageId,
              description,
            ),
          }
        : {}),
    };
  });
};

const rewriteProjectionLocalizationKeys = (
  projection: ModelAssetNodeProjection,
  packageId: string,
): ModelAssetNodeProjection => {
  const next = cloneModelAssetFixtureValue(projection);
  const projectedDescription = rewriteOptionalKey(packageId, next.description);
  if (projectedDescription) next.description = projectedDescription;

  next.ports.inputs.forEach((port) => {
    port.name = toProjectedKey(packageId, port.name);
    const description = rewriteOptionalKey(packageId, port.description);
    if (description) port.description = description;
  });
  next.ports.outputs.forEach((port) => {
    port.name = toProjectedKey(packageId, port.name);
    const description = rewriteOptionalKey(packageId, port.description);
    if (description) port.description = description;
  });

  next.parameter_schema.fields.forEach((field) => {
    field.label = toProjectedKey(packageId, field.label);
    const description = rewriteOptionalKey(packageId, field.description);
    if (description) field.description = description;
    field.enum_options?.forEach((option) => {
      const label = normalizeString(option.label);
      if (label) option.label = toProjectedKey(packageId, label);
    });
    if (field.component_props) {
      field.component_props["sizeOptions"] = rewriteChoiceOptions(
        packageId,
        field.component_props["sizeOptions"],
      );
      field.component_props["aspectOptions"] = rewriteChoiceOptions(
        packageId,
        field.component_props["aspectOptions"],
      );
    }
  });

  if (next.visibility.badges) {
    next.visibility.badges = next.visibility.badges.map((badge) =>
      toProjectedKey(packageId, badge),
    );
  }

  return next;
};

const loadLocalizationBundle = (
  packageDir: string,
  manifest: PackageManifest,
): ModelAssetLocalizationBundle => {
  const resources = {} as ModelAssetLocalizationBundle["resources"];
  for (const locale of ["zh-CN", "en"] as const) {
    const entry = manifest.locales?.find((item) => item.locale === locale);
    const relativePath = entry?.relative_path ?? `locales/${locale}.json`;
    resources[locale] = readJsonFile<Record<string, unknown>>(
      path.join(packageDir, relativePath),
    );
  }
  return {
    package_id: manifest.package_id,
    namespace: toNamespace(manifest.package_id),
    resources,
  };
};

const loadCatalog = (): ModelAssetPackageCatalogFixture => {
  const packageEntries = fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const projections: ModelAssetNodeProjection[] = [];
  const localization_bundles: ModelAssetLocalizationBundle[] = [];

  packageEntries.forEach((packageId) => {
    const packageDir = path.join(PACKAGES_ROOT, packageId);
    const manifest = readJsonFile<PackageManifest>(
      path.join(packageDir, "manifest.json"),
    );
    const runtimeModel = readJsonFile<Record<string, unknown>>(
      path.join(packageDir, manifest.entry_model.relative_path),
    );
    const nodeDefinition = readJsonFile<Record<string, unknown>>(
      path.join(packageDir, manifest.node_definition.relative_path),
    );
    const modelId = normalizeString(runtimeModel["model_id"]);
    if (!modelId) return;
    const display = runtimeModel["display"] as Record<string, unknown> | undefined;
    const projection: ModelAssetNodeProjection = {
      package_id: manifest.package_id,
      model_id: modelId,
      node_type: "model",
      role: runtimeModel["role"] as ModelAssetNodeProjection["role"],
      description: normalizeString(nodeDefinition["description"]),
      group_key: normalizeString(nodeDefinition["group_key"]),
      icon_ref: nodeDefinition["icon_ref"] as string | undefined,
      capability: runtimeModel["capability"] as ModelAssetNodeProjection["capability"],
      ports: {
        inputs:
          (nodeDefinition["input_ports"] as
            | ModelAssetNodeProjection["ports"]["inputs"]
            | undefined) ?? [],
        outputs:
          (nodeDefinition["output_ports"] as
            | ModelAssetNodeProjection["ports"]["outputs"]
            | undefined) ?? [],
      },
      parameter_schema:
        runtimeModel["parameter_schema"] as ModelAssetNodeProjection["parameter_schema"],
      prompt_field: runtimeModel["prompt_field"] as
        | ModelAssetNodeProjection["prompt_field"]
        | undefined,
      execution_profile:
        runtimeModel["execution_profile"] as ModelAssetNodeProjection["execution_profile"],
      visibility: display
        ? {
            visible: (display as { visible?: boolean }).visible !== false,
            order: Number((display as { order?: number }).order ?? 100),
          }
        : { visible: true, order: 100 },
      runtime: runtimeModel["runtime"] as ModelAssetNodeProjection["runtime"],
    };
    projections.push(
      rewriteProjectionLocalizationKeys(projection, manifest.package_id),
    );
    localization_bundles.push(loadLocalizationBundle(packageDir, manifest));
  });

  return { projections, localization_bundles, diagnostics: [] };
};

export const loadModelAssetPackageCatalogFixture = (): ModelAssetPackageCatalogFixture => {
  if (!catalogCache) {
    catalogCache = loadCatalog();
  }
  return cloneModelAssetFixtureValue(catalogCache);
};

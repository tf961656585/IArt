import * as path from "node:path";
import {
  MODEL_ASSET_SUPPORTED_LOCALES,
  type ModelAssetLocale,
  type ModelAssetLocalizationResourceMap,
} from "@iart/contracts/model-asset-contract";
import type {
  CatalogParameterField,
  CatalogProjection,
  CatalogRawObject,
} from "./model-package-catalog.types.cts";
import {
  ensureExistingFile,
  ensureRelativeChildPath,
  isObjectRecord,
  normalizeString,
  safeReadJsonFile,
} from "./model-package-catalog.shared.cts";

const SUPPORTED_LOCALES = [...MODEL_ASSET_SUPPORTED_LOCALES];

type LocaleResources = Record<ModelAssetLocale, ModelAssetLocalizationResourceMap>;
export type { LocaleResources };

type LocalizationTarget = {
  kind:
    | "field_label"
    | "field_description"
    | "enum_label"
    | "enum_description"
    | "component_option_label"
    | "component_option_description"
    | "port_name"
    | "port_description";
  identifier: string;
  value: string;
};

export const toModelAssetLocalizationNamespace = (packageId: string) =>
  `model-asset/${packageId}`;

const toProjectedModelAssetLocalizationKey = (packageId: string, key: string) =>
  `${toModelAssetLocalizationNamespace(packageId)}:${key}`;

const isForbiddenGlobalLocalizationKey = (value: string) =>
  value.startsWith("pages:") ||
  value.startsWith("models:") ||
  value.startsWith("models.");

const resolveLocalePath = (
  resources: ModelAssetLocalizationResourceMap,
  keyPath: string,
) =>
  keyPath.split(".").reduce<unknown>((current, segment) => {
    if (!isObjectRecord(current) || !(segment in current)) {
      return undefined;
    }
    return current[segment];
  }, resources);

const resolveLocaleString = (
  resources: LocaleResources,
  locale: ModelAssetLocale,
  key: string,
) => normalizeString(resolveLocalePath(resources[locale], key)) || undefined;

const getManifestLocaleEntries = (manifest: CatalogRawObject) =>
  Array.isArray(manifest.locales) ? manifest.locales : [];

export const readLocalizationResources = ({
  packageDir,
  manifest,
}: {
  packageDir: string;
  manifest: CatalogRawObject;
}): LocaleResources => {
  const entries = getManifestLocaleEntries(manifest);
  if (entries.length === 0) {
    throw new Error("manifest.locales_missing");
  }
  const byLocale = new Map<string, string>();
  entries.forEach((entry) => {
    if (!isObjectRecord(entry)) {
      throw new Error("manifest.locale_invalid");
    }
    const locale = normalizeString(entry.locale);
    const relativePath = normalizeString(entry.relative_path);
    if (!locale || !relativePath) {
      throw new Error("manifest.locale_invalid");
    }
    if (!SUPPORTED_LOCALES.includes(locale as ModelAssetLocale)) {
      throw new Error(`manifest.locale_unsupported:${locale}`);
    }
    if (byLocale.has(locale)) {
      throw new Error(`manifest.locale_duplicate:${locale}`);
    }
    byLocale.set(locale, relativePath);
  });

  const resources = {} as LocaleResources;
  for (const locale of SUPPORTED_LOCALES) {
    const relativePath = byLocale.get(locale);
    if (!relativePath) {
      throw new Error(`manifest.locale_missing:${locale}`);
    }
    const localePath = ensureRelativeChildPath(packageDir, relativePath);
    ensureExistingFile(localePath, `locale_file_missing:${locale}`);
    const raw = safeReadJsonFile(localePath);
    if (!isObjectRecord(raw)) {
      throw new Error(`locale_file_invalid:${locale}`);
    }
    resources[locale] = raw;
  }
  return resources;
};

const pushLocalizationTarget = (
  targets: LocalizationTarget[],
  kind: LocalizationTarget["kind"],
  identifier: string,
  value: unknown,
) => {
  const normalized = normalizeString(value);
  if (normalized) {
    targets.push({ kind, identifier, value: normalized });
  }
};

const collectChoiceOptionLocalizationTargets = (
  targets: LocalizationTarget[],
  fieldKey: string,
  optionGroup: string,
  value: unknown,
) => {
  if (!Array.isArray(value)) return;
  value.forEach((option, optionIndex) => {
    if (!isObjectRecord(option)) return;
    const optionId =
      normalizeString(option.id) ||
      normalizeString(option.value) ||
      `option#${optionIndex}`;
    pushLocalizationTarget(
      targets,
      "component_option_label",
      `parameter_schema.fields.${fieldKey}.component_props.${optionGroup}.${optionId}.label`,
      option.label,
    );
    pushLocalizationTarget(
      targets,
      "component_option_description",
      `parameter_schema.fields.${fieldKey}.component_props.${optionGroup}.${optionId}.description`,
      option.description,
    );
  });
};

const collectLocalizationTargets = (
  runtimeModel: CatalogRawObject,
  nodeDefinition: CatalogRawObject,
): LocalizationTarget[] => {
  const targets: LocalizationTarget[] = [];
  const parameterSchema = isObjectRecord(runtimeModel.parameter_schema)
    ? runtimeModel.parameter_schema
    : ({} as CatalogRawObject);
  const fields = Array.isArray(parameterSchema.fields)
    ? parameterSchema.fields as unknown[]
    : [];
  const inputPorts = Array.isArray(nodeDefinition.input_ports)
    ? nodeDefinition.input_ports
    : [];
  const outputPorts = Array.isArray(nodeDefinition.output_ports)
    ? nodeDefinition.output_ports
    : [];

  fields.forEach((field: unknown, fieldIndex: number) => {
    if (!isObjectRecord(field)) return;
    const fieldKey =
      normalizeString(field.field_key || field.fieldKey) ||
      `field#${fieldIndex}`;
    pushLocalizationTarget(
      targets,
      "field_label",
      `parameter_schema.fields.${fieldKey}.label`,
      field.label,
    );
    pushLocalizationTarget(
      targets,
      "field_description",
      `parameter_schema.fields.${fieldKey}.description`,
      field.description,
    );
    const enumOptions = Array.isArray(field.enum_options)
      ? field.enum_options
      : [];
    enumOptions.forEach((option, optionIndex) => {
      if (!isObjectRecord(option)) return;
      const optionValue =
        normalizeString(option.value) || `option#${optionIndex}`;
      pushLocalizationTarget(
        targets,
        "enum_label",
        `parameter_schema.fields.${fieldKey}.enum_options.${optionValue}.label`,
        option.label,
      );
      pushLocalizationTarget(
        targets,
        "enum_description",
        `parameter_schema.fields.${fieldKey}.enum_options.${optionValue}.description`,
        option.description,
      );
    });
    const componentProps = isObjectRecord(field.component_props)
      ? field.component_props
      : ({} as CatalogRawObject);
    collectChoiceOptionLocalizationTargets(
      targets,
      fieldKey,
      "sizeOptions",
      componentProps.sizeOptions,
    );
    collectChoiceOptionLocalizationTargets(
      targets,
      fieldKey,
      "aspectOptions",
      componentProps.aspectOptions,
    );
    collectChoiceOptionLocalizationTargets(
      targets,
      fieldKey,
      "sizeLevels",
      componentProps.sizeLevels,
    );
    collectChoiceOptionLocalizationTargets(
      targets,
      fieldKey,
      "aspectPresets",
      componentProps.aspectPresets,
    );
    collectChoiceOptionLocalizationTargets(
      targets,
      fieldKey,
      "presetOptions",
      componentProps.presetOptions,
    );
    collectChoiceOptionLocalizationTargets(
      targets,
      fieldKey,
      "customPresets",
      componentProps.customPresets,
    );
  });

  inputPorts
    .map((port) => ({ direction: "inputs", port }))
    .concat(outputPorts.map((port) => ({ direction: "outputs", port })))
    .forEach(({ direction, port }, portIndex) => {
      if (!isObjectRecord(port)) return;
      const portId = normalizeString(port.id) || `port#${portIndex}`;
      pushLocalizationTarget(
        targets,
        "port_name",
        `node_definition.ports.${direction}.${portId}.name`,
        port.name,
      );
      pushLocalizationTarget(
        targets,
        "port_description",
        `node_definition.ports.${direction}.${portId}.description`,
        port.description,
      );
    });
  return targets;
};

export const validateLocalizationTargets = ({
  packageId,
  resources,
  runtimeModel,
  nodeDefinition,
}: {
  packageId: string;
  resources: LocaleResources;
  runtimeModel: CatalogRawObject;
  nodeDefinition: CatalogRawObject;
}) => {
  collectLocalizationTargets(runtimeModel, nodeDefinition).forEach((target) => {
    if (isForbiddenGlobalLocalizationKey(target.value)) {
      throw new Error(
        `localization.global_key_not_allowed:${packageId}:${target.identifier}:${target.value}`,
      );
    }
    if (path.isAbsolute(target.value) || target.value.includes(":")) {
      throw new Error(
        `localization.package_relative_key_required:${packageId}:${target.identifier}:${target.value}`,
      );
    }
    for (const locale of SUPPORTED_LOCALES) {
      if (!resolveLocaleString(resources, locale, target.value)) {
        throw new Error(
          `localization.${target.kind}_missing:${packageId}:${locale}:${target.identifier}:${target.value}`,
        );
      }
    }
  });
};

const rewriteLocalizationKey = (packageId: string, key: string) =>
  toProjectedModelAssetLocalizationKey(packageId, key);

const rewriteOptionalLocalizationKey = (
  packageId: string,
  value: string | undefined,
) => {
  const normalized = normalizeString(value);
  return normalized ? rewriteLocalizationKey(packageId, normalized) : undefined;
};

const rewriteChoiceOptions = <T extends {
  label: string | undefined | undefined;
  description: string | undefined | undefined;
}>(
  packageId: string,
  options: T[] | undefined,
): T[] | undefined => {
  if (!options) return undefined;
  return options.map((option) => ({
    ...option,
    ...(option.label
      ? { label: rewriteLocalizationKey(packageId, option.label) }
      : {}),
    ...(option.description
      ? { description: rewriteLocalizationKey(packageId, option.description) }
      : {}),
  }));
};

export const rewriteProjectionLocalizationKeys = (
  projection: CatalogProjection,
  packageId: string,
): CatalogProjection => ({
  ...projection,
  description: undefined,
  ports: {
    inputs: projection.ports.inputs.map((port) => ({
      ...port,
      name: rewriteLocalizationKey(packageId, port.name),
      description: rewriteOptionalLocalizationKey(packageId, port.description),
    })),
    outputs: projection.ports.outputs.map((port) => ({
      ...port,
      name: rewriteLocalizationKey(packageId, port.name),
      description: rewriteOptionalLocalizationKey(packageId, port.description),
    })),
  },
  parameter_schema: {
    ...projection.parameter_schema,
    fields: projection.parameter_schema.fields.map((field): CatalogParameterField => ({
      ...field,
      label: rewriteLocalizationKey(packageId, field.label),
      description: rewriteOptionalLocalizationKey(packageId, field.description),
      enum_options: field.enum_options
        ? field.enum_options.map((option) => ({
            ...option,
            ...(option.label
              ? { label: rewriteLocalizationKey(packageId, option.label) }
              : {}),
          }))
        : undefined,
      component_props: field.component_props
        ? ({
            ...field.component_props,
            sizeOptions: rewriteChoiceOptions(
              packageId,
              field.component_props.sizeOptions,
            ),
            aspectOptions: rewriteChoiceOptions(
              packageId,
              field.component_props.aspectOptions,
            ),
            sizeLevels: rewriteChoiceOptions(
              packageId,
              field.component_props.sizeLevels as { label: string | undefined; description: string | undefined }[] | undefined,
            ),
            aspectPresets: rewriteChoiceOptions(
              packageId,
              field.component_props.aspectPresets as { label: string | undefined; description: string | undefined }[] | undefined,
            ),
            presetOptions: rewriteChoiceOptions(
              packageId,
              field.component_props.presetOptions,
            ),
            customPresets: rewriteChoiceOptions(
              packageId,
              field.component_props.customPresets,
            ),
          } as CatalogParameterField["component_props"])
        : undefined,
    })),
  },
  visibility: {
    ...projection.visibility,
    badges: projection.visibility.badges
      ? projection.visibility.badges.map((badge: string) =>
          rewriteLocalizationKey(packageId, badge),
        )
      : undefined,
  },
  runtime: {
    ...projection.runtime,
  },
});

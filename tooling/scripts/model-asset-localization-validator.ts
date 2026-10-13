import path from 'node:path';
import { MODEL_ASSET_SUPPORTED_LOCALES, type ModelAssetLocale } from '@iart/contracts/model-asset-contract';
import type { SourceManifest } from './model-asset-packages/types';
import { ensureFileExists, ensureRelativeChildPath, isRecord, normalizeString, readJson } from './model-asset-packages/shared';

type LocaleResources = Record<ModelAssetLocale, Record<string, unknown>>;

interface ValidationTarget {
  kind:
    | 'field_label'
    | 'field_description'
    | 'enum_label'
    | 'enum_description'
    | 'component_option_label'
    | 'component_option_description'
    | 'port_name'
    | 'port_description';
  identifier: string;
  value: string;
}

interface ValidationOptions {
  packageId: string;
  sourceDir: string;
  manifest: SourceManifest;
  runtimeModel: Record<string, unknown>;
  nodeDefinition: Record<string, unknown>;
}

export interface LoadedModelAssetLocales {
  resources: LocaleResources;
  localePaths: string[];
}

const SUPPORTED_LOCALES = [...MODEL_ASSET_SUPPORTED_LOCALES];

const resolvePath = (value: Record<string, unknown>, keyPath: string): unknown => {
  return keyPath.split('.').reduce<unknown>((current, segment) => {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    return current[segment];
  }, value);
};

export const isForbiddenGlobalLocalizationKey = (value: string): boolean =>
  value.startsWith('pages:') || value.startsWith('models:') || value.startsWith('models.');

export const toModelAssetLocalizationNamespace = (packageId: string): string =>
  `model-asset/${packageId}`;

export const toProjectedModelAssetLocalizationKey = (packageId: string, key: string): string =>
  `${toModelAssetLocalizationNamespace(packageId)}:${key}`;

const getLocaleEntries = (manifest: SourceManifest): Array<{ locale?: string; relative_path?: string }> => {
  return Array.isArray(manifest.locales) ? manifest.locales : [];
};

export const loadModelAssetLocales = async (
  sourceDir: string,
  manifest: SourceManifest,
): Promise<LoadedModelAssetLocales> => {
  const entries = getLocaleEntries(manifest);
  if (entries.length === 0) {
    throw new Error('manifest.locales_missing');
  }

  const byLocale = new Map<string, string>();
  entries.forEach((entry) => {
    if (!isRecord(entry)) {
      throw new Error('manifest.locale_invalid');
    }
    const locale = normalizeString(entry.locale);
    const relativePath = normalizeString(entry.relative_path);
    if (!locale || !relativePath) {
      throw new Error('manifest.locale_invalid');
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
  const localePaths: string[] = [];
  for (const locale of SUPPORTED_LOCALES) {
    const relativePath = byLocale.get(locale);
    if (!relativePath) {
      throw new Error(`manifest.locale_missing:${locale}`);
    }
    const localePath = ensureRelativeChildPath(sourceDir, relativePath);
    await ensureFileExists(localePath, `locale_file_missing:${locale}`);
    const raw = await readJson(localePath);
    if (!isRecord(raw)) {
      throw new Error(`locale_file_invalid:${locale}`);
    }
    resources[locale] = raw;
    localePaths.push(localePath);
  }

  return { resources, localePaths };
};

export const resolveModelAssetLocaleValue = (
  resources: LocaleResources,
  locale: ModelAssetLocale,
  key: string,
): string | undefined => {
  const value = resolvePath(resources[locale], key);
  const normalized = normalizeString(value);
  return normalized || undefined;
};

const pushIfString = (
  targets: ValidationTarget[],
  kind: ValidationTarget['kind'],
  identifier: string,
  value: unknown,
): void => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return;
  }
  targets.push({ kind, identifier, value: normalized });
};

const collectChoiceOptionTargets = (
  targets: ValidationTarget[],
  fieldKey: string,
  optionGroup: string,
  value: unknown,
): void => {
  if (!Array.isArray(value)) {
    return;
  }
  value.forEach((option, optionIndex) => {
    if (!isRecord(option)) {
      return;
    }
    const optionId =
      normalizeString(option["id"]) ||
      normalizeString(option["value"]) ||
      `option#${optionIndex}`;
    pushIfString(
      targets,
      'component_option_label',
      `parameter_schema.fields.${fieldKey}.component_props.${optionGroup}.${optionId}.label`,
      option["label"],
    );
    pushIfString(
      targets,
      'component_option_description',
      `parameter_schema.fields.${fieldKey}.component_props.${optionGroup}.${optionId}.description`,
      option["description"],
    );
  });
};

const collectValidationTargets = (
  runtimeModel: Record<string, unknown>,
  nodeDefinition: Record<string, unknown>,
): ValidationTarget[] => {
  const targets: ValidationTarget[] = [];
  const parameterSchema = isRecord(runtimeModel["parameter_schema"]) ? runtimeModel["parameter_schema"] : {};
  const fields: unknown[] = Array.isArray(parameterSchema["fields"]) ? parameterSchema["fields"] : [];
  const inputPorts: unknown[] = Array.isArray(nodeDefinition["input_ports"]) ? nodeDefinition["input_ports"] : [];
  const outputPorts: unknown[] = Array.isArray(nodeDefinition["output_ports"]) ? nodeDefinition["output_ports"] : [];

  fields.forEach((field, fieldIndex) => {
    if (!isRecord(field)) {
      return;
    }
    const fieldKey = normalizeString(field["field_key"]) || `field#${fieldIndex}`;
    pushIfString(targets, 'field_label', `parameter_schema.fields.${fieldKey}.label`, field["label"]);
    pushIfString(targets, 'field_description', `parameter_schema.fields.${fieldKey}.description`, field["description"]);

    const enumOptions: unknown[] = Array.isArray(field["enum_options"]) ? field["enum_options"] : [];
    enumOptions.forEach((option, optionIndex) => {
      if (!isRecord(option)) {
        return;
      }
      const optionValue = normalizeString(option["value"]) || `option#${optionIndex}`;
      pushIfString(
        targets,
        'enum_label',
        `parameter_schema.fields.${fieldKey}.enum_options.${optionValue}.label`,
        option["label"],
      );
      pushIfString(
        targets,
        'enum_description',
        `parameter_schema.fields.${fieldKey}.enum_options.${optionValue}.description`,
        option["description"],
      );
    });

    const componentProps = isRecord(field["component_props"]) ? field["component_props"] : {};
    collectChoiceOptionTargets(targets, fieldKey, 'sizeOptions', componentProps["sizeOptions"]);
    collectChoiceOptionTargets(targets, fieldKey, 'aspectOptions', componentProps["aspectOptions"]);
    collectChoiceOptionTargets(targets, fieldKey, 'sizeLevels', componentProps["sizeLevels"]);
    collectChoiceOptionTargets(targets, fieldKey, 'aspectPresets', componentProps["aspectPresets"]);
    collectChoiceOptionTargets(targets, fieldKey, 'presetOptions', componentProps["presetOptions"]);
  });

  const allPorts = inputPorts
    .map((port) => ({ port, direction: 'inputs' }))
    .concat(outputPorts.map((port) => ({ port, direction: 'outputs' })));
  allPorts.forEach(({ port, direction }, portIndex) => {
    if (!isRecord(port)) {
      return;
    }
    const portId = normalizeString(port["id"]) || `port#${portIndex}`;
    pushIfString(targets, 'port_name', `node_definition.ports.${direction}.${portId}.name`, port["name"]);
    pushIfString(targets, 'port_description', `node_definition.ports.${direction}.${portId}.description`, port["description"]);
  });

  return targets;
};

export const validateModelAssetLocalization = async ({
  packageId,
  sourceDir,
  manifest,
  runtimeModel,
  nodeDefinition,
}: ValidationOptions): Promise<{ errors: string[]; localePaths: string[] }> => {
  const loaded = await loadModelAssetLocales(sourceDir, manifest);
  const errors: string[] = [];

  collectValidationTargets(runtimeModel, nodeDefinition).forEach((target) => {
    if (isForbiddenGlobalLocalizationKey(target.value)) {
      errors.push(
        `localization.global_key_not_allowed:${packageId}:${target.identifier}:${target.value}`,
      );
      return;
    }
    if (path.isAbsolute(target.value) || target.value.includes(':')) {
      errors.push(
        `localization.package_relative_key_required:${packageId}:${target.identifier}:${target.value}`,
      );
      return;
    }

    SUPPORTED_LOCALES.forEach((locale) => {
      const resolved = resolveModelAssetLocaleValue(loaded.resources, locale, target.value);
      if (!resolved) {
        errors.push(
          `localization.${target.kind}_missing:${packageId}:${locale}:${target.identifier}:${target.value}`,
        );
      }
    });
  });

  return { errors, localePaths: loaded.localePaths };
};

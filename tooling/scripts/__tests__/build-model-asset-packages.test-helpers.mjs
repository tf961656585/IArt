import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export { test };

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);
export const repoRoot = path.resolve(__dirname, '..', '..', '..');
export const scriptPath = path.join(repoRoot, 'tooling', 'scripts', 'build-model-asset-packages.ts');
export const backendCatalogPath = path.join(
  repoRoot,
  'apps',
  'backend',
  'src',
  'local-server',
  'model-package-catalog.cts',
);
export const nodeBin = process.execPath;
export const tsxImportPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
export const tsxImportSpecifier = pathToFileURL(tsxImportPath).href;
export const backendCatalogSpecifier = pathToFileURL(backendCatalogPath).href;

export const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'iart-model-packages-'));

export const serialTest = (name, fn) => test(name, { concurrency: false }, fn);

export const writeJson = (targetPath, data) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

export const TEST_LOCALE_REFS = [
  { locale: 'zh-CN', relative_path: 'locales/zh-CN.json' },
  { locale: 'en', relative_path: 'locales/en.json' },
];

export const withTestLocales = (manifest) => ({
  ...manifest,
  locales: TEST_LOCALE_REFS,
});

export const runBuildScript = (cwd, args = []) =>
  spawnSync(nodeBin, ['--import', tsxImportSpecifier, scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  });

export const runBackendCatalog = (cwd, options = {}) => {
  const packageRoot = typeof options.packageRoot === 'string' ? options.packageRoot : '';
  const resourcesPath = typeof options.resourcesPath === 'string' ? options.resourcesPath : '';
  const script = `
    if (${JSON.stringify(resourcesPath)}) {
      Object.defineProperty(process, 'resourcesPath', {
        value: ${JSON.stringify(resourcesPath)},
        configurable: true,
      });
    }
    import catalogModule from ${JSON.stringify(backendCatalogSpecifier)};
    const { loadModelPackageCatalog } = catalogModule;
    const catalog = loadModelPackageCatalog();
    process.stdout.write(JSON.stringify(catalog));
  `;

  return spawnSync(nodeBin, ['--import', tsxImportSpecifier, '-e', script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(packageRoot ? { IART_MODEL_ASSET_PACKAGES_DIR: packageRoot } : {}),
    },
  });
};

export const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pickDefaultOutputTarget = (data = {}) => {
  const outputModalities = Array.isArray(data.capability?.output_modalities)
    ? data.capability.output_modalities
    : [];
  if (outputModalities.includes('video')) return 'output.video_url';
  if (outputModalities.includes('audio')) return 'output.audio_url';
  if (outputModalities.includes('text')) return 'output.text';
  return 'output.image_url';
};

export const withRequiredRuntime = (modelId, data = {}) => ({
  model_id: modelId,
  ...(!Object.prototype.hasOwnProperty.call(data, 'request_strategy')
    ? {
        request_strategy: {
          request_stage: 'submit',
          protocol: 'http',
          endpoint: '/v1/test',
          method: 'POST',
          header_rules: [],
          body_rules: [],
          query_rules: [],
        },
      }
    : {}),
  ...(!Object.prototype.hasOwnProperty.call(data, 'result_rule')
    ? {
        result_rule: {
          mode: 'sync',
          submit_response_id_path: '/id',
        },
      }
    : {}),
  ...(!Object.prototype.hasOwnProperty.call(data, 'result_output_mapping') &&
  Array.isArray(data.capability?.output_modalities) &&
  data.capability.output_modalities.length > 0
    ? {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: pickDefaultOutputTarget(data),
              source: { kind: 'response', path: 'output' },
            },
          ],
        },
      }
    : {}),
  ...data,
  runtime: {
    provider_id: 'google',
    execution_driver: 'http_formal_task',
    ...(data.runtime ?? {}),
  },
});

export const writeSourcePackage = (
  tempDir,
  {
    packageId,
    modelId,
    runtimeModel = {},
    rawRuntimeModel,
    nodeDefinition = {},
    resources = [],
    locales,
  },
) => {
  const sourceDir = path.join(tempDir, '.model-assets', 'sources', packageId);
  const localeEntries =
    locales === null
      ? []
      : TEST_LOCALE_REFS;
  writeJson(path.join(sourceDir, 'manifest.json'), {
    package_id: packageId,
    entry_model: {
      model_id: modelId,
      relative_path: 'runtime_model.json',
    },
    node_definition: {
      relative_path: 'node_definition.json',
    },
    resources: resources.map((resource) => ({
      resource_id: resource.resourceId,
      media_type: resource.mediaType,
      relative_path: resource.relativePath,
    })),
    ...(localeEntries.length > 0 ? { locales: localeEntries } : {}),
  });
  const resolvedRuntimeModel = rawRuntimeModel ?? withRequiredRuntime(modelId, runtimeModel);
  const resolvedNodeDefinition = {
    node_type: 'model',
    ...nodeDefinition,
  };
  writeJson(path.join(sourceDir, 'runtime_model.json'), resolvedRuntimeModel);
  writeJson(path.join(sourceDir, 'node_definition.json'), resolvedNodeDefinition);
  if (localeEntries.length > 0) {
    const resolvedLocales =
      locales && typeof locales === 'object'
        ? locales
        : buildDefaultLocalizationResources(resolvedRuntimeModel, resolvedNodeDefinition);
    writeJson(path.join(sourceDir, 'locales', 'zh-CN.json'), resolvedLocales['zh-CN'] ?? {});
    writeJson(path.join(sourceDir, 'locales', 'en.json'), resolvedLocales.en ?? {});
  }
  resources.forEach((resource) => {
    const resourcePath = path.join(sourceDir, resource.relativePath);
    fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
    fs.writeFileSync(resourcePath, resource.content, 'utf8');
  });
  return sourceDir;
};

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const setPath = (target, keyPath, value) => {
  const normalized = normalizeString(keyPath);
  if (!normalized) return;
  const segments = normalized.split('.').filter(Boolean);
  if (segments.length === 0) return;
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = normalizeString(value) || normalized;
};

const collectLocalizationTargets = (runtimeModel, nodeDefinition) => {
  const targets = [];
  const push = (value) => {
    const normalized = normalizeString(value);
    if (normalized) targets.push(normalized);
  };
  const parameterSchema = isRecord(runtimeModel.parameter_schema) ? runtimeModel.parameter_schema : {};
  const fields = Array.isArray(parameterSchema.fields) ? parameterSchema.fields : [];
  fields.forEach((field) => {
    if (!isRecord(field)) return;
    push(field.label);
    push(field.description);
    const enumOptions = Array.isArray(field.enum_options) ? field.enum_options : [];
    enumOptions.forEach((option) => {
      if (!isRecord(option)) return;
      push(option.label);
      push(option.description);
    });
    const componentProps = isRecord(field.component_props) ? field.component_props : {};
    for (const optionGroup of [
      componentProps.sizeOptions,
      componentProps.aspectOptions,
      componentProps.sizeLevels,
      componentProps.aspectPresets,
      componentProps.presetOptions,
      componentProps.customPresets,
    ]) {
      if (!Array.isArray(optionGroup)) continue;
      optionGroup.forEach((option) => {
        if (!isRecord(option)) return;
        push(option.label);
        push(option.description);
      });
    }
  });

  for (const ports of [nodeDefinition.input_ports, nodeDefinition.output_ports]) {
    if (!Array.isArray(ports)) continue;
    ports.forEach((port) => {
      if (!isRecord(port)) return;
      push(port.name);
      push(port.description);
    });
  }
  return targets;
};

const buildDefaultLocalizationResources = (runtimeModel, nodeDefinition) => {
  const resources = { 'zh-CN': {}, en: {} };
  collectLocalizationTargets(runtimeModel, nodeDefinition).forEach((key) => {
    setPath(resources['zh-CN'], key, key);
    setPath(resources.en, key, key);
  });
  return resources;
};

export const writeDefaultLocalizationFiles = (
  sourceDir,
  runtimeModel = {},
  nodeDefinition = {},
) => {
  const resources = buildDefaultLocalizationResources(runtimeModel, nodeDefinition);
  writeJson(path.join(sourceDir, 'locales', 'zh-CN.json'), resources['zh-CN']);
  writeJson(path.join(sourceDir, 'locales', 'en.json'), resources.en);
};

export { assert, fs, path };

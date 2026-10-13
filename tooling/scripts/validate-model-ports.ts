import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type PackageManifest = {
  package_id?: string;
  entry_model?: { relative_path?: string };
  node_definition?: { relative_path?: string };
};

type RuntimeModelField = {
  field_key?: string;
  component?: string;
  component_props?: {
    accept?: string;
  };
};

type RuntimeModelFile = {
  runtime?: {
    payload_rules?: Record<string, unknown>;
  };
  parameter_schema?: {
    fields?: RuntimeModelField[];
  };
};

type NodeDefinitionFile = {
  input_ports?: Array<{
    field_key?: string;
    data_type?: string;
  }>;
};

const REPO_ROOT = process.cwd();
const DEFAULT_PACKAGE_ROOT = path.join(REPO_ROOT, '.model-assets', 'packages');

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const uniqSorted = (values: string[]): string[] =>
  Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));

const isImageField = (field: RuntimeModelField): boolean => {
  const component = normalizeString(field.component);
  if (component === 'imageUpload') {
    return true;
  }
  if (component !== 'file') {
    return false;
  }
  return normalizeString(field.component_props?.accept).toLowerCase().includes('image/');
};

const collectFieldKeysFromPayloadRule = (
  value: unknown,
  fieldKeys: Set<string> = new Set<string>(),
): Set<string> => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectFieldKeysFromPayloadRule(item, fieldKeys));
    return fieldKeys;
  }

  if (!value || typeof value !== 'object') {
    return fieldKeys;
  }

  const record = value as Record<string, unknown>;
  if (record['kind'] === 'field') {
    const fieldKey = normalizeString(record['field_key']);
    if (fieldKey) {
      fieldKeys.add(fieldKey);
    }
  }

  Object.values(record).forEach((item) => collectFieldKeysFromPayloadRule(item, fieldKeys));
  return fieldKeys;
};

const readJsonFile = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as T;

export const validateModelPortCoverage = async (
  packageRoot = DEFAULT_PACKAGE_ROOT,
): Promise<string[]> => {
  const packageEntries = await fs
    .readdir(packageRoot, { withFileTypes: true, encoding: 'utf8' })
    .catch(() => null);
  if (!packageEntries) {
    return [`package_root_missing: ${packageRoot}`];
  }

  const errors: string[] = [];

  for (const entry of packageEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageDir = path.join(packageRoot, entry.name);
    const manifestPath = path.join(packageDir, 'manifest.json');
    const manifest = await readJsonFile<PackageManifest>(manifestPath);
    const packageId = normalizeString(manifest.package_id) || entry.name;
    const runtimeModel = await readJsonFile<RuntimeModelFile>(
      path.join(packageDir, normalizeString(manifest.entry_model?.relative_path)),
    );
    const nodeDefinition = await readJsonFile<NodeDefinitionFile>(
      path.join(packageDir, normalizeString(manifest.node_definition?.relative_path)),
    );

    const payloadFieldKeys = collectFieldKeysFromPayloadRule(runtimeModel.runtime?.payload_rules);
    const payloadImageFieldKeys = uniqSorted(
      (runtimeModel.parameter_schema?.fields ?? [])
        .filter((field) => isImageField(field) && payloadFieldKeys.has(normalizeString(field['field_key'])))
        .map((field) => normalizeString(field['field_key'])),
    );

    if (payloadImageFieldKeys.length === 0) {
      continue;
    }

    const declaredImageFieldKeys = uniqSorted(
      (nodeDefinition.input_ports ?? [])
        .filter((port) => normalizeString(port.data_type) === 'image')
        .map((port) => normalizeString(port['field_key'])),
    );

    const missingFieldKeys = payloadImageFieldKeys.filter(
      (fieldKey) => !declaredImageFieldKeys.includes(fieldKey),
    );
    const extraFieldKeys = declaredImageFieldKeys.filter(
      (fieldKey) => !payloadImageFieldKeys.includes(fieldKey),
    );

    if (missingFieldKeys.length === 0 && extraFieldKeys.length === 0) {
      continue;
    }

    errors.push(
      [
        `${packageId}: 图像端口字段与正式 payload 不一致`,
        `payload_image_fields=${payloadImageFieldKeys.join(',') || '(none)'}`,
        `declared_image_fields=${declaredImageFieldKeys.join(',') || '(none)'}`,
        `missing_image_fields=${missingFieldKeys.join(',') || '(none)'}`,
        `extra_image_fields=${extraFieldKeys.join(',') || '(none)'}`,
      ].join(' | '),
    );
  }

  return errors;
};

async function main() {
  const errors = await validateModelPortCoverage();

  if (errors.length > 0) {
    console.error('\n[model-asset-port-audit] 校验失败:');
    errors.forEach((err) => console.error(' -', err));
    process.exit(1);
  }

  console.log('[model-asset-port-audit] 所有模型资产图像端口校验通过');
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((err) => {
    console.error('[model-asset-port-audit] 执行异常', err);
    process.exit(1);
  });
}

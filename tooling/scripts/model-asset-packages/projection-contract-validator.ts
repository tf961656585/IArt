import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUTPUT_ROOT, TOOLING_REPO_ROOT } from './paths';

const TSX_LOADER_PATH = path.join(TOOLING_REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const BACKEND_CATALOG_PATH = path.join(
  TOOLING_REPO_ROOT,
  'apps',
  'backend',
  'src',
  'local-server',
  'model-package-catalog.cts',
);
const TSX_LOADER_SPECIFIER = pathToFileURL(TSX_LOADER_PATH).href;
const BACKEND_CATALOG_SPECIFIER = pathToFileURL(BACKEND_CATALOG_PATH).href;
const buildValidationScript = (packageIds: string[]): string => `
const catalogModule = await import(${JSON.stringify(BACKEND_CATALOG_SPECIFIER)});
const projectionSchemaModule = await import('@iart/contracts/model-asset-contract');
const { loadModelPackageCatalog } = catalogModule.default ?? catalogModule;
const { ModelAssetNodeProjectionResponseSchema } = projectionSchemaModule;
const selectedPackageIds = new Set(${JSON.stringify(packageIds)});

const catalog = loadModelPackageCatalog();
const allProjections = Array.isArray(catalog.projections) ? catalog.projections : [];
const allLocalizationBundles = Array.isArray(catalog.localization_bundles) ? catalog.localization_bundles : [];
const allDiagnostics = Array.isArray(catalog.diagnostics) ? catalog.diagnostics : [];
const projections = selectedPackageIds.size > 0
  ? allProjections.filter((item) => selectedPackageIds.has(item?.package_id))
  : allProjections;
const localizationBundles = selectedPackageIds.size > 0
  ? allLocalizationBundles.filter((item) => selectedPackageIds.has(item?.package_id))
  : allLocalizationBundles;
const diagnostics = selectedPackageIds.size > 0
  ? allDiagnostics.filter((item) => selectedPackageIds.has(item?.package_id))
  : allDiagnostics;
const payload = {
  success: true,
  loaded_at: typeof catalog.loaded_at === 'string' ? catalog.loaded_at : new Date().toISOString(),
  package_root: typeof catalog.package_root === 'string' ? catalog.package_root : '',
  projections,
  localization_bundles: localizationBundles,
  diagnostics,
};

const parsed = ModelAssetNodeProjectionResponseSchema.safeParse(payload);
if (!parsed.success) {
  console.error(JSON.stringify({
    code: 'model_asset_projection_response_schema_invalid',
    issues: parsed.error.issues,
  }, null, 2));
  process.exit(1);
}

// 端点是否已配置/合法是运行时的用户配置事实（spec docs/runtime/public-relay-capability.md
// 「结构对账」语义，2026-10-12 拍板）：public relay endpoint 类诊断不阻断打包——
// 用户可经设置页/env 自带端点后即用；结构类诊断（坏包）仍然致命。
const isEndpointConfigDiagnostic = (item: unknown): boolean =>
  typeof (item as { code?: unknown } | null | undefined)?.code === 'string' &&
  String((item as { code: unknown }).code).includes('public_relay_target_endpoint_');
const fatalDiagnostics = payload.diagnostics.filter((item) => !isEndpointConfigDiagnostic(item));

if (fatalDiagnostics.length > 0) {
  console.error(JSON.stringify({
    code: 'model_asset_package_diagnostics_present',
    diagnostics: fatalDiagnostics,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  projectionCount: payload.projections.length,
  packageRoot: payload.package_root,
  scope: selectedPackageIds.size > 0 ? Array.from(selectedPackageIds).sort() : 'all',
}));
`;

export const validateBuiltModelAssetProjectionContract = (
  packageIds: string[] = [],
): void => {
  const result = spawnSync(
    process.execPath,
    ['--import', TSX_LOADER_SPECIFIER, '-e', buildValidationScript(packageIds)],
    {
      cwd: TOOLING_REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        IART_MODEL_ASSET_PACKAGES_DIR: OUTPUT_ROOT,
      },
    },
  );

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `model_asset_projection_contract_invalid${detail ? `\n${detail}` : ''}`,
    );
  }

  const summary = (result.stdout || '').trim();
  console.log(`[model-asset-projection-contract] ${summary || 'ok'}`);
};

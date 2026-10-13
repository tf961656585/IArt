import fs from 'node:fs/promises';
import path from 'node:path';
import type { SourceManifestSummary, ValidatedPackage } from './types';
import { OUTPUT_ROOT, SOURCE_ROOT } from './paths';
import { normalizeString } from './shared';
import { buildPackage } from './package-builder';
import { computeModelPackageFingerprint, isModelPackageUpToDate, recordModelPackageState } from './build-freshness';
import { validateBuiltModelAssetProjectionContract } from './projection-contract-validator';
import { listSourcePackageDirs, loadSourceManifestSummary } from './source-reader';
import { validateSourcePackage } from './source-package-validator';
import { validateVariantGroupDefaults } from './variant-validator';

const formatError = (packageName: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `[${packageName}] ${message}`;
};

export const parseCliArgs = (argv: string[]): string[] => {
  const packageIds: string[] = [];
  const seenPackageIds = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--package') {
      throw new Error(`cli.argument_unknown:${arg}`);
    }

    const packageId = normalizeString(argv[index + 1]);
    if (!packageId) {
      throw new Error('cli.package_id_missing');
    }
    if (seenPackageIds.has(packageId)) {
      throw new Error(`cli.package_id_duplicated:${packageId}`);
    }
    seenPackageIds.add(packageId);
    packageIds.push(packageId);
    index += 1;
  }

  return packageIds;
};

export const runBuildModelAssetPackagesCli = async (): Promise<void> => {
  const requestedPackageIds = parseCliArgs(process.argv.slice(2));
  const sourceDirs = await listSourcePackageDirs();
  if (sourceDirs.length === 0) {
    throw new Error(`未找到任何包源目录: ${SOURCE_ROOT}`);
  }

  const validationErrors: string[] = [];
  const sourceDirByPackageId = new Map(sourceDirs.map((sourceDir) => [path.basename(sourceDir), sourceDir]));

  const pushDuplicateModelErrors = (packages: ValidatedPackage[]): void => {
    const modelOwner = new Map<string, string>();
    for (const pkg of packages) {
      const existingOwner = modelOwner.get(pkg.modelId);
      if (existingOwner) {
        validationErrors.push(
          `[${pkg.packageId}] duplicate_model_id: ${pkg.modelId} 已被包 ${existingOwner} 占用`,
        );
        continue;
      }
      modelOwner.set(pkg.modelId, pkg.packageId);
    }
  };

  if (requestedPackageIds.length === 0) {
    const validatedPackages: ValidatedPackage[] = [];

    for (const sourceDir of sourceDirs) {
      const packageName = path.basename(sourceDir);
      try {
        const validated = await validateSourcePackage(sourceDir);
        validatedPackages.push(validated);
      } catch (error) {
        validationErrors.push(formatError(packageName, error));
      }
    }

    pushDuplicateModelErrors(validatedPackages);

    if (validationErrors.length > 0) {
      throw new Error(`模型包校验失败:\n${validationErrors.join('\n')}`);
    }

    const variantWarnings = validateVariantGroupDefaults(validatedPackages);
    for (const warning of variantWarnings) {
      console.log(`⚠️ variant_group 警告: ${warning}`);
    }

    await fs.mkdir(OUTPUT_ROOT, { recursive: true });

    // 不再整目录 rm：指纹一致的包复用现有产物（与重建逐字节等价），只清理已移除源的残留包目录
    const currentPackageIds = new Set(validatedPackages.map((pkg) => pkg.packageId));
    for (const entry of await fs.readdir(OUTPUT_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && !currentPackageIds.has(entry.name)) {
        await fs.rm(path.join(OUTPUT_ROOT, entry.name), { recursive: true, force: true });
      }
    }

    let reusedPackages = 0;
    let rebuiltPackages = 0;
    for (const pkg of validatedPackages) {
      const sourceDir = sourceDirByPackageId.get(pkg.packageId);
      if (!sourceDir) {
        throw new Error(`[${pkg.packageId}] package_source_dir_missing`);
      }
      const fingerprint = await computeModelPackageFingerprint(sourceDir);
      const forceFreshBuild = process.env.IART_FORCE_FRESH_BUILD === '1';
      let outputDirExists = false;
      try {
        await fs.access(path.join(OUTPUT_ROOT, pkg.packageId));
        outputDirExists = true;
      } catch {
        outputDirExists = false;
      }
      if (
        !forceFreshBuild &&
        outputDirExists &&
        (await isModelPackageUpToDate(pkg.packageId, fingerprint))
      ) {
        reusedPackages += 1;
        continue;
      }
      await fs.rm(path.join(OUTPUT_ROOT, pkg.packageId), { recursive: true, force: true });
      await buildPackage(pkg);
      await recordModelPackageState(pkg.packageId, fingerprint);
      rebuiltPackages += 1;
    }
    validateBuiltModelAssetProjectionContract();

    console.log(
      `✅ 模型包打包完成，共 ${validatedPackages.length} 个包（重建 ${rebuiltPackages}，复用 ${reusedPackages}）`,
    );
    validatedPackages.forEach((pkg) => {
      console.log(`  - ${pkg.packageId} (${pkg.modelId})`);
    });
    console.log(`📦 输出目录: ${OUTPUT_ROOT}`);
    return;
  }

  const missingPackageIds = requestedPackageIds.filter((packageId) => !sourceDirByPackageId.has(packageId));
  for (const packageId of missingPackageIds) {
    validationErrors.push(formatError(packageId, 'package_not_found'));
  }

  const requestedPackageIdSet = new Set(requestedPackageIds);
  const selectedPackages: ValidatedPackage[] = [];
  const otherSourceSummaries: SourceManifestSummary[] = [];

  for (const packageId of requestedPackageIds) {
    const sourceDir = sourceDirByPackageId.get(packageId);
    if (!sourceDir) {
      continue;
    }
    try {
      const validated = await validateSourcePackage(sourceDir);
      selectedPackages.push(validated);
    } catch (error) {
      validationErrors.push(formatError(packageId, error));
    }
  }

  for (const sourceDir of sourceDirs) {
    const packageId = path.basename(sourceDir);
    if (requestedPackageIdSet.has(packageId)) {
      continue;
    }
    try {
      otherSourceSummaries.push(await loadSourceManifestSummary(sourceDir));
    } catch (error) {
      validationErrors.push(formatError(packageId, error));
    }
  }

  pushDuplicateModelErrors(selectedPackages);

  const otherOwnersByModelId = new Map<string, string[]>();
  for (const summary of otherSourceSummaries) {
    const owners = otherOwnersByModelId.get(summary.modelId) ?? [];
    owners.push(summary.packageId);
    otherOwnersByModelId.set(summary.modelId, owners);
  }

  for (const pkg of selectedPackages) {
    const conflictOwners = otherOwnersByModelId.get(pkg.modelId);
    if (!conflictOwners || conflictOwners.length === 0) {
      continue;
    }
    validationErrors.push(
      `[${pkg.packageId}] duplicate_model_id: ${pkg.modelId} 已被包 ${conflictOwners.join(', ')} 占用`,
    );
  }

  if (validationErrors.length > 0) {
    throw new Error(`模型包校验失败:\n${validationErrors.join('\n')}`);
  }

  const variantWarnings = validateVariantGroupDefaults(selectedPackages);
  for (const warning of variantWarnings) {
    console.log(`⚠️ variant_group 警告: ${warning}`);
  }

  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  for (const pkg of selectedPackages) {
    await fs.rm(path.join(OUTPUT_ROOT, pkg.packageId), { recursive: true, force: true });
    await buildPackage(pkg);
  }
  validateBuiltModelAssetProjectionContract(selectedPackages.map((pkg) => pkg.packageId));

  console.log(`✅ 模型包打包完成，共 ${selectedPackages.length} 个包`);
  selectedPackages.forEach((pkg) => {
    console.log(`  - ${pkg.packageId} (${pkg.modelId})`);
  });
  console.log(`📦 输出目录: ${OUTPUT_ROOT}`);
};

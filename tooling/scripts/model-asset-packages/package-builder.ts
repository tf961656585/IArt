import fs from 'node:fs/promises';
import path from 'node:path';
import type { ValidatedPackage } from './types';
import { OUTPUT_ROOT } from './paths';

const copyFileWithParents = async (fromPath: string, toPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(toPath), { recursive: true });
  await fs.copyFile(fromPath, toPath);
};

export const buildPackage = async (pkg: ValidatedPackage): Promise<void> => {
  const packageOutputDir = path.join(OUTPUT_ROOT, pkg.packageId);
  await fs.mkdir(packageOutputDir, { recursive: true });

  const manifestOutputPath = path.join(packageOutputDir, 'manifest.json');
  await fs.writeFile(manifestOutputPath, `${JSON.stringify(pkg.manifest, null, 2)}\n`, 'utf-8');

  const entryModelRelative = path.relative(pkg.sourceDir, pkg.entryModelPath);
  const nodeDefinitionRelative = path.relative(pkg.sourceDir, pkg.nodeDefinitionPath);

  await copyFileWithParents(pkg.entryModelPath, path.join(packageOutputDir, entryModelRelative));
  await copyFileWithParents(pkg.nodeDefinitionPath, path.join(packageOutputDir, nodeDefinitionRelative));

  for (const resourcePath of pkg.resourcePaths) {
    const relative = path.relative(pkg.sourceDir, resourcePath);
    await copyFileWithParents(resourcePath, path.join(packageOutputDir, relative));
  }

  for (const localePath of pkg.localePaths) {
    const relative = path.relative(pkg.sourceDir, localePath);
    await copyFileWithParents(localePath, path.join(packageOutputDir, relative));
  }

  await fs.mkdir(path.join(packageOutputDir, 'resources'), { recursive: true });
};

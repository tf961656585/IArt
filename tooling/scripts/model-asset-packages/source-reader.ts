import fs from 'node:fs/promises';
import path from 'node:path';
import type { SourceManifestSummary, SourceManifest } from './types';
import { SOURCE_ROOT } from './paths';
import { ensureFileExists, isRecord, normalizeString, readJson } from './shared';

export const listSourcePackageDirs = async (): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(SOURCE_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(SOURCE_ROOT, entry.name))
    .sort();
};

export const loadSourceManifestSummary = async (sourceDir: string): Promise<SourceManifestSummary> => {
  const packageIdByDir = path.basename(sourceDir);
  const manifestPath = path.join(sourceDir, 'manifest.json');
  await ensureFileExists(manifestPath, 'manifest_missing');

  const manifestRaw = await readJson(manifestPath);
  if (!isRecord(manifestRaw)) {
    throw new Error('manifest_invalid');
  }

  const manifest = manifestRaw as SourceManifest;
  const packageId = normalizeString(manifest.package_id);
  if (!packageId) {
    throw new Error('manifest.package_id_missing');
  }
  if (packageId !== packageIdByDir) {
    throw new Error('manifest.package_id_mismatch');
  }

  if (!isRecord(manifest.entry_model)) {
    throw new Error('manifest.entry_model_missing');
  }

  const modelId = normalizeString(manifest.entry_model['model_id']);
  if (!modelId) {
    throw new Error('manifest.entry_model_model_id_missing');
  }

  return {
    packageId,
    packageIdByDir,
    sourceDir,
    manifestPath,
    manifest,
    modelId,
  };
};

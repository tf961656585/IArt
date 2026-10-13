/**
 * Package Management Service — 包文件夹域逻辑（Main 进程唯一事实源）
 *
 * 语义（spec「右侧工作区与打包区服务」导出包节）：
 * - 执行一次打包 = 在 {projectPath}/packages/{folderName}/ 落一个包文件夹，
 *   拷贝打包区条目引用的媒体文件并写入自描述 manifest（package.json）
 * - 包文件夹是自描述事实源：list/rename/delete 全部以文件夹扫描/操作为准，
 *   不入 SQLite、不回写编辑域
 * - 本模块同时维护 packageId → folderPath 内存注册表，供 package-media:// 协议
 *   处理器把预览 URL 解析到磁盘文件（进程内单一注册点）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { shell } from 'electron';
import {
  PACKAGE_FOLDER_DIRNAME,
  PACKAGE_MANIFEST_FILENAME,
  PackageManifestSchema,
  type PackageManifest,
  type PackageSummary,
} from '@iart/contracts';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import { readMediaAssetById } from './editor-storage-read-model.cjs';

type DbHandle = SqliteDatabase;

/** packageId → 包文件夹绝对路径（package-media:// 协议解析注册表）。 */
const packageFolderRegistry = new Map<string, string>();

const registerPackageFolder = (packageId: string, folderPath: string): void => {
  packageFolderRegistry.set(packageId, folderPath);
};

const forgetPackageFolder = (packageId: string): void => {
  packageFolderRegistry.delete(packageId);
};

/** package-media:// 协议解析入口：packageId → 包文件夹绝对路径。 */
export const resolvePackageFolderById = (packageId: string): string | null => {
  const registered = packageFolderRegistry.get(packageId);
  if (registered !== undefined && fs.existsSync(registered)) return registered;
  return null;
};

const getPackagesRootDir = (projectPath: string): string =>
  path.join(path.resolve(projectPath), PACKAGE_FOLDER_DIRNAME);

const sanitizeFolderName = (name: string): string => {
  // 文件夹名安全化：去路径非法字符与控制字符、首尾空白；中文保留。空结果回退固定前缀。
  const sanitized = Array.from(name)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return '-';
      return '\\/:*?"<>|'.includes(char) ? '-' : char;
    })
    .join('')
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, 60) : '未命名包';
};

const isPackageFolder = (dirPath: string): boolean => {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
};

const readPackageManifest = (folderPath: string): PackageManifest | null => {
  const manifestPath = path.join(folderPath, PACKAGE_MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return PackageManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.warn('[package-management] manifest parse failed', {
      folderPath: path.basename(folderPath),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const writePackageManifest = (folderPath: string, manifest: PackageManifest): void => {
  const manifestPath = path.join(folderPath, PACKAGE_MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
};

/** 构建包摘要（预览 URL 走 package-media://{packageId}/{fileName}，由协议处理器解析）。 */
const buildPackageSummary = (folderPath: string, manifest: PackageManifest): PackageSummary => ({
  packageId: manifest.packageId,
  name: manifest.name,
  folderName: path.basename(folderPath),
  path: folderPath,
  createdAt: manifest.createdAt,
  entryCount: manifest.entries.length,
  entries: manifest.entries.map((entry) => ({
    fileName: entry.fileName,
    mediaType: entry.mediaType,
    url: `package-media://${encodeURIComponent(manifest.packageId)}/${encodeURIComponent(entry.fileName)}`,
  })),
});

const listPackages = (projectPath: string): PackageSummary[] => {
  const rootDir = getPackagesRootDir(projectPath);
  let dirNames: string[];
  try {
    dirNames = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
  } catch {
    // 无 packages 目录 = 无包（合法空态，不告警）。
    return [];
  }
  const summaries: PackageSummary[] = [];
  for (const dirName of dirNames) {
    const folderPath = path.join(rootDir, dirName);
    const manifest = readPackageManifest(folderPath);
    if (manifest === null) {
      console.debug('[package-management] list: folder without valid manifest, skip', { dirName });
      continue;
    }
    registerPackageFolder(manifest.packageId, folderPath);
    summaries.push(buildPackageSummary(folderPath, manifest));
  }
  summaries.sort((left, right) => right.createdAt - left.createdAt);
  return summaries;
};

const findPackageFolder = (projectPath: string, packageId: string): string | null => {
  for (const summary of listPackages(projectPath)) {
    if (summary.packageId === packageId) {
      return summary.path;
    }
  }
  return null;
};

/** 在 packages/ 下为给定名生成不冲突的文件夹名（同名追加序号）。 */
const allocateFolderName = (rootDir: string, name: string): string => {
  const base = sanitizeFolderName(name);
  if (!fs.existsSync(path.join(rootDir, base))) return base;
  let index = 2;
  while (fs.existsSync(path.join(rootDir, `${base}-${index}`))) {
    index += 1;
  }
  return `${base}-${index}`;
};

type CreatePackageOutcome = {
  package: PackageSummary | null;
  skippedAssetIds: string[];
};

const createPackage = (
  db: DbHandle,
  params: { projectPath: string; name: string; assetIds: string[] },
): CreatePackageOutcome => {
  const { projectPath, name, assetIds } = params;
  const mediaDir = path.join(path.resolve(projectPath), 'media');
  const rootDir = getPackagesRootDir(projectPath);

  // 解析每个 assetId 的媒体文件与类型；失效资产跳过并回告。
  const entries: PackageManifest['entries'] = [];
  const skippedAssetIds: string[] = [];
  for (const assetId of assetIds) {
    const asset = readMediaAssetById(db, assetId);
    const sourceUrl = asset?.original?.url ?? '';
    if (asset === null || !sourceUrl) {
      skippedAssetIds.push(assetId);
      console.debug('[package-management] create: media asset not found, skip', { assetId });
      continue;
    }
    // local-media:// URL 的 fileKey 即 media/ 内文件名（单一事实源解析见 @iart/utils/media-file-key）。
    const fileKey = sourceUrl.startsWith('local-media://')
      ? (() => {
          const raw = sourceUrl.slice('local-media://'.length);
          const slashIndex = raw.indexOf('/');
          return decodeURIComponent(slashIndex >= 0 ? raw.slice(slashIndex + 1) : raw);
        })()
      : null;
    if (fileKey === null || fileKey.length === 0 || fileKey.includes('..') || path.isAbsolute(fileKey)) {
      skippedAssetIds.push(assetId);
      console.debug('[package-management] create: unresolvable media url, skip', { assetId });
      continue;
    }
    const sourcePath = path.join(mediaDir, fileKey);
    if (!fs.existsSync(sourcePath)) {
      skippedAssetIds.push(assetId);
      console.debug('[package-management] create: media file missing on disk, skip', { assetId, fileKey });
      continue;
    }
    // 包内文件名 {order:03d}_{fileKey}：顺序可见、唯一、保留扩展名（连续编号即包内顺序）。
    const fileName = `${String(entries.length + 1).padStart(3, '0')}_${fileKey}`;
    entries.push({ assetId, mediaType: asset.mediaType, sourceFileKey: fileKey, fileName });
  }

  if (entries.length === 0) {
    // 全部失效：不落空包文件夹。
    return { package: null, skippedAssetIds };
  }

  fs.mkdirSync(rootDir, { recursive: true });
  const folderName = allocateFolderName(rootDir, name);
  const folderPath = path.join(rootDir, folderName);
  fs.mkdirSync(folderPath, { recursive: true });

  const manifest: PackageManifest = {
    packageId: `pkg_${randomUUID()}`,
    name: name.trim(),
    createdAt: Date.now(),
    entries,
  };
  for (const entry of entries) {
    fs.copyFileSync(path.join(mediaDir, entry.sourceFileKey), path.join(folderPath, entry.fileName));
  }
  writePackageManifest(folderPath, manifest);
  registerPackageFolder(manifest.packageId, folderPath);

  return { package: buildPackageSummary(folderPath, manifest), skippedAssetIds };
};

const renamePackage = (params: {
  projectPath: string;
  packageId: string;
  name: string;
}): PackageSummary => {
  const { projectPath, packageId, name } = params;
  const folderPath = findPackageFolder(projectPath, packageId);
  if (folderPath === null) {
    throw new Error(`PACKAGE_NOT_FOUND: ${packageId}`);
  }
  const manifest = readPackageManifest(folderPath);
  if (manifest === null) {
    throw new Error(`PACKAGE_MANIFEST_INVALID: ${packageId}`);
  }

  const trimmed = name.trim();
  const nextManifest: PackageManifest = { ...manifest, name: trimmed };
  writePackageManifest(folderPath, nextManifest);

  // 文件夹名跟随新名（Finder 里所见即所得）；重命名失败不阻断改名（manifest 已是新名）。
  const rootDir = getPackagesRootDir(projectPath);
  const targetName = allocateFolderName(rootDir, trimmed);
  const targetPath = path.join(rootDir, targetName);
  if (targetPath !== folderPath) {
    try {
      fs.renameSync(folderPath, targetPath);
      forgetPackageFolder(packageId);
      registerPackageFolder(packageId, targetPath);
      return buildPackageSummary(targetPath, nextManifest);
    } catch (error) {
      console.warn('[package-management] rename: folder rename failed, keep old folder name', {
        packageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return buildPackageSummary(folderPath, nextManifest);
};

const deletePackage = async (params: {
  projectPath: string;
  packageId: string;
}): Promise<{ ok: boolean }> => {
  const { projectPath, packageId } = params;
  const folderPath = findPackageFolder(projectPath, packageId);
  if (folderPath === null) {
    console.debug('[package-management] delete: package not found, no-op', { packageId });
    return { ok: false };
  }
  // 移入系统回收站而非直接递归删除：误删可恢复。trashItem 失败（文件被占用等）回告 false。
  forgetPackageFolder(packageId);
  try {
    await shell.trashItem(folderPath);
    return { ok: true };
  } catch (error) {
    console.warn('[package-management] delete: trashItem failed', {
      packageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
};

const revealPackage = (params: { projectPath: string; packageId: string }): { ok: boolean } => {
  const { projectPath, packageId } = params;
  const folderPath = findPackageFolder(projectPath, packageId);
  if (folderPath === null) {
    console.debug('[package-management] reveal: package not found, no-op', { packageId });
    return { ok: false };
  }
  shell.showItemInFolder(folderPath);
  return { ok: true };
};

export {
  getPackagesRootDir,
  isPackageFolder,
  listPackages,
  createPackage,
  renamePackage,
  deletePackage,
  revealPackage,
};

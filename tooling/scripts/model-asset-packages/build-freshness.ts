import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT } from './paths';

// 模型包构建指纹：判定「包源 + 构建器 + 依赖面」是否与上次成功构建一致。
// 指纹一致时可复用现有包目录（逐字节等价于重建产物），跳过重复打包；
// 这是内容哈希级的 up-to-date 判定，mtime 变化不构成失效条件。
const FINGERPRINT_SALT = 'iart-model-package-build-v1';

// 构建器依赖面：builder 代码本身、其 import 的 workspace dist（契约语义变化必须重建全部包）、lockfile。
const BUILDER_SOURCE_DIR = path.join(WORKSPACE_ROOT, 'tooling', 'scripts', 'model-asset-packages');
const CONTRACTS_DIST = path.join(WORKSPACE_ROOT, 'packages', 'contracts', 'dist');
const MODEL_ASSET_RUNTIME_DIST = path.join(WORKSPACE_ROOT, 'packages', 'model-asset-runtime', 'dist');
const LOCKFILE = path.join(WORKSPACE_ROOT, 'pnpm-lock.yaml');

export const MODEL_PACKAGE_STATE_DIR = path.join(
  WORKSPACE_ROOT,
  'node_modules',
  '.cache',
  'iart-build-state',
);

const hashFile = async (absolutePath: string): Promise<string> => {
  const content = await fs.readFile(absolutePath);
  return crypto.createHash('sha256').update(content).digest('hex');
};

const collectEntries = async (rootDir: string, entries: Array<[string, string]>, prefix = ''): Promise<void> => {
  if (!existsSync(rootDir)) return;
  for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await collectEntries(absolutePath, entries, relativePath);
    } else if (entry.isFile()) {
      entries.push([relativePath, await hashFile(absolutePath)]);
    }
  }
};

const collectFileEntries = async (files: string[], entries: Array<[string, string]>): Promise<void> => {
  for (const file of files) {
    if (!existsSync(file)) continue;
    const relativePath = path.relative(WORKSPACE_ROOT, file).split(path.sep).join('/');
    entries.push([relativePath, await hashFile(file)]);
  }
};

const computeEntriesHash = (entries: Array<[string, string]>): string => {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = sorted.map(([filePath, hash]) => `${filePath}:${hash}`).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

export const computeModelPackageFingerprint = async (sourceDir: string): Promise<string> => {
  const entries: Array<[string, string]> = [[FINGERPRINT_SALT, '']];
  await collectEntries(sourceDir, entries);
  await collectEntries(BUILDER_SOURCE_DIR, entries);
  await collectEntries(CONTRACTS_DIST, entries);
  await collectEntries(MODEL_ASSET_RUNTIME_DIST, entries);
  await collectFileEntries([LOCKFILE], entries);
  return computeEntriesHash(entries);
};

const statePathFor = (packageId: string): string =>
  path.join(MODEL_PACKAGE_STATE_DIR, `model-pkg-${packageId.replace(/[^a-zA-Z0-9._-]+/g, '-')}.json`);

export const isModelPackageUpToDate = async (packageId: string, fingerprint: string): Promise<boolean> => {
  try {
    const state = JSON.parse(await fs.readFile(statePathFor(packageId), 'utf-8')) as { fingerprint?: string };
    return state.fingerprint === fingerprint;
  } catch {
    return false;
  }
};

export const recordModelPackageState = async (packageId: string, fingerprint: string): Promise<void> => {
  await fs.mkdir(MODEL_PACKAGE_STATE_DIR, { recursive: true });
  await fs.writeFile(statePathFor(packageId), `${JSON.stringify({ fingerprint }, null, 2)}\n`, 'utf-8');
};

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const STATE_DIR = path.join(REPO_ROOT, 'node_modules', '.cache', 'iart-build-state');
const SALT = 'iart-up-to-date-runner-v1';

const log = (message) => console.log(`[up-to-date] ${message}`);

const hashFile = (absolutePath) => {
  const content = fs.readFileSync(absolutePath);
  return crypto.createHash('sha256').update(content).digest('hex');
};

const isWorkspacePackageDir = (dir) => {
  const packageJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof pkg.name === 'string' && pkg.name.startsWith('@iart/');
  } catch {
    return false;
  }
};

// 递归收集目录下所有文件（相对路径 + 内容哈希），排序后参与总哈希，
// 保证文件增删与内容变化都会改变输入指纹。只跳过 node_modules（外部依赖，
// 新鲜度由 pnpm-lock.yaml 哈希代表）；显式传入的构建产物根（如 packages/*/dist）按需哈希。
const collectFileEntries = (rootDir, entries, prefix = '') => {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const name = entry.name;
    if (name === 'node_modules' || name === '.DS_Store') continue;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const absolutePath = path.join(rootDir, name);
    if (entry.isDirectory()) {
      collectFileEntries(absolutePath, entries, relativePath);
    } else if (entry.isFile()) {
      entries.push([relativePath, hashFile(absolutePath)]);
    }
  }
};

const collectSingleFile = (absolutePath, entries) => {
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return;
  const relativePath = path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
  entries.push([relativePath, hashFile(absolutePath)]);
};

// workspace 依赖的声明产物（dist 内 .d.ts/.d.cts）与 package.json 是 tsc 构建的输入：
// 依赖源码变化会先落到其 dist d.ts，再驱动依赖方重建。
const collectWorkspaceDepEntries = (packageDir, entries) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const depNames = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const packageNodeModules = path.join(packageDir, 'node_modules');
  if (!fs.existsSync(packageNodeModules)) return;
  for (const depName of depNames) {
    const depLink = path.join(packageNodeModules, ...depName.split('/'));
    let depRoot;
    try {
      depRoot = fs.realpathSync(depLink);
    } catch {
      continue;
    }
    if (!isWorkspacePackageDir(depRoot) || depRoot === packageDir) continue;
    collectSingleFile(path.join(depRoot, 'package.json'), entries);
    const depDist = path.join(depRoot, 'dist');
    if (!fs.existsSync(depDist)) continue;
    for (const entry of fs.readdirSync(depDist, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(d\.ts|d\.cts)$/.test(entry.name)) continue;
      collectSingleFile(path.join(depDist, entry.name), entries);
    }
  }
};

// 包模式输入：自身 src、tsconfig、package.json、共享 tsconfig 基座、lockfile、workspace 依赖 d.ts。
const collectPackageInputs = (packageDir, entries) => {
  collectFileEntries(path.join(packageDir, 'src'), entries);
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.isFile() && /^tsconfig.*\.json$/.test(entry.name)) {
      collectSingleFile(path.join(packageDir, entry.name), entries);
    }
  }
  collectSingleFile(path.join(packageDir, 'package.json'), entries);
  collectFileEntries(path.join(REPO_ROOT, 'packages', 'config'), entries);
  collectSingleFile(path.join(REPO_ROOT, 'pnpm-lock.yaml'), entries);
  collectWorkspaceDepEntries(packageDir, entries);
};

// 显式模式输入：调用方给定的根目录/文件（相对仓库根）。
const collectExplicitInputs = (roots, entries) => {
  for (const root of roots) {
    const absoluteRoot = path.isAbsolute(root) ? root : path.join(REPO_ROOT, root);
    if (fs.existsSync(absoluteRoot) && fs.statSync(absoluteRoot).isDirectory()) {
      collectFileEntries(absoluteRoot, entries);
    } else {
      collectSingleFile(absoluteRoot, entries);
    }
  }
};

export const computeInputsHash = ({ packageDir, explicitRoots = [] } = {}) => {
  const entries = [[SALT, '']];
  if (packageDir) {
    collectPackageInputs(packageDir, entries);
  }
  if (explicitRoots.length > 0) {
    collectExplicitInputs(explicitRoots, entries);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = entries.map(([filePath, hash]) => `${filePath}:${hash}`).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const statePathFor = (key) => {
  const safeKey = key.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(STATE_DIR, `${safeKey}.json`);
};

export const readUpToDateState = (key) => {
  try {
    return JSON.parse(fs.readFileSync(statePathFor(key), 'utf8'));
  } catch {
    return null;
  }
};

export const writeUpToDateState = (key, inputsHash, command) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePathFor(key), `${JSON.stringify({ inputsHash, command }, null, 2)}\n`, 'utf8');
};

// 哈希一致即视为产物为本轮最新（构建输入未变，重编译产物逐字节相同）；
// 不一致时由调用方执行清理重建，成功后记录新指纹。
export const isUpToDate = (key, inputsHash) => readUpToDateState(key)?.inputsHash === inputsHash;

const parseCliArgs = (argv) => {
  const args = { key: null, workspaceDeps: false, explicitRoots: [], commandParts: [] };
  let index = 0;
  let commandMode = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (commandMode) {
      args.commandParts.push(arg);
      index += 1;
      continue;
    }
    if (arg === '--') {
      commandMode = true;
      index += 1;
      continue;
    }
    if (arg === '--workspace-deps') {
      args.workspaceDeps = true;
      index += 1;
      continue;
    }
    if (arg === '--inputs') {
      const value = argv[index + 1];
      if (!value) throw new Error('up-to-date-runner: --inputs 需要一个路径参数');
      args.explicitRoots.push(value);
      index += 2;
      continue;
    }
    if (args.key === null && !arg.startsWith('-')) {
      args.key = arg;
      index += 1;
      continue;
    }
    throw new Error(`up-to-date-runner: 无法识别的参数 ${arg}`);
  }
  if (!args.key) throw new Error('up-to-date-runner: 缺少 cache key');
  if (args.commandParts.length === 0) throw new Error('up-to-date-runner: 缺少 -- 之后的构建命令');
  return args;
};

const runCli = () => {
  const args = parseCliArgs(process.argv.slice(2));
  const command = args.commandParts.join(' ');
  const packageDir = args.workspaceDeps ? process.cwd() : null;
  const inputsHash = computeInputsHash({ packageDir, explicitRoots: args.explicitRoots });

  // 发布链路（desktop-release-local）注入 IART_FORCE_FRESH_BUILD=1：跳过复用判定，强制清理重建
  const forceFreshBuild = process.env.IART_FORCE_FRESH_BUILD === '1';
  if (!forceFreshBuild && isUpToDate(args.key, inputsHash) && readUpToDateState(args.key).command === command) {
    log(`${args.key}: 构建输入未变化，跳过重建（产物为本轮最新）`);
    return;
  }

  log(`${args.key}: 执行构建 ${command}`);
  const result = spawnSync(command, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });
  if (result.error || result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }
  // state 里记录命令文本：命令本身变化（如 tsconfig 参数调整）必须触发重建
  writeUpToDateState(args.key, inputsHash, command);
};

const isDirectExecution = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  runCli();
}


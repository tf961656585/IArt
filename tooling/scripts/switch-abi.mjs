#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shouldUseShellOnWindows } from '../lib/pnpm-runner.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const preparedRoot = path.join(repoRoot, 'apps', 'backend', 'native-modules', 'better-sqlite3');

const usage = `Usage:
  node scripts/switch-abi.mjs [node|electron] [--verify] [--arch <arch>]
  node scripts/switch-abi.mjs --runtime node --verify
  node scripts/switch-abi.mjs --all --verify --arch x64

Examples:
  pnpm abi:node
  pnpm abi:electron -- --verify
  pnpm sqlite:prepare -- --verify
  pnpm sqlite:prepare -- --all --verify --arch x64
`;

const baseEnv = { ...process.env };
if (!baseEnv.CXXFLAGS || !baseEnv.CXXFLAGS.includes('-std=gnu++20')) {
  baseEnv.CXXFLAGS = [baseEnv.CXXFLAGS, '-std=gnu++20'].filter(Boolean).join(' ');
}

const parseCliArgs = (argv = []) => {
  const verify = argv.includes('--verify');
  const help = argv.includes('--help') || argv.includes('-h');
  const forceAll = argv.includes('--all');

  const runtimeFlagIndex = argv.findIndex((arg) => arg === '--runtime' || arg.startsWith('--runtime='));
  let runtime = '';
  if (runtimeFlagIndex >= 0) {
    const arg = argv[runtimeFlagIndex];
    if (arg.startsWith('--runtime=')) {
      runtime = arg.slice('--runtime='.length).trim();
    } else {
      runtime = String(argv[runtimeFlagIndex + 1] || '').trim();
    }
  }
  if (!runtime) {
    runtime = argv.find((arg) => !arg.startsWith('-')) || '';
  }

  const archFlagIndex = argv.findIndex((arg) => arg === '--arch');
  const targetArch = archFlagIndex >= 0 ? String(argv[archFlagIndex + 1] || '').trim().toLowerCase() : '';

  const normalizedRuntime = runtime.trim().toLowerCase();
  const runtimes = forceAll || !normalizedRuntime ? ['node', 'electron'] : [normalizedRuntime];
  return { runtimes, verify, help, targetArch };
};

const run = (command, cmdArgs, env, label, options = {}) => {
  const useShell = typeof options.shell === 'boolean' ? options.shell : shouldUseShellOnWindows(command);
  const result = spawnSync(command, cmdArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: useShell,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const hint =
      label && label.includes('better-sqlite3')
        ? '\nHint: if you see "Ignored build scripts", run `pnpm approve-builds` and retry.'
        : '';
    console.error(`\n[abi] ${label || command} failed (exit=${result.status ?? 'null'}).${hint}`);
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
};

const resolveElectronVersion = () => {
  const electronPkg = path.join(repoRoot, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(electronPkg)) {
    console.error('[abi] Missing node_modules/electron. Run `pnpm install` first.');
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(electronPkg, 'utf-8'));
    return typeof parsed?.version === 'string' ? parsed.version : '';
  } catch {
    return '';
  }
};

const resolveElectronBinary = () => {
  const electronDir = path.join(repoRoot, 'node_modules', 'electron');
  const pathFile = path.join(electronDir, 'path.txt');
  try {
    const executableRel = fs.readFileSync(pathFile, 'utf-8').trim();
    if (executableRel) {
      const executablePath = path.join(electronDir, 'dist', executableRel);
      if (fs.existsSync(executablePath)) {
        return executablePath;
      }
    }
  } catch {
    // ignore
  }

  const binName = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  return path.join(repoRoot, 'node_modules', '.bin', binName);
};

const resolveBetterSqlite3PackageDir = () =>
  path.dirname(require.resolve('better-sqlite3/package.json', { paths: [repoRoot] }));

const getPreparedRuntimeDir = (runtime) => path.join(preparedRoot, runtime);

const readPackageJson = (packageDir) => JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'));

const collectPackageProductionDependencies = (packageDir) => {
  const pkg = readPackageJson(packageDir);
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ].sort();
};

const getNodeModulesPackageDir = (nodeModulesDir, packageName) => {
  const parts = packageName.split('/');
  return path.join(nodeModulesDir, ...parts);
};

const resolvePackageDir = (packageName, searchPaths = [repoRoot]) =>
  path.dirname(require.resolve(`${packageName}/package.json`, { paths: searchPaths }));

const copyPackageIntoNodeModules = ({ packageName, targetNodeModulesDir, seen, resolveFromPaths = [repoRoot] }) => {
  if (seen.has(packageName)) return;
  seen.add(packageName);

  const packageDir = resolvePackageDir(packageName, resolveFromPaths);
  const targetDir = getNodeModulesPackageDir(targetNodeModulesDir, packageName);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(packageDir, targetDir, { recursive: true, dereference: true });

  for (const dependencyName of collectPackageProductionDependencies(packageDir)) {
    copyPackageIntoNodeModules({
      packageName: dependencyName,
      targetNodeModulesDir,
      seen,
      resolveFromPaths: [packageDir, repoRoot],
    });
  }
};

const copyRuntimeDependencyClosure = ({ rootPackageDir, targetDir }) => {
  const targetNodeModulesDir = path.join(targetDir, 'node_modules');
  const seen = new Set();
  fs.rmSync(targetNodeModulesDir, { recursive: true, force: true });
  fs.mkdirSync(targetNodeModulesDir, { recursive: true });

  for (const packageName of collectPackageProductionDependencies(rootPackageDir)) {
    copyPackageIntoNodeModules({
      packageName,
      targetNodeModulesDir,
      seen,
      resolveFromPaths: [rootPackageDir, repoRoot],
    });
  }

  return [...seen].sort();
};

const copyPreparedRuntime = (runtime) => {
  const sourceDir = resolveBetterSqlite3PackageDir();
  const targetDir = getPreparedRuntimeDir(runtime);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
  const includedRuntimeDependencies = copyRuntimeDependencyClosure({ rootPackageDir: sourceDir, targetDir });
  fs.writeFileSync(
    path.join(targetDir, '.iart-runtime.json'),
    JSON.stringify(
      {
        runtime,
        copiedFrom: sourceDir,
        preparedAt: new Date().toISOString(),
        includedRuntimeDependencies,
      },
      null,
      2
    )
  );
  console.log(`[abi] prepared isolated better-sqlite3 runtime: ${targetDir}`);
  return targetDir;
};

const verifyPreparedNodeRuntime = (runtimeDir) => {
  run(
    process.execPath,
    [
      '-e',
      `const Database=require(${JSON.stringify(runtimeDir)}); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 ok (node isolated)');`,
    ],
    baseEnv,
    'verify node isolated runtime'
  );
};

const verifyPreparedElectronRuntime = (runtimeDir) => {
  const electronBin = resolveElectronBinary();
  if (!fs.existsSync(electronBin)) {
    console.error('[abi] Missing electron binary. Run `pnpm ensure:electron` first.');
    process.exit(1);
  }
  const env = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' };
  run(
    electronBin,
    [
      '-e',
      `const Database=require(${JSON.stringify(runtimeDir)}); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 ok (electron isolated)');`,
    ],
    env,
    'verify electron isolated runtime',
    { shell: false }
  );
};

const prepareNodeRuntime = (targetArch) => {
  const crossCompiling = targetArch && targetArch !== process.arch;
  if (crossCompiling) {
    console.log(`[abi] cross-compiling better-sqlite3 for node (${process.arch} -> ${targetArch}) via npm_config_arch`);
  } else {
    console.log('[abi] rebuilding better-sqlite3 for node...');
  }
  const env = crossCompiling
    ? { ...baseEnv, npm_config_arch: targetArch }
    : baseEnv;
  run('pnpm', ['rebuild', 'better-sqlite3'], env, 'rebuild better-sqlite3 (node)');
  return copyPreparedRuntime('node');
};

const prepareElectronRuntime = (targetArch) => {
  const electronVersion = resolveElectronVersion();
  if (!electronVersion) {
    console.error('[abi] Unable to detect electron version.');
    process.exit(1);
  }

  const crossCompiling = targetArch && targetArch !== process.arch;
  if (crossCompiling) {
    console.log(`[abi] cross-compiling better-sqlite3 for electron ${electronVersion} (${process.arch} -> ${targetArch}) via npm_config_arch`);
  } else {
    console.log(`[abi] rebuilding better-sqlite3 for electron ${electronVersion}...`);
  }
  const env = {
    ...baseEnv,
    npm_config_runtime: 'electron',
    npm_config_target: electronVersion,
    npm_config_disturl: 'https://electronjs.org/headers',
    npm_config_build_from_source: 'true',
    ...(crossCompiling ? { npm_config_arch: targetArch } : {}),
  };
  run('pnpm', ['rebuild', 'better-sqlite3'], env, 'rebuild better-sqlite3 (electron)');
  return copyPreparedRuntime('electron');
};

const prepareRuntime = (runtime, targetArch) => {
  if (runtime === 'node') return prepareNodeRuntime(targetArch);
  if (runtime === 'electron') return prepareElectronRuntime(targetArch);
  console.error(`[abi] Unsupported runtime: ${runtime}`);
  process.exit(1);
};

const verifyRuntime = (runtime, runtimeDir) => {
  if (runtime === 'node') {
    verifyPreparedNodeRuntime(runtimeDir);
    return;
  }
  verifyPreparedElectronRuntime(runtimeDir);
};

export const runSwitchAbi = (argv = process.argv.slice(2)) => {
  const { runtimes, verify, help, targetArch } = parseCliArgs(argv);

  if (help) {
    console.log(usage);
    return 0;
  }

  if (targetArch && targetArch !== 'x64' && targetArch !== 'arm64') {
    console.error(`[abi] Unsupported arch: ${targetArch}. Must be x64 or arm64.`);
    return 1;
  }

  const invalidRuntime = runtimes.find((runtime) => runtime !== 'node' && runtime !== 'electron');
  if (invalidRuntime) {
    console.log(usage);
    return 1;
  }

  for (const runtime of runtimes) {
    const runtimeDir = prepareRuntime(runtime, targetArch);
    if (verify) {
      verifyRuntime(runtime, runtimeDir);
    }
  }

  return 0;
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
  const code = runSwitchAbi(process.argv.slice(2));
  if (code !== 0) {
    process.exit(code);
  }
}

export const __test_only__ = {
  shouldUseShellOnWindows,
  parseCliArgs,
  collectPackageProductionDependencies,
  copyRuntimeDependencyClosure,
  getNodeModulesPackageDir,
};

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolvePnpmCommand, shouldUseShellOnWindows } from '../lib/pnpm-runner.mjs';
import {
  activateFfmpeg,
  activateBetterSqlite3,
  fileMachoArch,
  probeFfmpegExecution,
} from './desktop-deps-cache.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const preparedElectronRuntimeDir = path.join(rootDir, 'apps', 'backend', 'native-modules', 'better-sqlite3', 'electron');

const log = (message) => console.log(`[ensure-desktop-deps] ${message}`);
const warn = (message) => console.warn(`[ensure-desktop-deps] ${message}`);
const error = (message) => console.error(`[ensure-desktop-deps] ${message}`);

const run = (command, args, label, options = {}) => {
  const useShell = typeof options.shell === 'boolean' ? options.shell : shouldUseShellOnWindows(command);
  log(`运行: ${label}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: rootDir,
    shell: useShell,
    env: options.env,
  });
  if (result.error) {
    error(`${label} 失败: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    error(`${label} 失败，退出码 ${result.status}`);
    return false;
  }
  return true;
};

const resolveFfmpegPath = () => {
  try {
    const resolved = require('ffmpeg-static');
    return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : null;
  } catch {
    return null;
  }
};

// ffmpeg-static 是单文件二进制（不同架构互斥覆盖，不像 sharp 的平台子包可共存）。
// 交叉打包时需确保 node_modules/ffmpeg-static/ffmpeg 的 Mach-O 架构与目标一致。
const normalizeArch = (machoArchs) => {
  if (!machoArchs) return '';
  if (machoArchs.includes('arm64')) return 'arm64';
  if (machoArchs.includes('x86_64')) return 'x64';
  return '';
};

// ffmpeg 完整二进制大小下限。官方 ffmpeg-static b6.1.1 产物：darwin-arm64 约 45MB、
// darwin-x64 约 78MB、win32-x64 约 138MB。残缺/损坏样本观测到 1.5MB。
// 5MB 下限对正常产物留足余量，且能可靠拦截残缺文件。交叉编译无法在本机执行目标
// 架构二进制，只能用大小作为完整性兜底；非交叉则用真实执行测试。
const FFMPEG_MIN_BYTES = 5_000_000;

// ffmpeg 就绪判定：解析 node_modules/ffmpeg-static 当前二进制，架构/可执行性满足
// 目标即就绪；否则由依赖缓存层 activateFfmpeg（内部 provision，下载一生只发生一次）
// 供给。不再调用 ffmpeg-static/install.js（30 秒硬超时不可控，已否决复用）。
export const ensureFfmpegStatic = (options = {}) => {
  const targetArch = options.targetArch || '';
  const crossCompiling = targetArch && targetArch !== process.arch;
  const desiredArch = crossCompiling ? targetArch : process.arch;

  const deps = options.deps || {};
  const resolvePath = deps.resolveFfmpegPath || resolveFfmpegPath;
  const machoArch = deps.fileMachoArch || fileMachoArch;
  const execProbe = deps.probeFfmpegExecution || probeFfmpegExecution;
  const activate = deps.activateFfmpeg || activateFfmpeg;
  const fsx = deps.fs || fs;

  const pkgJsonPath = path.join(rootDir, 'node_modules', 'ffmpeg-static', 'package.json');
  if (!fsx.existsSync(pkgJsonPath)) {
    error(`找不到 ffmpeg-static 包: ${pkgJsonPath}`);
    error('请先执行 pnpm install，然后重试。');
    return false;
  }

  const checkReady = () => {
    const ffmpegPath = resolvePath();
    if (!ffmpegPath || !fsx.existsSync(ffmpegPath)) {
      return { ready: false, reason: 'ffmpeg 二进制缺失' };
    }
    let size = 0;
    try {
      size = fsx.statSync(ffmpegPath).size;
    } catch {
      size = 0;
    }
    if (size < FFMPEG_MIN_BYTES) {
      return { ready: false, reason: `文件过小（${size} bytes < ${FFMPEG_MIN_BYTES}，疑似残缺）` };
    }
    if (process.platform === 'darwin') {
      const currentArch = normalizeArch(machoArch(ffmpegPath));
      if (currentArch !== desiredArch) {
        return { ready: false, reason: `架构不匹配（当前 ${currentArch || 'unknown'}，需要 ${desiredArch}）` };
      }
    }
    // 交叉编译无法执行目标架构二进制，大小+架构（darwin）即兜底；原生用真实执行测试。
    if (!crossCompiling) {
      const probe = execProbe(ffmpegPath);
      if (!probe.ok) {
        return { ready: false, reason: `执行失败（${probe.message}），疑似残缺或丢失执行位` };
      }
    }
    return { ready: true, path: ffmpegPath, size };
  };

  const first = checkReady();
  if (first.ready) {
    log(`ffmpeg-static 已就绪（${desiredArch}, ${first.size} bytes）: ${first.path}`);
    return true;
  }

  warn(`ffmpeg-static ${first.reason}，从依赖缓存层获取（${process.platform}-${desiredArch}）。`);
  const activatedPath = activate({ platform: process.platform, arch: desiredArch });
  if (!activatedPath) {
    error('ffmpeg-static 经依赖缓存层获取失败。');
    error('请检查网络/代理后重试（缓存命中时本步骤为零网络本地拷贝）。');
    return false;
  }

  const second = checkReady();
  if (second.ready) {
    log(`ffmpeg-static 已就绪（${desiredArch}, ${second.size} bytes）: ${second.path}`);
    return true;
  }
  error(`ffmpeg-static 激活后仍未就绪（${second.reason}）。`);
  return false;
};

const ensureElectronBinary = () => {
  const scriptPath = path.join(rootDir, 'tooling', 'dev', 'ensure-electron.mjs');
  if (!fs.existsSync(scriptPath)) {
    error(`找不到 Electron 校验脚本: ${scriptPath}`);
    return false;
  }
  return run(process.execPath, [scriptPath], 'node ./tooling/dev/ensure-electron.mjs');
};

const resolveElectronLaunchCommand = () => {
  const electronDir = path.join(rootDir, 'node_modules', 'electron');
  const pathFile = path.join(electronDir, 'path.txt');
  let executableRel = '';
  try {
    executableRel = fs.readFileSync(pathFile, 'utf-8').trim();
  } catch {
    executableRel = '';
  }
  if (executableRel) {
    const executablePath = path.join(electronDir, 'dist', executableRel);
    if (fs.existsSync(executablePath)) {
      return { command: executablePath, useShell: false };
    }
  }

  const binName = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  const binPath = path.join(rootDir, 'node_modules', '.bin', binName);
  if (fs.existsSync(binPath)) {
    return { command: binPath, useShell: process.platform === 'win32' };
  }
  return null;
};

const canLoadBetterSqlite3InNode = () => {
  const preparedNodeRuntimeDir = path.join(rootDir, 'apps', 'backend', 'native-modules', 'better-sqlite3', 'node');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const Database=require(${JSON.stringify(preparedNodeRuntimeDir)}); new Database(':memory:').close(); console.log('better-sqlite3 ok (node isolated)');`,
    ],
    {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

  if (result.status === 0) {
    return true;
  }

  if (result.error) {
    warn(`better-sqlite3 Node 隔离运行时校验失败: ${result.error.message}`);
    return false;
  }
  const detail = (result.stderr || result.stdout || '').trim();
  warn(`better-sqlite3 Node 隔离运行时校验失败: ${detail || `exit=${result.status ?? 'null'}`}`);
  return false;
};

const canLoadBetterSqlite3InElectron = () => {
  const electronLaunch = resolveElectronLaunchCommand();
  if (!electronLaunch?.command) {
    warn('未找到 Electron 可执行文件，无法校验 better-sqlite3 的 Electron 隔离运行时。');
    return false;
  }

  const result = spawnSync(
    electronLaunch.command,
    [
      '-e',
      `const Database=require(${JSON.stringify(preparedElectronRuntimeDir)}); new Database(':memory:'); console.log('better-sqlite3 ok (electron isolated)');`,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: electronLaunch.useShell,
    },
  );

  if (result.status === 0) {
    return true;
  }

  if (result.error) {
    warn(`better-sqlite3 Electron 隔离运行时校验失败: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    warn(`better-sqlite3 Electron 隔离运行时校验失败: ${detail || `exit=${result.status}`}`);
    return false;
  }
  return true;
};

const NATIVE_MODULE_RELATIVE = path.join('build', 'Release', 'better_sqlite3.node');

const checkNativeModuleArch = (targetArch) => {
  if (process.platform !== 'darwin') return true;
  if (!targetArch || targetArch === process.arch) return true;

  const nodeModulePath = path.join(rootDir, 'apps', 'backend', 'native-modules', 'better-sqlite3', 'node', NATIVE_MODULE_RELATIVE);
  const electronModulePath = path.join(rootDir, 'apps', 'backend', 'native-modules', 'better-sqlite3', 'electron', NATIVE_MODULE_RELATIVE);

  const expectedArch = targetArch === 'x64' ? 'x86_64' : 'arm64';

  for (const modulePath of [nodeModulePath, electronModulePath]) {
    if (!fs.existsSync(modulePath)) continue;
    const archs = fileMachoArch(modulePath);
    if (archs && !archs.includes(expectedArch)) {
      warn(`native module 架构不匹配: ${modulePath} (当前: ${archs}, 需要: ${expectedArch})`);
      return false;
    }
  }
  return true;
};

export const ensureBetterSqlite3 = (options = {}) => {
  const targetArch = options.targetArch || '';
  const crossCompiling = targetArch && targetArch !== process.arch;

  const probeInNode =
    typeof options.probeInNode === 'function'
      ? options.probeInNode
      : canLoadBetterSqlite3InNode;
  const probeInElectron =
    typeof options.probeInElectron === 'function'
      ? options.probeInElectron
      : canLoadBetterSqlite3InElectron;
  const runCommand = typeof options.runCommand === 'function' ? options.runCommand : run;
  const logFn = typeof options.logFn === 'function' ? options.logFn : log;
  const errorFn = typeof options.errorFn === 'function' ? options.errorFn : error;
  const resolvedPnpmCmd = options.pnpmCmd || resolvePnpmCommand();
  const activate =
    typeof options.activateBetterSqlite3 === 'function'
      ? options.activateBetterSqlite3
      : activateBetterSqlite3;

  // better-sqlite3 的两个隔离运行时。修复路径走依赖缓存层：缓存命中即本地拷贝
  // （零网络、零重编译）；未命中才由 buildFn 调既有 sqlite:prepare（switch-abi）编译，
  // 编译产物随即入缓存。buildFn 包一层只执行一次（一条命令同时产出两个运行时）。
  const SQLITE_RUNTIMES = ['node', 'electron'];
  const makeBuildFn = (commandArgs, label) => {
    let attempted = false;
    let succeeded = false;
    return () => {
      if (attempted) return succeeded;
      attempted = true;
      succeeded = runCommand(resolvedPnpmCmd, commandArgs, label);
      return succeeded;
    };
  };

  // Cross-compile: skip runtime loading verification (impossible on different arch),
  // but verify the compiled binary has the correct Mach-O architecture.
  if (crossCompiling) {
    logFn(`交叉编译模式: 目标架构 ${targetArch}，当前架构 ${process.arch}。跳过加载验证，检查编译产物架构。`);
    const buildFn = makeBuildFn(
      ['run', 'sqlite:prepare', '--', '--arch', targetArch],
      `pnpm run sqlite:prepare -- --arch ${targetArch}`,
    );
    const activatedAll = SQLITE_RUNTIMES.every((runtime) =>
      activate({ runtime, platform: process.platform, arch: targetArch, buildFn }),
    );
    if (activatedAll && checkNativeModuleArch(targetArch)) {
      logFn(`better-sqlite3 已为 ${targetArch} 架构编译完成。`);
      return true;
    }
    errorFn(`better-sqlite3 交叉编译失败或产物架构不匹配，期望 ${targetArch}。`);
    return false;
  }

  if (probeInNode() && probeInElectron()) {
    logFn('better-sqlite3（Node/Electron 隔离运行时）已就绪。');
    return true;
  }

  const buildFn = makeBuildFn(
    ['run', 'sqlite:prepare', '--', '--verify'],
    'pnpm run sqlite:prepare -- --verify',
  );
  const activatedAll = SQLITE_RUNTIMES.every((runtime) =>
    activate({ runtime, platform: process.platform, arch: process.arch, buildFn }),
  );
  if (activatedAll && probeInNode() && probeInElectron()) {
    logFn('better-sqlite3 已通过依赖缓存层准备完成（Node/Electron 隔离运行时）。');
    return true;
  }

  errorFn('better-sqlite3 在 Node/Electron 隔离运行时仍不可用。');
  errorFn('请尝试: pnpm run sqlite:prepare -- --verify');
  return false;
};

export const runEnsureDesktopDeps = (options = {}) => {
  const okFfmpeg = ensureFfmpegStatic({ targetArch: options.targetArch });
  const okElectron = ensureElectronBinary();
  const okSqlite = okElectron ? ensureBetterSqlite3({ targetArch: options.targetArch }) : false;

  return okFfmpeg && okElectron && okSqlite;
};

const parseDirectArgs = (argv) => {
  const archIndex = argv.indexOf('--target-arch');
  if (archIndex >= 0 && argv[archIndex + 1]) {
    return { targetArch: argv[archIndex + 1] };
  }
  return {};
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
  const directArgs = parseDirectArgs(process.argv.slice(2));
  if (!runEnsureDesktopDeps(directArgs)) {
    process.exitCode = 1;
  }
}

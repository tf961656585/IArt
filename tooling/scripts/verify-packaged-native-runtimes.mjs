#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const distRoot = path.join(repoRoot, 'dist-desktop');
const resourcesRuntimeSuffix = path.join('Contents', 'Resources');
const packagedRuntimeSuffix = path.join(
  'app.asar.unpacked',
  'apps',
  'backend',
  'native-modules',
  'better-sqlite3',
  'electron',
  'package.json',
);
const sharpPackageSuffix = path.join('app.asar.unpacked', 'node_modules', 'sharp', 'package.json');
const oneByOnePngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const log = (message) => console.log(`[verify:packaged-native-runtimes] ${message}`);
const error = (message) => console.error(`[verify:packaged-native-runtimes] ${message}`);

const toPosix = (value) => value.split(path.sep).join('/');

// ffmpeg 完整二进制大小下限。与 ensure-desktop-deps.mjs 保持一致口径：
// 官方产物 darwin-arm64 约 45MB、darwin-x64 约 78MB、win32-x64 约 138MB，残缺样本 1.5MB。
const FFMPEG_MIN_BYTES = 5_000_000;

const fileMachoArch = (filePath) => {
  try {
    const result = spawnSync('lipo', ['-archs', filePath], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // lipo not available (non-macOS)
  }
  return '';
};

// 真实执行 ffmpeg 验证可用性，对齐 better-sqlite3/sharp 的产物加载测试标准。
// 拦截无执行位（EACCES）和文件残缺（异常退出/无输出）。
const probeFfmpegExecution = (ffmpegPath) => {
  const result = spawnSync(ffmpegPath, ['-version'], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, message: `${result.error.code || ''} ${result.error.message}`.trim() };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return { ok: false, message: `exit=${result.status}${detail ? ` ${detail}` : ''}` };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!stdout) {
    return { ok: false, message: 'ffmpeg -version 退出码 0 但无输出，疑似残缺二进制' };
  }
  return { ok: true, message: stdout.split(/\r?\n/, 1)[0] };
};

const uniqueSorted = (values) => [...new Set(values)].sort();

const resolveResourcesDirFromPath = (absPath) => {
  const normalizedPath = path.resolve(absPath);
  const segments = toPosix(normalizedPath).split('/');
  const unpackedIndex = segments.indexOf('app.asar.unpacked');
  if (unpackedIndex > 0) {
    const candidate = segments.slice(0, unpackedIndex).join('/');
    const prefix = normalizedPath.startsWith(path.sep) ? path.sep : '';
    return path.normalize(prefix + candidate);
  }
  return null;
};

const resolveElectronLaunchCommand = () => {
  const electronDir = path.join(repoRoot, 'node_modules', 'electron');
  const pathFile = path.join(electronDir, 'path.txt');
  try {
    const executableRel = fs.readFileSync(pathFile, 'utf-8').trim();
    if (executableRel) {
      const executablePath = path.join(electronDir, 'dist', executableRel);
      if (fs.existsSync(executablePath)) {
        return { command: executablePath, useShell: false };
      }
    }
  } catch {
    // fall through to .bin lookup
  }

  const binName = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  const binPath = path.join(repoRoot, 'node_modules', '.bin', binName);
  if (fs.existsSync(binPath)) {
    return { command: binPath, useShell: process.platform === 'win32' };
  }
  return null;
};

const findPackagedNativeRuntimeDirs = (rootDir = distRoot) => {
  if (!fs.existsSync(rootDir)) return [];

  const found = [];
  const stack = [rootDir];
  const normalizedSuffix = toPosix(packagedRuntimeSuffix);

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'package.json') continue;

      const normalized = toPosix(absPath);
      if (normalized.endsWith(normalizedSuffix)) {
        found.push(path.dirname(absPath));
      }
    }
  }

  return found.sort();
};

const findPackagedResourcesDirs = (rootDir = distRoot) => {
  if (!fs.existsSync(rootDir)) return [];

  const found = [];
  const stack = [rootDir];
  const nativeRuntimeSuffix = toPosix(packagedRuntimeSuffix);
  const sharpRuntimeSuffix = toPosix(sharpPackageSuffix);

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'package.json') continue;

      const normalized = toPosix(absPath);
      if (!normalized.endsWith(nativeRuntimeSuffix) && !normalized.endsWith(sharpRuntimeSuffix)) {
        continue;
      }
      const resourcesDir = resolveResourcesDirFromPath(absPath);
      if (resourcesDir) {
        found.push(resourcesDir);
      }
    }
  }

  return uniqueSorted(found);
};

const readIncludedRuntimeDependencies = (runtimeDir) => {
  const metadataPath = path.join(runtimeDir, '.iart-runtime.json');
  if (!fs.existsSync(metadataPath)) {
    return {
      ok: false,
      dependencies: [],
      message: `缺少 prepared runtime metadata: ${metadataPath}`,
    };
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    const dependencies = Array.isArray(metadata.includedRuntimeDependencies)
      ? metadata.includedRuntimeDependencies.filter((name) => typeof name === 'string' && name.trim())
      : [];
    if (dependencies.length === 0) {
      return {
        ok: false,
        dependencies: [],
        message: `prepared runtime metadata 未声明 includedRuntimeDependencies: ${metadataPath}`,
      };
    }
    return { ok: true, dependencies, message: '' };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      dependencies: [],
      message: `无法读取 prepared runtime metadata: ${metadataPath}\n${detail}`,
    };
  }
};

const getNodeModulesPackageJsonPath = (runtimeDir, packageName) =>
  path.join(runtimeDir, 'node_modules', ...packageName.split('/'), 'package.json');

const verifyRuntimeDependencyClosure = (runtimeDir) => {
  const metadata = readIncludedRuntimeDependencies(runtimeDir);
  if (!metadata.ok) return { ok: false, issues: [metadata.message] };

  const missing = metadata.dependencies
    .map((packageName) => ({ packageName, packageJsonPath: getNodeModulesPackageJsonPath(runtimeDir, packageName) }))
    .filter(({ packageJsonPath }) => !fs.existsSync(packageJsonPath));

  if (missing.length === 0) return { ok: true, issues: [] };

  return {
    ok: false,
    issues: missing.map(
      ({ packageName, packageJsonPath }) => `缺少 runtime dependency "${packageName}": ${packageJsonPath}`,
    ),
  };
};

const verifyRuntimeDir = ({ runtimeDir, electronLaunch, runner = spawnSync, skipLoadTest = false }) => {
  const closure = verifyRuntimeDependencyClosure(runtimeDir);
  if (!closure.ok) {
    return { ok: false, message: closure.issues.join('\n') };
  }

  if (skipLoadTest) {
    log(`跳过加载测试 (交叉编译产物): ${runtimeDir}`);
    return { ok: true, message: 'skipped (cross-compiled)' };
  }

  const result = runner(
    electronLaunch.command,
    [
      '-e',
      `const Database=require(${JSON.stringify(runtimeDir)}); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 ok (packaged electron isolated)');`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: electronLaunch.useShell,
    },
  );

  if (result.error) {
    return { ok: false, message: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: (result.stderr || result.stdout || `exit=${result.status ?? 'null'}`).trim(),
    };
  }
  return { ok: true, message: (result.stdout || '').trim() };
};

const getBetterSqliteRuntimeDir = (resourcesDir) =>
  path.join(
    resourcesDir,
    'app.asar.unpacked',
    'apps',
    'backend',
    'native-modules',
    'better-sqlite3',
    'electron',
  );

const getSharpRuntimeDir = (resourcesDir) =>
  path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'sharp');

// sharp 平台包目录：app.asar.unpacked/node_modules/@img/sharp-darwin-{arch}/
const getSharpPlatformPackageDir = (resourcesDir, arch) =>
  path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', `sharp-darwin-${arch}`);

// sharp-libvips 平台包目录：app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-{arch}/
const getSharpLibvipsPackageDir = (resourcesDir, arch) =>
  path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@img', `sharp-libvips-darwin-${arch}`);

// ffmpeg 二进制路径：app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg[.exe]
// win32 下文件名带 .exe 后缀，对齐 ffmpeg-static/index.js 的口径。
const getFfmpegBinaryPath = (resourcesDir) => {
  const baseName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', baseName);
};

const expectedMachoForArch = (arch) => (arch === 'x64' ? 'x86_64' : 'arm64');

// 校验产物中某一路径的 Mach-O 架构是否包含期望架构（用于交叉编译场景，无法实际加载）。
const verifyMachoArch = ({ filePath, expectedArch, label }) => {
  if (!fs.existsSync(filePath)) {
    return { ok: false, message: `${label} 缺失: ${filePath}` };
  }
  if (process.platform !== 'darwin') {
    // 非 macOS 无法用 lipo 校验架构，仅确认存在。
    return { ok: true, message: `${label} 存在（非 darwin，跳过架构校验）` };
  }
  const archs = fileMachoArch(filePath);
  const expected = expectedMachoForArch(expectedArch);
  if (!archs) {
    return { ok: false, message: `${label} 无法检测架构（lipo 失败）: ${filePath}` };
  }
  if (!archs.includes(expected)) {
    return { ok: false, message: `${label} 架构不匹配（期望 ${expected}，实际 ${archs}）: ${filePath}` };
  }
  return { ok: true, message: `${label} 架构正确（${archs}）` };
};

// 交叉编译场景：校验 sharp 平台包（sharp.node + libvips dylib）存在且架构匹配。
const verifySharpPlatformArch = ({ resourcesDir, expectedArch }) => {
  const issues = [];
  const sharpPkgDir = getSharpPlatformPackageDir(resourcesDir, expectedArch);
  const sharpNodePath = path.join(sharpPkgDir, 'lib', `sharp-darwin-${expectedArch}.node`);
  const sharpNodeResult = verifyMachoArch({ filePath: sharpNodePath, expectedArch, label: `sharp ${expectedArch} binding` });
  if (!sharpNodeResult.ok) issues.push(sharpNodeResult.message);

  // libvips 平台包：校验目录存在，内部 dylib 架构匹配。
  const libvipsPkgDir = getSharpLibvipsPackageDir(resourcesDir, expectedArch);
  if (!fs.existsSync(path.join(libvipsPkgDir, 'package.json'))) {
    issues.push(`sharp-libvips ${expectedArch} 平台包缺失: ${libvipsPkgDir}`);
  } else if (process.platform === 'darwin') {
    const libDir = path.join(libvipsPkgDir, 'lib');
    if (fs.existsSync(libDir)) {
      const dylib = fs.readdirSync(libDir).find((name) => name.endsWith('.dylib'));
      if (dylib) {
        const libvipsResult = verifyMachoArch({
          filePath: path.join(libDir, dylib),
          expectedArch,
          label: `sharp-libvips ${expectedArch} dylib`,
        });
        if (!libvipsResult.ok) issues.push(libvipsResult.message);
      }
    }
  }
  return { ok: issues.length === 0, issues };
};

// 交叉编译场景：校验 ffmpeg 二进制架构匹配且大小达标（交叉无法执行目标架构，用大小兜底完整性）。
const verifyFfmpegArch = ({ resourcesDir, expectedArch }) => {
  const ffmpegPath = getFfmpegBinaryPath(resourcesDir);
  const archResult = verifyMachoArch({ filePath: ffmpegPath, expectedArch, label: 'ffmpeg binary' });
  if (!archResult.ok) return archResult;
  try {
    const size = fs.statSync(ffmpegPath).size;
    if (size < FFMPEG_MIN_BYTES) {
      return { ok: false, message: `ffmpeg binary 文件过小（${size} bytes < ${FFMPEG_MIN_BYTES}，疑似残缺）: ${ffmpegPath}` };
    }
  } catch (statError) {
    return { ok: false, message: `ffmpeg binary 无法读取大小: ${ffmpegPath} (${statError instanceof Error ? statError.message : String(statError)})` };
  }
  return { ok: true, message: archResult.message };
};

const summarizeRunnerFailure = (result) => {
  if (result.error) return result.error.message;
  if (result.status !== 0) {
    return (result.stderr || result.stdout || `exit=${result.status ?? 'null'}`).trim();
  }
  return '';
};

const verifySharpRuntimeDir = ({ resourcesDir, electronLaunch, runner = spawnSync }) => {
  const sharpRuntimeDir = getSharpRuntimeDir(resourcesDir);
  const sharpPackageJson = path.join(sharpRuntimeDir, 'package.json');
  if (!fs.existsSync(sharpPackageJson)) {
    return {
      ok: false,
      message: [
        `缺少 sharp packaged runtime: ${sharpPackageJson}`,
        `resources: ${resourcesDir}`,
        `require entry: ${sharpRuntimeDir}`,
      ].join('\n'),
    };
  }

  const result = runner(
    electronLaunch.command,
    [
      '-e',
      [
        `const sharp=require(${JSON.stringify(sharpRuntimeDir)});`,
        `(async()=>{`,
        `const metadata=await sharp(Buffer.from(${JSON.stringify(oneByOnePngBase64)}, 'base64')).metadata();`,
        `if (metadata.width !== 1 || metadata.height !== 1) throw new Error('unexpected sharp metadata');`,
        `console.log('sharp ok (packaged electron isolated)');`,
        `})().catch((error)=>{ console.error(error && error.stack ? error.stack : error); process.exit(1); });`,
      ].join(' '),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: electronLaunch.useShell,
    },
  );

  const failure = summarizeRunnerFailure(result);
  if (failure) {
    return {
      ok: false,
      message: [`resources: ${resourcesDir}`, `require entry: ${sharpRuntimeDir}`, failure].join('\n'),
    };
  }
  return { ok: true, message: (result.stdout || '').trim(), runtimeDir: sharpRuntimeDir };
};

const detectNativeModuleArch = (runtimeDir) => {
  if (process.platform !== 'darwin') return '';
  const nativeModulePath = path.join(runtimeDir, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(nativeModulePath)) return '';
  const archs = fileMachoArch(nativeModulePath);
  if (!archs) return '';
  if (archs.includes('x86_64')) return 'x64';
  if (archs.includes('arm64')) return 'arm64';
  return '';
};

const isCrossCompiledProduct = (betterSqliteRuntimeDir) => {
  if (process.platform !== 'darwin') return false;
  const moduleArch = detectNativeModuleArch(betterSqliteRuntimeDir);
  return moduleArch && moduleArch !== process.arch;
};

const verifyPackagedResourceDir = ({ resourcesDir, electronLaunch, runner = spawnSync }) => {
  const betterSqliteRuntimeDir = getBetterSqliteRuntimeDir(resourcesDir);
  const issues = [];
  const verifiedRuntimeDirs = [];
  const crossCompiled = isCrossCompiledProduct(betterSqliteRuntimeDir);
  const moduleArch = detectNativeModuleArch(betterSqliteRuntimeDir);

  if (!fs.existsSync(path.join(betterSqliteRuntimeDir, 'package.json'))) {
    issues.push(`缺少 better-sqlite3 packaged native runtime: ${betterSqliteRuntimeDir}`);
  } else {
    if (crossCompiled) {
      log(`交叉编译产物 (${moduleArch || 'unknown'} on ${process.arch})，跳过 better-sqlite3 加载测试: ${betterSqliteRuntimeDir}`);
      verifiedRuntimeDirs.push(betterSqliteRuntimeDir);
    } else {
      const sqliteResult = verifyRuntimeDir({
        runtimeDir: betterSqliteRuntimeDir,
        electronLaunch,
        runner,
      });
      if (sqliteResult.ok) {
        verifiedRuntimeDirs.push(betterSqliteRuntimeDir);
      } else {
        issues.push(`${betterSqliteRuntimeDir}\n${sqliteResult.message}`);
      }
    }
  }

  if (crossCompiled) {
    // 交叉编译场景：无法在本机实际加载目标架构二进制，
    // 改为校验 sharp 平台包与 ffmpeg 二进制的 Mach-O 架构与目标一致。
    // 不再无条件跳过 sharp 校验，否则 x64 产物缺失 sharp 二进制也无法发现。
    const sharpRuntimeDir = getSharpRuntimeDir(resourcesDir);
    log(`交叉编译产物 (${moduleArch} on ${process.arch})，校验 sharp/ffmpeg 架构而非加载测试`);
    verifiedRuntimeDirs.push(sharpRuntimeDir);

    const sharpArchResult = verifySharpPlatformArch({ resourcesDir, expectedArch: moduleArch });
    if (!sharpArchResult.ok) {
      issues.push(...sharpArchResult.issues);
    }

    const ffmpegArchResult = verifyFfmpegArch({ resourcesDir, expectedArch: moduleArch });
    if (!ffmpegArchResult.ok) {
      issues.push(ffmpegArchResult.message);
    }
  } else {
    const sharpResult = verifySharpRuntimeDir({
      resourcesDir,
      electronLaunch,
      runner,
    });
    if (sharpResult.ok) {
      verifiedRuntimeDirs.push(sharpResult.runtimeDir);
    } else {
      issues.push(sharpResult.message);
    }

    // 非交叉场景：真实执行 ffmpeg 验证可用性，对齐 better-sqlite3/sharp 的加载测试标准。
    // 拦截无执行位（EACCES）和文件残缺/损坏。
    const ffmpegPath = getFfmpegBinaryPath(resourcesDir);
    if (fs.existsSync(ffmpegPath)) {
      const ffmpegResult = probeFfmpegExecution(ffmpegPath);
      if (!ffmpegResult.ok) {
        issues.push(`ffmpeg binary 执行失败: ${ffmpegPath}\n${ffmpegResult.message}`);
      }
    } else {
      issues.push(`缺少 ffmpeg binary: ${ffmpegPath}`);
    }
  }

  return { ok: issues.length === 0, issues, verifiedRuntimeDirs };
};

const verifyPackagedNativeRuntimes = ({
  rootDir = distRoot,
  electronLaunch = resolveElectronLaunchCommand(),
  runner = spawnSync,
} = {}) => {
  const resourcesDirs = findPackagedResourcesDirs(rootDir);
  if (resourcesDirs.length === 0) {
    return {
      ok: false,
      issues: [
        `未发现 packaged native runtime resources: ${path.join(rootDir, '**', resourcesRuntimeSuffix)}`,
        `期望包含: ${packagedRuntimeSuffix}`,
        `期望包含: ${sharpPackageSuffix}`,
      ],
      verifiedRuntimeDirs: [],
    };
  }

  if (!electronLaunch?.command) {
    return {
      ok: false,
      issues: ['未找到 Electron 可执行文件，无法验证 packaged native runtime。请先执行 pnpm ensure:electron。'],
      verifiedRuntimeDirs: [],
    };
  }

  const issues = [];
  const verifiedRuntimeDirs = [];
  for (const resourcesDir of resourcesDirs) {
    const result = verifyPackagedResourceDir({ resourcesDir, electronLaunch, runner });
    verifiedRuntimeDirs.push(...result.verifiedRuntimeDirs);
    if (result.ok) {
      continue;
    }
    issues.push(`${resourcesDir}\n${result.issues.join('\n')}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    verifiedRuntimeDirs,
  };
};

export const runVerifyPackagedNativeRuntimes = (options = {}) => {
  const result = verifyPackagedNativeRuntimes(options);
  if (result.ok) {
    for (const runtimeDir of result.verifiedRuntimeDirs) {
      log(`通过: ${runtimeDir}`);
    }
    return 0;
  }

  error(`失败 (${result.issues.length} issue(s))`);
  for (const issue of result.issues) {
    error(issue);
  }
  return 1;
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
  const code = runVerifyPackagedNativeRuntimes();
  if (code !== 0) {
    process.exit(code);
  }
}

export const __test_only__ = {
  findPackagedNativeRuntimeDirs,
  findPackagedResourcesDirs,
  verifyPackagedResourceDir,
  verifyPackagedNativeRuntimes,
  verifyRuntimeDependencyClosure,
  verifySharpRuntimeDir,
  verifySharpPlatformArch,
  verifyFfmpegArch,
  verifyMachoArch,
  getSharpPlatformPackageDir,
  getSharpLibvipsPackageDir,
  getFfmpegBinaryPath,
  FFMPEG_MIN_BYTES,
};

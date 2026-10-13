import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { __test_only__ } from '../verify-packaged-native-runtimes.mjs';

const createRuntime = (rootDir, productDir, options = {}) => {
  const resourcesDir = path.join(rootDir, productDir, 'Contents', 'Resources');
  const runtimeDir = path.join(
    resourcesDir,
    'app.asar.unpacked',
    'apps',
    'backend',
    'native-modules',
    'better-sqlite3',
    'electron',
  );
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3' }));
  fs.writeFileSync(
    path.join(runtimeDir, '.iart-runtime.json'),
    JSON.stringify({ includedRuntimeDependencies: options.dependencies ?? [] }),
  );
  for (const packageName of options.installedDependencies ?? []) {
    const packageDir = path.join(runtimeDir, 'node_modules', ...packageName.split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName }));
  }
  if (options.sharp !== false) {
    const sharpDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'sharp');
    fs.mkdirSync(sharpDir, { recursive: true });
    fs.writeFileSync(path.join(sharpDir, 'package.json'), JSON.stringify({ name: 'sharp' }));
  }
  return runtimeDir;
};

const createRuntimeWithoutSharp = (rootDir, productDir, options = {}) =>
  createRuntime(rootDir, productDir, { ...options, sharp: false });

const getResourcesDir = (rootDir, productDir) =>
  path.join(rootDir, productDir, 'Contents', 'Resources');

const getSharpDir = (rootDir, productDir) =>
  path.join(getResourcesDir(rootDir, productDir), 'app.asar.unpacked', 'node_modules', 'sharp');

const createLegacyRuntime = (rootDir, productDir, options = {}) => {
  const runtimeDir = path.join(
    rootDir,
    productDir,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'apps',
    'backend',
    'native-modules',
    'better-sqlite3',
    'electron',
  );
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'better-sqlite3' }));
  fs.writeFileSync(
    path.join(runtimeDir, '.iart-runtime.json'),
    JSON.stringify({ includedRuntimeDependencies: options.dependencies ?? [] }),
  );
  for (const packageName of options.installedDependencies ?? []) {
    const packageDir = path.join(runtimeDir, 'node_modules', ...packageName.split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName }));
  }
  return runtimeDir;
};

test('findPackagedNativeRuntimeDirs 扫描 dist-desktop 下所有 packaged runtime', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-find-'));
  const first = createLegacyRuntime(rootDir, 'mac/IARTStudio.app');
  const second = createLegacyRuntime(rootDir, 'mac-arm64/IARTStudio.app');

  assert.deepEqual(__test_only__.findPackagedNativeRuntimeDirs(rootDir), [first, second].sort());
});

test('findPackagedResourcesDirs 扫描 packaged app resources 目录', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-resources-find-'));
  createRuntime(rootDir, 'mac/IARTStudio.app');
  createRuntime(rootDir, 'mac-arm64/IARTStudio.app');

  assert.deepEqual(__test_only__.findPackagedResourcesDirs(rootDir), [
    getResourcesDir(rootDir, 'mac-arm64/IARTStudio.app'),
    getResourcesDir(rootDir, 'mac/IARTStudio.app'),
  ].sort());
});

test('verifyPackagedNativeRuntimes 未发现 runtime 时失败', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-empty-'));

  const result = __test_only__.verifyPackagedNativeRuntimes({
    rootDir,
    electronLaunch: { command: 'electron', useShell: false },
    runner: () => ({ status: 0, stdout: 'ok' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.issues[0], /未发现 packaged native runtime resources/);
});

test('verifyPackagedNativeRuntimes 逐个验证并汇总失败', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-verify-'));
  const first = createRuntime(rootDir, 'mac/IARTStudio.app', {
    dependencies: ['bindings'],
    installedDependencies: ['bindings'],
  });
  const second = createRuntime(rootDir, 'mac-arm64/IARTStudio.app', {
    dependencies: ['bindings'],
    installedDependencies: ['bindings'],
  });
  const calls = [];

  const result = __test_only__.verifyPackagedNativeRuntimes({
    rootDir,
    electronLaunch: { command: 'electron', useShell: false },
    runner: (_command, args) => {
      calls.push(args[1]);
      if (args[1].includes(JSON.stringify(getSharpDir(rootDir, 'mac/IARTStudio.app')))) {
        return { status: 0, stdout: 'sharp ok' };
      }
      if (args[1].includes(JSON.stringify(getSharpDir(rootDir, 'mac-arm64/IARTStudio.app')))) {
        return { status: 0, stdout: 'sharp ok' };
      }
      return args[1].includes(JSON.stringify(second))
        ? { status: 1, stderr: 'Cannot find module bindings' }
        : { status: 0, stdout: 'ok' };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.verifiedRuntimeDirs, [
    getSharpDir(rootDir, 'mac-arm64/IARTStudio.app'),
    first,
    getSharpDir(rootDir, 'mac/IARTStudio.app'),
  ]);
  assert.equal(calls.length, 4);
  assert.match(result.issues[0], /Cannot find module bindings/);
});

test('verifyPackagedNativeRuntimes 要求 packaged resources 携带 sharp runtime', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-sharp-missing-'));
  createRuntimeWithoutSharp(rootDir, 'mac/IARTStudio.app', {
    dependencies: ['bindings'],
    installedDependencies: ['bindings'],
  });

  const result = __test_only__.verifyPackagedNativeRuntimes({
    rootDir,
    electronLaunch: { command: 'electron', useShell: false },
    runner: () => ({ status: 0, stdout: 'ok' }),
  });

  assert.equal(result.ok, false);
  assert.match(result.issues[0], /缺少 sharp packaged runtime/);
  assert.match(result.issues[0], /app\.asar\.unpacked/);
});

test('verifyPackagedNativeRuntimes 保留 sharp Electron isolated runner 的 stderr', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-sharp-runner-'));
  const runtimeDir = createRuntime(rootDir, 'mac/IARTStudio.app', {
    dependencies: ['bindings'],
    installedDependencies: ['bindings'],
  });
  const resourcesDir = getResourcesDir(rootDir, 'mac/IARTStudio.app');
  const sharpDir = getSharpDir(rootDir, 'mac/IARTStudio.app');
  const calls = [];

  const result = __test_only__.verifyPackagedNativeRuntimes({
    rootDir,
    electronLaunch: { command: 'electron', useShell: false },
    runner: (_command, args) => {
      calls.push(args[1]);
      return args[1].includes(JSON.stringify(sharpDir))
        ? { status: 1, stderr: 'Library not loaded: @rpath/libvips-cpp.8.17.3.dylib' }
        : { status: 0, stdout: 'better-sqlite3 ok' };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.verifiedRuntimeDirs, [runtimeDir]);
  assert.equal(calls.length, 2);
  assert.match(result.issues[0], new RegExp(resourcesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.issues[0], /require entry:/);
  assert.match(result.issues[0], /Library not loaded: @rpath\/libvips-cpp/);
});

test('verifyRuntimeDependencyClosure 要求 runtime 自身携带 metadata 声明的依赖包', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-runtime-closure-'));
  const runtimeDir = createLegacyRuntime(rootDir, 'mac/IARTStudio.app', {
    dependencies: ['bindings', 'file-uri-to-path'],
    installedDependencies: ['bindings'],
  });

  const result = __test_only__.verifyRuntimeDependencyClosure(runtimeDir);

  assert.equal(result.ok, false);
  assert.match(result.issues[0], /file-uri-to-path/);
  assert.match(result.issues[0], /node_modules/);
});

// ─── 交叉编译场景：sharp 平台包与 ffmpeg 架构校验 ───────────────────────────────
// 这些测试覆盖"x64 产物缺失 sharp/ffmpeg 二进制"的校验盲区修复。
// verifyMachoArch 在非 darwin 平台只检查存在性；在 darwin 平台用 lipo 校验架构。
// 在 darwin 平台构造文件时使用真实 Mach-O 二进制（从 node_modules/@img 复制），
// 使 lipo 能正确识别架构；缺失场景直接不创建文件。

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

const resolveRealMachoForArch = (arch) => {
  if (process.platform !== 'darwin') return null;
  const candidate = path.join(repoRoot, 'node_modules', '@img', `sharp-darwin-${arch}`, 'lib', `sharp-darwin-${arch}.node`);
  return fs.existsSync(candidate) ? candidate : null;
};

const createSharpPlatformPackage = (resourcesDir, arch) => {
  const pkgDir = __test_only__.getSharpPlatformPackageDir(resourcesDir, arch);
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: `@img/sharp-darwin-${arch}` }));
  const nodePath = path.join(pkgDir, 'lib', `sharp-darwin-${arch}.node`);
  const realMacho = resolveRealMachoForArch(arch);
  if (realMacho) {
    fs.copyFileSync(realMacho, nodePath);
  } else {
    fs.writeFileSync(nodePath, 'fake-node');
  }
  return pkgDir;
};

const createSharpLibvipsPackage = (resourcesDir, arch, options = {}) => {
  const pkgDir = __test_only__.getSharpLibvipsPackageDir(resourcesDir, arch);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: `@img/sharp-libvips-darwin-${arch}` }));
  if (options.withLib !== false) {
    const libDir = path.join(pkgDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    // darwin 平台用真实 sharp .node 冒充 dylib（只需 lipo 能识别架构即可）；
    // 非 darwin 平台写 fake 文件（只检查存在性）。
    const realMacho = resolveRealMachoForArch(arch);
    fs.writeFileSync(path.join(libDir, 'libvips-cpp.8.17.3.dylib'), realMacho ? fs.readFileSync(realMacho) : 'fake-dylib');
  }
  return pkgDir;
};

const createFfmpegBinary = (resourcesDir, arch, options = {}) => {
  const ffmpegPath = __test_only__.getFfmpegBinaryPath(resourcesDir);
  fs.mkdirSync(path.dirname(ffmpegPath), { recursive: true });
  const realMacho = resolveRealMachoForArch(arch);
  if (realMacho) {
    fs.copyFileSync(realMacho, ffmpegPath);
  } else {
    fs.writeFileSync(ffmpegPath, 'fake-ffmpeg');
  }
  // verifyFfmpegArch 要求文件大小达到下限。默认补齐到 FFMPEG_MIN_BYTES；
  // 传入 { undersized: true } 可故意制造残缺小文件用于负向测试。
  const minBytes = __test_only__.FFMPEG_MIN_BYTES;
  if (!options.undersized) {
    const currentSize = fs.statSync(ffmpegPath).size;
    if (currentSize < minBytes) {
      const fd = fs.openSync(ffmpegPath, 'a');
      try {
        fs.writeSync(fd, Buffer.alloc(minBytes - currentSize + 1, 0));
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return ffmpegPath;
};

test('verifySharpPlatformArch: sharp x64 平台包完整时通过', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-arch-ok-'));
  const resourcesDir = path.join(rootDir, 'Contents', 'Resources');
  createSharpPlatformPackage(resourcesDir, 'x64');
  createSharpLibvipsPackage(resourcesDir, 'x64');

  const result = __test_only__.verifySharpPlatformArch({ resourcesDir, expectedArch: 'x64' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('verifySharpPlatformArch: sharp x64 binding 缺失时失败', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-arch-missing-binding-'));
  const resourcesDir = path.join(rootDir, 'Contents', 'Resources');
  // 只创建 libvips，不创建 sharp binding
  createSharpLibvipsPackage(resourcesDir, 'x64');

  const result = __test_only__.verifySharpPlatformArch({ resourcesDir, expectedArch: 'x64' });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /sharp x64 binding 缺失/.test(issue)));
});

test('verifySharpPlatformArch: sharp-libvips x64 平台包缺失时失败', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-arch-missing-libvips-'));
  const resourcesDir = path.join(rootDir, 'Contents', 'Resources');
  createSharpPlatformPackage(resourcesDir, 'x64');
  // 不创建 libvips

  const result = __test_only__.verifySharpPlatformArch({ resourcesDir, expectedArch: 'x64' });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => /sharp-libvips x64 平台包缺失/.test(issue)));
});

test('verifyFfmpegArch: ffmpeg 二进制缺失时失败', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-arch-missing-'));
  const resourcesDir = path.join(rootDir, 'Contents', 'Resources');

  const result = __test_only__.verifyFfmpegArch({ resourcesDir, expectedArch: 'x64' });

  assert.equal(result.ok, false);
  assert.match(result.message, /ffmpeg binary 缺失/);
});

test('verifyFfmpegArch: ffmpeg 二进制存在时通过', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-arch-ok-'));
  const resourcesDir = path.join(rootDir, 'Contents', 'Resources');
  createFfmpegBinary(resourcesDir, 'x64');

  const result = __test_only__.verifyFfmpegArch({ resourcesDir, expectedArch: 'x64' });

  assert.equal(result.ok, true);
});

test('verifyFfmpegArch: ffmpeg 二进制过小时失败（残缺文件兜底）', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-arch-undersized-'));
  const resourcesDir = path.join(rootDir, 'Contents', 'Resources');
  createFfmpegBinary(resourcesDir, 'x64', { undersized: true });

  const result = __test_only__.verifyFfmpegArch({ resourcesDir, expectedArch: 'x64' });

  assert.equal(result.ok, false);
  assert.match(result.message, /文件过小|疑似残缺/);
});

test('verifyPackagedResourceDir: 交叉编译产物缺 sharp x64 平台包时失败', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-sharp-missing-'));
  const productDir = 'mac-x64/IARTStudio.app';
  const resourcesDir = getResourcesDir(rootDir, productDir);
  const runtimeDir = createRuntime(rootDir, productDir, {
    dependencies: ['bindings'],
    installedDependencies: ['bindings'],
  });

  // 构造交叉编译特征：better-sqlite3 .node 是 x86_64（使 detectNativeModuleArch 返回 x64）
  const buildReleaseDir = path.join(runtimeDir, 'build', 'Release');
  fs.mkdirSync(buildReleaseDir, { recursive: true });
  const realX64Macho = resolveRealMachoForArch('x64');
  if (process.platform === 'darwin' && realX64Macho) {
    fs.copyFileSync(realX64Macho, path.join(buildReleaseDir, 'better_sqlite3.node'));
  }

  // 不创建任何 sharp x64 平台包和 ffmpeg
  const result = __test_only__.verifyPackagedResourceDir({
    resourcesDir,
    electronLaunch: { command: 'electron', useShell: false },
    runner: () => ({ status: 0, stdout: 'ok' }),
  });

  // 在 darwin + 真实 x64 .node 可用时，交叉编译路径应检出 sharp/ffmpeg 缺失。
  // 非 darwin 或无真实 .node 时，crossCompiled 为 false，走加载测试路径，无法测此场景。
  const sqliteNodePath = path.join(runtimeDir, 'build', 'Release', 'better_sqlite3.node');
  if (process.platform === 'darwin' && fs.existsSync(sqliteNodePath)) {
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => /sharp x64 binding 缺失|ffmpeg binary 缺失/.test(issue)),
      `期望检出 sharp/ffmpeg 缺失，实际 issues: ${JSON.stringify(result.issues)}`,
    );
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  downloadWithMirrors,
  loadLock,
  saveLock,
  sha256File,
  sqliteCacheKey,
  provisionFfmpeg,
  activateFfmpeg,
  provisionBetterSqlite3,
  activateBetterSqlite3,
} from '../../dev/desktop-deps-cache.mjs';

const silent = () => {};

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-deps-cache-test-'));

// 构造一个 >5MB 的确定性内容（ffmpeg 大小下限校验需要）。
const makeLargeContent = () => Buffer.alloc(6_000_000, 7);

// 交叉架构（相对当前机器），用于走 darwin lipo 校验分支而避免真实执行探测。
const crossArch = process.arch === 'arm64' ? 'x64' : 'arm64';
const crossMacho = crossArch === 'x64' ? 'x86_64' : 'arm64';

// mock 下载器：把 contents 按 url 映射写入 destPath，返回成功的 url。
const makeFakeDownload = ({ contentsByUrl, failUrls = new Set(), calls }) => {
  return ({ urls, destPath }) => {
    for (const url of urls) {
      calls.push(url);
      if (failUrls.has(url)) continue;
      const content = contentsByUrl.get(url);
      if (!content) continue;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, zlib.gzipSync(content));
      return url;
    }
    return false;
  };
};

const ffmpegDeps = ({ cacheDir, lockPath, download, calls }) => ({
  cacheDir,
  lockPath,
  download,
  sha256: sha256File,
  machoArchs: () => crossMacho,
  execProbe: () => ({ ok: true, message: 'ffmpeg version fake' }),
  env: {},
  logFn: silent,
  warnFn: silent,
  errorFn: silent,
  calls,
});

test('sqliteCacheKey: 由 better-sqlite3 版本、runtime 及版本、平台架构组成', () => {
  const key = sqliteCacheKey({
    runtime: 'electron',
    platform: 'darwin',
    arch: 'x64',
    deps: { sqliteVersion: '12.6.2', runtimeVersion: '39.2.7' },
  });
  assert.equal(key, '12.6.2-electron-39.2.7-darwin-x64');

  const nodeKey = sqliteCacheKey({
    runtime: 'node',
    platform: 'win32',
    arch: 'x64',
    deps: { sqliteVersion: '12.6.2', runtimeVersion: '22.0.0' },
  });
  assert.equal(nodeKey, '12.6.2-node-22.0.0-win32-x64');
});

test('锁文件: 缺失时按空锁读取，saveLock 后可回读', () => {
  const tempDir = makeTempDir();
  const lockPath = path.join(tempDir, 'desktop-deps.lock.json');

  assert.deepEqual(loadLock(lockPath), { schemaVersion: 1, entries: {} });

  const lock = { schemaVersion: 1, entries: { 'a/b/c-d': { sha256: 'x', source: 'u', recordedAt: 't' } } };
  saveLock(lock, lockPath);
  assert.deepEqual(loadLock(lockPath), lock);
});

test('downloadWithMirrors: 第一源失败自动 fallback 第二源', () => {
  const tempDir = makeTempDir();
  const destPath = path.join(tempDir, 'file.bin');
  const attempted = [];

  const runner = (args) => {
    const url = args[args.length - 1];
    const partPath = args[args.indexOf('-o') + 1];
    attempted.push(url);
    if (url === 'https://mirror-a.example/file') {
      return { status: 22, stderr: 'HTTP 404' };
    }
    fs.writeFileSync(partPath, 'payload');
    return { status: 0 };
  };

  const used = downloadWithMirrors({
    urls: ['https://mirror-a.example/file', 'https://mirror-b.example/file'],
    destPath,
    runner,
    logFn: silent,
    warnFn: silent,
  });

  assert.equal(used, 'https://mirror-b.example/file');
  assert.deepEqual(attempted, ['https://mirror-a.example/file', 'https://mirror-b.example/file']);
  assert.equal(fs.readFileSync(destPath, 'utf-8'), 'payload');
});

test('downloadWithMirrors: 全部源失败返回 false', () => {
  const tempDir = makeTempDir();
  const destPath = path.join(tempDir, 'file.bin');

  const used = downloadWithMirrors({
    urls: ['https://a.example/f', 'https://b.example/f'],
    destPath,
    runner: () => ({ status: 1, stderr: 'boom' }),
    logFn: silent,
    warnFn: silent,
  });

  assert.equal(used, false);
  assert.equal(fs.existsSync(destPath), false);
});

test('downloadWithMirrors: expectedSha256 不符时删除并尝试下一源', () => {
  const tempDir = makeTempDir();
  const destPath = path.join(tempDir, 'file.bin');
  const good = Buffer.from('good-content');
  const goodSha = sha256OfBuffer(good);

  const runner = (args) => {
    const url = args[args.length - 1];
    const partPath = args[args.indexOf('-o') + 1];
    fs.writeFileSync(partPath, url.endsWith('-bad') ? 'tampered' : good);
    return { status: 0 };
  };

  const used = downloadWithMirrors({
    urls: ['https://a.example/f-bad', 'https://b.example/f-good'],
    destPath,
    expectedSha256: goodSha,
    runner,
    logFn: silent,
    warnFn: silent,
  });

  assert.equal(used, 'https://b.example/f-good');
  assert.deepEqual(fs.readFileSync(destPath), good);
});

const sha256OfBuffer = (buffer) => {
  const tempDir = makeTempDir();
  const tempFile = path.join(tempDir, 'b.bin');
  fs.writeFileSync(tempFile, buffer);
  return sha256File(tempFile);
};

test('provisionFfmpeg: 锁文件无记录时下载成功并 TOFU 写入', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const lockPath = path.join(tempDir, 'lock.json');
  const content = makeLargeContent();
  const calls = [];
  const download = makeFakeDownload({
    contentsByUrl: new Map([
      [`https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-${crossArch}.gz`, content],
    ]),
    calls,
  });
  // env 注入 release tag，避免依赖真实 node_modules。
  const deps = ffmpegDeps({ cacheDir, lockPath, download, calls });
  deps.env = { FFMPEG_BINARY_RELEASE: 'b6.1.1' };

  const cachePath = provisionFfmpeg({ platform: 'darwin', arch: crossArch, deps });

  assert.equal(typeof cachePath, 'string');
  assert.equal(calls.length > 0, true);
  assert.deepEqual(fs.readFileSync(cachePath), content);

  const lock = loadLock(lockPath);
  const entry = lock.entries[`ffmpeg-static/b6.1.1/darwin-${crossArch}`];
  assert.equal(Boolean(entry), true);
  assert.equal(entry.sha256, sha256File(cachePath));
  assert.equal(entry.source, calls[calls.length - 1]);
  assert.equal(typeof entry.recordedAt, 'string');
});

test('provisionFfmpeg: 缓存命中（sha256 匹配）时不触发任何下载', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const lockPath = path.join(tempDir, 'lock.json');
  const content = makeLargeContent();
  const calls = [];

  // 先跑一次完成 TOFU。
  const seedDeps = ffmpegDeps({
    cacheDir,
    lockPath,
    download: makeFakeDownload({
      contentsByUrl: new Map([
        ['https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-arm64.gz', content],
      ]),
      calls,
    }),
    calls,
  });
  seedDeps.env = { FFMPEG_BINARY_RELEASE: 'b6.1.1' };
  seedDeps.machoArchs = () => 'arm64';
  const seeded = provisionFfmpeg({ platform: 'darwin', arch: 'arm64', deps: seedDeps });
  assert.equal(typeof seeded, 'string');
  calls.length = 0;

  // 第二次：下载器直接抛错，命中缓存则不应被调用。
  const hitDeps = ffmpegDeps({
    cacheDir,
    lockPath,
    download: () => {
      throw new Error('download must not be called on cache hit');
    },
    calls,
  });
  hitDeps.env = { FFMPEG_BINARY_RELEASE: 'b6.1.1' };
  hitDeps.machoArchs = () => 'arm64';
  const hit = provisionFfmpeg({ platform: 'darwin', arch: 'arm64', deps: hitDeps });

  assert.equal(hit, seeded);
});

test('provisionFfmpeg: 缓存文件损坏（sha256 不符）时拒绝并重新下载', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const lockPath = path.join(tempDir, 'lock.json');
  const content = makeLargeContent();
  const calls = [];
  const download = makeFakeDownload({
    contentsByUrl: new Map([
      [`https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-${crossArch}.gz`, content],
    ]),
    calls,
  });
  const deps = ffmpegDeps({ cacheDir, lockPath, download, calls });
  deps.env = { FFMPEG_BINARY_RELEASE: 'b6.1.1' };

  const cachePath = provisionFfmpeg({ platform: 'darwin', arch: crossArch, deps });
  assert.equal(typeof cachePath, 'string');

  // 损坏缓存文件。
  fs.writeFileSync(cachePath, 'corrupted');
  calls.length = 0;

  const restored = provisionFfmpeg({ platform: 'darwin', arch: crossArch, deps });
  assert.equal(restored, cachePath);
  assert.equal(calls.length > 0, true, '损坏缓存应触发重新下载');
  assert.deepEqual(fs.readFileSync(cachePath), content);
});

test('provisionFfmpeg: 下载内容 sha256 与锁文件不符时拒绝', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const lockPath = path.join(tempDir, 'lock.json');
  const content = makeLargeContent();
  const calls = [];
  const deps = ffmpegDeps({
    cacheDir,
    lockPath,
    download: makeFakeDownload({
      contentsByUrl: new Map([
        [`https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-${crossArch}.gz`, content],
      ]),
      calls,
    }),
    calls,
  });
  deps.env = { FFMPEG_BINARY_RELEASE: 'b6.1.1' };

  const cachePath = provisionFfmpeg({ platform: 'darwin', arch: crossArch, deps });
  assert.equal(typeof cachePath, 'string');
  fs.rmSync(cachePath);

  // 篡改下载内容（所有源都给错误内容）。
  const tampered = makeLargeContent();
  tampered[0] = 13;
  const tamperedCalls = [];
  const tamperedDeps = ffmpegDeps({
    cacheDir,
    lockPath,
    download: makeFakeDownload({
      contentsByUrl: new Map([
        [`https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-${crossArch}.gz`, tampered],
        [`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-${crossArch}.gz`, tampered],
      ]),
      calls: tamperedCalls,
    }),
    calls: tamperedCalls,
  });
  tamperedDeps.env = { FFMPEG_BINARY_RELEASE: 'b6.1.1' };

  const result = provisionFfmpeg({ platform: 'darwin', arch: crossArch, deps: tamperedDeps });
  assert.equal(result, null);
  assert.equal(fs.existsSync(cachePath), false, '拒绝后不得留下不符产物');
});

test('activateFfmpeg: provision 后复制到生效位置', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const lockPath = path.join(tempDir, 'lock.json');
  const targetPath = path.join(tempDir, 'node_modules', 'ffmpeg-static', 'ffmpeg');
  const content = makeLargeContent();
  const calls = [];
  const deps = ffmpegDeps({
    cacheDir,
    lockPath,
    download: makeFakeDownload({
      contentsByUrl: new Map([
        [`https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-darwin-${crossArch}.gz`, content],
      ]),
      calls,
    }),
    calls,
  });
  deps.env = { FFMPEG_BINARY_RELEASE: 'b6.1.1' };
  deps.targetPath = targetPath;

  const activated = activateFfmpeg({ platform: 'darwin', arch: crossArch, deps });

  assert.equal(activated, targetPath);
  assert.deepEqual(fs.readFileSync(targetPath), content);
});

test('provisionBetterSqlite3: 缓存命中时不调用 buildFn', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const key = '12.6.2-electron-39.2.7-linux-x64';
  const runtimeCacheDir = path.join(cacheDir, 'better-sqlite3', key);
  fs.mkdirSync(path.join(runtimeCacheDir, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(runtimeCacheDir, 'build', 'Release', 'better_sqlite3.node'), 'native');
  fs.writeFileSync(path.join(runtimeCacheDir, '.iart-runtime.json'), '{}');

  const result = provisionBetterSqlite3({
    runtime: 'electron',
    platform: 'linux',
    arch: 'x64',
    buildFn: () => {
      throw new Error('buildFn must not be called on cache hit');
    },
    deps: {
      cacheDir,
      sqliteVersion: '12.6.2',
      runtimeVersion: '39.2.7',
      logFn: silent,
      warnFn: silent,
      errorFn: silent,
    },
  });

  assert.equal(result, runtimeCacheDir);
});

test('provisionBetterSqlite3: 缓存未命中时调用 buildFn 并把产物存入缓存', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const preparedDir = path.join(tempDir, 'native-modules', 'electron');
  let buildCalls = 0;

  const buildFn = () => {
    buildCalls += 1;
    fs.mkdirSync(path.join(preparedDir, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(preparedDir, 'build', 'Release', 'better_sqlite3.node'), 'native');
    fs.writeFileSync(
      path.join(preparedDir, '.iart-runtime.json'),
      JSON.stringify({ runtime: 'electron', includedRuntimeDependencies: ['bindings'] }),
    );
    return true;
  };

  const result = provisionBetterSqlite3({
    runtime: 'electron',
    platform: 'linux',
    arch: 'x64',
    buildFn,
    deps: {
      cacheDir,
      preparedDir,
      sqliteVersion: '12.6.2',
      runtimeVersion: '39.2.7',
      logFn: silent,
      warnFn: silent,
      errorFn: silent,
    },
  });

  assert.equal(buildCalls, 1);
  const expectedCacheDir = path.join(cacheDir, 'better-sqlite3', '12.6.2-electron-39.2.7-linux-x64');
  assert.equal(result, expectedCacheDir);
  assert.equal(
    fs.readFileSync(path.join(expectedCacheDir, 'build', 'Release', 'better_sqlite3.node'), 'utf-8'),
    'native',
  );
});

test('provisionBetterSqlite3: buildFn 失败返回 null', () => {
  const tempDir = makeTempDir();

  const result = provisionBetterSqlite3({
    runtime: 'node',
    platform: 'linux',
    arch: 'x64',
    buildFn: () => false,
    deps: {
      cacheDir: path.join(tempDir, 'cache'),
      sqliteVersion: '12.6.2',
      runtimeVersion: '22.0.0',
      logFn: silent,
      warnFn: silent,
      errorFn: silent,
    },
  });

  assert.equal(result, null);
});

test('activateBetterSqlite3: 复制到 native-modules 生效位置并重写元数据', () => {
  const tempDir = makeTempDir();
  const cacheDir = path.join(tempDir, 'cache');
  const targetDir = path.join(tempDir, 'native-modules', 'electron');
  const key = '12.6.2-electron-39.2.7-linux-x64';
  const runtimeCacheDir = path.join(cacheDir, 'better-sqlite3', key);
  fs.mkdirSync(path.join(runtimeCacheDir, 'build', 'Release'), { recursive: true });
  fs.writeFileSync(path.join(runtimeCacheDir, 'build', 'Release', 'better_sqlite3.node'), 'native');
  fs.writeFileSync(
    path.join(runtimeCacheDir, '.iart-runtime.json'),
    JSON.stringify({
      runtime: 'electron',
      copiedFrom: '/old/source',
      preparedAt: '2000-01-01T00:00:00.000Z',
      includedRuntimeDependencies: ['bindings', 'prebuild-install'],
    }),
  );

  const activated = activateBetterSqlite3({
    runtime: 'electron',
    platform: 'linux',
    arch: 'x64',
    deps: {
      cacheDir,
      targetDir,
      sqliteVersion: '12.6.2',
      runtimeVersion: '39.2.7',
      logFn: silent,
      warnFn: silent,
      errorFn: silent,
    },
  });

  assert.equal(activated, targetDir);
  assert.equal(
    fs.readFileSync(path.join(targetDir, 'build', 'Release', 'better_sqlite3.node'), 'utf-8'),
    'native',
  );
  const meta = JSON.parse(fs.readFileSync(path.join(targetDir, '.iart-runtime.json'), 'utf-8'));
  assert.equal(meta.copiedFrom, runtimeCacheDir);
  assert.notEqual(meta.preparedAt, '2000-01-01T00:00:00.000Z');
  assert.deepEqual(meta.includedRuntimeDependencies, ['bindings', 'prebuild-install']);
});

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 依赖缓存层：ffmpeg/better-sqlite3 二进制的唯一供给入口。
// provision* 保证 .cache/desktop-deps/ 中产物完整（下载/编译只发生在这里）；
// activate* 把缓存产物拷贝进生效位置（架构翻转 = 纯本地拷贝，零网络）。
// 下载走 curl 断点续传 + 双源 fallback，sha256 由 tooling/policies/desktop-deps.lock.json
// TOFU 固定（首次下载成功后写入，入库共享，跨机器一致）。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const log = (message) => console.log(`[desktop-deps-cache] ${message}`);
const warn = (message) => console.warn(`[desktop-deps-cache] ${message}`);
const error = (message) => console.error(`[desktop-deps-cache] ${message}`);

export const cacheRoot = () => path.join(repoRoot, '.cache', 'desktop-deps');

const defaultLockPath = () => path.join(repoRoot, 'tooling', 'policies', 'desktop-deps.lock.json');

export const loadLock = (lockPath = defaultLockPath()) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {
    // 锁文件缺失或损坏时按空锁处理（TOFU 会重新写入）。
  }
  return { schemaVersion: 1, entries: {} };
};

export const saveLock = (lock, lockPath = defaultLockPath()) => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
};

export const sha256File = (filePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

// 真实执行 ffmpeg 验证可用性（拦截无执行位与残缺二进制）。
export const probeFfmpegExecution = (ffmpegPath) => {
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

// darwin-only：读取 Mach-O 架构；非 macOS 或无 lipo 时返回空串。
export const fileMachoArch = (filePath) => {
  try {
    const result = spawnSync('lipo', ['-archs', filePath], {
      cwd: repoRoot,
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

// curl 断点续传下载器：按 urls 顺序尝试，写入 destPath.part 后 rename。
// expectedSha256 非空时逐源校验，不符删除该次下载并尝试下一源。
// 返回成功使用的 url；全部失败返回 false。
const defaultCurlRunner = (args) =>
  spawnSync('curl', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf-8' });

export const downloadWithMirrors = ({
  urls,
  destPath,
  expectedSha256 = '',
  runner = defaultCurlRunner,
  sha256 = sha256File,
  logFn = log,
  warnFn = warn,
}) => {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  for (const url of urls) {
    logFn(`下载: ${url}`);
    const result = runner(['-fSL', '-C', '-', '-o', partPath, url]);
    if (result.error || result.status !== 0) {
      const detail = result.error
        ? result.error.message
        : `exit=${result.status ?? 'null'} ${(result.stderr || '').trim()}`.trim();
      warnFn(`源失败: ${url}（${detail}）`);
      continue;
    }
    if (expectedSha256) {
      const actual = sha256(partPath);
      if (actual !== expectedSha256) {
        warnFn(`源 sha256 不符: ${url}（期望 ${expectedSha256}，实际 ${actual}），丢弃。`);
        fs.rmSync(partPath, { force: true });
        continue;
      }
    }
    fs.renameSync(partPath, destPath);
    return url;
  }
  return false;
};

export const ffmpegReleaseTag = (
  pkgPath = path.join(repoRoot, 'node_modules', 'ffmpeg-static', 'package.json'),
  env = process.env,
) => {
  if (env.FFMPEG_BINARY_RELEASE) return env.FFMPEG_BINARY_RELEASE;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const tag = pkg?.['ffmpeg-static']?.['binary-release-tag'];
  if (typeof tag !== 'string' || !tag) {
    throw new Error(`无法从 ${pkgPath} 读取 ffmpeg-static.binary-release-tag`);
  }
  return tag;
};

// ffmpeg 完整二进制大小下限。官方 ffmpeg-static b6.1.1 产物：darwin-arm64 约 45MB、
// darwin-x64 约 78MB、win32-x64 约 138MB。残缺/损坏样本观测到 1.5MB。
const FFMPEG_MIN_BYTES = 5_000_000;

const ffmpegBinaryName = (platform) => (platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const ffmpegCachePath = (cacheDir, tag, platform, arch) =>
  path.join(cacheDir, 'ffmpeg', tag, `${platform}-${arch}`, ffmpegBinaryName(platform));

const ffmpegLockKey = (tag, platform, arch) => `ffmpeg-static/${tag}/${platform}-${arch}`;

// 源顺序：env 显式覆盖 → npmmirror → GitHub 官方。
const ffmpegDownloadUrls = (tag, platform, arch, env) => {
  const suffix = `/${tag}/ffmpeg-${platform}-${arch}.gz`;
  const urls = [];
  if (env.FFMPEG_BINARIES_URL) {
    urls.push(`${String(env.FFMPEG_BINARIES_URL).replace(/\/+$/, '')}${suffix}`);
  }
  urls.push(`https://registry.npmmirror.com/-/binary/ffmpeg-static${suffix}`);
  urls.push(`https://github.com/eugeneware/ffmpeg-static/releases/download${suffix}`);
  return urls;
};

const validateFfmpegBinary = ({ binaryPath, platform, arch, machoArchs, execProbe, warnFn }) => {
  let size = 0;
  try {
    size = fs.statSync(binaryPath).size;
  } catch {
    warnFn(`ffmpeg 校验失败：无法读取 ${binaryPath}`);
    return false;
  }
  if (size < FFMPEG_MIN_BYTES) {
    warnFn(`ffmpeg 校验失败：文件过小（${size} bytes < ${FFMPEG_MIN_BYTES}，疑似残缺）`);
    return false;
  }
  if (platform === 'darwin') {
    const expected = arch === 'x64' ? 'x86_64' : 'arm64';
    const archs = machoArchs(binaryPath);
    if (!archs.includes(expected)) {
      warnFn(`ffmpeg 校验失败：架构不匹配（当前 ${archs || 'unknown'}，需要 ${expected}）`);
      return false;
    }
  }
  // 本机架构可真实执行探测；交叉产物无法在本机执行，大小+架构（darwin）即兜底。
  if (platform === process.platform && arch === process.arch) {
    const probe = execProbe(binaryPath);
    if (!probe.ok) {
      warnFn(`ffmpeg 校验失败：执行探测不通过（${probe.message}）`);
      return false;
    }
  }
  return true;
};

// 保证缓存中 ffmpeg 二进制完整并返回缓存路径；失败返回 null。
// 流程：锁文件有记录且缓存文件 sha256 匹配 → 命中；否则下载 → 校验 → TOFU 写锁。
export const provisionFfmpeg = ({ platform, arch, deps = {} }) => {
  const cacheDir = deps.cacheDir || cacheRoot();
  const lockPath = deps.lockPath || defaultLockPath();
  const download = deps.download || downloadWithMirrors;
  const sha256 = deps.sha256 || sha256File;
  const machoArchs = deps.machoArchs || fileMachoArch;
  const execProbe = deps.execProbe || probeFfmpegExecution;
  const env = deps.env || process.env;
  const logFn = deps.logFn || log;
  const warnFn = deps.warnFn || warn;
  const errorFn = deps.errorFn || error;

  let tag;
  try {
    tag = ffmpegReleaseTag(undefined, env);
  } catch (tagError) {
    errorFn(`${tagError instanceof Error ? tagError.message : String(tagError)}`);
    errorFn('请先执行 pnpm install，然后重试。');
    return null;
  }

  const cachePath = ffmpegCachePath(cacheDir, tag, platform, arch);
  const lockKey = ffmpegLockKey(tag, platform, arch);
  const lock = loadLock(lockPath);
  const entry = lock.entries[lockKey];

  if (entry && fs.existsSync(cachePath)) {
    if (sha256(cachePath) === entry.sha256) {
      logFn(`ffmpeg 缓存命中（${lockKey}）: ${cachePath}`);
      return cachePath;
    }
    warnFn(`ffmpeg 缓存文件 sha256 与锁文件不符，删除损坏缓存并重新下载: ${cachePath}`);
    fs.rmSync(cachePath, { force: true });
  }

  const gzPath = `${cachePath}.gz`;
  fs.rmSync(gzPath, { force: true });
  const usedUrl = download({
    urls: ffmpegDownloadUrls(tag, platform, arch, env),
    destPath: gzPath,
    logFn,
    warnFn,
  });
  if (!usedUrl) {
    errorFn(`ffmpeg 下载失败（${platform}-${arch}，所有源均不可用）。`);
    return null;
  }

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, zlib.gunzipSync(fs.readFileSync(gzPath)));
  } catch (gunzipError) {
    errorFn(`ffmpeg 解压失败: ${gunzipError instanceof Error ? gunzipError.message : String(gunzipError)}`);
    return null;
  } finally {
    fs.rmSync(gzPath, { force: true });
  }
  fs.chmodSync(cachePath, 0o755);

  if (!validateFfmpegBinary({ binaryPath: cachePath, platform, arch, machoArchs, execProbe, warnFn })) {
    errorFn(`ffmpeg 下载完成但完整性/架构校验不通过（${platform}-${arch}）。`);
    fs.rmSync(cachePath, { force: true });
    return null;
  }

  const actualSha256 = sha256(cachePath);
  if (entry && actualSha256 !== entry.sha256) {
    errorFn(`ffmpeg 下载内容 sha256 与锁文件不符（${lockKey}，期望 ${entry.sha256}，实际 ${actualSha256}）。`);
    errorFn('锁文件固定了首次下载内容；如确认上游产物已合法更新，请人工审查后更新锁文件。');
    fs.rmSync(cachePath, { force: true });
    return null;
  }
  if (!entry) {
    lock.entries[lockKey] = {
      sha256: actualSha256,
      source: usedUrl,
      recordedAt: new Date().toISOString(),
    };
    saveLock(lock, lockPath);
    logFn(`锁文件已记录 ${lockKey}（sha256 ${actualSha256}）`);
  }

  logFn(`ffmpeg 已就位（${platform}-${arch}）: ${cachePath}`);
  return cachePath;
};

// provision 后把缓存二进制复制到 node_modules/ffmpeg-static/ 并 chmod 755。
export const activateFfmpeg = ({ platform, arch, deps = {} }) => {
  const logFn = deps.logFn || log;
  const cachePath = provisionFfmpeg({ platform, arch, deps });
  if (!cachePath) return null;
  const targetPath =
    deps.targetPath ||
    path.join(repoRoot, 'node_modules', 'ffmpeg-static', ffmpegBinaryName(platform));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(cachePath, targetPath);
  fs.chmodSync(targetPath, 0o755);
  logFn(`ffmpeg 已激活（${platform}-${arch}）: ${targetPath}`);
  return targetPath;
};

const readPackageVersion = (pkgPath) =>
  JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;

// 缓存键组成：better-sqlite3 版本 + runtime 及其版本 + 平台架构。
// electron runtime 取 node_modules/electron 版本，node runtime 取 process.versions.node。
export const sqliteCacheKey = ({ runtime, platform, arch, deps = {} }) => {
  const sqliteVersion =
    deps.sqliteVersion ||
    readPackageVersion(path.join(repoRoot, 'node_modules', 'better-sqlite3', 'package.json'));
  const runtimeVersion =
    deps.runtimeVersion ||
    (runtime === 'electron'
      ? readPackageVersion(path.join(repoRoot, 'node_modules', 'electron', 'package.json'))
      : process.versions.node);
  return `${sqliteVersion}-${runtime}-${runtimeVersion}-${platform}-${arch}`;
};

const NATIVE_MODULE_RELATIVE = path.join('build', 'Release', 'better_sqlite3.node');

const preparedRuntimeDir = (runtime) =>
  path.join(repoRoot, 'apps', 'backend', 'native-modules', 'better-sqlite3', runtime);

// darwin 交叉编译时校验 .node 产物架构是否匹配目标。
const matchesTargetMachoArch = (modulePath, arch, machoArchs) => {
  const expected = arch === 'x64' ? 'x86_64' : 'arm64';
  return machoArchs(modulePath).includes(expected);
};

// 保证缓存中 better-sqlite3 隔离运行时完整并返回缓存目录；失败返回 null。
// 缓存命中（含 .node 产物与 .iart-runtime.json，darwin 交叉 lipo 校验架构）→ 直接返回；
// 未命中 → 调 buildFn()（既有 switch-abi 路径）→ 产物存入缓存。
export const provisionBetterSqlite3 = ({ runtime, platform, arch, buildFn, deps = {} }) => {
  const cacheDir = deps.cacheDir || cacheRoot();
  const machoArchs = deps.machoArchs || fileMachoArch;
  const logFn = deps.logFn || log;
  const warnFn = deps.warnFn || warn;
  const errorFn = deps.errorFn || error;

  const key = sqliteCacheKey({ runtime, platform, arch, deps });
  const runtimeCacheDir = path.join(cacheDir, 'better-sqlite3', key);
  const cachedModule = path.join(runtimeCacheDir, NATIVE_MODULE_RELATIVE);
  const darwinCross = platform === 'darwin' && arch !== process.arch;

  if (fs.existsSync(cachedModule) && fs.existsSync(path.join(runtimeCacheDir, '.iart-runtime.json'))) {
    if (!darwinCross || matchesTargetMachoArch(cachedModule, arch, machoArchs)) {
      logFn(`better-sqlite3 缓存命中（${key}）: ${runtimeCacheDir}`);
      return runtimeCacheDir;
    }
    warnFn(`better-sqlite3 缓存产物架构不符（${key}），重新编译。`);
  }

  if (typeof buildFn !== 'function') {
    errorFn(`better-sqlite3 缓存未命中（${key}）且未提供 buildFn，无法编译。`);
    return null;
  }
  if (!buildFn()) {
    errorFn(`better-sqlite3 编译失败（${key}）。`);
    return null;
  }

  const preparedDir = deps.preparedDir || preparedRuntimeDir(runtime);
  const builtModule = path.join(preparedDir, NATIVE_MODULE_RELATIVE);
  if (!fs.existsSync(builtModule)) {
    errorFn(`better-sqlite3 编译后未找到产物: ${builtModule}`);
    return null;
  }
  if (darwinCross && !matchesTargetMachoArch(builtModule, arch, machoArchs)) {
    errorFn(`better-sqlite3 编译完成但架构不匹配（${key}，当前 ${machoArchs(builtModule) || 'unknown'}）。`);
    return null;
  }

  fs.rmSync(runtimeCacheDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(runtimeCacheDir), { recursive: true });
  fs.cpSync(preparedDir, runtimeCacheDir, { recursive: true, dereference: true });
  logFn(`better-sqlite3 已存入缓存（${key}）: ${runtimeCacheDir}`);
  return runtimeCacheDir;
};

// provision 后把缓存目录复制到 apps/backend/native-modules/better-sqlite3/<runtime>/。
// 有意不恢复根 node_modules：ensure 探针与 electron-builder 打包均只消费 native-modules 副本。
export const activateBetterSqlite3 = ({ runtime, platform, arch, buildFn, deps = {} }) => {
  const logFn = deps.logFn || log;
  const runtimeCacheDir = provisionBetterSqlite3({ runtime, platform, arch, buildFn, deps });
  if (!runtimeCacheDir) return null;

  const targetDir = deps.targetDir || preparedRuntimeDir(runtime);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(runtimeCacheDir, targetDir, { recursive: true, dereference: true });

  // 恢复时重写 copiedFrom/preparedAt 保持元数据准确（无功能消费方）；
  // includedRuntimeDependencies 必须原样保留（verify 脚本消费）。
  const metaPath = path.join(targetDir, '.iart-runtime.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.copiedFrom = runtimeCacheDir;
    meta.preparedAt = new Date().toISOString();
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  } catch {
    // 元数据缺失或损坏时不阻断激活。
  }

  logFn(`better-sqlite3 已激活（${runtime}，${platform}-${arch}）: ${targetDir}`);
  return targetDir;
};

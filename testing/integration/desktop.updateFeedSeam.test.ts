// @vitest-environment node
/**
 * 更新链接缝测试：真实桥 + 真实 electron-updater + 假 HTTP 上游。
 *
 * 使命（批次 2「客户端指向切换」）：把「检查更新 → 检出 → 下载」主链首尾
 * 真实跑一遍（两端真实，只在外层挡掉网络）：
 *   真实 desktop-shell-updater.cjs 桥（dist 产物，桥内模块零 mock）
 *   → 真实 electron-updater（node_modules 真包，MacUpdater + ElectronHttpExecutor；
 *   其 electron.net.request 经 shim 落到真实 node http 客户端，仅做传输面适配）
 *   → 真实 HTTP 请求打到本机假上游（node http server 服务 latest-mac.yml + 假 zip，
 *   服务端捕获请求路径断言 generic provider 语义）
 *   → 检出更新（真实 semver 比较）→ 显式 startDownload 后 downloadUpdate 真实下载落盘；
 *   取消用例同样走真实 CancellationToken（慢速上游 → 下载中 cancel → 回到 available）。
 *
 * 契约 parse：状态快照经 AppUpdateStateSchema.parse（桥内真实执行）后断言。
 *
 * 桥内单例隔离：真实 electron-updater 的 autoUpdater 是模块级单例，每次装配前清除其
 * require 缓存，避免上一次的 configOnDisk / 已下载缓存污染下一条用例。
 *
 * 配置事实源钉扎：根 package.json build.publish.url 必须等于公开仓 GitHub
 * latest/download 地址（批次 2 终态）。打包态该值由 electron-builder 写入
 * Resources/app-update.yml，dev 态由桥从根 package.json 读取——本测试的
 * app-update.yml 夹具镜像同一份 publish 配置形状（provider/url），真实
 * electron-updater 与真实桥读取的是同一份文件。
 *
 * 红态自证：切换前运行本文件，配置钉扎断言（it 1）应失败；链路测试（it 2）
 * 不受切换影响（上游是本机假服务）。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { AppUpdateState } from '@iart/contracts';
import {
  cjsRequireAs,
  clearCjsCache,
  patchModuleLoad,
  sharedRequire,
} from './helpers/cjs-mock';

const updaterWrapperPath = path.join(process.cwd(), 'apps/desktop-shell/dist/desktop-shell-updater.cjs');
const bridgePath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/electron-updater-bridge.cjs');
const updateStatePath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/app-update-state.cjs');
const pendingPath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/app-update-pending.cjs');
const logPath = path.join(process.cwd(), 'apps/desktop-shell/dist/update/app-update-log.cjs');

// ── 批次 2 终态：配置事实源钉扎 ──

const GITHUB_LATEST_DOWNLOAD_URL = 'https://github.com/tf961656585/IArt/releases/latest/download';

// ── 最小合法 zip（stored 单条目，无外部依赖，字节确定性）──

const crc32 = (buf: Buffer): number => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
};

const u16 = (value: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
};
const u32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
};

/** 单条目 stored zip：local file header + 内容 + central directory + EOCD。 */
const buildMinimalStoredZip = (entryName: string, content: Buffer): Buffer => {
  const name = Buffer.from(entryName, 'utf8');
  const crc = crc32(content);
  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20), // version needed
    u16(0), // flags
    u16(0), // method: stored
    u16(0), // mod time
    u16(0), // mod date
    u32(crc),
    u32(content.length),
    u32(content.length),
    u16(name.length),
    u16(0), // extra len
    name,
    content,
  ]);
  const centralDirectory = Buffer.concat([
    u32(0x02014b50),
    u16(20), // version made by
    u16(20), // version needed
    u16(0), // flags
    u16(0), // method
    u16(0), // mod time
    u16(0), // mod date
    u32(crc),
    u32(content.length),
    u32(content.length),
    u16(name.length),
    u16(0), // extra len
    u16(0), // comment len
    u16(0), // disk number
    u16(0), // internal attrs
    u32(0), // external attrs
    u32(0), // local header offset
    name,
  ]);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk
    u16(0), // cd disk
    u16(1), // entries (this disk)
    u16(1), // entries (total)
    u32(centralDirectory.length),
    u32(localHeader.length),
    u16(0), // comment len
  ]);
  return Buffer.concat([localHeader, centralDirectory, eocd]);
};

// ── 假 HTTP 上游 ──

type FakeUpstream = {
  base: string;
  servedPaths: string[];
  /** 慢速安装包传输在完整写出前被客户端关闭连接（取消 → abort 生效）时置位。 */
  readonly downloadAborted: boolean;
  close: () => Promise<void>;
};

const startFakeUpstream = async (
  ymlBody: string,
  zipName: string,
  zipBytes: Buffer,
  options?: { slowZip: boolean },
): Promise<FakeUpstream> => {
  const servedPaths: string[] = [];
  let downloadAborted = false;
  let slowTimer: NodeJS.Timeout | null = null;
  const stopSlowTimer = (): void => {
    if (slowTimer !== null) {
      clearInterval(slowTimer);
      slowTimer = null;
    }
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    servedPaths.push(pathname);
    if (pathname.endsWith('/latest-mac.yml')) {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(ymlBody);
      return;
    }
    if (pathname.endsWith(`/${zipName}`)) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBytes.length) });
      if (!options?.slowZip) {
        res.end(zipBytes);
        return;
      }
      // 慢速传输：首块立即写出，其余按 4KB / 100ms 推进，给取消留出真实传输窗口。
      const chunkSize = 4096;
      let offset = Math.min(chunkSize, zipBytes.length);
      res.write(zipBytes.subarray(0, offset));
      // 取消生效的判据：连接关闭时响应尚未完整写出（客户端 abort 而非正常传完）。
      req.on('aborted', () => {
        downloadAborted = true;
      });
      res.on('close', () => {
        stopSlowTimer();
        if (!res.writableEnded) downloadAborted = true;
      });
      slowTimer = setInterval(() => {
        if (offset >= zipBytes.length) {
          stopSlowTimer();
          res.end();
          return;
        }
        res.write(zipBytes.subarray(offset, offset + chunkSize));
        offset += chunkSize;
      }, 100);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('update feed fake upstream did not listen on a tcp port');
  }
  return {
    base: `http://127.0.0.1:${address.port}/releases`,
    servedPaths,
    get downloadAborted() {
      return downloadAborted;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        stopSlowTimer();
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

// ── 装配 ──

const sha512Base64 = (bytes: Buffer): string => crypto.createHash('sha512').update(bytes).digest('base64');

type UpdaterControllerLike = {
  setupAutoUpdater: () => void;
  checkForUpdates: (manual: boolean | undefined) => Promise<{
    status: string;
    reason?: string;
    state: AppUpdateState;
  }>;
  startDownload: () => Promise<{
    status: string;
    reason?: string;
    state: AppUpdateState;
  }>;
  cancelDownload: () => Promise<{
    status: string;
    reason?: string;
    state: AppUpdateState;
  }>;
  buildUpdateStateSnapshot: () => AppUpdateState;
};

type MainWindowLike = {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
};

type UpdaterModule = {
  createUpdaterController: (options: {
    getMainWindow: () => MainWindowLike | null;
    setAllowQuit: (value: boolean) => void;
  }) => UpdaterControllerLike;
  resolveUpdatePublishUrl: () => string;
};

type LoadedSeam = {
  controller: UpdaterControllerLike;
  resolveUpdatePublishUrl: () => string;
  upstream: FakeUpstream;
  mainWindow: MainWindowLike;
  zipBytes: Buffer;
  zipName: string;
  tempRoot: string;
  restore: () => void;
};

let loaded: LoadedSeam | null = null;

// 真实 electron-updater 的 autoUpdater 是模块级单例：不重建的话，第二次装配会复用
// 上一次的 configOnDisk / updateInfoAndProvider / 下载缓存，让「取消」用例看到上一次的已完成下载。
const clearElectronUpdaterCache = (): void => {
  const resolved = sharedRequire.resolve('electron-updater', {
    paths: [path.join(process.cwd(), 'apps/desktop-shell')],
  });
  const packageRoot = path.dirname(resolved);
  const builderUtilRoot = path.sep + 'builder-util-runtime' + path.sep;
  for (const cacheKey of Object.keys(sharedRequire.cache)) {
    if (cacheKey.startsWith(packageRoot) || cacheKey.includes(builderUtilRoot)) {
      delete sharedRequire.cache[cacheKey];
    }
  }
};

let seamLoadCount = 0;
const loadedSeams: LoadedSeam[] = [];

/** 装配真实桥 + 真实 electron-updater + 本机假上游；返回后即可走 checkForUpdates。 */
const loadSeam = async (options?: { slowZip?: boolean }): Promise<LoadedSeam> => {
  seamLoadCount += 1;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-update-feed-seam-'));
  const originalHome = process.env['HOME'] ?? '';
  const fakeHome = path.join(tempRoot, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env['HOME'] = fakeHome;

  const fakeElectronApp = {
    isPackaged: true,
    getVersion: () => '0.5.0',
    getName: () => 'IARTStudio',
    getPath: (name: string) =>
      name === 'logs' ? path.join(tempRoot, 'logs') : path.join(tempRoot, 'userData'),
    getAppPath: () => path.join(tempRoot, 'appRoot'),
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    once: vi.fn(),
  };
  // MacUpdater 构造时 require("electron").autoUpdater 并只挂事件监听；
  // autoInstallOnAppQuit=false 路径不会调用 checkForUpdates。
  const nativeAutoUpdaterMock = {
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
  };
  // electron.net.request → 真实 node http：electron-updater 的 ElectronHttpExecutor
  // 把所有请求（yml 与安装包）都交给 net.request；这里只做传输面适配，
  // 请求语义（URL 解析、重定向处理、校验）全部留在真实 electron-updater 内。
  const netRequestShim = (options: Record<string, unknown>): http.ClientRequest => {
    const { session: _session, redirect: _redirect, useSessionCookies: _useSessionCookies, ...rest } = options;
    const request = http.request(rest as Parameters<typeof http.request>[0]);
    if (typeof (request as { abort?: unknown }).abort !== 'function') {
      (request as { abort?: () => void }).abort = () => {
        request.destroy(new Error('request aborted'));
      };
    }
    return request;
  };

  // 打包态夹具：electron-builder 会把根 package.json build.publish 写入
  // Resources/app-update.yml；此处镜像同一形状（provider/url/updaterCacheDirName），
  // 真实 electron-updater 与真实桥读取同一份文件。
  const resourcesDir = path.join(tempRoot, 'resources');
  fs.mkdirSync(resourcesDir, { recursive: true });

  const archSuffix = process.arch === 'arm64' ? 'arm64' : 'x64';
  const zipName = `IARTStudio-0.7.0-mac-${archSuffix}.zip`;
  // 慢速取消用例需要足够长的传输窗口；普通用例用最小载荷。
  const payloadSize = options?.slowZip ? 96 * 1024 : 'IARTStudio update feed seam payload\n'.length;
  const zipContent = options?.slowZip
    ? Buffer.alloc(payloadSize, 'i')
    : Buffer.from('IARTStudio update feed seam payload\n', 'utf8');
  const zipBytes = buildMinimalStoredZip('IARTStudio.app/Contents/Info.plist', zipContent);
  const zipSha512 = sha512Base64(zipBytes);
  const ymlBody = [
    'provider: generic',
    `updaterCacheDirName: iart-update-feed-seam-${seamLoadCount}-${Date.now().toString(36)}`,
    'url: REPLACE_FEED_BASE',
    'version: 0.7.0',
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${zipSha512}`,
    `    size: ${zipBytes.length}`,
    `path: ${zipName}`,
    `sha512: ${zipSha512}`,
    "releaseDate: '2026-10-13T00:00:00.000Z'",
    '',
  ].join('\n');

  const upstream = await startFakeUpstream(ymlBody, zipName, zipBytes, { slowZip: options?.slowZip ?? false });
  fs.writeFileSync(
    path.join(resourcesDir, 'app-update.yml'),
    ymlBody.replace('REPLACE_FEED_BASE', upstream.base),
    'utf8',
  );

  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesDir,
    configurable: true,
    writable: true,
  });

  const restoreModuleLoad = patchModuleLoad({
    electron: {
      app: fakeElectronApp,
      shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
      autoUpdater: nativeAutoUpdaterMock,
      session: { fromPartition: () => ({}) },
      net: { request: netRequestShim },
    },
  });

  const restore = (): void => {
    restoreModuleLoad();
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
    } else {
      Reflect.deleteProperty(process, 'resourcesPath');
    }
    if (originalHome !== '') {
      process.env['HOME'] = originalHome;
    } else {
      delete process.env['HOME'];
    }
  };

  clearCjsCache(updaterWrapperPath);
  clearCjsCache(bridgePath);
  clearCjsCache(updateStatePath);
  clearCjsCache(pendingPath);
  clearCjsCache(logPath);
  clearElectronUpdaterCache();

  const mod = cjsRequireAs<UpdaterModule>(sharedRequire(updaterWrapperPath));
  const mainWindow: MainWindowLike = {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  };
  const controller = mod.createUpdaterController({
    getMainWindow: () => mainWindow,
    setAllowQuit: () => undefined,
  });
  controller.setupAutoUpdater();

  const seam: LoadedSeam = {
    controller,
    resolveUpdatePublishUrl: mod.resolveUpdatePublishUrl,
    upstream,
    mainWindow,
    zipBytes,
    zipName,
    tempRoot,
    restore,
  };
  loadedSeams.push(seam);
  return seam;
};

/** 轮询等待异步事实成立（TCP 连接关闭在服务端是异步到达的）。 */
const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

/** 等待桥状态机落到目标状态（下载由显式 startDownload 驱动，桥内不再自动下载）。 */
const waitForState = async (
  controller: UpdaterControllerLike,
  target: AppUpdateState['status'],
  timeoutMs = 15_000,
): Promise<AppUpdateState> => {
  const deadline = Date.now() + timeoutMs;
  let last: AppUpdateState = controller.buildUpdateStateSnapshot();
  while (Date.now() < deadline) {
    last = controller.buildUpdateStateSnapshot();
    if (last.status === target) return last;
    if (last.status === 'error') {
      throw new Error(`updater entered error state: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for state ${target}, last=${JSON.stringify(last)}`);
};

describe('更新链 generic provider 接缝（真实桥 + 真实 electron-updater + 本机假上游）', () => {
  it('根 package.json build.publish 指向公开仓 GitHub latest/download（配置事实源钉扎）', () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      build?: { publish?: { provider?: string; url?: string } };
    };
    expect(pkg.build?.publish?.provider).toBe('generic');
    expect(pkg.build?.publish?.url).toBe(GITHUB_LATEST_DOWNLOAD_URL);
  });

  it.skipIf(process.platform !== 'darwin')(
    '检查→检出→下载全链：真实桥装配后按 generic provider 请求 latest-mac.yml 并真实下载落盘',
    async () => {
      loaded = await loadSeam();
      const { controller, upstream, zipBytes, zipName, resolveUpdatePublishUrl } = loaded;

      // 桥的发布地址读取路径与真实 electron-updater 同源（同一份 app-update.yml）。
      expect(resolveUpdatePublishUrl()).toBe(upstream.base);

      const checkResult = await controller.checkForUpdates(false);
      expect(checkResult.status).toBe('success');
      // 发现更新只停在 available：不自动下载。
      expect(controller.buildUpdateStateSnapshot().status).toBe('available');

      const downloadResult = await controller.startDownload();
      expect(downloadResult.status).toBe('success');

      const state = await waitForState(controller, 'downloaded');
      // 状态经 AppUpdateStateSchema.parse（桥内真实执行）后断言。
      expect(state.status).toBe('downloaded');
      if (state.status !== 'downloaded') {
        throw new Error('unreachable');
      }
      expect(state.latestVersion).toBe('0.7.0');
      expect(path.basename(state.downloadPath)).toBe(zipName);

      // generic provider 语义：向 <base>/latest-mac.yml 发起真实请求（服务端捕获路径）。
      expect(upstream.servedPaths.some((p) => p.endsWith('/releases/latest-mac.yml'))).toBe(true);
      // 安装包本体也被真实请求过。
      expect(upstream.servedPaths.some((p) => p.endsWith(`/${zipName}`))).toBe(true);

      // 下载落盘的字节与上游服务的字节一致，且与清单 sha512（base64）一致：
      // 真实网络往返后的完整性校验。
      const downloadedBytes = fs.readFileSync(state.downloadPath);
      expect(downloadedBytes.equals(zipBytes)).toBe(true);
      expect(crypto.createHash('sha512').update(downloadedBytes).digest('base64')).toBe(
        sha512Base64(zipBytes),
      );
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    '下载中取消接缝：真实 CancellationToken 使下载立即结束并回到 available（无 error、不写 pending）',
    async () => {
      loaded = await loadSeam({ slowZip: true });
      const { controller, upstream, mainWindow, tempRoot } = loaded;

      const checkResult = await controller.checkForUpdates(false);
      expect(checkResult.status).toBe('success');
      expect(controller.buildUpdateStateSnapshot().status).toBe('available');

      const downloadPromise = controller.startDownload();
      await waitForState(controller, 'downloading', 10_000);
      // 给真实传输留出窗口：确保上游已经收到安装包请求并开始分块写。
      await new Promise((resolve) => setTimeout(resolve, 300));
      // 上游确实在传输安装包（取消发生在传输途中，而不是请求发起前）。
      expect(upstream.servedPaths.some((p) => p.endsWith(`/${loaded?.zipName ?? ''}`))).toBe(true);

      const cancelResult = await controller.cancelDownload();
      const downloadResult = await downloadPromise;

      expect(cancelResult.status).toBe('success');
      expect(cancelResult.state.status).toBe('available');
      expect(downloadResult.status).toBe('skipped');
      if (downloadResult.status === 'skipped') {
        expect(downloadResult.reason).toBe('download-cancelled');
      }

      // 真中止：服务端必须观察到连接在完整写出前被关闭，而不是继续把字节传完。
      const aborted: boolean = await waitUntil(() => upstream.downloadAborted, 5_000);
      expect(aborted).toBe(true);

      // 取消后不会「稍后完成」再翻回 downloaded：慢速上游此刻远未传完。
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(controller.buildUpdateStateSnapshot().status).toBe('available');

      // 取消不算失败：不产生 error 事件，也不产生 downloaded 事件；不写 pending。
      const sentEvents = mainWindow.webContents.send.mock.calls
        .filter((call) => (call[0] as unknown) === 'app-update:event')
        .map((call) => (call[1] as { type: string }).type);
      expect(sentEvents).not.toContain('error');
      expect(sentEvents).not.toContain('downloaded');
      expect(fs.existsSync(path.join(tempRoot, 'userData', 'pending-update.json'))).toBe(false);
    },
    20_000,
  );

  afterAll(async () => {
    // LIFO 恢复：每次 loadSeam 记录的原始 resourcesPath / HOME 是上一次装配的值。
    for (const seam of [...loadedSeams].reverse()) {
      seam.restore();
      await seam.upstream.close().catch(() => undefined);
      fs.rmSync(seam.tempRoot, { recursive: true, force: true });
    }
    loadedSeams.length = 0;
    loaded = null;
  });
});

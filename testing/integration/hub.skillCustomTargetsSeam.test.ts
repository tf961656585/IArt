// @vitest-environment jsdom
/**
 * Skill 商店「自定义安装目标」跨层接缝集成测试。
 *
 * 使命：把新功能主链首尾真实接起来跑一遍（两端真实，只在最外层挡掉传输与外网）：
 *   Hub 渲染进程平台桥（真实 apps/hub/src/client/platform/electron-bridge.ts 的管理方法
 *   与 install/reveal/state）→ IPC 传输（替身：真实 dist/preload.cjs 暴露的
 *   window.electron，假 ipcRenderer.invoke 捕获转发到假 ipcMain 的 handler 捕获表）
 *   → 主进程 handler（真实 dist/skill-store/skill-store-ipc.cjs 注册的 handler）
 *   → 注册表 store（真实 skill-install-targets-store.cjs，HOME 指向临时目录，不污染真实 HOME）
 *   → installer（真实 skill-store-installer.cjs，bundle 从本机 http 服务取，零外网请求）
 *   → 真实磁盘写入 → 状态扫描回读。
 *
 * 输入全部来自真实链路源头：安装请求的 target 取自真实桥 add 返回的注册表条目，
 * sha512 取自本地服务实际服务的字节；所有断言对象都是经桥侧 contracts schema parse 后的值。
 * 目录选取（select-folder 系统选择框）不在本接缝范围（docs/hub/skill-store.md §3.2）。
 *
 * update 为全量提交 { id, name, skillsDir }（2026-10-16 批次）：本文件覆盖改名（同目录
 * 自排除）、改路径（旧目录文件保留、扫描/定位随新目录解析）、`~` 展开持久化，以及
 * handler 层缺 skillsDir 的负例（证明新字段是必经路径而非可选装饰）。
 *
 * 加载机制照 testing/integration 既有先例（desktop.preloadBridge.test.ts /
 * desktop.mainProcessEditorOpen.test.ts）：desktop-shell 侧经 sharedRequire 加载 dist 产物，
 * electron 以 patchModuleLoad 替身注入；Hub 侧直接 import 真实桥 TS 源码（与
 * apps/hub/src/client/platform/__tests__/electron-bridge-skill-targets.test.ts 先例一致）。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SKILL_IPC_CHANNELS, type SkillInstallRequest } from '@iart/contracts';
import { createHubPlatformBridge } from '../../apps/hub/src/client/platform/electron-bridge';
import { cast, clearCjsCache, patchModuleLoad, sharedRequire } from './helpers/cjs-mock';

const preloadPath = path.join(process.cwd(), 'apps/desktop-shell/dist/preload.cjs');
const skillStoreIpcPath = path.join(
  process.cwd(),
  'apps/desktop-shell/dist/skill-store/skill-store-ipc.cjs',
);

// ── 被安装的 bundle（本地 http 服务真实服务的字节，sha512 按所服务字节计算）──

const SKILL_ID = 'seam-demo-skill';
const SKILL_VERSION = '1.2.3';
const SKILL_JSON_CONTENT = JSON.stringify({ id: SKILL_ID, version: SKILL_VERSION });
const RUN_SH_CONTENT = '#!/bin/sh\necho seam-demo\n';
const demoBundle = {
  id: SKILL_ID,
  version: SKILL_VERSION,
  files: [
    { path: 'skill.json', content: SKILL_JSON_CONTENT, executable: false },
    { path: 'run.sh', content: RUN_SH_CONTENT, executable: true },
  ],
};
const bundleBytes = Buffer.from(JSON.stringify(demoBundle), 'utf8');
const bundleSha512 = crypto.createHash('sha512').update(bundleBytes).digest('hex');

// ── 假 IPC 传输：ipcRenderer.invoke 捕获转发到 ipcMain.handle 捕获表 ──

type MainHandler = (event: unknown, payload: unknown) => unknown;
const mainHandlers = new Map<string, MainHandler>();

const fakeInvoke = async (channel: string, payload?: unknown): Promise<unknown> => {
  const handler = mainHandlers.get(channel);
  if (handler === undefined) {
    if (channel.startsWith('skills:')) {
      // skills 通道是本接缝的被测传输面：未注册即接缝断裂，按真实 Electron 语义以异常拒绝。
      throw new Error(`No handler registered for '${channel}'`);
    }
    // preload 装载期对无关通道的探活（如 get-editor-bootstrap，preload.cts 顶部 void 调用）
    // 不在本接缝范围，回空避免无关未处理拒绝（先例 desktop.preloadBridge.test.ts 回 null）。
    return null;
  }
  return await handler({}, payload);
};

type ExposedElectronApi = Record<string, unknown>;

/** 加载真实 dist/preload.cjs，捕获 exposeInMainWorld 暴露的 window.electron。 */
const loadRealPreloadWithFakeIpcRenderer = (): ExposedElectronApi => {
  let exposed: ExposedElectronApi | null = null;
  const restore = patchModuleLoad({
    electron: {
      contextBridge: {
        exposeInMainWorld: (name: string, api: ExposedElectronApi) => {
          if (name === 'electron') {
            exposed = api;
          }
        },
      },
      ipcRenderer: {
        invoke: fakeInvoke,
        send: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      webUtils: { getPathForFile: vi.fn() },
    },
  });
  try {
    clearCjsCache(preloadPath);
    sharedRequire(preloadPath);
  } finally {
    restore();
  }
  if (exposed === null) {
    throw new Error('preload.cjs did not expose window.electron');
  }
  return exposed;
};

const shellShowItemInFolder = vi.fn();

/** 加载真实 dist/skill-store/skill-store-ipc.cjs，把 handler 注册进假 ipcMain 捕获表。 */
const loadRealSkillStoreIpcHandlers = (): void => {
  const restore = patchModuleLoad({
    electron: {
      ipcMain: {
        handle: (channel: string, handler: MainHandler) => {
          mainHandlers.set(channel, handler);
        },
        on: vi.fn(),
      },
      shell: {
        showItemInFolder: shellShowItemInFolder,
        openExternal: vi.fn(async () => true),
      },
      net: {
        // skill 下载经 IPC 层注入 net.fetch 搭 default session（代理治理 PROXY-003）；
        // 假 electron 把 net.fetch 映射到 Node 全局 fetch，请求仍打到本机 bundle 服务。
        fetch: (input: string | URL, init?: RequestInit) => fetch(input, init),
      },
    },
  });
  try {
    clearCjsCache(skillStoreIpcPath);
    const mod = cast<{ registerSkillStoreIpcHandlers: () => void }>(
      sharedRequire(skillStoreIpcPath),
    );
    mod.registerSkillStoreIpcHandlers();
  } finally {
    restore();
  }
};

// ── 临时 HOME 隔离与本机 bundle 服务 ──

const tmpRoot = path.join(os.tmpdir(), `iart-skill-targets-seam-${process.pid}-${Date.now()}`);
const fakeHome = path.join(tmpRoot, 'home');
const customSkillsDir = path.join(tmpRoot, 'dsh-skills');
const expectedSkillsDir = path.resolve(customSkillsDir);
const expectedInstallDir = path.join(expectedSkillsDir, SKILL_ID);
// 恒不可能与注册表生成的 custom-<8 位 hex> 撞名（长度不同），且符合 id 格式
const unknownTargetId = 'custom-not-registered-anywhere';

let originalHome = '';
let originalUserProfile = '';
let httpServer: http.Server | null = null;
let bundleUrlBase = '';
let serverHits = 0;

const bridge = createHubPlatformBridge();

let firstTargetId = '';
let currentTargetId = '';

beforeAll(async () => {
  originalHome = process.env['HOME'] ?? '';
  originalUserProfile = process.env['USERPROFILE'] ?? '';
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env['HOME'] = fakeHome;
  process.env['USERPROFILE'] = fakeHome;

  const exposedApi = loadRealPreloadWithFakeIpcRenderer();
  (window as { electron?: unknown }).electron = exposedApi;
  loadRealSkillStoreIpcHandlers();

  await new Promise<void>((resolve) => {
    const server = http.createServer((_req, res) => {
      serverHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(bundleBytes);
    });
    server.listen(0, '127.0.0.1', () => {
      httpServer = server;
      resolve();
    });
  });
  const address = httpServer?.address();
  if (address === undefined || address === null || typeof address === 'string') {
    throw new Error('skill bundle http server did not listen on a tcp port');
  }
  bundleUrlBase = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  (window as { electron?: unknown }).electron = undefined;
  if (originalHome !== '') {
    process.env['HOME'] = originalHome;
  } else {
    delete process.env['HOME'];
  }
  if (originalUserProfile !== '') {
    process.env['USERPROFILE'] = originalUserProfile;
  } else {
    delete process.env['USERPROFILE'];
  }
  await new Promise<void>((resolve, reject) => {
    if (httpServer === null) {
      resolve();
      return;
    }
    httpServer.closeIdleConnections?.();
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Skill 自定义安装目标接缝（真实桥 → 假 IPC 传输 → 真实 handler/store/installer → 临时 HOME 磁盘）', () => {
  it('场景1：add → install（本机 bundle）→ 状态扫描全链跑通', async () => {
    const addResult = await bridge.addCustomSkillInstallTarget('dsh', customSkillsDir);
    if (!addResult.ok) {
      throw new Error('add custom target should succeed');
    }
    expect(addResult.target.name).toBe('dsh');
    expect(addResult.target.skillsDir).toBe(expectedSkillsDir);
    expect(addResult.target.id).toMatch(/^custom-[0-9a-f]{8}$/);
    firstTargetId = addResult.target.id;
    currentTargetId = firstTargetId;

    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual({
      targets: [{ id: firstTargetId, name: 'dsh', skillsDir: expectedSkillsDir }],
    });

    // 安装请求的 target 来自真实 add 返回的注册表条目，sha512 来自本地服务实际服务的字节
    const installRequest: SkillInstallRequest = {
      bundleUrl: `${bundleUrlBase}/bundles/${SKILL_ID}.json`,
      sha512: bundleSha512,
      target: firstTargetId,
      skillId: SKILL_ID,
    };
    await expect(bridge.installSkill(installRequest)).resolves.toEqual({
      ok: true,
      installedPath: expectedInstallDir,
    });

    // 真实磁盘写入：内容与可执行位
    expect(fs.readFileSync(path.join(expectedInstallDir, 'skill.json'), 'utf8')).toBe(
      SKILL_JSON_CONTENT,
    );
    expect(fs.statSync(path.join(expectedInstallDir, 'run.sh')).mode & 0o111).toBe(0o111);

    // 状态扫描回读：临时 HOME 下内置目录不存在，唯一条目来自自定义目标
    await expect(bridge.getSkillInstalledState()).resolves.toEqual({
      skills: [{ skillId: SKILL_ID, version: SKILL_VERSION, target: firstTargetId }],
    });

    // 定位链经自定义注册表回退解析，且真实触达 shell 定位
    await expect(
      bridge.revealSkillInstallFolder({ skillId: SKILL_ID, target: firstTargetId }),
    ).resolves.toEqual({ ok: true, path: expectedInstallDir });
    expect(shellShowItemInFolder).toHaveBeenCalledWith(expectedInstallDir);
  });

  it('场景2：防呆错误码经真实桥全链返回（duplicate/nested/reserved）', async () => {
    await expect(bridge.addCustomSkillInstallTarget('另一名字', customSkillsDir)).resolves.toEqual({
      ok: false,
      error: 'duplicate-dir',
    });
    // 内置 agents 目标的 skills 目录等价物（临时 HOME 下）
    await expect(
      bridge.addCustomSkillInstallTarget('内置同名', path.join(fakeHome, '.agents', 'skills')),
    ).resolves.toEqual({ ok: false, error: 'duplicate-dir' });
    await expect(
      bridge.addCustomSkillInstallTarget('内置父目录', path.join(fakeHome, '.agents')),
    ).resolves.toEqual({ ok: false, error: 'nested-dir' });
    await expect(
      bridge.addCustomSkillInstallTarget('app 数据目录', path.join(fakeHome, '.iart-studio-dev')),
    ).resolves.toEqual({ ok: false, error: 'reserved-dir' });

    // 被拒的 add 不产生注册表条目、不创建目录（防呆先于落盘）
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual({
      targets: [{ id: firstTargetId, name: 'dsh', skillsDir: expectedSkillsDir }],
    });
    expect(fs.existsSync(path.join(fakeHome, '.agents'))).toBe(false);
  });

  it('场景3：remove 只摘注册表不删文件；重登记同目录自动重新识别已装 skill', async () => {
    await expect(bridge.removeCustomSkillInstallTarget(firstTargetId)).resolves.toEqual({
      ok: true,
    });
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual({ targets: [] });
    await expect(bridge.getSkillInstalledState()).resolves.toEqual({ skills: [] });

    // 磁盘文件保留（用户数据不删）
    expect(fs.existsSync(path.join(expectedInstallDir, 'skill.json'))).toBe(true);

    // 重新登记同一目录，不重装即被扫描重新识别（自愈）
    const reAdd = await bridge.addCustomSkillInstallTarget('dsh', customSkillsDir);
    if (!reAdd.ok) {
      throw new Error('re-add should succeed');
    }
    expect(reAdd.target.id).not.toBe(firstTargetId);
    currentTargetId = reAdd.target.id;
    await expect(bridge.getSkillInstalledState()).resolves.toEqual({
      skills: [{ skillId: SKILL_ID, version: SKILL_VERSION, target: currentTargetId }],
    });

    // 已移除的旧 id 按注册表未命中处理（not-found）
    await expect(
      bridge.updateCustomSkillInstallTarget(firstTargetId, 'x', expectedSkillsDir),
    ).resolves.toEqual({
      ok: false,
      error: 'not-found',
    });
    await expect(bridge.removeCustomSkillInstallTarget(firstTargetId)).resolves.toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('场景4：unknown-target 容错——install 明确拒绝且不发起任何下载', async () => {
    const hitsBefore = serverHits;
    await expect(
      bridge.installSkill({
        bundleUrl: `${bundleUrlBase}/bundles/${SKILL_ID}.json`,
        sha512: bundleSha512,
        target: unknownTargetId,
        skillId: SKILL_ID,
      }),
    ).resolves.toEqual({ ok: false, error: 'unknown-target' });
    expect(serverHits).toBe(hitsBefore);

    await expect(
      bridge.revealSkillInstallFolder({ skillId: SKILL_ID, target: unknownTargetId }),
    ).resolves.toEqual({ ok: false, reason: 'unknown-target' });
  });

  it('场景5：改名（同目录自排除）——name 已改、id/skillsDir 不变、安装状态不受影响', async () => {
    await expect(
      bridge.updateCustomSkillInstallTarget(currentTargetId, 'dsh-renamed', expectedSkillsDir),
    ).resolves.toEqual({
      ok: true,
      target: { id: currentTargetId, name: 'dsh-renamed', skillsDir: expectedSkillsDir },
    });
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual({
      targets: [{ id: currentTargetId, name: 'dsh-renamed', skillsDir: expectedSkillsDir }],
    });

    // 同目录自排除：改到目标自身已占用的目录不报 duplicate-dir；id 与安装状态原样
    await expect(bridge.getSkillInstalledState()).resolves.toEqual({
      skills: [{ skillId: SKILL_ID, version: SKILL_VERSION, target: currentTargetId }],
    });
    expect(fs.existsSync(path.join(expectedInstallDir, 'skill.json'))).toBe(true);
  });

  it('场景6：改路径——注册表指向新目录，旧目录文件保留，扫描/定位随新目录解析', async () => {
    const movedSkillsDir = path.join(tmpRoot, 'dsh-skills-moved');
    const expectedMovedDir = path.resolve(movedSkillsDir);

    await expect(
      bridge.updateCustomSkillInstallTarget(currentTargetId, 'dsh-renamed', movedSkillsDir),
    ).resolves.toEqual({
      ok: true,
      target: { id: currentTargetId, name: 'dsh-renamed', skillsDir: expectedMovedDir },
    });
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual({
      targets: [{ id: currentTargetId, name: 'dsh-renamed', skillsDir: expectedMovedDir }],
    });

    // 不搬移文件：旧目录里已装的 Skill 文件仍在磁盘；新目录按未安装（无 <skillId> 子目录）
    expect(fs.existsSync(path.join(expectedInstallDir, 'skill.json'))).toBe(true);
    expect(fs.existsSync(path.join(expectedInstallDir, 'run.sh'))).toBe(true);
    expect(fs.existsSync(path.join(expectedMovedDir, SKILL_ID))).toBe(false);
    await expect(bridge.getSkillInstalledState()).resolves.toEqual({ skills: [] });

    // 定位按新目录解析：旧目录有文件却不再被解析到（若仍指旧目录，这里会返回 ok）
    const revealCallsBefore = shellShowItemInFolder.mock.calls.length;
    await expect(
      bridge.revealSkillInstallFolder({ skillId: SKILL_ID, target: currentTargetId }),
    ).resolves.toEqual({ ok: false, reason: 'path-missing' });
    expect(shellShowItemInFolder.mock.calls.length).toBe(revealCallsBefore);
  });

  it('场景7：`~` 展开——update 传 `~/...` 持久化为展开后的绝对路径', async () => {
    const expectedHomeSkillsDir = path.resolve(path.join(fakeHome, 'seam-home-skills'));

    await expect(
      bridge.updateCustomSkillInstallTarget(currentTargetId, 'dsh-renamed', '~/seam-home-skills'),
    ).resolves.toEqual({
      ok: true,
      target: { id: currentTargetId, name: 'dsh-renamed', skillsDir: expectedHomeSkillsDir },
    });
    // 持久化值即展开后的绝对路径（HOME 已指向临时目录，未展开或展开到真实 HOME 都无法通过）
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual({
      targets: [{ id: currentTargetId, name: 'dsh-renamed', skillsDir: expectedHomeSkillsDir }],
    });
  });

  it('场景8：负例（接线证明）——缺 skillsDir 的 {id, name} 请求在 handler 层被拒且不落盘', async () => {
    const before = await bridge.listCustomSkillInstallTargets();

    // 绕过桥的类型签名，直接向真实 handler 投递旧形态两字段请求：形状校验拒绝（invalid-request）
    await expect(
      fakeInvoke(SKILL_IPC_CHANNELS.UPDATE_CUSTOM_TARGET, { id: currentTargetId, name: 'dsh-x' }),
    ).resolves.toEqual({ ok: false, error: 'invalid-request' });
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual(before);

    // update 重跑 add 的整套目录校验：相对路径拒绝
    await expect(
      bridge.updateCustomSkillInstallTarget(currentTargetId, 'dsh-renamed', 'relative/skills'),
    ).resolves.toEqual({ ok: false, error: 'invalid-request' });
    // 改到内置目标目录拒绝（重复检查对「别家占用」照常生效，仅排除自身）
    await expect(
      bridge.updateCustomSkillInstallTarget(
        currentTargetId,
        'dsh-renamed',
        path.join(fakeHome, '.agents', 'skills'),
      ),
    ).resolves.toEqual({ ok: false, error: 'duplicate-dir' });
    // 被拒请求均不落注册表、不建目录
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual(before);
    expect(fs.existsSync(path.join(fakeHome, '.agents'))).toBe(false);
  });
});

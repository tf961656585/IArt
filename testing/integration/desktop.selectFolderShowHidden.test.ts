// @vitest-environment node
/**
 * select-folder 通道 showHiddenFiles 扩展的主进程接线测试（2026-10-16 批次）。
 *
 * 使命：证明「IPC 请求字段 → 系统选择框 properties」这段接线真实存在——
 * Hub 侧 `selectFolder({ ..., showHiddenFiles: true })`（Skill 安装目录选择场景：
 * apps/hub/src/features/skills/ManageInstallTargetsDialog.tsx）经真实主进程 handler
 * 落到真实 dialog.showOpenDialog 的 properties；缺省/未传时 properties 与历史行为完全一致
 * （默认关）。渲染层调用点与 preload 透传不在本文件范围（前者归 Hub 单测，后者归
 * desktop.preloadBridge.test.ts）。
 *
 * 装载机制照 testing/integration 既有先例（desktop.mainProcessEditorOpen.test.ts /
 * hub.skillCustomTargetsSeam.test.ts）：经 sharedRequire 加载 dist 产物，electron 以
 * patchModuleLoad 替身注入；被测对象是真实 registerDesktopIpcHandlers 注册出的
 * select-folder / select-project-folder handler。runtime/windows/updater/cli 控制器
 * 对这两个 handler 的执行无参与（窗口取 BrowserWindow.getFocusedWindow），用空桩填充。
 */

import * as path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cast, clearCjsCache, cjsRequireAs, patchModuleLoad, sharedRequire } from './helpers/cjs-mock';

const ipcPath = path.join(process.cwd(), 'apps/desktop-shell/dist/desktop-shell-ipc.cjs');

type MainHandler = (event: unknown, payload: unknown) => unknown;

type SelectFolderResult = {
  status: 'success' | 'canceled' | 'error';
  path: string | null;
  errorCode: string | null;
  userMessage: string | null;
  debugMessage: string | null;
};

type DesktopShellIpcModule = {
  registerDesktopIpcHandlers: (deps: {
    runtime: unknown;
    windows: unknown;
    updater: unknown;
    cli: unknown;
  }) => void;
};

const handlers = new Map<string, MainHandler>();
const focusedWindow = { isDestroyed: () => false };
const showOpenDialog = vi.fn(
  async (
    _window: unknown,
    _options: unknown,
  ): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
);

const getHandler = (channel: string): MainHandler => {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} handler 未注册（接缝断裂）`);
  }
  return handler;
};

beforeAll(() => {
  const restore = patchModuleLoad({
    electron: {
      ipcMain: {
        handle: (channel: string, handler: MainHandler) => {
          handlers.set(channel, handler);
        },
        on: vi.fn(),
      },
      BrowserWindow: {
        getFocusedWindow: () => focusedWindow,
        getAllWindows: () => [focusedWindow],
      },
      dialog: { showOpenDialog },
      shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => true) },
      clipboard: { writeText: vi.fn(), writeImage: vi.fn() },
      nativeImage: {
        createFromPath: vi.fn(() => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) })),
      },
      nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
      net: { fetch: vi.fn(async () => ({ ok: false })) },
    },
  });
  try {
    clearCjsCache(ipcPath);
    cjsRequireAs<DesktopShellIpcModule>(sharedRequire(ipcPath)).registerDesktopIpcHandlers({
      runtime: {},
      windows: {},
      updater: {},
      cli: {},
    });
  } finally {
    restore();
  }
});

beforeEach(() => {
  showOpenDialog.mockClear();
});

describe('select-folder showHiddenFiles 接线（真实 dist handler → 假 dialog）', () => {
  it('showHiddenFiles: true → properties 追加 showHiddenFiles，选定路径按成功形态返回', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/hidden-skills'] });

    const result = cast<SelectFolderResult>(
      await getHandler('select-folder')({}, {
        title: '选择 Skill 安装文件夹',
        defaultPath: undefined,
        buttonLabel: '选择',
        showHiddenFiles: true,
      }),
    );

    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(showOpenDialog).toHaveBeenCalledWith(focusedWindow, {
      title: '选择 Skill 安装文件夹',
      defaultPath: '',
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
      buttonLabel: '选择',
    });
    expect(result).toEqual({
      status: 'success',
      path: '/tmp/hidden-skills',
      errorCode: null,
      userMessage: null,
      debugMessage: null,
    });
  });

  it('缺省 / 显式 false / 非布尔真值均不放宽：properties 与历史行为完全一致，取消形态返回 canceled', async () => {
    const handler = getHandler('select-folder');
    const payloadWithoutFlag = { title: '选择文件夹', defaultPath: '', buttonLabel: '选择此文件夹' };
    const expectedOptions = {
      title: '选择文件夹',
      defaultPath: '',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此文件夹',
    };

    // 字段缺席（既有调用方形态）
    const canceled = cast<SelectFolderResult>(await handler({}, payloadWithoutFlag));
    expect(showOpenDialog).toHaveBeenLastCalledWith(focusedWindow, expectedOptions);
    expect(canceled).toEqual({
      status: 'canceled',
      path: null,
      errorCode: null,
      userMessage: null,
      debugMessage: null,
    });

    // 显式 false
    await handler({}, { ...payloadWithoutFlag, showHiddenFiles: false });
    expect(showOpenDialog).toHaveBeenLastCalledWith(focusedWindow, expectedOptions);

    // 非布尔真值不放宽（IPC 载荷不可信，仅字面 true 生效）
    await handler({}, { ...payloadWithoutFlag, showHiddenFiles: 'yes' });
    expect(showOpenDialog).toHaveBeenLastCalledWith(focusedWindow, expectedOptions);
  });

  it('select-project-folder 不开放该扩展：传 showHiddenFiles: true 也不放宽', async () => {
    await getHandler('select-project-folder')({}, {
      title: '选择项目文件夹',
      defaultPath: '',
      buttonLabel: '打开项目',
      showHiddenFiles: true,
    });

    expect(showOpenDialog).toHaveBeenLastCalledWith(focusedWindow, {
      title: '选择项目文件夹',
      defaultPath: '',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '打开项目',
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { CliCommandLogEntry, CliEntryStatusDetail, CliStatusDto } from '@iart/contracts';
import { CliCommandLogEntrySchema, CliStatusDtoSchema } from '@iart/contracts';
import type { HubPlatformBridge } from '../../../client/types';
import { CliSection } from '../CliSection';

/**
 * 设置页「命令行工具」子单元（spec docs/integrations/CLI与本地Agent集成.md §8）：
 * 只读状态展示（注册状态五态 + 遮蔽/PATH 指引）+ 命令入口一键注册/卸除（CLI-016）；
 * 子单元不提供令牌查看或重置（CLI-013 红线）。
 *
 * platform 用完整 HubPlatformBridge 桩（编译期钉住接口形状），经 vi.mock 注入 useHubRuntime。
 * 状态夹具经 contracts 的 CliStatusDtoSchema / CliCommandLogEntrySchema parse 产生（与真实 IPC 响应同形）。
 */

const platformRef = vi.hoisted(() => ({ current: null as HubPlatformBridge | null }));

vi.mock('../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: () => {
    const platform = platformRef.current;
    if (platform === null) throw new Error('用例没有装载 platform');
    return { platform };
  },
}));

const logEntry = (overrides: Partial<CliCommandLogEntry> = {}): CliCommandLogEntry =>
  CliCommandLogEntrySchema.parse({
    timestamp: '2026-10-07T02:30:00.000Z',
    command: 'generate',
    paramsSummary: '模型 gpt-image-2 · 2 个任务',
    status: 'success',
    durationMs: 320,
    ...overrides,
  });

/** 注册状态详情夹具（spec §8 五态）：缺省未注册、落点示意路径、无旧入口、无需配 PATH。 */
const entryDetail = (overrides: Partial<CliEntryStatusDetail> = {}): CliEntryStatusDetail => ({
  state: 'missing',
  entryPath: '/tmp/example/iart',
  legacyEntryPath: null,
  pathSetupRequired: false,
  ...overrides,
});

const statusFixture = (overrides: Partial<CliStatusDto> = {}): CliStatusDto =>
  CliStatusDtoSchema.parse({
    serviceRunning: true,
    port: 41087,
    discoveryFileValid: true,
    entry: entryDetail(),
    recentCommands: [],
    ...overrides,
  });

const createPlatform = (
  overrides: Partial<Pick<HubPlatformBridge, 'getCliStatus' | 'registerCliEntry' | 'unregisterCliEntry'>>,
): HubPlatformBridge => {
  const bridge: HubPlatformBridge = {
    isElectron: () => true,
    openEditorWindow: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve(true)),
    selectFolder: vi.fn(),
    selectProjectFolder: vi.fn(),
    revealProjectFolder: vi.fn(),
    isStorageReady: () => true,
    getAppVersion: vi.fn(() => Promise.resolve('9.9.9')),
    checkForUpdates: vi.fn(),
    startUpdateDownload: vi.fn(),
    cancelUpdateDownload: vi.fn(),
    installUpdate: vi.fn(),
    revealDownloadedUpdate: vi.fn(),
    getUpdateState: vi.fn(() => Promise.resolve(null)),
    getUpdaterLogInfo: vi.fn(() => Promise.resolve(null)),
    revealUpdaterLog: vi.fn(),
    revealBackendLogFolder: vi.fn(),
    onAppUpdateEvent: vi.fn(),
    onUpdateChecking: vi.fn(),
    onUpdateAvailable: vi.fn(),
    onUpdateNotAvailable: vi.fn(),
    onUpdateDownloadProgress: vi.fn(),
    onUpdateDownloaded: vi.fn(),
    onUpdateError: vi.fn(),
    onTaskStateChanged: vi.fn(),
    onTaskStateSnapshot: vi.fn(),
    removeTaskStateListeners: vi.fn(),
    onHubFocusSettings: vi.fn(),
    removeHubFocusSettingsListener: vi.fn(),
    storageListProjects: vi.fn(),
    storageCreateProject: vi.fn(),
    storageOpenProject: vi.fn(),
    storageDeleteProject: vi.fn(),
    storageImportFolder: vi.fn(),
    storageImportBundle: vi.fn(),
    storageExportBundle: vi.fn(),
    packagesList: vi.fn(),
    packagesCreate: vi.fn(),
    packagesRename: vi.fn(),
    packagesDelete: vi.fn(),
    packagesReveal: vi.fn(),
    getSkillInstalledState: vi.fn(),
    installSkill: vi.fn(),
    revealSkillInstallFolder: vi.fn(),
    listCustomSkillInstallTargets: vi.fn(),
    addCustomSkillInstallTarget: vi.fn(),
    updateCustomSkillInstallTarget: vi.fn(),
    removeCustomSkillInstallTarget: vi.fn(),
    getCliStatus: overrides.getCliStatus ?? vi.fn(() => Promise.resolve(statusFixture())),
    registerCliEntry: overrides.registerCliEntry ?? vi.fn(),
    unregisterCliEntry: overrides.unregisterCliEntry ?? vi.fn(),
  };
  return bridge;
};

afterEach(() => {
  cleanup();
  platformRef.current = null;
});

describe('CliSection 状态展示（CLI-013）', () => {
  // @spec: CLI-013
  it('渲染在役状态、注册状态、注册按钮与最近命令记录，时间为北京时间', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() =>
        Promise.resolve(
          statusFixture({
            recentCommands: [
              logEntry(),
              logEntry({
                timestamp: '2026-10-06T18:00:00.000Z',
                command: 'project.list',
                paramsSummary: '',
                status: 'error',
                durationMs: 1500,
                errorCode: 'not_running',
              }),
            ],
          }),
        ),
      ),
    });
    const { container } = render(<CliSection />);

    expect(await screen.findByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('运行状态')).toBeInTheDocument();
    expect(screen.getByText('终端命令')).toBeInTheDocument();
    expect(screen.getByText('未注册')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册 iart 命令' })).toBeInTheDocument();
    expect(screen.getByText('最近命令')).toBeInTheDocument();
    expect(screen.getByText('generate')).toBeInTheDocument();
    expect(screen.getByText('project.list')).toBeInTheDocument();
    expect(screen.getByText('模型 gpt-image-2 · 2 个任务')).toBeInTheDocument();
    // 状态词与耗时
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('320 ms')).toBeInTheDocument();
    expect(screen.getByText('1.5 秒')).toBeInTheDocument();
    // 北京时间（UTC+8）：02:30Z → 10:30，18:00Z → 次日 02:00
    expect(screen.getByText(/10:30:00/)).toBeInTheDocument();
    expect(screen.getByText(/02:00:00/)).toBeInTheDocument();
    // CLI-013 红线：不渲染令牌类内容，端口等诊断细节不进界面
    expect(container.textContent ?? '').not.toMatch(/令牌|token/i);
    expect(container.textContent ?? '').not.toContain('41087');
  });

  // @spec: CLI-013
  it('已注册态提供卸除注册动作，未注册态才提供注册动作', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() => Promise.resolve(statusFixture({ entry: entryDetail({ state: 'registered' }) }))),
    });
    render(<CliSection />);

    expect(await screen.findByText('已注册')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '卸除注册' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注册 iart 命令' })).not.toBeInTheDocument();
  });

  // @spec: CLI-013
  it('entry.state 为 unsupported（平台不支持一键注册）时展示不支持态且不渲染动作', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() =>
        Promise.resolve(statusFixture({ entry: entryDetail({ state: 'unsupported', entryPath: null }) })),
      ),
    });
    render(<CliSection />);

    expect(await screen.findByText('当前平台暂不支持一键注册')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注册 iart 命令' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '卸除注册' })).not.toBeInTheDocument();
  });

  // @spec: CLI-013
  it('发现文件失效时以次级信息并入在役状态行', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() => Promise.resolve(statusFixture({ discoveryFileValid: false }))),
    });
    render(<CliSection />);

    expect(await screen.findByText('重启应用前，终端的 iart 命令可能连不上')).toBeInTheDocument();
  });

  // @spec: CLI-013
  it('最近命令记录为空时展示空态文案', async () => {
    platformRef.current = createPlatform({ getCliStatus: vi.fn(() => Promise.resolve(statusFixture())) });
    render(<CliSection />);

    expect(await screen.findByText('暂无命令记录')).toBeInTheDocument();
  });

  // @spec: CLI-013
  it('状态读取失败给子单元内失败显示位，不静默', async () => {
    platformRef.current = createPlatform({ getCliStatus: vi.fn(() => Promise.resolve(null)) });
    render(<CliSection />);

    expect(await screen.findByText('没能读取命令行工具状态，请重试')).toBeInTheDocument();
  });
});

describe('CliSection 命令入口注册/卸除（CLI-016）', () => {
  // @spec: CLI-016
  it('点注册调用注册通道，成功后重读状态并即时更新注册状态行', async () => {
    const registerCliEntry = vi.fn(() => Promise.resolve({ ok: true }));
    const getCliStatus = vi
      .fn<HubPlatformBridge['getCliStatus']>()
      .mockResolvedValueOnce(statusFixture())
      .mockResolvedValueOnce(statusFixture({ entry: entryDetail({ state: 'registered' }) }));
    platformRef.current = createPlatform({ getCliStatus, registerCliEntry });
    render(<CliSection />);

    fireEvent.click(await screen.findByRole('button', { name: '注册 iart 命令' }));

    expect(await screen.findByText('已注册')).toBeInTheDocument();
    expect(registerCliEntry).toHaveBeenCalledTimes(1);
    expect(getCliStatus).toHaveBeenCalledTimes(2);
    // 注册成功后动作切换为卸除注册
    expect(screen.getByRole('button', { name: '卸除注册' })).toBeInTheDocument();
  });

  // @spec: CLI-016
  it('点卸除注册调用卸除通道，成功后注册状态行回到未注册', async () => {
    const unregisterCliEntry = vi.fn(() => Promise.resolve({ ok: true }));
    const getCliStatus = vi
      .fn<HubPlatformBridge['getCliStatus']>()
      .mockResolvedValueOnce(statusFixture({ entry: entryDetail({ state: 'registered' }) }))
      .mockResolvedValueOnce(statusFixture());
    platformRef.current = createPlatform({ getCliStatus, unregisterCliEntry });
    render(<CliSection />);

    fireEvent.click(await screen.findByRole('button', { name: '卸除注册' }));

    expect(await screen.findByText('未注册')).toBeInTheDocument();
    expect(unregisterCliEntry).toHaveBeenCalledTimes(1);
  });

  // @spec: CLI-016
  it('注册失败在子单元内展示后端返回的 message（Hub 无 toast）', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() => Promise.resolve(statusFixture())),
      registerCliEntry: vi.fn(() => Promise.resolve({ ok: false, message: '写入命令入口没能完成，请手动注册' })),
    });
    render(<CliSection />);

    fireEvent.click(await screen.findByRole('button', { name: '注册 iart 命令' }));

    expect(await screen.findByText('写入命令入口没能完成，请手动注册')).toBeInTheDocument();
  });

  // @spec: CLI-016
  it('注册失败且后端未携带 message 时给兜底文案', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() => Promise.resolve(statusFixture())),
      registerCliEntry: vi.fn(() => Promise.resolve({ ok: false })),
    });
    render(<CliSection />);

    fireEvent.click(await screen.findByRole('button', { name: '注册 iart 命令' }));

    expect(await screen.findByText('没能注册 iart 命令，请重试')).toBeInTheDocument();
  });

  // @spec: CLI-016
  it('重复点击注册期间动作按钮禁用，不并发重复注册', async () => {
    let resolveRegister: ((result: { ok: boolean }) => void) | undefined;
    const registerCliEntry = vi.fn(
      () => new Promise<{ ok: boolean }>((resolve) => {
        resolveRegister = resolve;
      }),
    );
    const getCliStatus = vi
      .fn<HubPlatformBridge['getCliStatus']>()
      .mockResolvedValueOnce(statusFixture())
      .mockResolvedValueOnce(statusFixture({ entry: entryDetail({ state: 'registered' }) }));
    platformRef.current = createPlatform({ getCliStatus, registerCliEntry });
    render(<CliSection />);

    const button = await screen.findByRole('button', { name: '注册 iart 命令' });
    fireEvent.click(button);
    // loading 态由 Button 的 loading prop 承载：文案不变，置 aria-busy 并自动禁用（按钮样式标准 §6）
    const busyButton = await screen.findByRole('button', { name: '注册 iart 命令' });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute('aria-busy', 'true');

    resolveRegister?.({ ok: true });
    expect(await screen.findByText('已注册')).toBeInTheDocument();
    expect(registerCliEntry).toHaveBeenCalledTimes(1);
  });
});

describe('CliSection 注册状态五态与指引（spec §8）', () => {
  // @spec: CLI-016
  it('入口已失效态：给失效说明与注册动作', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() => Promise.resolve(statusFixture({ entry: entryDetail({ state: 'stale' }) }))),
    });
    render(<CliSection />);

    expect(await screen.findByText('已失效')).toBeInTheDocument();
    expect(screen.getByText('已有的 iart 命令指向旧版本或旧位置，重新注册后就能继续使用。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册 iart 命令' })).toBeInTheDocument();
  });

  // @spec: CLI-016
  it('同名他物态：说明注册会替换它，注册动作可用', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() => Promise.resolve(statusFixture({ entry: entryDetail({ state: 'foreign' }) }))),
    });
    render(<CliSection />);

    expect(await screen.findByText('已被其他程序占用')).toBeInTheDocument();
    expect(screen.getByText('已有一个不是本应用创建的 iart 命令；注册后它会被替换。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册 iart 命令' })).toBeInTheDocument();
  });

  // @spec: CLI-016
  it('落点之外有旧入口：给遮蔽提示与手动清理指引', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() =>
        Promise.resolve(statusFixture({ entry: entryDetail({ legacyEntryPath: '/usr/local/bin/iart' }) })),
      ),
    });
    render(<CliSection />);

    expect(
      await screen.findByText(
        '在 /usr/local/bin/iart 还有一个 iart 命令，终端可能会优先使用它。如果它是你以前自己创建的，可以在终端执行 sudo rm /usr/local/bin/iart 删除。',
      ),
    ).toBeInTheDocument();
  });

  // @spec: CLI-016
  it('落点需配 PATH 时给加入命令搜索路径指引', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() =>
        Promise.resolve(
          statusFixture({
            entry: entryDetail({
              state: 'registered',
              entryPath: '/home/u/.local/bin/iart',
              pathSetupRequired: true,
            }),
          }),
        ),
      ),
    });
    render(<CliSection />);

    expect(
      await screen.findByText('如果终端提示找不到 iart 命令，请把 /home/u/.local/bin 加入 PATH，然后在终端重新输入 iart。'),
    ).toBeInTheDocument();
  });

  // @spec: CLI-016
  it('注册成功展示结果消息（不静默；PATH 引导由状态行单独承载）', async () => {
    platformRef.current = createPlatform({
      getCliStatus: vi.fn(() => Promise.resolve(statusFixture())),
      registerCliEntry: vi.fn(() => Promise.resolve({ ok: true, message: 'iart 命令已创建。' })),
    });
    render(<CliSection />);

    fireEvent.click(await screen.findByRole('button', { name: '注册 iart 命令' }));

    expect(await screen.findByText('iart 命令已创建。')).toBeInTheDocument();
  });
});

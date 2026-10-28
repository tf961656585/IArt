import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  SkillCustomTargetMutationResultSchema,
  SkillListCustomTargetsResultSchema,
  SkillRemoveCustomTargetResultSchema,
} from '@iart/contracts';
import type { SkillCustomTargetErrorCode } from '@iart/contracts';
import type { SelectFolderResult } from '@iart/backend-sdk';
import type { HubPlatformBridge } from '../../../client/types';
import { ManageInstallTargetsDialog } from '../ManageInstallTargetsDialog';

/**
 * 「管理自定义 Agent 目录」集中管理弹层（docs/hub/skill-store.md §3.2 UI 口径）：
 * 内置目标只读展示（「内置」徽标，无编辑/删除）；自定义目标增删改走平台桥；
 * 文件夹可键入/粘贴，也可用系统选择框（selectFolder，带 showHiddenFiles）取路径；
 * 错误码→文案映射集中一处；删除需二次确认；每次操作成功后弹层自行刷新列表。
 * 结构口径：底栏「关闭」+「添加」同排（添加为主操作）；行内「编辑」态首行编辑名称、
 * 次行编辑文件夹（改路径成功后行内给静默色说明）；添加区由小节标题「添加自定义目录」承载分组。
 *
 * platform 用完整 HubPlatformBridge 桩（编译期钉住接口形状），经 vi.mock 注入 useHubRuntime；
 * 响应夹具经 contracts schema parse 产生（与真实 IPC 响应同形）。
 */

const platformRef = vi.hoisted(() => ({ current: null as HubPlatformBridge | null }));

vi.mock('../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: () => {
    const platform = platformRef.current;
    if (platform === null) throw new Error('用例没有装载 platform');
    return { platform };
  },
}));

const targetFixture = (overrides: { id?: string; name?: string; skillsDir?: string } = {}) =>
  SkillListCustomTargetsResultSchema.parse({
    targets: [
      {
        id: 'custom-ab12cd34',
        name: '我的目录',
        skillsDir: '/Users/me/skills',
        ...overrides,
      },
    ],
  });

const mutationOk = (id: string, name: string, skillsDir: string) =>
  SkillCustomTargetMutationResultSchema.parse({ ok: true, target: { id, name, skillsDir } });

const mutationFail = (error: SkillCustomTargetErrorCode) =>
  SkillCustomTargetMutationResultSchema.parse({ ok: false, error });

const selectFolderSuccess = (path: string): SelectFolderResult => ({
  status: 'success',
  path,
  errorCode: null,
  userMessage: null,
  debugMessage: null,
});

type TargetOverrides = Partial<
  Pick<
    HubPlatformBridge,
    'listCustomSkillInstallTargets' | 'addCustomSkillInstallTarget' | 'updateCustomSkillInstallTarget' | 'removeCustomSkillInstallTarget' | 'selectFolder' | 'isElectron'
  >
>;

const createPlatform = (overrides: TargetOverrides = {}): HubPlatformBridge => {
  const bridge: HubPlatformBridge = {
    isElectron: overrides.isElectron ?? (() => true),
    openEditorWindow: vi.fn(),
    openExternal: vi.fn(() => Promise.resolve(true)),
    selectFolder: overrides.selectFolder ?? vi.fn(),
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
    listCustomSkillInstallTargets: overrides.listCustomSkillInstallTargets ?? vi.fn(() => Promise.resolve(targetFixture())),
    addCustomSkillInstallTarget: overrides.addCustomSkillInstallTarget ?? vi.fn(),
    updateCustomSkillInstallTarget: overrides.updateCustomSkillInstallTarget ?? vi.fn(),
    removeCustomSkillInstallTarget: overrides.removeCustomSkillInstallTarget ?? vi.fn(),
    getCliStatus: vi.fn(),
    registerCliEntry: vi.fn(),
    unregisterCliEntry: vi.fn(),
  };
  return bridge;
};

const renderDialog = () => {
  const onOpenChange = vi.fn();
  render(<ManageInstallTargetsDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange };
};

const fillAddForm = async (name: string, dir: string | null): Promise<void> => {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: name } });
  if (dir !== null) {
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }));
    await waitFor(() => expect(screen.getByLabelText('文件夹')).toHaveValue(dir));
  }
};

afterEach(() => {
  cleanup();
  platformRef.current = null;
  vi.restoreAllMocks();
});

describe('ManageInstallTargetsDialog 列表展示', () => {
  it('内置两行只读展示并带「内置」徽标，无改名/删除；自定义行回显 name 与 skillsDir', async () => {
    platformRef.current = createPlatform();
    renderDialog();

    expect(await screen.findByText('全局 .agents')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getAllByText('内置')).toHaveLength(2);
    expect(await screen.findByText('我的目录')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/skills')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑 我的目录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除 我的目录' })).toBeInTheDocument();
  });

  it('加载中先呈现读取态，注册表到达后渲染自定义行', async () => {
    let resolveList: ((value: ReturnType<typeof targetFixture>) => void) | undefined;
    platformRef.current = createPlatform({
      listCustomSkillInstallTargets: vi.fn(
        () =>
          new Promise<ReturnType<typeof targetFixture>>((resolve) => {
            resolveList = resolve;
          }),
      ),
    });
    renderDialog();

    expect(await screen.findByText('正在读取自定义目录...')).toBeInTheDocument();
    if (resolveList === undefined) throw new Error('listCustom promise 应已被创建');
    resolveList(targetFixture());
    expect(await screen.findByText('我的目录')).toBeInTheDocument();
  });

  it('自定义空态呈现引导文案', async () => {
    platformRef.current = createPlatform({
      listCustomSkillInstallTargets: vi.fn(() => Promise.resolve(SkillListCustomTargetsResultSchema.parse({ targets: [] }))),
    });
    renderDialog();

    expect(
      await screen.findByText('还没有自定义目录。添加后，可以把 Skill 安装到你指定的文件夹。'),
    ).toBeInTheDocument();
  });

  it('读取失败呈现失败提示与「重试」出路，重试重新拉取', async () => {
    const listCustom = vi.fn()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValueOnce(targetFixture());
    platformRef.current = createPlatform({ listCustomSkillInstallTargets: listCustom });
    renderDialog();

    expect(await screen.findByText('没能读取自定义目录')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('我的目录')).toBeInTheDocument();
    expect(listCustom).toHaveBeenCalledTimes(2);
  });
});

describe('ManageInstallTargetsDialog 添加', () => {
  it('校验失败：未填名称提示「请填写名称」，未填文件夹提示「请填写或选择文件夹路径」，不发起 IPC', async () => {
    const addCustom = vi.fn();
    platformRef.current = createPlatform({ addCustomSkillInstallTarget: addCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(await screen.findByText('请填写名称')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'dsh' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(await screen.findByText('请填写或选择文件夹路径')).toBeInTheDocument();
    expect(addCustom).not.toHaveBeenCalled();
  });

  it('选择文件夹回显所选路径，添加成功后清空表单并刷新列表', async () => {
    const selectFolder = vi.fn(() => Promise.resolve(selectFolderSuccess('/Users/me/dsh-skills')));
    const addCustomSkillInstallTarget = vi.fn(() =>
      Promise.resolve(mutationOk('custom-11223344', 'dsh', '/Users/me/dsh-skills')),
    );
    const listCustom = vi.fn().mockResolvedValueOnce(targetFixture()).mockResolvedValueOnce(
      SkillListCustomTargetsResultSchema.parse({
        targets: [
          { id: 'custom-ab12cd34', name: '我的目录', skillsDir: '/Users/me/skills' },
          { id: 'custom-11223344', name: 'dsh', skillsDir: '/Users/me/dsh-skills' },
        ],
      }),
    );
    platformRef.current = createPlatform({
      selectFolder,
      addCustomSkillInstallTarget,
      listCustomSkillInstallTargets: listCustom,
    });
    renderDialog();
    await screen.findByText('我的目录');

    await fillAddForm('dsh', '/Users/me/dsh-skills');
    expect(selectFolder).toHaveBeenCalledWith({
      title: '选择 Skill 安装文件夹',
      defaultPath: undefined,
      buttonLabel: '选择',
      showHiddenFiles: true,
    });

    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(addCustomSkillInstallTarget).toHaveBeenCalledWith('dsh', '/Users/me/dsh-skills'));
    // 成功后表单清空、列表自行刷新
    await waitFor(() => expect(screen.getByLabelText('名称')).toHaveValue(''));
    await waitFor(() => expect(screen.getByLabelText('文件夹')).toHaveValue(''));
    expect(await screen.findByText('dsh')).toBeInTheDocument();
    expect(listCustom).toHaveBeenCalledTimes(2);
  });

  it('添加被拒：错误码映射成用户提示（duplicate-dir），列表不清空', async () => {
    const selectFolder = vi.fn(() => Promise.resolve(selectFolderSuccess('/Users/me/skills')));
    const addCustomSkillInstallTarget = vi.fn(() => Promise.resolve(mutationFail('duplicate-dir')));
    platformRef.current = createPlatform({ selectFolder, addCustomSkillInstallTarget });
    renderDialog();
    await screen.findByText('我的目录');

    await fillAddForm('重复目录', '/Users/me/skills');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByText('该文件夹已被其他自定义目录使用，请另选一个文件夹')).toBeInTheDocument();
    expect(addCustomSkillInstallTarget).toHaveBeenCalledTimes(1);
  });

  it('添加被拒：reserved-dir 提示带出路的文案', async () => {
    const addCustomSkillInstallTarget = vi.fn(() => Promise.resolve(mutationFail('reserved-dir')));
    platformRef.current = createPlatform({ addCustomSkillInstallTarget });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '数据目录' } });
    fireEvent.change(screen.getByLabelText('文件夹'), { target: { value: '/Users/me/app-data' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(await screen.findByText('不能使用应用数据所在的文件夹，请另选一个文件夹')).toBeInTheDocument();
  });
});

describe('ManageInstallTargetsDialog 编辑', () => {
  it('编辑态两行：名称与文件夹回显原值；保存携带 (id, 新名, 新路径) 并刷新列表；取消不发起 IPC', async () => {
    const updateCustom = vi.fn(() => Promise.resolve(mutationOk('custom-ab12cd34', '新名字', '/Users/me/skills')));
    const listCustom = vi.fn()
      .mockResolvedValueOnce(targetFixture())
      .mockResolvedValueOnce(targetFixture({ name: '新名字' }));
    platformRef.current = createPlatform({ updateCustomSkillInstallTarget: updateCustom, listCustomSkillInstallTargets: listCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '编辑 我的目录' }));
    expect(screen.getByLabelText('编辑名称 我的目录')).toHaveValue('我的目录');
    expect(screen.getByLabelText('编辑文件夹 我的目录')).toHaveValue('/Users/me/skills');
    fireEvent.change(screen.getByLabelText('编辑名称 我的目录'), { target: { value: '新名字' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 我的目录' }));

    await waitFor(() => expect(updateCustom).toHaveBeenCalledWith('custom-ab12cd34', '新名字', '/Users/me/skills'));
    expect(await screen.findByText('新名字')).toBeInTheDocument();
    expect(listCustom).toHaveBeenCalledTimes(2);
    // 仅改名：不出现「路径已更新」说明（该说明只在文件夹值变化时给）
    expect(
      screen.queryByText('路径已更新。原来文件夹里的 Skill 文件不会被移动，如需在新文件夹使用请重新安装。'),
    ).toBeNull();

    // 再次进入编辑后取消：不发起 IPC、回到展示态
    fireEvent.click(screen.getByRole('button', { name: '编辑 新名字' }));
    fireEvent.click(screen.getByRole('button', { name: '取消 新名字' }));
    expect(updateCustom).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '编辑 新名字' })).toBeInTheDocument();
  });

  it('改文件夹保存后：列表刷新为新路径，行内显示静默色说明（非错误红）', async () => {
    const updateCustom = vi.fn(() => Promise.resolve(mutationOk('custom-ab12cd34', '我的目录', '/Users/me/new-skills')));
    const listCustom = vi.fn()
      .mockResolvedValueOnce(targetFixture())
      .mockResolvedValueOnce(targetFixture({ skillsDir: '/Users/me/new-skills' }));
    platformRef.current = createPlatform({ updateCustomSkillInstallTarget: updateCustom, listCustomSkillInstallTargets: listCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '编辑 我的目录' }));
    fireEvent.change(screen.getByLabelText('编辑文件夹 我的目录'), { target: { value: '/Users/me/new-skills' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 我的目录' }));

    await waitFor(() =>
      expect(updateCustom).toHaveBeenCalledWith('custom-ab12cd34', '我的目录', '/Users/me/new-skills'),
    );
    const notice = await screen.findByText(
      '路径已更新。原来文件夹里的 Skill 文件不会被移动，如需在新文件夹使用请重新安装。',
    );
    expect(notice.className).toContain('text-muted-foreground');
    expect(notice.className).not.toContain('text-destructive');
    expect(await screen.findByText('/Users/me/new-skills')).toBeInTheDocument();
  });

  it('编辑行「选择文件夹」走同一通道（带 showHiddenFiles）回填草稿，未保存不发起 update', async () => {
    const selectFolder = vi.fn(() => Promise.resolve(selectFolderSuccess('/Users/me/picked-skills')));
    const updateCustom = vi.fn();
    platformRef.current = createPlatform({ selectFolder, updateCustomSkillInstallTarget: updateCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '编辑 我的目录' }));
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹 我的目录' }));

    await waitFor(() =>
      expect(selectFolder).toHaveBeenCalledWith({
        title: '选择 Skill 安装文件夹',
        defaultPath: undefined,
        buttonLabel: '选择',
        showHiddenFiles: true,
      }),
    );
    await waitFor(() => expect(screen.getByLabelText('编辑文件夹 我的目录')).toHaveValue('/Users/me/picked-skills'));
    expect(updateCustom).not.toHaveBeenCalled();
  });

  it('编辑态按 Enter 直接提交保存', async () => {
    const updateCustom = vi.fn(() => Promise.resolve(mutationOk('custom-ab12cd34', '回车名', '/Users/me/skills')));
    const listCustom = vi.fn()
      .mockResolvedValueOnce(targetFixture())
      .mockResolvedValueOnce(targetFixture({ name: '回车名' }));
    platformRef.current = createPlatform({ updateCustomSkillInstallTarget: updateCustom, listCustomSkillInstallTargets: listCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '编辑 我的目录' }));
    fireEvent.change(screen.getByLabelText('编辑名称 我的目录'), { target: { value: '回车名' } });
    fireEvent.keyDown(screen.getByLabelText('编辑名称 我的目录'), { key: 'Enter' });

    await waitFor(() => expect(updateCustom).toHaveBeenCalledWith('custom-ab12cd34', '回车名', '/Users/me/skills'));
  });

  it('名称为空被拦下（请填写名称），不发起 IPC', async () => {
    const updateCustom = vi.fn();
    platformRef.current = createPlatform({ updateCustomSkillInstallTarget: updateCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '编辑 我的目录' }));
    fireEvent.change(screen.getByLabelText('编辑名称 我的目录'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 我的目录' }));

    expect(await screen.findByText('请填写名称')).toBeInTheDocument();
    expect(updateCustom).not.toHaveBeenCalled();
  });

  it('文件夹清空被拦下（请填写或选择文件夹路径），不发起 IPC', async () => {
    const updateCustom = vi.fn();
    platformRef.current = createPlatform({ updateCustomSkillInstallTarget: updateCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '编辑 我的目录' }));
    fireEvent.change(screen.getByLabelText('编辑文件夹 我的目录'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 我的目录' }));

    expect(await screen.findByText('请填写或选择文件夹路径')).toBeInTheDocument();
    expect(updateCustom).not.toHaveBeenCalled();
  });

  it('编辑被拒：invalid-request 提示指认文件夹路径与修法', async () => {
    const updateCustom = vi.fn(() => Promise.resolve(mutationFail('invalid-request')));
    platformRef.current = createPlatform({ updateCustomSkillInstallTarget: updateCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '编辑 我的目录' }));
    fireEvent.change(screen.getByLabelText('编辑文件夹 我的目录'), { target: { value: 'relative/skills' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 我的目录' }));

    expect(
      await screen.findByText('文件夹路径不对，请填写完整的文件夹路径（可用 ~ 开头）'),
    ).toBeInTheDocument();
  });
});

describe('ManageInstallTargetsDialog 结构口径', () => {
  it('底栏组成：「添加」（主操作）与「关闭」同排于弹层底栏，关闭在前、添加殿后', async () => {
    platformRef.current = createPlatform();
    renderDialog();
    await screen.findByText('我的目录');

    const footer = document.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    if (footer === null) throw new Error('弹层底栏应存在');
    expect(within(footer).getAllByRole('button').map((button) => button.textContent)).toEqual(['关闭', '添加']);
  });

  it('文件夹输入框可键入 / 可粘贴（无只读、不设 tabIndex=-1），点击不再唤起系统选择框', async () => {
    const selectFolder = vi.fn();
    platformRef.current = createPlatform({ selectFolder });
    renderDialog();
    await screen.findByText('我的目录');

    const dirInput = screen.getByLabelText('文件夹');
    expect(dirInput).toHaveAttribute('placeholder', '选择或粘贴文件夹路径');
    expect(dirInput).not.toHaveAttribute('readonly');
    expect(dirInput).not.toHaveAttribute('tabindex');

    fireEvent.click(dirInput);
    expect(selectFolder).not.toHaveBeenCalled();
  });

  it('键入路径直接参与添加（提交前 trim），`~` 开头的路径不被前端拒绝（交主进程裁定）', async () => {
    const addCustom = vi.fn(() => Promise.resolve(mutationOk('custom-11223344', 'dsh', '~/my-skills')));
    platformRef.current = createPlatform({ addCustomSkillInstallTarget: addCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: ' dsh ' } });
    fireEvent.change(screen.getByLabelText('文件夹'), { target: { value: '  ~/my-skills  ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(addCustom).toHaveBeenCalledWith('dsh', '~/my-skills'));
  });

  it('添加区由小节标题「添加自定义目录」承载分组', async () => {
    platformRef.current = createPlatform();
    renderDialog();
    await screen.findByText('我的目录');

    expect(screen.getByText('添加自定义目录')).toBeInTheDocument();
  });
});

describe('ManageInstallTargetsDialog 删除', () => {
  it('删除需确认：确认文案带目标名；确认后携带 id 调 IPC 并刷新列表', async () => {
    const removeCustom = vi.fn(() => Promise.resolve(SkillRemoveCustomTargetResultSchema.parse({ ok: true })));
    const listCustom = vi.fn()
      .mockResolvedValueOnce(targetFixture())
      .mockResolvedValueOnce(SkillListCustomTargetsResultSchema.parse({ targets: [] }));
    platformRef.current = createPlatform({ removeCustomSkillInstallTarget: removeCustom, listCustomSkillInstallTargets: listCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '删除 我的目录' }));
    expect(await screen.findByText('删除自定义目录')).toBeInTheDocument();
    expect(
      screen.getByText('将移除「我的目录」。已安装到该文件夹的 Skill 文件不会被删除，需要时可以手动清理。'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(removeCustom).toHaveBeenCalledWith('custom-ab12cd34'));
    expect(await screen.findByText('还没有自定义目录。添加后，可以把 Skill 安装到你指定的文件夹。')).toBeInTheDocument();
    expect(listCustom).toHaveBeenCalledTimes(2);
  });

  it('确认弹层点「取消」不发起删除 IPC', async () => {
    const removeCustom = vi.fn();
    platformRef.current = createPlatform({ removeCustomSkillInstallTarget: removeCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '删除 我的目录' }));
    await screen.findByText('删除自定义目录');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(removeCustom).not.toHaveBeenCalled();
    expect(await screen.findByText('我的目录')).toBeInTheDocument();
  });

  it('删除被拒：错误码映射成行内提示（not-found 时刷新列表对齐注册表）', async () => {
    const removeCustom = vi.fn(() => Promise.resolve(SkillRemoveCustomTargetResultSchema.parse({ ok: false, error: 'not-found' })));
    const listCustom = vi.fn().mockResolvedValue(targetFixture());
    platformRef.current = createPlatform({ removeCustomSkillInstallTarget: removeCustom, listCustomSkillInstallTargets: listCustom });
    renderDialog();
    await screen.findByText('我的目录');

    fireEvent.click(screen.getByRole('button', { name: '删除 我的目录' }));
    await screen.findByText('删除自定义目录');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(await screen.findByText('该目录不存在，可能已被删除')).toBeInTheDocument();
    await waitFor(() => expect(listCustom).toHaveBeenCalledTimes(2));
  });
});

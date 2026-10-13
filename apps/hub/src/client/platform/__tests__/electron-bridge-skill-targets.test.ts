import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SkillCustomTargetMutationResultSchema,
  SkillListCustomTargetsResultSchema,
  SkillRemoveCustomTargetResultSchema,
} from '@iart/contracts';
import { createHubPlatformBridge } from '../electron-bridge';

/**
 * Hub 平台桥 skill 自定义安装目标四方法（docs/hub/skill-store.md §3.2）：
 * preload 返回 unknown，消费端必须经 contracts schema .parse() —— 成功与失败两个分支都要过 schema；
 * window.electron 缺席（非 Electron 环境）回退到合法的失败/空结果；
 * IPC 意外异常兜底为 invoke-failed（对齐 revealSkillInstallFolder 先例）。
 */

const bridge = createHubPlatformBridge();

const setElectronApi = (api: Record<string, unknown> | undefined): void => {
  (window as { electron?: unknown }).electron = api;
};

const validListRaw = {
  targets: [{ id: 'custom-ab12cd34', name: '我的目录', skillsDir: '/Users/me/skills' }],
};

afterEach(() => {
  setElectronApi(undefined);
  vi.restoreAllMocks();
});

describe('listCustomSkillInstallTargets 边界校验', () => {
  it('window.electron 缺席时回退空注册表', async () => {
    setElectronApi(undefined);
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual({ targets: [] });
  });

  it('合法响应经 schema parse 返回，原样透传位置参数', async () => {
    const listCustom = vi.fn(() => Promise.resolve(validListRaw));
    setElectronApi({ listCustomSkillInstallTargets: listCustom });
    await expect(bridge.listCustomSkillInstallTargets()).resolves.toEqual(
      SkillListCustomTargetsResultSchema.parse(validListRaw),
    );
    expect(listCustom).toHaveBeenCalledTimes(1);
    expect(listCustom).toHaveBeenCalledWith();
  });

  it('非法响应在边界被 parse 拒绝（id 格式不符）', async () => {
    setElectronApi({
      listCustomSkillInstallTargets: () =>
        Promise.resolve({ targets: [{ id: 'Bad ID', name: 'x', skillsDir: '/x' }] }),
    });
    await expect(bridge.listCustomSkillInstallTargets()).rejects.toThrowError();
  });

  it('非法响应在边界被 parse 拒绝（strict schema 拒绝多余键）', async () => {
    setElectronApi({
      listCustomSkillInstallTargets: () =>
        Promise.resolve({ targets: [], unexpectedKey: true }),
    });
    await expect(bridge.listCustomSkillInstallTargets()).rejects.toThrowError();
  });
});

describe('addCustomSkillInstallTarget 边界校验', () => {
  it('成功分支经 schema parse 返回完整条目，位置参数原样透传', async () => {
    const raw = { ok: true, target: { id: 'custom-11223344', name: 'dsh', skillsDir: '/Users/me/dsh-skills' } };
    const addCustom = vi.fn(() => Promise.resolve(raw));
    setElectronApi({ addCustomSkillInstallTarget: addCustom });
    await expect(bridge.addCustomSkillInstallTarget('dsh', '/Users/me/dsh-skills')).resolves.toEqual(
      SkillCustomTargetMutationResultSchema.parse(raw),
    );
    expect(addCustom).toHaveBeenCalledWith('dsh', '/Users/me/dsh-skills');
  });

  it('失败分支经 schema parse 返回错误码', async () => {
    const raw = { ok: false, error: 'duplicate-dir' };
    setElectronApi({ addCustomSkillInstallTarget: () => Promise.resolve(raw) });
    await expect(bridge.addCustomSkillInstallTarget('x', '/y')).resolves.toEqual(
      SkillCustomTargetMutationResultSchema.parse(raw),
    );
  });

  it('window.electron 缺席时回退 invoke-failed 结果', async () => {
    setElectronApi(undefined);
    await expect(bridge.addCustomSkillInstallTarget('x', '/y')).resolves.toEqual({ ok: false, error: 'invoke-failed' });
  });

  it('IPC 意外异常兜底为 invoke-failed 结果', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setElectronApi({ addCustomSkillInstallTarget: () => Promise.reject(new Error('ipc down')) });
    await expect(bridge.addCustomSkillInstallTarget('x', '/y')).resolves.toEqual({ ok: false, error: 'invoke-failed' });
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('updateCustomSkillInstallTarget 边界校验', () => {
  it('成功分支经 schema parse 返回更新后条目，位置参数原样透传', async () => {
    const raw = { ok: true, target: { id: 'custom-ab12cd34', name: '新名字', skillsDir: '/Users/me/skills' } };
    const updateCustom = vi.fn(() => Promise.resolve(raw));
    setElectronApi({ updateCustomSkillInstallTarget: updateCustom });
    await expect(bridge.updateCustomSkillInstallTarget('custom-ab12cd34', '新名字')).resolves.toEqual(
      SkillCustomTargetMutationResultSchema.parse(raw),
    );
    expect(updateCustom).toHaveBeenCalledWith('custom-ab12cd34', '新名字');
  });

  it('失败分支经 schema parse 返回错误码（not-found）', async () => {
    const raw = { ok: false, error: 'not-found' };
    setElectronApi({ updateCustomSkillInstallTarget: () => Promise.resolve(raw) });
    await expect(bridge.updateCustomSkillInstallTarget('custom-ab12cd34', 'x')).resolves.toEqual(
      SkillCustomTargetMutationResultSchema.parse(raw),
    );
  });

  it('window.electron 缺席与 IPC 异常均回退 invoke-failed 结果', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setElectronApi(undefined);
    await expect(bridge.updateCustomSkillInstallTarget('x', 'y')).resolves.toEqual({ ok: false, error: 'invoke-failed' });
    setElectronApi({ updateCustomSkillInstallTarget: () => Promise.reject(new Error('ipc down')) });
    await expect(bridge.updateCustomSkillInstallTarget('x', 'y')).resolves.toEqual({ ok: false, error: 'invoke-failed' });
  });
});

describe('removeCustomSkillInstallTarget 边界校验', () => {
  it('成功分支经 schema parse 返回 { ok: true }，位置参数原样透传', async () => {
    const raw = { ok: true };
    const removeCustom = vi.fn(() => Promise.resolve(raw));
    setElectronApi({ removeCustomSkillInstallTarget: removeCustom });
    await expect(bridge.removeCustomSkillInstallTarget('custom-ab12cd34')).resolves.toEqual(
      SkillRemoveCustomTargetResultSchema.parse(raw),
    );
    expect(removeCustom).toHaveBeenCalledWith('custom-ab12cd34');
  });

  it('失败分支经 schema parse 返回错误码', async () => {
    const raw = { ok: false, error: 'nested-dir' };
    setElectronApi({ removeCustomSkillInstallTarget: () => Promise.resolve(raw) });
    await expect(bridge.removeCustomSkillInstallTarget('custom-ab12cd34')).resolves.toEqual(
      SkillRemoveCustomTargetResultSchema.parse(raw),
    );
  });

  it('window.electron 缺席与 IPC 异常均回退 invoke-failed 结果', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setElectronApi(undefined);
    await expect(bridge.removeCustomSkillInstallTarget('x')).resolves.toEqual({ ok: false, error: 'invoke-failed' });
    setElectronApi({ removeCustomSkillInstallTarget: () => Promise.reject(new Error('ipc down')) });
    await expect(bridge.removeCustomSkillInstallTarget('x')).resolves.toEqual({ ok: false, error: 'invoke-failed' });
  });
});

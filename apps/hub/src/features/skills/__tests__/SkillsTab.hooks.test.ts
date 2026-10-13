import { describe, expect, it } from 'vitest';

import type { CustomSkillInstallTarget, SkillCatalog, SkillInstalledState } from '@iart/contracts';
import {
  collectPendingUpdates,
  INSTALL_TARGETS,
  skillHasUpdate,
  targetShortLabel,
  type InstallTargetRow,
} from '../SkillsTab.hooks';

/**
 * 目标行集合与显示名口径：
 * - INSTALL_TARGETS 语义收窄为内置两行，文案「全局 .agents」/「Claude Code」；
 * - targetShortLabel 查表（内置映射 → 自定义按 id 查 name → 兜底返回原始 id），
 *   未知目标不得误显示为某个内置名（历史二元三目会把未知 id 显示成「Claude Code」）；
 * - 更新收集覆盖自定义目标行。
 */

const customTarget = (overrides: Partial<CustomSkillInstallTarget> = {}): CustomSkillInstallTarget => ({
  id: 'custom-ab12cd34',
  name: '我的目录',
  skillsDir: '/Users/me/skills',
  ...overrides,
});

const rowsWithCustom = (overrides: Partial<InstallTargetRow> = {}): InstallTargetRow[] => [
  ...INSTALL_TARGETS,
  { target: 'custom-ab12cd34', label: '我的目录', kind: 'custom', ...overrides },
];

describe('targetShortLabel 显示名口径', () => {
  it('内置目标按查表文案显示', () => {
    expect(INSTALL_TARGETS.map((row) => row.label)).toEqual(['全局 .agents', 'Claude Code']);
    expect(targetShortLabel('agents')).toBe('全局 .agents');
    expect(targetShortLabel('claude')).toBe('Claude Code');
  });

  it('自定义目标按 id 查注册表 name', () => {
    const customTargets = [customTarget(), customTarget({ id: 'custom-9988aabb', name: 'NAS 技能库' })];
    expect(targetShortLabel('custom-ab12cd34', customTargets)).toBe('我的目录');
    expect(targetShortLabel('custom-9988aabb', customTargets)).toBe('NAS 技能库');
  });

  it('未知 id 兜底返回原始 id，不误显示为内置名', () => {
    // 无自定义注册表
    expect(targetShortLabel('custom-gone')).toBe('custom-gone');
    // 有注册表但未命中同样兜底
    expect(targetShortLabel('custom-gone', [customTarget()])).toBe('custom-gone');
  });
});

describe('更新收集覆盖自定义目标行', () => {
  const skill = {
    id: 'gpt-image',
    name: 'GPT Image',
    version: '1.2.0',
    description: '文生图 / 改图技能',
    bundleKey: 'skills/bundles/gpt-image-1.2.0.json',
    sha512: 'a'.repeat(128),
  };
  const catalog: SkillCatalog = { version: 1, skills: [skill] };
  const installedState: SkillInstalledState = {
    skills: [{ skillId: skill.id, version: '1.1.0', target: 'custom-ab12cd34' }],
  };

  it('自定义目标上本地版本低于远端时收集为待更新组合', () => {
    const pending = collectPendingUpdates(catalog, installedState, rowsWithCustom());
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ skill, target: 'custom-ab12cd34', installedVersion: '1.1.0' });
  });

  it('skillHasUpdate 覆盖自定义目标行', () => {
    expect(skillHasUpdate(skill, installedState, rowsWithCustom())).toBe(true);
    expect(skillHasUpdate(skill, installedState, INSTALL_TARGETS)).toBe(false);
  });
});

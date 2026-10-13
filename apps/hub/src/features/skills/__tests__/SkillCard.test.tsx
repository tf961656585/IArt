import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { SkillCatalogEntry, SkillInstalledState } from '@iart/contracts';
import { INSTALL_TARGETS, type InstallTargetRow } from '../SkillsTab.hooks';
import { SkillCard } from '../SkillCard';

/**
 * Skill 卡定位入口（spec docs/editor/本地文件快捷跳转.md LFJ-007）：
 * 已安装目标行提供「打开所在文件夹」，未安装目标不呈现（能力门先行）；
 * 点击把 (skill, target) 交给上层动作，路径解析归主进程。
 *
 * 目标行集合（内置 + 自定义）由 props 传入（useSkills 的 targetRows），
 * 卡片只读展示，不承载管理入口（管理在「管理安装目标」弹层）。
 */

const skill: SkillCatalogEntry = {
  id: 'gpt-image',
  name: 'GPT Image',
  version: '1.2.0',
  description: '文生图 / 改图技能',
  bundleKey: 'skills/bundles/gpt-image-1.2.0.json',
  sha512: 'a'.repeat(128),
};

const customRow = (overrides: Partial<InstallTargetRow> = {}): InstallTargetRow => ({
  target: 'custom-ab12cd34',
  label: '我的目录',
  kind: 'custom',
  ...overrides,
});

const baseProps = {
  skill,
  targetRows: INSTALL_TARGETS,
  busyKeys: new Set<string>(),
  disabled: false,
  onInstall: vi.fn(),
};

describe('SkillCard 定位入口（LFJ-007）', () => {
  // @spec: LFJ-007
  it('已安装目标行提供「打开所在文件夹」，点击携带该目标的 (skill, target)', () => {
    const installedState: SkillInstalledState = {
      skills: [{ skillId: skill.id, version: '1.1.0', target: 'agents' }],
    };
    const onReveal = vi.fn();
    render(<SkillCard {...baseProps} installedState={installedState} onReveal={onReveal} />);

    const [revealButton] = screen.getAllByRole('button', { name: '打开 全局 .agents 的安装文件夹' });
    if (revealButton === undefined) throw new Error('已安装目标行应提供「打开所在文件夹」按钮');
    // 仅 agents 已安装：入口恰好一个（未安装的全局 .agents 之外目标行不呈现）
    expect(screen.getAllByRole('button', { name: '打开 全局 .agents 的安装文件夹' })).toHaveLength(1);

    fireEvent.click(revealButton);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith(skill, 'agents');
  });

  // @spec: LFJ-007
  it('未安装目标不呈现定位入口（能力门先行）', () => {
    const installedState: SkillInstalledState = { skills: [] };
    const onReveal = vi.fn();
    render(<SkillCard {...baseProps} installedState={installedState} onReveal={onReveal} />);

    expect(screen.queryByRole('button', { name: /^打开 .* 的安装文件夹$/ })).not.toBeInTheDocument();
  });

  // @spec: LFJ-007
  it('两个内置目标都安装时各呈现一个入口，分别定位各自安装目录', () => {
    const installedState: SkillInstalledState = {
      skills: [
        { skillId: skill.id, version: '1.2.0', target: 'agents' },
        { skillId: skill.id, version: '1.2.0', target: 'claude' },
      ],
    };
    const onReveal = vi.fn();
    render(<SkillCard {...baseProps} installedState={installedState} onReveal={onReveal} />);

    const buttons = screen.getAllByRole('button', { name: /^打开 .* 的安装文件夹$/ });
    expect(buttons).toHaveLength(2);

    // INSTALL_TARGETS 固定顺序 [agents, claude]：第二枚属 Claude Code 行
    const claudeButton = buttons[1];
    if (claudeButton === undefined) throw new Error('Claude Code 行应提供「打开所在文件夹」按钮');
    fireEvent.click(claudeButton);
    expect(onReveal).toHaveBeenCalledWith(skill, 'claude');
  });
});

describe('SkillCard 目标行集合（内置 + 自定义）', () => {
  it('内置行按固定文案渲染（全局 .agents / Claude Code）', () => {
    render(<SkillCard {...baseProps} installedState={{ skills: [] }} onReveal={vi.fn()} />);

    expect(screen.getByText('全局 .agents')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('自定义行显示自定义 name，行内动作携带自定义 target id', () => {
    const onInstall = vi.fn();
    render(
      <SkillCard
        {...baseProps}
        targetRows={[...INSTALL_TARGETS, customRow()]}
        installedState={{ skills: [] }}
        onInstall={onInstall}
        onReveal={vi.fn()}
      />,
    );

    expect(screen.getByText('我的目录')).toBeInTheDocument();
    // 共三行：内置两行 + 自定义一行，各自一个「安装」按钮（可访问名带目标名注记）
    expect(screen.getAllByRole('button', { name: /^安装（.+）$/ })).toHaveLength(3);

    const installButtons = screen.getAllByRole('button', { name: /^安装（.+）$/ });
    const customInstall = installButtons[2];
    if (customInstall === undefined) throw new Error('自定义目标行应提供「安装」按钮');
    fireEvent.click(customInstall);
    expect(onInstall).toHaveBeenCalledWith(skill, 'custom-ab12cd34');
  });

  it('卡片只读展示目标行：不提供改名/删除/内置徽标等管理入口', () => {
    render(
      <SkillCard
        {...baseProps}
        targetRows={[...INSTALL_TARGETS, customRow()]}
        installedState={{ skills: [] }}
        onReveal={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '改名' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
    expect(screen.queryByText('内置')).not.toBeInTheDocument();
  });

  it('自定义目标已安装时提供「打开所在文件夹」，定位携带自定义 id', () => {
    const onReveal = vi.fn();
    render(
      <SkillCard
        {...baseProps}
        targetRows={[...INSTALL_TARGETS, customRow()]}
        installedState={{ skills: [{ skillId: skill.id, version: '1.2.0', target: 'custom-ab12cd34' }] }}
        onReveal={onReveal}
      />,
    );

    expect(screen.getAllByRole('button', { name: '打开 我的目录 的安装文件夹' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '打开 我的目录 的安装文件夹' }));
    expect(onReveal).toHaveBeenCalledWith(skill, 'custom-ab12cd34');
  });
});

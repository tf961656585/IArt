import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { ProjectIndexItem } from '@iart/contracts';
import { ProjectCard } from '../ProjectCard';

/**
 * 项目卡定位入口文案（spec docs/editor/本地文件快捷跳转.md LFJ-009）：
 * 目录类入口统一「打开所在文件夹」，禁倒装（「在文件夹中显示」）与旧表述（「打开所在位置」）。
 */

const project: ProjectIndexItem = {
  nodeGraphId: 'graph-1',
  name: '示例项目',
  savedAt: 1759000000000,
  createdAt: 1759000000000,
  path: '/tmp/projects/示例项目',
  valid: true,
  mediaSize: 0,
  mediaCount: 0,
};

const baseProps = {
  project,
  isOpened: false,
  onOpen: vi.fn(),
  onDelete: vi.fn(),
  onExport: vi.fn(),
};

describe('ProjectCard 定位入口文案（LFJ-009）', () => {
  // @spec: LFJ-009
it('右键菜单提供「打开所在文件夹」，不再出现「打开所在位置」', async () => {
    const onReveal = vi.fn();
    render(<ProjectCard {...baseProps} onReveal={onReveal} />);

    fireEvent.contextMenu(screen.getByText('示例项目'));

    const menuItem = await screen.findByRole('menuitem', { name: '打开所在文件夹' });
    expect(menuItem).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '打开所在位置' })).not.toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
});

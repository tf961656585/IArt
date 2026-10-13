import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PackageSummary } from '@iart/contracts';
import { PackageCard } from '../PackageCard';

/**
 * 包卡片定位入口文案（spec docs/editor/本地文件快捷跳转.md LFJ-009）：
 * 目录类入口统一「打开所在文件夹」，禁倒装表述（「在文件夹中显示」）。
 */

const pkg: PackageSummary = {
  packageId: 'pkg_1',
  name: '示例包',
  folderName: '示例包',
  path: '/tmp/projects/示例项目/packages/示例包',
  createdAt: 1759000000000,
  entryCount: 0,
  entries: [],
};

const baseProps = {
  pkg,
  onPreview: vi.fn(),
  onRename: vi.fn(() => Promise.resolve(true)),
  onDelete: vi.fn(() => Promise.resolve()),
};

describe('PackageCard 定位入口文案（LFJ-009）', () => {
  // @spec: LFJ-009
it('右键菜单提供「打开所在文件夹」，不再出现倒装「在文件夹中显示」', async () => {
    const onReveal = vi.fn();
    render(<PackageCard {...baseProps} onReveal={onReveal} />);

    fireEvent.contextMenu(screen.getByText('示例包'));

    const menuItem = await screen.findByRole('menuitem', { name: '打开所在文件夹' });
    expect(menuItem).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: '在文件夹中显示' })).not.toBeInTheDocument();
  });
});

afterEach(() => {
  cleanup();
});

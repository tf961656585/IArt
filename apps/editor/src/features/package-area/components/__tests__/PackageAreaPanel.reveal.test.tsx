import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

import type { PackageAreaEntryView, PackageAreaView, PackageSummary } from '@iart/contracts';
import { usePackageAreaStore } from '@/features/package-area/store/packageAreaStore';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import type { NodeGraph } from '@/features/canvas/types';
import { getCurrentProjectPath } from '@/features/canvas/storage/backendCore';
import type * as BackendCoreModule from '@/features/canvas/storage/backendCore';
import { createPackage, listPackages, revealPackage } from '@/features/package-area/storage/backendPackages';

/**
 * 打包区面板「打开所在文件夹」定位入口（spec docs/editor/本地文件快捷跳转.md
 * LFJ-001 / LFJ-002 / LFJ-003 / LFJ-010）：
 *
 * 保护：
 * - LFJ-001：头部与「执行打包」同栏存在「打开所在文件夹」常驻按钮；点击经 packages:reveal
 *   定位最近一次打包产物目录（目标 = packages:list 中 createdAt 最新的包）。
 * - LFJ-002：当前项目尚无已生成包时按钮禁用；打包成功后立即可用并指向新包。
 * - LFJ-003：定位失败（ok:false 或异常）给可见「找不到」反馈，不静默吞错（主进程 debug
 *   日志属主进程侧，真机项）。
 * - LFJ-010：调用链只传 packageId（目录定位并高亮目录本身的语义由 packages:reveal 通道
 *   在主进程用 shell.showItemInFolder 承载）；Finder 实际唤起为真机项，单测记 SKIP。
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/features/package-area/storage/backendPackages', () => ({
  listPackages: vi.fn(),
  createPackage: vi.fn(),
  revealPackage: vi.fn(),
}));

vi.mock('@/features/canvas/storage/backendCore', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendCoreModule>();
  return { ...actual, getCurrentProjectPath: vi.fn() };
});

import { PackageAreaPanel } from '../PackageAreaPanel';

const PROJECT_PATH = '/projects/demo';

const graphWith = (nodes: NodeGraph['nodes']): NodeGraph => ({
  id: 'graph-1',
  name: 'test',
  description: undefined,
  status: 'draft',
  nodes,
  annotations: [],
  variables: undefined,
  settings: undefined,
  viewport: { x: 0, y: 0, zoom: 1 },
  meta: {
    version: '1.0.0',
    schemaVersion: undefined,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

// 面板只消费 nodeGraph.id（graphId 就绪信号），节点内容与本测试无关。
const nodeGraph = graphWith([]);

const packageAreaViewWith = (entries: PackageAreaEntryView[]): PackageAreaView => ({
  graphId: 'graph-1',
  entries,
});

/** 失效占位条目：让打包区非空（「执行打包」可用），不依赖完整媒体资产形状。 */
const missingEntry: PackageAreaEntryView = {
  packageEntryId: 'pe-1',
  graphId: 'graph-1',
  order: 0,
  assetId: 'asset-1',
  mediaType: 'image',
  createdAt: 1_770_000_000_000,
  asset: { assetId: 'asset-1', mediaType: 'image', isMissing: true, mediaAsset: null },
};

const pkg = (packageId: string, createdAt: number): PackageSummary => ({
  packageId,
  name: `包 ${packageId}`,
  folderName: packageId,
  path: `${PROJECT_PATH}/packages/${packageId}`,
  createdAt,
  entryCount: 1,
  entries: [
    { fileName: '1_a.png', mediaType: 'image', url: `package-media://${packageId}/1_a.png` },
  ],
});

const getRevealButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: '打开所在文件夹' }) as HTMLButtonElement;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(getCurrentProjectPath).mockResolvedValue(PROJECT_PATH);
  useCanvasStore.setState({ nodeGraph, selectedNodeIds: [] });
  usePackageAreaStore.setState({
    packageArea: packageAreaViewWith([missingEntry]),
    loading: false,
    error: null,
  });
});

describe('打包区面板「打开所在文件夹」', () => {
  it('LFJ-001: 头部常驻「打开所在文件夹」按钮，点击定位 createdAt 最新的包（最近一次打包产物）', async () => {
    // @spec: LFJ-001
    vi.mocked(listPackages).mockResolvedValue({
      packages: [pkg('pkg-old', 1_770_000_000_000), pkg('pkg-new', 1_770_000_900_000)],
    });
    vi.mocked(revealPackage).mockResolvedValue({ ok: true });

    render(<PackageAreaPanel />);

    const button = await waitFor(() => {
      const el = getRevealButton();
      expect(el).not.toBeDisabled();
      return el;
    });
    expect(button).toHaveTextContent('打开所在文件夹');

    fireEvent.click(button);
    await waitFor(() => {
      expect(revealPackage).toHaveBeenCalledTimes(1);
    });
    expect(revealPackage).toHaveBeenCalledWith(PROJECT_PATH, 'pkg-new');
  });

  it('LFJ-002: 当前项目尚无已生成包时按钮禁用', async () => {
    // @spec: LFJ-002
    vi.mocked(listPackages).mockResolvedValue({ packages: [] });

    render(<PackageAreaPanel />);

    await waitFor(() => {
      expect(listPackages).toHaveBeenCalledWith(PROJECT_PATH);
    });
    expect(getRevealButton()).toBeDisabled();
    expect(revealPackage).not.toHaveBeenCalled();
  });

  it('LFJ-002: 打包成功后立即可用并指向新包', async () => {
    // @spec: LFJ-002
    vi.mocked(listPackages).mockResolvedValue({ packages: [] });
    vi.mocked(createPackage).mockResolvedValue({
      package: pkg('pkg-new-1', 1_770_001_000_000),
      skippedAssetIds: [],
    });
    vi.mocked(revealPackage).mockResolvedValue({ ok: true });

    render(<PackageAreaPanel />);
    expect(getRevealButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '执行打包' }));
    fireEvent.change(await screen.findByLabelText('包名'), { target: { value: '我的包' } });
    fireEvent.click(screen.getByRole('button', { name: '创建包' }));

    const button = await waitFor(() => {
      const el = getRevealButton();
      expect(el).not.toBeDisabled();
      return el;
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(revealPackage).toHaveBeenCalledWith(PROJECT_PATH, 'pkg-new-1');
    });
  });

  it('LFJ-003: 定位失败（ok:false）给「找不到」反馈，不静默', async () => {
    // @spec: LFJ-003
    vi.mocked(listPackages).mockResolvedValue({ packages: [pkg('pkg-1', 1_770_000_000_000)] });
    vi.mocked(revealPackage).mockResolvedValue({ ok: false });

    render(<PackageAreaPanel />);
    fireEvent.click(await waitFor(() => getRevealButton()));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('没能找到打包文件夹，可能已被移动或删除');
    });
  });

  it('LFJ-003: 定位异常（IPC 抛错）同样给「找不到」反馈，不静默', async () => {
    // @spec: LFJ-003
    vi.mocked(listPackages).mockResolvedValue({ packages: [pkg('pkg-1', 1_770_000_000_000)] });
    vi.mocked(revealPackage).mockRejectedValue(new Error('ipc unavailable'));

    render(<PackageAreaPanel />);
    fireEvent.click(await waitFor(() => getRevealButton()));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('没能找到打包文件夹，可能已被移动或删除');
    });
  });

  it('LFJ-010: 调用链只传 packageId，目录高亮语义由 packages:reveal 通道承载（Finder 唤起为真机项，SKIP）', async () => {
    // @spec: LFJ-010
    vi.mocked(listPackages).mockResolvedValue({ packages: [pkg('pkg-1', 1_770_000_000_000)] });
    vi.mocked(revealPackage).mockResolvedValue({ ok: true });

    render(<PackageAreaPanel />);
    fireEvent.click(await waitFor(() => getRevealButton()));

    await waitFor(() => {
      expect(revealPackage).toHaveBeenCalledTimes(1);
    });
    // 前端不自行拼接路径：入参是 packageId，不是包文件夹绝对路径。
    // noUncheckedIndexedAccess 下 mock.calls[0] 可能为 undefined，先控制流收窄再断言。
    const call = vi.mocked(revealPackage).mock.calls[0];
    if (call === undefined) {
      throw new Error('revealPackage 应已被调用一次');
    }
    expect(call[0]).toBe(PROJECT_PATH);
    expect(call[1]).toBe('pkg-1');
    expect(call[1]).not.toContain('/packages/');
  });
});

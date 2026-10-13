import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// reveal 封装整链 mock 掉（IPC → 主进程定位不属于本组件的职责面）；断言只看「点了没有、
// 点的时候把哪条预览地址交给了封装」。失败分级 toast 的语义由封装自己的测试
// （revealFilesUrlWithToast.test.ts）承载，这里不重复。
const revealFilesUrlWithToast = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock('@/client/utils/revealFilesUrlWithToast', () => ({
  revealFilesUrlWithToast: (url: unknown, options: unknown) =>
    revealFilesUrlWithToast(url, options),
}));

import { AssetPreviewDialog } from '../AssetPreviewDialog';

/**
 * AssetPreviewDialog 定位入口（docs/editor/本地文件快捷跳转.md LFJ-004）：
 * 能力门（classifyMediaUrl().capabilities.canRevealFile）通过才渲染「打开文件所在位置」，
 * 三类媒体分支（image/video/audio）同位同形；点击把当前预览地址交给共享 reveal 封装。
 *
 * 覆盖边界说明：jsdom 的 fireEvent.click 直接投递目标节点，覆盖不了真机的指针捕获重定向
 * 语义——本按钮是 ZoomableImagePreview surface 的**兄弟节点**（不在 surface 根的子树内），
 * pointerdown 不经过 surface 的 setPointerCapture 路径，jsdom 无法失真的正是这一前置条件
 * （对照 ZoomableImagePreview.test.tsx 的槽位守卫测试：那是挂在 surface 子树内的槽位）。
 * 真机点击点验按 spec「真机类验收」双轨执行（SKIP 注记：真机项），不进本文件。
 */

const LOCAL_MEDIA_URL = 'local-media://prj_demo/images/asset-1.png';
const REMOTE_URL = 'https://example.com/generated.png';

const renderDialog = (
  mediaType: 'image' | 'video' | 'audio',
  previewUrl: string | null,
  extraProps: Partial<Parameters<typeof AssetPreviewDialog>[0]> = {},
): void => {
  render(
    <AssetPreviewDialog
      open
      onOpenChange={() => undefined}
      mediaType={mediaType}
      previewUrl={previewUrl}
      name="测试资产"
      {...extraProps}
    />,
  );
};

const revealButton = (): HTMLElement | null =>
  screen.queryByRole('button', { name: '打开文件所在位置' });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AssetPreviewDialog · 定位入口能力门（LFJ-004）', () => {
  it('image + 项目本地媒体：按钮渲染', () => {
    // @spec: LFJ-004
    renderDialog('image', LOCAL_MEDIA_URL);
    expect(revealButton()).not.toBeNull();
  });

  it('video + 项目本地媒体：按钮渲染（三态同形）', () => {
    // @spec: LFJ-004
    renderDialog('video', LOCAL_MEDIA_URL);
    expect(revealButton()).not.toBeNull();
  });

  it('audio + 项目本地媒体：按钮渲染（三态同形）', () => {
    // @spec: LFJ-004
    renderDialog('audio', LOCAL_MEDIA_URL);
    expect(revealButton()).not.toBeNull();
  });

  it('远端 URL：能力门不通过，不渲染（判据三：不呈现，不让点击后才失败）', () => {
    // @spec: LFJ-004
    renderDialog('image', REMOTE_URL);
    expect(revealButton()).toBeNull();
  });

  it('data URL：不渲染', () => {
    // @spec: LFJ-004
    renderDialog('image', 'data:image/png;base64,AAAA');
    expect(revealButton()).toBeNull();
  });

  it('空地址（相册占位页形态）：不渲染', () => {
    // @spec: LFJ-004
    renderDialog('image', '');
    expect(revealButton()).toBeNull();
  });

  it('无媒体面（previewUrl null）：不渲染', () => {
    // @spec: LFJ-004
    renderDialog('image', null);
    expect(revealButton()).toBeNull();
  });

  it('faceSlot 替代媒体面（相册错误详情形态）：不渲染', () => {
    // @spec: LFJ-004
    renderDialog('image', null, { faceSlot: <div>生成失败</div> });
    expect(revealButton()).toBeNull();
  });
});

describe('AssetPreviewDialog · 点击调用 reveal 封装', () => {
  it('点击把当前预览地址交给 revealFilesUrlWithToast（不新写 toast 文案）', () => {
    // @spec: LFJ-004
    renderDialog('image', LOCAL_MEDIA_URL);
    fireEvent.click(screen.getByRole('button', { name: '打开文件所在位置' }));
    expect(revealFilesUrlWithToast).toHaveBeenCalledTimes(1);
    expect(revealFilesUrlWithToast.mock.calls[0]?.[0]).toBe(LOCAL_MEDIA_URL);
    expect(revealFilesUrlWithToast.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('视频分支点击同样交给封装', () => {
    // @spec: LFJ-004
    renderDialog('video', LOCAL_MEDIA_URL);
    fireEvent.click(screen.getByRole('button', { name: '打开文件所在位置' }));
    expect(revealFilesUrlWithToast.mock.calls[0]?.[0]).toBe(LOCAL_MEDIA_URL);
  });
});

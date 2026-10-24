import { describe, expect, it } from 'vitest';

import {
  AUDIO_CHROME_OVERHEAD,
  CANVAS_MEDIA_MAX_DISPLAY_DIMENSION,
  CANVAS_MEDIA_MIN_WIDTH,
  GROUP_COLLAPSED_HEIGHT,
  GROUP_COLLAPSED_MIN_WIDTH,
  computeCanvasAudioNodeSize,
  computeCanvasMediaDisplaySize,
  computeFittedCanvasSize,
  computeGroupCollapsedBox,
  computeGroupExpandedBox,
  computeGroupExpandedPosition,
  computeGroupRenderBox,
  estimateGroupCollapsedWidth,
} from '@iart/utils/canvas-geometry';

/**
 * 共享画布几何口径的直接单测。
 *
 * 这些公式同时服务画布界面与 CLI 投影；数值锚点与画布侧既有实现一致，
 * 改动任何一个都意味着两端渲染/报告同步变化。
 */
describe('computeFittedCanvasSize', () => {
  it('在限制内原样返回并标记未缩放', () => {
    expect(computeFittedCanvasSize(300, 200, 320)).toEqual({
      width: 300,
      height: 200,
      resized: false,
    });
  });

  it('超限时按较小比例等比缩放', () => {
    expect(computeFittedCanvasSize(500, 600, 320)).toEqual({
      width: 267,
      height: 320,
      resized: true,
    });
  });

  it('maxDimension 无效时视为无上限', () => {
    expect(computeFittedCanvasSize(5000, 4000, undefined)).toEqual({
      width: 5000,
      height: 4000,
      resized: false,
    });
  });
});

describe('computeCanvasMediaDisplaySize', () => {
  it('竖图按长边 320 收敛（1024x1536 → 213x320）', () => {
    expect(computeCanvasMediaDisplaySize({ width: 1024, height: 1536 }, 3 / 2)).toEqual({
      width: 213,
      height: 320,
    });
  });

  it('方图 1024x1024 → 320x320', () => {
    expect(computeCanvasMediaDisplaySize({ width: 1024, height: 1024 }, 1)).toEqual({
      width: 320,
      height: 320,
    });
  });

  it('小图抬升到宽度下限 180（100x50 → 180x90）', () => {
    expect(computeCanvasMediaDisplaySize({ width: 100, height: 50 }, 3 / 2)).toEqual({
      width: 180,
      height: 90,
    });
  });

  it('极端竖图抬升会超过上限时回退 fitted（100x1000 → 32x320）', () => {
    expect(computeCanvasMediaDisplaySize({ width: 100, height: 1000 }, 3 / 2)).toEqual({
      width: 32,
      height: 320,
    });
  });

  it('无 meta 返回 null', () => {
    expect(computeCanvasMediaDisplaySize(null, 3 / 2)).toBeNull();
  });

  it('常量口径固定（下限 180 / 上限 320）', () => {
    expect(CANVAS_MEDIA_MIN_WIDTH).toBe(180);
    expect(CANVAS_MEDIA_MAX_DISPLAY_DIMENSION).toBe(320);
  });
});

describe('容器派生几何', () => {
  const members = [
    { position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
    { position: { x: 300, y: 200 }, size: { width: 100, height: 100 } },
  ];

  it('展开态 position = 成员包围盒左上角 − (12, 40)', () => {
    expect(computeGroupExpandedPosition(members)).toEqual({ x: -12, y: -40 });
  });

  it('展开态 size = 包围盒 + padding + header', () => {
    expect(computeGroupExpandedBox(members)).toEqual({
      position: { x: -12, y: -40 },
      size: { width: 424, height: 352 },
    });
  });

  it('空成员返回 null（由调用方回落）', () => {
    expect(computeGroupExpandedBox([])).toBeNull();
  });

  it('折叠态卡片宽度取组名估算与下限的较大值', () => {
    expect(estimateGroupCollapsedWidth('abc')).toBe(GROUP_COLLAPSED_MIN_WIDTH);
    expect(estimateGroupCollapsedWidth('a'.repeat(40))).toBe(40 * 8 + 44 + 56);
    expect(computeGroupCollapsedBox({ x: 10, y: 20 }, 'abc')).toEqual({
      position: { x: 10, y: 20 },
      size: { width: GROUP_COLLAPSED_MIN_WIDTH, height: GROUP_COLLAPSED_HEIGHT },
    });
  });

  it('渲染框按折叠态选择卡片形态', () => {
    expect(
      computeGroupRenderBox({
        collapsed: true,
        position: { x: 5, y: 6 },
        name: '组',
        members,
      }),
    ).toEqual({
      position: { x: 5, y: 6 },
      size: { width: GROUP_COLLAPSED_MIN_WIDTH, height: GROUP_COLLAPSED_HEIGHT },
    });
  });
});

describe('computeCanvasAudioNodeSize', () => {
  it('分段列表与编辑按钮同时渲染时按块叠加', () => {
    expect(
      computeCanvasAudioNodeSize({
        segmentsCount: 3,
        segmentModeEnabled: true,
        hasAudioUrl: true,
        chrome: AUDIO_CHROME_OVERHEAD,
      }),
    ).toEqual({ width: 200, height: 234 });
  });

  it('无分段、无音频 URL 时只有播放区与 chrome', () => {
    expect(
      computeCanvasAudioNodeSize({
        segmentsCount: 0,
        segmentModeEnabled: false,
        hasAudioUrl: false,
      }),
    ).toEqual({ width: 200, height: 90 });
  });
});

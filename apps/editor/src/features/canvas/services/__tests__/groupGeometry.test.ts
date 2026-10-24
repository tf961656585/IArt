import { describe, expect, it } from 'vitest';
import {
  GROUP_COLLAPSED_HEIGHT,
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_LOD_ANCHOR_SCREEN_SIZE,
  GROUP_LOD_LOCATE_ZOOM,
  GROUP_LOD_TRIGGER_SCREEN_HEIGHT,
  GROUP_LOD_TRIGGER_SCREEN_WIDTH,
  computeLodAnchorLocateZoom,
  isContainerLodDegraded,
  shouldShowAgentLeafGrip,
  shouldShowContainerGrip,
} from '../groupGeometry';

/**
 * computeLodAnchorLocateZoom 是 spec「聚焦脱离 LOD 不变量」（AG-CN-021）的可执行表达：
 * 点击 LOD 锚点定位后，目标组的折叠卡片屏幕尺寸（聚焦后 zoom × 卡片画布尺寸）的
 * 每一维度必须分别 ≥ 宽阈值 / 高阈值（双阈值）。本测试套验证该不变量在任意合法输入下成立。
 */
describe('computeLodAnchorLocateZoom', () => {
  // @spec: AG-CN-021
  it('满足聚焦脱离 LOD 双阈值不变量：zoom × 宽 ≥ 120 且 zoom × 高 ≥ 48（多组尺寸）', () => {
    const cases: ReadonlyArray<[number, number]> = [
      [240, 72], // 折叠卡片默认推导尺寸（100% 缩放下正好显示）
      [120, 90], // 宽恰等于阈值
      [81, 81], // 宽受限、高达标
      [80, 80], // 宽略低于阈值
      [50, 50], // 远低于阈值
      [240, 30], // 宽达标、高受限
      [100, 72], // 宽受限
      [90, 85], // 宽受限、高刚好
    ];
    const EPSILON = 1e-9;
    for (const [w, h] of cases) {
      const zoom = computeLodAnchorLocateZoom(w, h);
      expect(zoom * w).toBeGreaterThanOrEqual(GROUP_LOD_TRIGGER_SCREEN_WIDTH - EPSILON);
      expect(zoom * h).toBeGreaterThanOrEqual(GROUP_LOD_TRIGGER_SCREEN_HEIGHT - EPSILON);
    }
  });

  // @spec: AG-CN-021
  it('宽高均远大于阈值时返回下限（不下探到 1 以下）', () => {
    // max(120/800, 48/600) = 0.15，被下限 1 抬升
    expect(computeLodAnchorLocateZoom(800, 600)).toBe(GROUP_LOD_LOCATE_ZOOM);
    expect(computeLodAnchorLocateZoom(1000, 1000)).toBe(GROUP_LOD_LOCATE_ZOOM);
  });

  // @spec: AG-CN-021
  it('折叠卡片默认尺寸（240×72）在 100% 缩放下不降级：返回 1', () => {
    // 旧单阈值 80px 的死锁场景：240×72 的屏幕高 72 < 80，zoom=1 时必然仍触发 LOD，
    // 折叠卡永远看不到。改为「高 < 48」后 72 ≥ 48 不再触发，默认 240×72 卡正常显示。
    const zoom = computeLodAnchorLocateZoom(
      GROUP_COLLAPSED_MIN_WIDTH,
      GROUP_COLLAPSED_HEIGHT,
    );
    expect(zoom).toBe(1);
    expect(GROUP_COLLAPSED_MIN_WIDTH * zoom).toBeGreaterThanOrEqual(
      GROUP_LOD_TRIGGER_SCREEN_WIDTH,
    );
    expect(GROUP_COLLAPSED_HEIGHT * zoom).toBeGreaterThanOrEqual(
      GROUP_LOD_TRIGGER_SCREEN_HEIGHT,
    );
  });

  // @spec: AG-CN-021
  it('最受限维度驱动反算：宽达标但高受限时按高反算（240×30 → 1.6）', () => {
    expect(computeLodAnchorLocateZoom(240, 30)).toBeCloseTo(1.6, 10);
  });

  // @spec: AG-CN-021
  it('宽受限时按宽反算（100×72 → 1.2）', () => {
    expect(computeLodAnchorLocateZoom(100, 72)).toBeCloseTo(1.2, 10);
  });

  // @spec: AG-CN-021
  it('两维接近阈值时取较大需求（90×85 → 120/90）', () => {
    // max(120/90 ≈ 1.333, 48/85 ≈ 0.565) = 120/90
    expect(computeLodAnchorLocateZoom(90, 85)).toBeCloseTo(120 / 90, 10);
  });

  // @spec: AG-CN-021
  it('零或负尺寸输入时返回下限（防御，不产生 Infinity/NaN）', () => {
    expect(computeLodAnchorLocateZoom(0, 0)).toBe(GROUP_LOD_LOCATE_ZOOM);
    expect(computeLodAnchorLocateZoom(-100, 100)).toBe(GROUP_LOD_LOCATE_ZOOM);
    expect(computeLodAnchorLocateZoom(100, -100)).toBe(GROUP_LOD_LOCATE_ZOOM);
  });
});

describe('isContainerLodDegraded', () => {
  // @spec: AG-CN-021
  it('屏幕宽 < 120 或屏幕高 < 48 时降级', () => {
    expect(isContainerLodDegraded(240, 72)).toBe(false);
    expect(isContainerLodDegraded(119, 72)).toBe(true);
    expect(isContainerLodDegraded(240, 47)).toBe(true);
    expect(isContainerLodDegraded(120, 48)).toBe(false);
  });
});

describe('shouldShowContainerGrip', () => {
  // @spec: AG-CN-019
  it('大容器（32 / 360 / 268）不显示握把', () => {
    expect(
      shouldShowContainerGrip({
        headerScreenHeight: 32,
        screenWidth: 360,
        screenHeight: 268,
      }),
    ).toBe(false);
  });

  // @spec: AG-CN-019
  it('0.7 档（头 22.4 屏幕高）显示握把', () => {
    expect(
      shouldShowContainerGrip({
        headerScreenHeight: 22.4,
        screenWidth: 252,
        screenHeight: 188,
      }),
    ).toBe(true);
  });

  // @spec: AG-CN-019
  it('0.4 档（最短边 107）显示握把', () => {
    expect(
      shouldShowContainerGrip({
        headerScreenHeight: 32,
        screenWidth: 144,
        screenHeight: 107,
      }),
    ).toBe(true);
  });

  // @spec: AG-CN-019
  it('空组（32 / 240 / 52）因最短边 < 120 显示握把', () => {
    expect(
      shouldShowContainerGrip({
        headerScreenHeight: 32,
        screenWidth: 240,
        screenHeight: 52,
      }),
    ).toBe(true);
  });

  // @spec: AG-CN-019
  it('边界：最短边恰为 120 时不显示', () => {
    expect(
      shouldShowContainerGrip({
        headerScreenHeight: 32,
        screenWidth: 360,
        screenHeight: 120,
      }),
    ).toBe(false);
  });
});

describe('shouldShowAgentLeafGrip', () => {
  // @spec: AG-CN-019
  it('单节点 Agent 只在卡片屏幕高 < 48px 时显示握把', () => {
    expect(shouldShowAgentLeafGrip(64)).toBe(false);
    expect(shouldShowAgentLeafGrip(48)).toBe(false);
    expect(shouldShowAgentLeafGrip(47.9)).toBe(true);
  });
});

describe('LOD 锚点尺寸常量', () => {
  // @spec: AG-CN-021
  it('锚点屏幕固定尺寸为 44px（Apple HIG / WCAG 2.5.5 舒适目标）', () => {
    expect(GROUP_LOD_ANCHOR_SCREEN_SIZE).toBe(44);
  });
});

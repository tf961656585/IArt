import { describe, expect, it } from 'vitest';
import {
  GROUP_COLLAPSED_HEIGHT,
  GROUP_COLLAPSED_MIN_WIDTH,
  GROUP_LOD_LOCATE_ZOOM,
  GROUP_LOD_TRIGGER_SCREEN_SIZE,
  computeLodAnchorLocateZoom,
} from '../groupGeometry';

/**
 * computeLodAnchorLocateZoom 是 spec「聚焦脱离 LOD 不变量」的可执行表达：
 * 点击 LOD 锚点定位后，目标组的折叠卡片屏幕尺寸（聚焦后 zoom × 卡片画布尺寸）的
 * 每一维度必须 ≥ GROUP_LOD_TRIGGER_SCREEN_SIZE。本测试套验证该不变量在任意合法输入下成立。
 */
describe('computeLodAnchorLocateZoom', () => {
  it('满足聚焦脱离 LOD 不变量：返回值 × min(宽, 高) ≥ 阈值（多组尺寸）', () => {
    const cases: ReadonlyArray<[number, number]> = [
      [240, 72], // 折叠卡片默认推导尺寸（宽 ≥ 最小宽度，高固定）
      [300, 100],
      [1000, 1000],
      [120, 90],
      [81, 81], // 刚好高于阈值
      [80, 80], // 恰等于阈值
      [79, 79], // 刚低于阈值
      [50, 50], // 远低于阈值
      [240, 50], // 宽达标、高受限
      [50, 240], // 高达标、宽受限
    ];
    for (const [w, h] of cases) {
      const zoom = computeLodAnchorLocateZoom(w, h);
      const limiting = Math.min(w, h);
      expect(zoom * limiting).toBeGreaterThanOrEqual(GROUP_LOD_TRIGGER_SCREEN_SIZE);
    }
  });

  it('宽高均远大于阈值时返回下限（不下探到 1 以下）', () => {
    // 阈值 80 / min(800,600)=600 ≈ 0.133，应被下限 1 抬升
    expect(computeLodAnchorLocateZoom(800, 600)).toBe(GROUP_LOD_LOCATE_ZOOM);
    expect(computeLodAnchorLocateZoom(1000, 1000)).toBe(GROUP_LOD_LOCATE_ZOOM);
  });

  it('折叠卡片默认尺寸（240×72）反算后脱离 LOD：min 维度屏幕尺寸 ≥ 阈值', () => {
    // 这是修复前的死锁场景：固定 zoom=1 时屏幕高 72 < 80 必然仍触发 LOD。
    // 反算后 min(240,72)=72 → zoom = 80/72 ≈ 1.111，72×1.111 ≈ 80 恰脱离。
    const zoom = computeLodAnchorLocateZoom(
      GROUP_COLLAPSED_MIN_WIDTH,
      GROUP_COLLAPSED_HEIGHT,
    );
    const limitingScreen = Math.min(
      GROUP_COLLAPSED_MIN_WIDTH,
      GROUP_COLLAPSED_HEIGHT,
    ) * zoom;
    expect(limitingScreen).toBeGreaterThanOrEqual(GROUP_LOD_TRIGGER_SCREEN_SIZE);
    expect(zoom).toBeGreaterThan(1);
  });

  it('最受限维度驱动反算：宽达标但高受限时按高反算', () => {
    // 宽 240 远达标，高 50 受限 → 按 50 反算 = 80/50 = 1.6
    expect(computeLodAnchorLocateZoom(240, 50)).toBeCloseTo(80 / 50, 10);
  });

  it('宽达标、高达标但接近阈值时反算值 > 1（恰脱离而非过脱离）', () => {
    // min=85 → 80/85 ≈ 0.94，被下限抬到 1；1×85=85 ≥ 80 成立
    const zoom = computeLodAnchorLocateZoom(90, 85);
    expect(zoom).toBe(GROUP_LOD_LOCATE_ZOOM);
    expect(Math.min(90, 85) * zoom).toBeGreaterThanOrEqual(GROUP_LOD_TRIGGER_SCREEN_SIZE);
  });

  it('零或负尺寸输入时返回下限（防御，不产生 Infinity/NaN）', () => {
    expect(computeLodAnchorLocateZoom(0, 0)).toBe(GROUP_LOD_LOCATE_ZOOM);
    expect(computeLodAnchorLocateZoom(-100, 100)).toBe(GROUP_LOD_LOCATE_ZOOM);
    expect(computeLodAnchorLocateZoom(100, -100)).toBe(GROUP_LOD_LOCATE_ZOOM);
  });
});

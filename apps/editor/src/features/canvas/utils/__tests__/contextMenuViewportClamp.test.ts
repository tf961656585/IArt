import { describe, expect, it } from 'vitest';
import {
  clampMenuLayoutToViewport,
  MENU_VIEWPORT_RESERVED_PX,
} from '../contextMenuViewportClamp';

/**
 * 主菜单视口钳制纯函数的回归保护。
 *
 * 背景（2026-09-25 真机 React #185 P0）：钳制数学内联在组件里时，测量用的是
 * getBoundingClientRect（transform 后矩形），面板的 zoom-in 入场动画让钳制路径的
 * 实测尺寸逐帧漂移，「测量→setState→重渲染→再测」永不收敛。修复后钳制数学收敛到
 * 本纯函数：同一输入恒定输出（幂等），组件侧以逐字段判等兜底。
 *
 * 崩溃几何：光标 (1000,660)、菜单 240×371、视口 1512×851 —— 底缘 1031 超出视口
 * 触发钳制路径，曾整树崩到错误边界。
 */

describe('clampMenuLayoutToViewport', () => {
  it('崩溃几何一次收敛：底缘溢出上移钳制，第二次调用返回全等结果（幂等）', () => {
    const input = {
      originX: 1000,
      originY: 660,
      width: 240,
      height: 371,
      viewportWidth: 1512,
      viewportHeight: 851,
    };

    const first = clampMenuLayoutToViewport(input);
    // 底缘 660+371=1031 超出 851−8=843：top 钳到 843−371=472；左右不溢出保持原位
    expect(first).toEqual({
      left: 1000,
      top: 472,
      maxHeight: 851 - MENU_VIEWPORT_RESERVED_PX,
    });

    // 同一输入永远得到同一输出：第二次调用全等（钳制幂等，不再触发 setState）
    const second = clampMenuLayoutToViewport(input);
    expect(second).toEqual(first);
    expect(second.left).toBe(first.left);
    expect(second.top).toBe(first.top);
    expect(second.maxHeight).toBe(first.maxHeight);
  });

  it('无需钳制的几何：原位输出（对照组 (950,200)）', () => {
    expect(
      clampMenuLayoutToViewport({
        originX: 950,
        originY: 200,
        width: 240,
        height: 371,
        viewportWidth: 1512,
        viewportHeight: 851,
      }),
    ).toEqual({ left: 950, top: 200, maxHeight: 851 - MENU_VIEWPORT_RESERVED_PX });
  });

  it('右缘溢出左移（翻转）：左缘钳到视口宽减边距减菜单宽', () => {
    // 1000+240=1240 ≤ 1504 不触发；改用右缘真实溢出的光标位
    expect(
      clampMenuLayoutToViewport({
        originX: 1400,
        originY: 200,
        width: 240,
        height: 100,
        viewportWidth: 1512,
        viewportHeight: 851,
      }).left,
    ).toBe(1512 - 8 - 240);
  });

  it('下缘溢出上移（翻转）：顶缘钳到视口高减边距减菜单高', () => {
    expect(
      clampMenuLayoutToViewport({
        originX: 100,
        originY: 800,
        width: 240,
        height: 371,
        viewportWidth: 1512,
        viewportHeight: 851,
      }).top,
    ).toBe(851 - 8 - 371);
  });

  it('期望位置越过左/上安全边距：钳到边距值', () => {
    const clamped = clampMenuLayoutToViewport({
      originX: 3,
      originY: 2,
      width: 100,
      height: 100,
      viewportWidth: 1512,
      viewportHeight: 851,
    });
    expect(clamped.left).toBe(8);
    expect(clamped.top).toBe(8);
  });

  it('极小视口：最大高度不低于 0', () => {
    expect(
      clampMenuLayoutToViewport({
        originX: 10,
        originY: 10,
        width: 100,
        height: 100,
        viewportWidth: 50,
        viewportHeight: 10,
      }).maxHeight,
    ).toBe(0);
  });
});

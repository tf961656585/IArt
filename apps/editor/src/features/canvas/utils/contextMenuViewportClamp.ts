/**
 * 右键菜单主面板的视口钳制纯函数（一次收敛、幂等）。
 *
 * 同一输入永远得到同一输出；组件侧的「测量 → 钳制 → setState」循环里，
 * 只要测量值稳定，第二次运行就是精确 no-op（组件侧以逐字段判等兜底，
 * 不做对象引用判等）。禁止在组件里内联复制本数学——回归测试以本函数为对象。
 *
 * 测量口径（关键，2026-09-25 真机 React #185 教训）：宽高必须用
 * `offsetWidth` / `offsetHeight` 等布局尺寸量测得，不得用 `getBoundingClientRect`——
 * 后者返回 transform 后矩形，主面板带 `animate-in zoom-in-95` 入场动画，
 * 动画进行中每次测得的尺寸都在漂移，钳制路径的 top/left 依赖该尺寸，
 * 会让「测量 → setState → 重渲染 → 再测」永不收敛。
 */

/** 菜单面板与视口边缘的安全边距（与子菜单同口径，spec §5.3 定位规则）。 */
export const MENU_VIEWPORT_MARGIN_PX = 8;
/** 菜单最大高度预留：视口高减去该值（上下各留 8px 呼吸空间）。 */
export const MENU_VIEWPORT_RESERVED_PX = 16;

export type MenuViewportClampInput = {
  /** 期望锚点（右键点屏幕坐标） */
  originX: number;
  originY: number;
  /** 菜单实测布局尺寸（transform 无关） */
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type MenuViewportClampedLayout = {
  left: number;
  top: number;
  /** 内部滚动的最大高度（视口高减去上下预留） */
  maxHeight: number;
};

/**
 * 把菜单布局钳制进视口：右/下溢出按需左/上移回（翻转），并把左/上边距钳到
 * 安全边距内；最大高度为视口高减上下预留（最低 0），供内部垂直滚动使用。
 */
export const clampMenuLayoutToViewport = (
  input: MenuViewportClampInput,
): MenuViewportClampedLayout => {
  const {
    originX,
    originY,
    width,
    height,
    viewportWidth,
    viewportHeight,
  } = input;
  const margin = MENU_VIEWPORT_MARGIN_PX;
  const maxHeight = Math.max(0, viewportHeight - MENU_VIEWPORT_RESERVED_PX);

  let left = originX;
  if (left + width > viewportWidth - margin) {
    left = viewportWidth - margin - width;
  }
  left = Math.max(margin, left);

  let top = originY;
  if (top + height > viewportHeight - margin) {
    top = viewportHeight - margin - height;
  }
  top = Math.max(margin, top);

  return { left: Math.round(left), top: Math.round(top), maxHeight };
};

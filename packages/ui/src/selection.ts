/**
 * 选中态共享配方（docs/ui-selection-standard.md §5）。
 *
 * 只导出类串，不绑定具体颜色：`--selection-bg` / `--selection-fg` /
 * `--selection-depth` / `--selection-edge` 由 Hub 与 Editor 各自的 globals.css
 * 按主题定义（Hub = L3 软凹陷；Editor = L1 实底回退，depth/edge 透明）。
 *
 * 消费方不得在页面里自造第三套选中填充：要么用这里的类串，要么走
 * `--selection-*` 令牌。改配方时四处同步：本文件、两个窗口 globals.css、
 * spec 的质检口径、原型（prototypes/interface-format-selection）。
 */

/** 选中底 + 反白文字 + 600 字重 + 钉住 hover（避免 ghost 基类把选中冲淡）。 */
export const SELECTION_SOFT_BASE =
  'bg-[var(--selection-bg)] text-[var(--selection-fg)] font-semibold hover:bg-[var(--selection-bg)]';

/** 选中项获得焦点时，环与底之间留背景色间隙（S-3 焦点/选中分离）。 */
export const SELECTION_SOFT_FOCUS = 'focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** 行 / 卡片级：顶部暗影 + 底部亮边的完整内凹陷。 */
export const SELECTION_SOFT_SHADOW =
  'shadow-[inset_0_2px_4px_var(--selection-depth),inset_0_8px_14px_-8px_var(--selection-depth),inset_0_-1px_0_var(--selection-edge)]';

/** 导航项 / 页签 / 筛选片等紧凑单元：更薄的一档，避免 8px 暗影压过 32px 行高。 */
export const SELECTION_SOFT_COMPACT_SHADOW =
  'shadow-[inset_0_1px_2px_var(--selection-depth),inset_0_-1px_0_var(--selection-edge)]';

/** 完整配方（用于按钮 / div[role=button] / 列表行）。 */
export const SELECTION_SOFT_CLASSES = `${SELECTION_SOFT_BASE} ${SELECTION_SOFT_SHADOW} ${SELECTION_SOFT_FOCUS}`;

/** 紧凑配方（导航项 / 页签 / 筛选片 / 分段控件）。 */
export const SELECTION_SOFT_COMPACT_CLASSES = `${SELECTION_SOFT_BASE} ${SELECTION_SOFT_COMPACT_SHADOW} ${SELECTION_SOFT_FOCUS}`;

/** Toggle / ToggleGroup 的 on 态（Radix data-state=on 驱动）。
    写成完整字面量而非拼接：Tailwind 扫描的是源码文本，运行时拼接的前缀类不会被生成。 */
export const SELECTION_SOFT_TOGGLE_CLASSES =
  'data-[state=on]:bg-[var(--selection-bg)] data-[state=on]:text-[var(--selection-fg)] data-[state=on]:font-semibold data-[state=on]:border-transparent data-[state=on]:hover:bg-[var(--selection-bg)] data-[state=on]:shadow-[inset_0_1px_2px_var(--selection-depth),inset_0_-1px_0_var(--selection-edge)] data-[state=on]:focus-visible:ring-offset-2 data-[state=on]:focus-visible:ring-offset-background';

/** TableRow 的 selected 态（宽数据行；共享表组件当前无消费方，先固化配方）。 */
export const SELECTION_SOFT_ROW_CLASSES =
  'data-[state=selected]:bg-[var(--selection-bg)] data-[state=selected]:text-[var(--selection-fg)] data-[state=selected]:font-semibold data-[state=selected]:shadow-[inset_0_1px_2px_var(--selection-depth),inset_0_-1px_0_var(--selection-edge)]';

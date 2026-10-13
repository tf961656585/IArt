'use client';

/**
 * 对象右键菜单的行渲染。
 *
 * 按菜单行的判别字段 `kind` 选择渲染形态（spec：docs/editor/画布对象右键菜单.md §5.1 / §5.2）：
 * - `action`：标准按钮行，激活执行单一动作；
 * - `swatchRow` / `customRow`：菜单内联控制行，行内控件自身承担焦点与悬停态，
 *   菜单在该行上保持打开；
 * - `submenu`：子菜单触发项，激活只展开子菜单（展开态与面板归 CanvasContextSubmenu）。
 *
 * 子菜单触发项的子菜单内容不在本层渲染：子菜单是独立顶层面板，其展开态由宿主持有。
 */

import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ContextMenuItem, ContextMenuSubmenuTrigger } from '../../types/clipboard';

/**
 * 菜单行（action 行与子菜单触发项）的无障碍角色。
 *
 * 面板 role="menu" 的合法子项是 menuitem 系角色：显式声明后，行按钮的无障碍角色从
 * 隐式 button 收敛为 menuitem（原生 button 的激活语义仍由浏览器承担，Enter/Space 不变）。
 * 色板行（role="group"）与网格行等内联控制行不是 menuitem——行内控件自身承担焦点，
 * 由 Tab 可达，不进方向键 roving 序列（spec §5.5 内联控制行语义）。
 */
export const CANVAS_CONTEXT_MENU_ITEM_ROLE = 'menuitem';

/**
 * roving 导航的项匹配选择器：精确到菜单行级。
 *
 * 菜单行内存在嵌套按钮（色板行的色点、网格行的格点），roving 的 itemSelector 若用
 * 默认 "button" 会让方向键走进行内小控件——必须用本选择器把导航范围圈定在菜单行上。
 */
export const CANVAS_CONTEXT_MENU_ITEM_SELECTOR = `[role="${CANVAS_CONTEXT_MENU_ITEM_ROLE}"]`;

type CanvasContextMenuListProps = {
  items: ContextMenuItem[];
  /**
   * 子菜单触发项的展开态与展开请求。
   *
   * 只在主菜单层传入 —— 子菜单内容不承载子菜单触发项（spec §5.2 最多一层，
   * 由 `ContextMenuSubmenuRow` 在类型上排除嵌套）。
   */
  submenu?: {
    /** 当前展开的触发项 id；null 表示无展开项 */
    activeItemId: string | null;
    /** 指针进入触发项（延迟展开由宿主裁决） */
    onTriggerEnter: (anchorEl: HTMLElement, item: ContextMenuSubmenuTrigger) => void;
    /** 指针离开触发项（延迟收起由宿主裁决） */
    onTriggerLeave: () => void;
    /** 激活触发项（点击 / 键盘），立即展开 */
    onTriggerActivate: (anchorEl: HTMLElement, item: ContextMenuSubmenuTrigger) => boolean;
  };
};

export function CanvasContextMenuList({ items, submenu }: CanvasContextMenuListProps) {
  return (
    <div className="p-1">
      {items.map((item) => {
        switch (item.kind) {
          case 'separator':
            // 分隔线行：无交互的视觉分隔（容器段与画布段之间，唯一豁免）。
            // 普通 div 不可聚焦：任何基于焦点的导航（Tab / 方向键循环）天然跳过它。
            return (
              <div
                key={item.id}
                role="separator"
                aria-orientation="horizontal"
                className="-mx-1 my-1 h-px bg-border"
              />
            );

          case 'customRow':
            // 自定义控制行：以 item.content 替代标准按钮行渲染（如「整理为网格」的网格快速选择行）
            return <div key={item.id}>{item.content}</div>;

          case 'swatchRow':
            // 色板行：换色入口（如「组颜色」）。点色点即时生效，菜单保持打开便于连续试色。
            return (
              <div
                key={item.id}
                role="group"
                aria-label={item.label}
                className="relative flex w-full select-none items-center gap-2 rounded-sm px-2 py-1.5"
              >
                {item.icon}
                <span className="flex-1 text-left text-sm">{item.label}</span>
                <span className="ml-auto flex items-center gap-1">
                  {item.swatches.map((swatch) => (
                    <button
                      key={swatch.color}
                      type="button"
                      aria-pressed={swatch.active}
                      aria-label={`${item.label} ${swatch.color}`}
                      title={swatch.active ? `${item.label}（当前）` : item.label}
                      className={cn(
                        'size-3.5 cursor-pointer rounded-full border transition-transform',
                        'hover:scale-110',
                        swatch.active && 'ring-2 ring-ring ring-offset-1 ring-offset-popover',
                      )}
                      style={{ backgroundColor: swatch.color, borderColor: 'var(--border)' }}
                      onClick={() => item.onSwatchSelect(swatch.color)}
                    />
                  ))}
                </span>
              </div>
            );

          case 'submenu': {
            const expanded = submenu !== undefined && submenu.activeItemId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role={CANVAS_CONTEXT_MENU_ITEM_ROLE}
                data-canvas-context-submenu-trigger={item.id}
                aria-haspopup="menu"
                aria-expanded={expanded}
                className={cn(
                  'relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  'focus:bg-accent focus:text-accent-foreground',
                  expanded && 'bg-accent text-accent-foreground',
                  item.disabled && 'pointer-events-none opacity-50',
                )}
                disabled={item.disabled}
                onMouseEnter={(event) => {
                  if (submenu !== undefined) submenu.onTriggerEnter(event.currentTarget, item);
                }}
                onMouseLeave={() => {
                  if (submenu !== undefined) submenu.onTriggerLeave();
                }}
                onClick={(event) => {
                  if (submenu !== undefined) submenu.onTriggerActivate(event.currentTarget, item);
                }}
                onKeyDown={(event) => {
                  // 焦点在触发项上按 ArrowRight 展开子菜单（spec §5.5）；Enter/Space 已由
                  // 原生 click 语义承接同一条 onTriggerActivate 路径，无需另接。
                  // 展开失败（禁用项）不消费，事件保持原生行为。
                  if (event.key !== 'ArrowRight' || event.defaultPrevented) return;
                  if (submenu === undefined) return;
                  if (submenu.onTriggerActivate(event.currentTarget, item)) {
                    event.preventDefault();
                  }
                }}
              >
                {item.icon}
                <span className="flex-1 text-left">{item.label}</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            );
          }

          case 'action':
            return (
              <button
                key={item.id}
                role={CANVAS_CONTEXT_MENU_ITEM_ROLE}
                aria-label={item.ariaLabel}
                className={cn(
                  'relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  'focus:bg-accent focus:text-accent-foreground',
                  item.disabled && 'pointer-events-none opacity-50',
                  item.destructive &&
                    'text-destructive hover:bg-destructive/10 hover:text-destructive',
                )}
                onClick={item.action}
                disabled={item.disabled}
              >
                {item.icon}
                <span className="flex-1 text-left">{item.label}</span>
                {item.shortcut && (
                  <span className="ml-auto text-xs text-muted-foreground">{item.shortcut}</span>
                )}
              </button>
            );
        }
      })}
    </div>
  );
}

'use client';

/**
 * 「加入组…」目标组选择器 popover。
 *
 * 触发场景：右键多选节点 → 「加入组…」→ 关闭右键菜单 → 弹出本 popover 选择目标组。
 *
 * 设计要点：
 * - 右键菜单已关闭无可用锚点，用一个 fixed 定位于视口中心的透明 anchor 元素，
 *   让 PopoverContent 显示在视口中心附近（符合"右键位轻量 popover"语义，避免居中模态 Dialog）。
 * - 受控开关：由宿主组件通过 `request` prop 持有状态（open + 候选 nodeIds）。
 *   request === null 表示关闭；非 null 表示打开。
 * - 选定目标组后调 `onSelectTargetGroup(targetGroupId)`，宿主负责调 store action。
 * - 列表数据复用 `useGroupCandidates`（画布对象查找器 hooks 同源派生，
 *   deriveGroupCandidates + 成员计数索引），含组名 + 成员数 + 折叠态。
 * - 列表含全部组（含折叠态组），因为「加入组」是显式操作，折叠组也允许加入。
 *
 * 键盘导航（统一基元 useListNavigation 形态 1，修复历史「键盘完全失效」缺陷）：
 * - 历史缺陷：onOpenAutoFocus preventDefault 且无手动聚焦，焦点既不在列表也不在
 *   任何输入宿主，ArrowUp/Down/Enter 无可达宿主，弹层键盘完全失效（Esc 走浮层栈正常）。
 * - 事件宿主是弹层面板容器（PopoverContent，本弹层没有输入框宿主）：原生
 *   capture keydown 监听（对齐 usePromptTriggerSuggestion 的参考接法），消费时
 *   preventDefault（基元内部）+ stopPropagation（消费方），阻断 cmdk root 的
 *   同键处理避免双账。
 * - 打开时把焦点放进列表容器（cmdk List 自带 tabIndex=-1、role=listbox），
 *   键盘事件可达且 Tab 序从列表起跳；onOpenAutoFocus 仍 preventDefault，焦点
 *   时机由本组件 effect 自主控制。
 * - 高亮渲染用自有 data-active 属性驱动（cmdk Item 会用内部选中态覆盖外部
 *   data-selected，且首项注册后内部 value 恒落首项形成静态驻留）；className 里
 *   中和 cmdk 的 data-selected 着色，悬停同步经包裹层 onPointerMove →
 *   setActiveIndex（cmdk Item 自身会覆盖传入的 onPointerMove，不能直接挂 Item）。
 * - Esc 不归本组件与基元：经浮层栈（Popover 包装层自动注册）统一分发关闭。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useListNavigation } from '@iart/ui';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useGroupCandidates } from '../toolbar/canvasObjectFinder/CanvasObjectFinder.hooks';
import type { FinderGroupCandidate } from '../../services/finderModel';

/** 「加入组」请求：携带候选节点 id 列表。null 表示 popover 关闭。 */
export type AddToGroupRequest = {
  candidateNodeIds: string[];
};

export type AddToGroupPopoverProps = {
  /** 当前请求；null 时 popover 关闭。 */
  request: AddToGroupRequest | null;
  /** 选定目标组后回调，宿主调 addNodesToGroup。 */
  onSelectTargetGroup: (targetGroupId: string) => void;
  /** 用户取消（Esc / 点外部）回调，宿主清空 request。 */
  onCancel: () => void;
};

const POPOVER_WIDTH_CLASS = 'w-72 p-0';

export function AddToGroupPopover({
  request,
  onSelectTargetGroup,
  onCancel,
}: AddToGroupPopoverProps) {
  const items = useGroupCandidates();
  const open = request !== null;
  /**
   * 弹层面板容器元素（事件宿主：capture keydown 在此拦截导航键）。
   * Radix PopoverContent 经 Portal 挂载，首次 commit 时 ref 还不可达（Portal 内部
   * useLayoutEffect 翻转 mounted 后第二个 commit 才挂出内容），普通 ref + [open]
   * effect 会在元素存在前执行后不再重跑。用 callback ref 落 state，元素真实挂载
   * 时触发重渲染，下方 effects 以 [open, panelElement] 为依赖在元素就绪后执行。
   */
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  /** 列表容器（打开时的焦点落点，cmdk List 自带 tabIndex=-1）。 */
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectItemByIndex = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined) return;
      onSelectTargetGroup(item.groupId);
    },
    [items, onSelectTargetGroup],
  );

  // 键盘导航统一基元（形态 1）：↑↓ 循环、Home/End、Enter/Tab 选中、IME 让位、
  // 空候选放行；高亮索引为悬停与键盘共用的唯一事实源。
  const nav = useListNavigation({
    count: items.length,
    open,
    resetKey: `${open}:${items.length}`,
    onSelect: selectItemByIndex,
  });

  // 打开时若无任何组，直接提示并取消（避免空 popover）
  useEffect(() => {
    if (open && items.length === 0) {
      onCancel();
    }
  }, [open, items.length, onCancel]);

  // 打开时把焦点放进列表容器：键盘事件可达（↑↓/Enter 由面板容器 capture 接住）、
  // Tab 序从列表起跳。焦点时机由本 effect 自主控制（onOpenAutoFocus 已 preventDefault）。
  // panelElement 就绪（Portal 第二个 commit 挂出内容）时列表 ref 必已同 commit 附着
  // （React 自底向上附着 ref），此处 focus 才真实可达。
  useEffect(() => {
    if (!open || panelElement === null) return;
    listRef.current?.focus();
  }, [open, panelElement]);

  // 面板容器原生 capture keydown（对齐 usePromptTriggerSuggestion 的参考接法）：
  // 基元消费的按键 preventDefault + stopPropagation，阻断 cmdk root 的同键处理；
  // 让位的按键（含 Esc）原样放行。基元闭包随配置重建，处理器必须列入依赖数组。
  useEffect(() => {
    if (!open || panelElement === null) return;
    const panel = panelElement;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (nav.handleKeyDown(event)) {
        event.stopPropagation();
      }
    };
    panel.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      panel.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [open, panelElement, nav]);

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      {/* 透明锚点：fixed 定位于视口中心，让 PopoverContent 显示在中心附近 */}
      <PopoverAnchor asChild>
        <div
          aria-hidden
          style={{
            position: 'fixed',
            left: '50%',
            top: '40%',
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        ref={setPanelElement}
        className={POPOVER_WIDTH_CLASS}
        align="center"
        side="bottom"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList ref={listRef}>
            <CommandEmpty>画布上还没有组，先选中节点创建一个</CommandEmpty>
            <CommandGroup heading="选择目标组">
              {items.map((item: FinderGroupCandidate, index: number) => (
                <div key={item.groupId} onPointerMove={() => nav.setActiveIndex(index)}>
                  <CommandItem
                    ref={(element) => nav.setItemRef(index, element)}
                    value={item.groupId}
                    data-active={index === nav.activeIndex ? 'true' : undefined}
                    className={
                      'cursor-pointer' +
                      (index === nav.activeIndex ? ' bg-accent text-accent-foreground' : '') +
                      ' data-[selected=true]:bg-transparent data-[selected=true]:text-inherit'
                    }
                    onSelect={() => onSelectTargetGroup(item.groupId)}
                  >
                    <span className="truncate">{item.name}</span>
                    <span className="ml-auto pl-2 text-xs text-muted-foreground">
                      {item.memberCount} 成员
                      {item.collapsed ? ' · 折叠' : ''}
                    </span>
                  </CommandItem>
                </div>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default AddToGroupPopover;
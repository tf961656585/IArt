'use client';

/**
 * 画布对象查找器：工具栏常驻查找框 + 下拉（类型/状态筛选 + 结果列表 + 空态）。
 *
 * 交互（对齐已评审原型 prototypes/canvas-object-finder/ 与设计稿
 * docs/editor/画布对象查找-design.md §4「交互结构」、§5「界面用语」）：
 * - 聚焦或输入即打开下拉；Cmd/Ctrl+G 聚焦并打开（hooks 内 window 级监听）。
 * - 下拉 = 类型筛选行（全部/组/Agent/任务/媒体）+ 状态筛选行（全部/运行中/失败）
 *   + 结果列表 + 空态两档（无对象 / 无匹配）。
 * - ↑↓ 移动高亮、Enter 定位（无高亮项时定位首项 = 最佳匹配）、Esc 关闭并回焦画布；
 *   鼠标点击结果项与 Enter 等效；点输入框外部关闭。
 * - 命中动作 = 委托 useLocateToNode('locate-finder')，本组件不做视口操作。
 *
 * 结构（画布工具栏组件同款壳层模式）：
 * - CanvasObjectFinder（壳）：用 useOptionalReactFlow 判断 RF 实例可用性。
 *   RF 不可用（无 ReactFlowProvider，如 CanvasToolbar 的单测环境）时返回 null，
 *   避免 useReactFlow 抛错向上冒泡破坏宿主组件测试。
 * - CanvasObjectFinderInner（内部）：承载全部 UI 与 hooks，保证 useLocateToNode
 *   只在 Provider 内被调用。
 *
 * 实现要点：
 * - Popover + PopoverAnchor（锚定 input）+ Command（cmdk 列表）组合；input 用
 *   anchor 而非 trigger，避免 Radix 把 input 当 button 处理；open 受控。
 * - popover 内不放 CommandInput，避免双输入框焦点竞争；过滤由 hooks 的
 *   queryFinderEntries 完成（Command shouldFilter=false）。
 * - cmdk 自带键盘导航依赖焦点在 cmdk root 内，而焦点始终在外部 input 上，
 *   故 ↑↓/Enter/Esc 由组件在 input onKeyDown 自行处理（hooks 内经统一基元
 *   useListNavigation 承载）；cmdk 只承担列表渲染。
 * - cmdk 双账坑：cmdk Item 会用内部选中态覆盖外部 data-selected，且首项注册后
 *   内部 value 恒落首项（data-selected 静态驻留），与键盘高亮形成双账漂移。
 *   高亮渲染用自有 data-active 属性驱动，className 里中和 cmdk 的
 *   data-selected 着色；悬停同步经包裹层 onPointerMove → setActiveIndex
 *   （cmdk Item 自身会覆盖传入的 onPointerMove，故不能直接挂在 Item 上）。
 */

import { IconSearch } from '@tabler/icons-react';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useOptionalReactFlow } from '../../canvas/useOptionalReactFlow';
import {
  canvasObjectFinderKindOptions,
  canvasObjectFinderStatusOptions,
  useCanvasObjectFinderState,
} from './CanvasObjectFinder.hooks';
import type {
  CanvasObjectFinderProps,
  FinderKindOption,
  FinderStatusOption,
} from './CanvasObjectFinder.types';
import type { FinderEntry } from '../../../services/finderModel';

/** 下拉内容固定宽度，与 PopoverContent 默认 w-72 对齐；p-0 让 Command 自带内边距。 */
const POPOVER_WIDTH_CLASS = 'w-80 p-0';
/** input 宽度，让占位符「查找节点 (Cmd/Ctrl+G)」能完整显示。 */
const INPUT_WIDTH_CLASS = 'w-52';

/** 结果列表最大高度内可完整呈现的条目渲染上限（设计稿 §6：超出不一次性挂载）。 */
const MAX_RENDERED_RESULTS = 50;

/** 筛选档位按钮通用样式（原型 finder-chip 同语义）。 */
const FILTER_CHIP_BASE_CLASS =
  'rounded-full px-2 py-0.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-(--ring) focus-visible:outline-offset-2';
const FILTER_CHIP_ACTIVE_CLASS = 'bg-primary text-primary-foreground font-semibold hover:bg-primary';
const FILTER_CHIP_IDLE_CLASS = 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground';

/**
 * CanvasObjectFinder 壳：判断 RF 可用性，不可用时返回 null。
 *
 * useOptionalReactFlow（try/catch 包 useReactFlow）在无 Provider 时返回 null，
 * 不抛错。这样宿主组件（CanvasToolbar）的单测无需 ReactFlowProvider 也不会被破坏。
 */
export function CanvasObjectFinder(_props: CanvasObjectFinderProps) {
  const reactFlowInstance = useOptionalReactFlow();
  if (reactFlowInstance === null) return null;
  return <CanvasObjectFinderInner />;
}

/** 内部组件：承载 UI 与 hooks，仅在 RF 实例可用时挂载。 */
function CanvasObjectFinderInner() {
  const {
    keyword,
    setKeyword,
    kindFilter,
    setKindFilter,
    statusFilter,
    setStatusFilter,
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    setItemRef,
    results,
    totalCount,
    inputRef,
    handleInputKeyDown,
    selectEntry,
  } = useCanvasObjectFinderState();

  const hasObjects = totalCount > 0;
  const renderedResults = results.slice(0, MAX_RENDERED_RESULTS);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // 打开由 onFocus 驱动（含 Cmd+G 路径）；关闭（点外部）在此同步
        if (!next) setOpen(false);
      }}
    >
      <PopoverAnchor asChild>
        <div className="relative flex items-center">
          <IconSearch
            size={14}
            className="pointer-events-none absolute left-2 text-muted-foreground"
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls="canvas-object-finder-list"
            aria-autocomplete="list"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={handleInputKeyDown}
            placeholder="查找节点 (Cmd/Ctrl+G)"
            title="跨类型查找并定位画布对象 (Cmd/Ctrl+G)"
            autoComplete="off"
            spellCheck={false}
            className={
              INPUT_WIDTH_CLASS +
              ' h-8 rounded-md border border-input bg-background pl-7 pr-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring'
            }
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        className={POPOVER_WIDTH_CLASS}
        align="start"
        // 阻止 popover 打开时抢走 input 焦点，保证外部 input 始终可输入
        onOpenAutoFocus={(e) => e.preventDefault()}
        // input 用 PopoverAnchor（仅定位，不纳入 popover 焦点管理），聚焦 input 会被
        // Radix DismissableLayer 判为「焦点移到 popover 外部」从而关闭下拉。这里阻止
        // 该判定，保证 input 持有焦点时下拉持续打开；关闭仍由 Esc / 选中项 / 点击
        // 真正外部区域（画布等，经 onPointerDownOutside）正常触发。
        onFocusOutside={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <div className="flex flex-col gap-1 border-b px-2 py-2" aria-label="筛选行">
            <FinderFilterRow
              ariaLabel="类型筛选"
              options={canvasObjectFinderKindOptions}
              activeValue={kindFilter}
              onPick={setKindFilter}
            />
            <FinderFilterRow
              ariaLabel="状态筛选"
              options={canvasObjectFinderStatusOptions}
              activeValue={statusFilter}
              onPick={setStatusFilter}
            />
          </div>
          <CommandList id="canvas-object-finder-list" aria-label="查找结果列表">
            <CommandEmpty>
              {hasObjects ? '没有匹配的节点' : '画布上还没有可查找的对象'}
            </CommandEmpty>
            <CommandGroup aria-label="查找结果列表">
              {renderedResults.map((entry, index) => (
                <FinderResultItem
                  key={entry.nodeId}
                  entry={entry}
                  active={index === activeIndex}
                  onSelect={() => selectEntry(entry)}
                  onPointerMove={() => setActiveIndex(index)}
                  registerRef={(element) => setItemRef(index, element)}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** 筛选行（类型/状态共用）：一排档位 chip。 */
function FinderFilterRow({
  ariaLabel,
  options,
  activeValue,
  onPick,
}: {
  ariaLabel: string;
  options: ReadonlyArray<FinderKindOption | FinderStatusOption>;
  activeValue: string;
  onPick: (value: never) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === activeValue;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            className={FILTER_CHIP_BASE_CLASS + ' ' + (active ? FILTER_CHIP_ACTIVE_CLASS : FILTER_CHIP_IDLE_CLASS)}
            onClick={() => onPick(option.value as never)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 结果项：类型徽章 + 主标题 + 副行（副行末段已含状态词，引擎产出，不另设右列）。
 *
 * 结构说明：
 * - 外层包裹 div 承载悬停同步（onPointerMove → setActiveIndex）。cmdk Item 会用
 *   内部 onPointerMove（写内部选中态）覆盖传入的同名 prop，悬停同步不能直接挂
 *   CommandItem。
 * - 高亮由 hooks 的 activeIndex 单账驱动：自有 data-active 属性 + 条件 className。
 *   cmdk 内部选中态（data-selected，首项注册后静态驻留、悬停漂移）在 className
 *   里被中和，避免「键盘移走后首项残留高亮」的双账渲染。
 * - ref 转发给 useListNavigation.setItemRef 实现滚动跟随（cmdk Item 组合外部 ref）。
 */
function FinderResultItem({
  entry,
  active,
  onSelect,
  onPointerMove,
  registerRef,
}: {
  entry: FinderEntry;
  active: boolean;
  onSelect: () => void;
  onPointerMove: () => void;
  registerRef: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div onPointerMove={onPointerMove}>
      <CommandItem
        ref={registerRef}
        value={entry.nodeId}
        data-active={active ? 'true' : undefined}
        className={
          'cursor-pointer' +
          (active ? ' bg-accent text-accent-foreground' : '') +
          ' data-[selected=true]:bg-transparent data-[selected=true]:text-inherit'
        }
        onSelect={onSelect}
      >
        <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {entry.badge}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{entry.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{entry.subline}</span>
        </span>
      </CommandItem>
    </div>
  );
}

export default CanvasObjectFinder;

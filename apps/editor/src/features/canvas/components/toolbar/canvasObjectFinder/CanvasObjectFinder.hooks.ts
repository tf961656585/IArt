'use client';

/**
 * 画布对象查找器的数据接线与视图态 hooks。
 *
 * 职责拆分（component-scaffold.md：useState/useEffect/复杂计算必须抽 hooks）：
 * - useFinderAgentProjection：从 agentSessionStore 取三份只读快照，
 *   组合成引擎的 FinderAgentProjection。
 * - useFinderEntries：nodeGraph.nodes + 成员计数索引 + 会话投影 → FinderEntry[]
 *   （useMemo 按引用依赖缓存，图不变不重建；输入过滤不触发重建）。
 * - useGroupCandidates：「加入组」弹层的组候选来源（deriveGroupCandidates 派生，
 *   产出与旧组候选类型（groupId / name / memberCount / collapsed）同形）。
 * - useCanvasObjectFinderState：汇总 UI 视图态（keyword / 两行筛选 / open /
 *   键盘高亮）+ Cmd+G 监听 + 键盘导航。
 *
 * 性能契约（设计稿 §6）：候选构建只依赖图引用与索引引用，随输入变化走
 * queryFinderEntries 纯函数实时过滤，不做全图扫描。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useListNavigation, useOverlayLayer } from '@iart/ui';
import { useCanvasStore } from '../../../store/canvasStore';
import { selectContainerMemberCountIndex } from '../../../store/internal/containerMemberIndex';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';
import { useLocateToNode } from '../../../hooks/useLocateToNode';
import {
  buildFinderEntries,
  deriveGroupCandidates,
  queryFinderEntries,
} from '../../../services/finderModel';
import type {
  FinderAgentProjection,
  FinderEntry,
  FinderGroupCandidate,
} from '../../../services/finderModel';
import type {
  CanvasObjectFinderState,
} from './CanvasObjectFinder.types';
import type {
  FinderKindFilter,
  FinderStatusFilter,
} from '../../../services/finderModel';

/** 选择 reason，用于定位桥审计日志（契约 4）。 */
const LOCATE_SELECTION_REASON = 'locate-finder';

/** 状态筛选行的档位选项（§5 用语）。 */
const STATUS_OPTIONS: ReadonlyArray<{ value: FinderStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'failed', label: '失败' },
];

/** 类型筛选行的档位选项（§5 用语）。 */
const KIND_OPTIONS: ReadonlyArray<{ value: FinderKindFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'group', label: '组' },
  { value: 'agent', label: 'Agent' },
  { value: 'task', label: '任务' },
  { value: 'media', label: '媒体' },
];

/**
 * 从 agentSessionStore 取会话投影（三份只读快照，供引擎判断 Agent
 * 会话标题 / 在途 / 出错）。
 */
export function useFinderAgentProjection(): FinderAgentProjection {
  const sessionsById = useAgentSessionStore((state) => state.sessionsById);
  const inFlightBySessionId = useAgentSessionStore((state) => state.inFlightBySessionId);
  const errorsBySessionId = useAgentSessionStore((state) => state.errorsBySessionId);

  return useMemo<FinderAgentProjection>(
    () => ({ sessionsById, inFlightBySessionId, errorsBySessionId }),
    [sessionsById, inFlightBySessionId, errorsBySessionId],
  );
}

/**
 * 构建查找条目（图变化才重建；依赖三处引用：nodes / 成员计数索引 / 会话投影）。
 */
export function useFinderEntries(): FinderEntry[] {
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const memberCountIndex = useCanvasStore(selectContainerMemberCountIndex);
  const agentProjection = useFinderAgentProjection();

  return useMemo<FinderEntry[]>(
    () =>
      buildFinderEntries(
        nodeGraph === null || nodeGraph === undefined ? [] : nodeGraph.nodes,
        memberCountIndex,
        agentProjection,
      ),
    [nodeGraph, memberCountIndex, agentProjection],
  );
}

/**
 * 「加入组」弹层的组候选来源（单点派生，字段结构与旧组候选类型同形：
 * 成员数来自变更驱动的容器成员计数索引（D7：禁全图扫描）。
 */
export function useGroupCandidates(): FinderGroupCandidate[] {
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const memberCountIndex = useCanvasStore(selectContainerMemberCountIndex);

  return useMemo<FinderGroupCandidate[]>(
    () =>
      deriveGroupCandidates(
        nodeGraph === null || nodeGraph === undefined ? [] : nodeGraph.nodes,
        memberCountIndex,
      ),
    [nodeGraph, memberCountIndex],
  );
}

/**
 * 汇总 CanvasObjectFinder 的视图态、事件处理与 Cmd/Ctrl+G 快捷键监听。
 *
 * Cmd+G 监听独立于 useCanvasHotkeys，原因是后者对 INPUT/TEXTAREA target 有守卫
 * （useCanvasHotkeys.ts:52-57），焦点在任意输入框时无法触发——与「随时按
 * Cmd+G 聚焦查找框」诉求冲突。此处自治 window 级监听，卸载时移除。
 *
 * 键盘导航（原型 finder-ui.js 同语义，经统一基元 useListNavigation 承载）：
 * ↑↓ 循环移动高亮；Enter 定位当前高亮项（打开/筛选变化时高亮归 0 = 首项最佳匹配，
 * 与旧实现「无高亮项时 Enter 定位首项」的可观测结果一致）；Esc 关闭并回焦画布
 * （blur input，经浮层栈统一分发，见 useOverlayLayer 注册处）。
 * 键盘监听挂在外部 input 上（焦点始终在 input，cmdk root 的 keydown 收不到），
 * cmdk 只承担列表渲染；shouldFilter=false，过滤由 queryFinderEntries 完成。
 */
export function useCanvasObjectFinderState(): CanvasObjectFinderState {
  const entries = useFinderEntries();
  const locateToNode = useLocateToNode();

  const [keyword, setKeyword] = useState('');
  const [kindFilter, setKindFilter] = useState<FinderKindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<FinderStatusFilter>('all');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 查询纯函数随输入实时过滤（不重建候选）
  const results = useMemo<FinderEntry[]>(
    () => queryFinderEntries(entries, { keyword: keyword.trim(), kind: kindFilter, status: statusFilter }),
    [entries, keyword, kindFilter, statusFilter],
  );

  const totalCount = entries.length;

  const locateNode = useCallback(
    (nodeId: string) => {
      if (typeof nodeId !== 'string' || nodeId.length === 0) return;
      locateToNode(nodeId, LOCATE_SELECTION_REASON);
    },
    [locateToNode],
  );

  const confirmEntry = useCallback(
    (entry: FinderEntry | undefined) => {
      if (entry === undefined) return;
      locateNode(entry.nodeId);
      setOpen(false);
    },
    [locateNode],
  );

  // 键盘导航统一基元（形态 1）：↑↓ 循环、Home/End、Enter 选中、IME 让位、空候选放行；
  // 高亮索引为悬停与键盘共用的唯一事实源（组件侧列表项 onPointerMove → setActiveIndex）。
  // resetKey 覆盖旧实现的三处手动重置点（关键词 / 类型档 / 状态档变化时高亮归 0）。
  const listNav = useListNavigation({
    count: results.length,
    open,
    resetKey: `${open}:${keyword}:${kindFilter}:${statusFilter}`,
    wrap: true,
    onSelect: useCallback(
      (index: number) => {
        confirmEntry(results[index]);
      },
      [confirmEntry, results],
    ),
  });

  const selectEntry = useCallback(
    (entry: FinderEntry) => {
      confirmEntry(entry);
      // 焦点回到 input，便于继续查找（原型 closeFinder 不 blur，仅 Enter/Esc blur）
      const node = inputRef.current;
      if (node !== null) node.focus();
    },
    [confirmEntry],
  );

  // Cmd/Ctrl+G：聚焦查找框并打开下拉。preventDefault 避免浏览器「查找下一个」默认行为。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'g') return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      const node = inputRef.current;
      if (node !== null) {
        node.focus();
        node.select();
      }
      setOpen(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Tab 保持现状：移动焦点，不选候选（基元的 Tab 选中语义对本浮层是行为变化，不启用）。
      if (event.key === 'Tab') return;
      // 现状保持：Shift+Enter 与 Enter 同语义定位（单行查找输入无换行意图，
      // 基元的「Shift+Enter 让位换行」规则在此不适配），手动按旧语义执行后返回。
      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        confirmEntry(results[listNav.activeIndex]);
        return;
      }
      listNav.handleKeyDown(event);
      // Esc 关闭不在 input 上自行判定：下拉打开时经 useOverlayLayer 注册入栈，
      // Esc 由 OverlayEscapeDispatcher 统一分发（spec docs/editor/浮层堆栈管理.md）。
    },
    [confirmEntry, listNav, results],
  );

  // 浮层栈注册（spec docs/editor/浮层堆栈管理.md「业务面接入清单」）：下拉打开即入栈，
  // Esc 命中栈顶时关闭下拉并回焦画布（blur input，焦点交还给页面）。焦点在 input
  // （可编辑元素）内时必须让位吗？不——本浮层的关闭语义就是「Esc 关闭并回焦画布」，
  // 焦点常态即在 input 上，若声明 ignoreWhenFocusInEditable 则 Esc 永远关不掉下拉，
  // 与原型行为相悖，故保持默认 false。
  useOverlayLayer({
    id: 'canvas-object-finder',
    active: open,
    onClose: useCallback(() => {
      setOpen(false);
      const node = inputRef.current;
      if (node !== null) node.blur();
    }, []),
  });

  return {
    keyword,
    setKeyword,
    kindFilter,
    setKindFilter,
    statusFilter,
    setStatusFilter,
    open,
    setOpen,
    activeIndex: listNav.activeIndex,
    setActiveIndex: listNav.setActiveIndex,
    setItemRef: listNav.setItemRef,
    results,
    totalCount,
    locateNode,
    inputRef,
    handleInputKeyDown,
    selectEntry,
  };
}

/** 供测试/内部断言的类型选项（不对外暴露的常量经此只读复用）。 */
export const canvasObjectFinderKindOptions = KIND_OPTIONS;

/** 供测试/内部断言的状态选项（不对外暴露的常量经此只读复用）。 */
export const canvasObjectFinderStatusOptions = STATUS_OPTIONS;

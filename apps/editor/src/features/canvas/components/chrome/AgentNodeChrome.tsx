'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { IconSparkles, IconTrash } from '@tabler/icons-react';
import { Ungroup as IconUngroup } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { useChromePlacement } from './MediaNodeChrome.hooks';
import { useAgentChromeActions, useAgentChromeState } from './AgentNodeChrome.hooks';
import type { AgentNodeChromeProps } from './AgentNodeChrome.types';

/**
 * 底栏动作钮（原 .usage-btn 退役后的共享 Button 组合，docs/ui-button-standard.md §4/§5）：
 * ghost 2xs（28px 高）+ 1px 透明边框，承载「使用 agent」data-active 已用态描边与
 * 生成蓝底（editor visual-design §7：st-generating 低 alpha 底 + st-generating-text 字）。
 */
const CHROME_ACTION_BUTTON_CLASS = 'border border-transparent';
const REF_ACTIVE_CLASS = [
  'data-[active=true]:border-[color-mix(in_srgb,var(--st-generating)_30%,transparent)]',
  'data-[active=true]:bg-[color-mix(in_srgb,var(--st-generating)_14%,transparent)]',
  'data-[active=true]:text-[var(--st-generating-text)]',
  'data-[active=true]:hover:bg-[color-mix(in_srgb,var(--st-generating)_20%,transparent)]',
  'data-[active=true]:hover:text-[var(--st-generating-text)]',
].join(' ');

/**
 * Agent 节点选中态工具栏（spec docs/agent/02-Agent节点与画布投影.md「选中态工具栏」；
 * 视觉与结构口径对齐设计层 prototypes/shared/node-chrome.js 的 agent 分支）。
 *
 * 挂于 NodeCanvas 根容器（与 MediaNodeChrome / MarqueeSelectionOverlay 同层）：选中单个
 * Agent 节点时显示「使用 agent｜解散｜删除」（解散仅容器形态出现），多选只保留
 * 「解散」「删除」。定位、折返与入场动画复用 useChromePlacement，表面样式复用
 * globals.css 的 .node-chrome-bottom 令牌。
 *
 * 工具栏动作只改变 PromptDock 上下文或容器组织关系，不执行生成、不改 viewport、
 * 不动兄弟节点；「删除」只开确认请求（确认框宿主消费），会话视图随选中驱动进入打开
 *（spec 06「历史承载与会话视图」），工具栏不设开合动作。
 */

export const AgentNodeChrome = memo(function AgentNodeChrome({
  canvasRef,
}: AgentNodeChromeProps) {
  const { selection, single, agentSessionId, alreadyInSession, dissolvableNodeIds } =
    useAgentChromeState();
  const actions = useAgentChromeActions();

  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  // Agent 节点没有媒体加工工具 → 无顶栏；占位 ref 只为复用同一定位 hook（showTop=false）。
  const topBarRef = useRef<HTMLDivElement | null>(null);
  const [viewportTick, setViewportTick] = useState(0);

  const nodeIds = useMemo(
    () => selection.agentNodes.map((node) => node.id),
    [selection.agentNodes],
  );
  const animateKey = nodeIds.join('|');

  // 选中集变化：作废在途的删除确认请求（状态完整性，与资产 chrome 同口径）。
  const { cancelDelete, requestDelete, dissolve } = actions;
  useEffect(() => {
    cancelDelete();
  }, [animateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 画布容器尺寸变化（右栏开合 / 窗口缩放）→ 重算 toolbar 定位。
  useEffect(() => {
    const onResize = () => setViewportTick((tick) => tick + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 键盘链（与资产 chrome 同一 D23 口径）：toolbar 激活时 Delete/Backspace 走删除确认框
  //（AG-CT-011：键盘 Delete 对 Agent 节点触发删除且必须经确认框），拦截全局即时删除；
  // 输入态中不拦截。
  useEffect(() => {
    if (!selection.active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target: EventTarget | null = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      requestDelete(nodeIds);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [selection.active, requestDelete, nodeIds]);

  useChromePlacement({
    canvasRef,
    topBarRef,
    bottomBarRef,
    selectedIds: nodeIds,
    showTop: false,
    animateKey,
    resizeTick: viewportTick,
  });

  if (!selection.active) return null;

  const multi = selection.multi;

  return (
    <div
      ref={bottomBarRef}
      className="node-chrome-bottom"
      role="toolbar"
      data-agent-node-chrome="bottom"
      aria-label="Agent 节点工具栏"
      data-testid="agent-chrome-bottom"
    >
      {!multi && single !== null && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="2xs"
            className={cn(CHROME_ACTION_BUTTON_CLASS, REF_ACTIVE_CLASS)}
            data-act="use-agent"
            // 已处于该会话时是幂等操作（spec 02）：按已用态呈现，不给点了没反应的按钮。
            data-active={alreadyInSession ? 'true' : undefined}
            disabled={alreadyInSession}
            onClick={(e) => {
              e.stopPropagation();
              actions.useAgent(single.id, agentSessionId);
            }}
          >
            <IconSparkles size={14} className="size-3.5" />
            <span>使用 agent</span>
          </Button>
          <div className="sep" aria-hidden="true" />
        </>
      )}
      {/* 解散（AG-CT-010）：仅容器形态（有成员）出现——解除组织关系，纯可逆不经删除路径 */}
      {dissolvableNodeIds.length > 0 && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="2xs"
            data-act="dissolve"
            aria-label="解散容器"
            onClick={(e) => {
              e.stopPropagation();
              dissolve(nodeIds);
            }}
          >
            <IconUngroup size={14} className="size-3.5" />
            <span>解散</span>
          </Button>
          <div className="sep" aria-hidden="true" />
        </>
      )}
      <Button
        type="button"
        variant="ghost-destructive"
        size="2xs"
        data-act="del"
        aria-label="删除 Agent"
        onClick={(e) => {
          e.stopPropagation();
          requestDelete(nodeIds);
        }}
      >
        <IconTrash size={14} className="size-3.5" />
        <span>删除</span>
      </Button>
    </div>
  );
});

export default AgentNodeChrome;

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { IconX } from '@tabler/icons-react';
import { useOverlayLayer } from '@iart/ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { agentSessionIdOf } from '@/features/canvas/components/chrome/agentChromeModel';
import { useAgentSessionMeta } from '@/features/agent/agentSessionStore';
import { usePackageAreaStore } from '@/features/package-area/store/packageAreaStore';
import { PackageAreaPanel } from '@/features/package-area/components/PackageAreaPanel';
import { AgentSessionView } from './components/AgentSessionView';
import { useAgentSessionErrorToast } from './useAgentSessionErrorToast';
import {
  useRightWorkspaceStore,
  type RightWorkspaceKind,
} from './rightWorkspaceStore';

/**
 * 右侧工作区容器 — 画布右缘的单一动态承载面（spec「右侧工作区与打包区服务」）。
 *
 * - 完全收起：width:0、aria-hidden、不占画布布局空间（无把手列）
 * - 单内容互斥：同一时刻最多一个内容种类（当前正式内容：打包区、Agent 会话视图）
 * - 宽度拖拽调整（360–560px 硬边界，按内容种类独立持久化）
 * - 关闭路径：再触同入口 / 关闭钮 / Esc（焦点在编辑面时让位）/ 会话视图宿主节点被删除
 * - 无跟随画布选中的自动行为（唯一例外：Agent 会话视图随 Agent 节点选中打开，
 *   spec docs/agent/06「历史承载与会话视图」）
 */

const CONTENT_TITLE: Record<RightWorkspaceKind, string> = {
  packageArea: '打包区',
  agentSession: 'Agent 会话',
};

/** 会话标题为空（空串 / 只有空白）时的兜底：标题栏不留空白，也不假装有名字。 */
const UNTITLED_SESSION_TITLE = '未命名会话';

export function RightWorkspace() {
  const activeKind = useRightWorkspaceStore((s) => s.activeKind);
  const activeAgentSessionId = useRightWorkspaceStore((s) => s.agentSessionId);
  const width = useRightWorkspaceStore((s) => s.width);
  const setWidth = useRightWorkspaceStore((s) => s.setWidth);
  const commitWidth = useRightWorkspaceStore((s) => s.commitWidth);
  const close = useRightWorkspaceStore((s) => s.close);
  // 会话视图的标题栏标题 = 当前会话标题（spec 02「节点身份与数据」会话视图节）：
  // 会话元数据缺失（无会话 id / 查不到记录）时回退常量，不留空白也不显示废值。
  const activeSession = useAgentSessionMeta(
    activeKind === 'agentSession' ? activeAgentSessionId : null,
  );

  // 一轮回复失败的一次性出口提示：本容器常驻（收起时 width:0 仍在树上），
  // 所以会话视图没打开也能提示到用户（受理前的失败由 PromptDock 的提交路径提示）。
  useAgentSessionErrorToast();

  // 画布级打包区生命周期：随 nodeGraph 就绪加载，切换/关闭时重置。
  const nodeGraph = useCanvasStore((s) => s.nodeGraph);
  const loadPackageArea = usePackageAreaStore((s) => s.loadPackageArea);
  const resetPackageArea = usePackageAreaStore((s) => s.reset);
  const graphId = nodeGraph ? nodeGraph.id : null;

  useEffect(() => {
    if (graphId === null) {
      resetPackageArea();
      return;
    }
    void loadPackageArea(graphId);
  }, [graphId, loadPackageArea, resetPackageArea]);

  // 宿主节点删除同步关闭（spec docs/agent/02「会话视图与多轮历史」）：面板正显示某会话、
  // 画布上已无任何节点持有该会话引用（覆盖 chrome/右键菜单/键盘/组连删/撤销重做等全部
  // 删除入口）时关闭，不保留指向已删节点的孤儿视图。nodeGraph 未就绪（项目加载中）不判定。
  useEffect(() => {
    if (activeKind !== 'agentSession' || activeAgentSessionId === null) return;
    if (nodeGraph === null || nodeGraph === undefined) return;
    const stillReferenced = nodeGraph.nodes.some(
      (node) => agentSessionIdOf(node) === activeAgentSessionId,
    );
    if (stillReferenced) return;
    console.debug('[rightWorkspace] agent session view closed: host node removed', {
      agentSessionId: activeAgentSessionId,
    });
    close();
  }, [activeKind, activeAgentSessionId, nodeGraph, close]);

  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(0);
  const resizingRef = useRef(false);

  const isOpen = activeKind !== null;

  /**
   * 标题栏显示文本：agentSession 显示当前会话标题，其余内容种类显示常量名。
   * 会话不可用（无会话 id 或会话记录查不到）时回退常量，与内容区的不可用说明一致。
   */
  const headerTitle = ((): string => {
    if (activeKind === null) return '';
    if (activeKind !== 'agentSession') return CONTENT_TITLE[activeKind];
    if (activeAgentSessionId === null || activeSession === null) return CONTENT_TITLE.agentSession;
    return activeSession.title.trim().length > 0 ? activeSession.title : UNTITLED_SESSION_TITLE;
  })();

  // Esc 关闭右栏：注册为浮层栈的一层，由窗口唯一分发器派发（spec docs/editor/浮层堆栈管理.md）。
  // ignoreWhenFocusInEditable 保持「焦点在输入框内时让位给控件」的现状语义；
  // 不再自挂 keydown 监听，也不再做 target 标签白名单判定。
  useOverlayLayer({
    active: isOpen,
    id: 'right-workspace',
    onClose: close,
    ignoreWhenFocusInEditable: true,
  });

  // 拖拽调整宽度：mousedown 挂窗口级监听，mouseup 持久化。
  const onStartResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      resizeStartXRef.current = event.clientX;
      resizeStartWidthRef.current = useRightWorkspaceStore.getState().width;
      resizingRef.current = true;

      const handleMove = (moveEvent: MouseEvent) => {
        // 右侧工作区在画布右缘：向左拖（delta<0）变宽。
        const delta = moveEvent.clientX - resizeStartXRef.current;
        const next = resizeStartWidthRef.current - delta;
        setWidth(next);
      };
      const handleUp = () => {
        resizingRef.current = false;
        commitWidth();
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    },
    [setWidth, commitWidth],
  );

  const renderContent = (): React.ReactNode => {
    if (activeKind === 'packageArea') return <PackageAreaPanel />;
    if (activeKind === 'agentSession') {
      // 会话标识由打开入口一次性写入（openAgentSessionView）；缺失时不留空白面板。
      if (activeAgentSessionId === null) {
        return (
          <div
            className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground"
            data-testid="agent-session-view-unavailable"
          >
            这个会话已经不在了，删掉这个节点后可以重新开始。
          </div>
        );
      }
      return <AgentSessionView agentSessionId={activeAgentSessionId} />;
    }
    return null;
  };

  if (!isOpen) {
    return (
      <aside
        className="h-full shrink-0 overflow-hidden"
        data-testid="right-workspace"
        data-open="false"
        aria-hidden="true"
        style={{ width: 0 }}
      />
    );
  }

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l bg-card"
      data-testid="right-workspace"
      data-open="true"
      data-kind={activeKind}
      style={{ width }}
    >
      {/* 头部：标题 + 关闭钮。标题栏显示当前会话标题（可为长标题，truncate + title 悬浮全称）；
          关闭钮的无障碍名保持内容种类常量，不随会话标题变化。 */}
      <div className="flex min-h-10 items-center justify-between gap-2 border-b px-3">
        <span
          className="min-w-0 truncate text-sm font-semibold"
          title={headerTitle}
          data-testid="right-workspace-title"
        >
          {headerTitle}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={close}
          className="shrink-0 text-muted-foreground"
          aria-label={activeKind ? `关闭 ${CONTENT_TITLE[activeKind]}` : '关闭'}
        >
          <IconX size={16} />
        </Button>
      </div>

      {/* 内容面板 */}
      <div className="min-h-0 flex-1 overflow-hidden">{renderContent()}</div>

      {/* 宽度调整拖拽手柄 */}
      <button
        type="button"
        aria-label={`拖拽调整 ${activeKind ? CONTENT_TITLE[activeKind] : ''}宽度`}
        className={cn(
          'absolute inset-y-0 -left-0.5 z-10 flex w-1 cursor-col-resize items-center justify-center',
        )}
        onMouseDown={onStartResize}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0;
          if (step === 0) return;
          event.preventDefault();
          setWidth(useRightWorkspaceStore.getState().width + step);
          commitWidth();
        }}
      >
        <div
          aria-hidden="true"
          className="h-full w-0.5 rounded-full bg-border/30 transition-colors hover:bg-primary/60"
        />
      </button>
    </aside>
  );
}

export default RightWorkspace;

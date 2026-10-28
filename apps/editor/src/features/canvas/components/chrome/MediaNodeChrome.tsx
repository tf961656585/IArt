'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconBookmark,
  IconCheck,
  IconHistory,
  IconPackages,
  IconTrash,
  IconX,
} from '@tabler/icons-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useCanvasSelectionBridge } from '../canvas/useCanvasSelectionBridge';
import { topToolGroupsFor, type MediaChromeTool } from './chromeModel';
import {
  useChromePlacement,
  useMediaChromeActions,
  useMediaChromeState,
} from './MediaNodeChrome.hooks';
import type { ToolCtx } from './mediaToolExecutors';
import { MEDIA_TOOL_ICONS } from './mediaToolIcons';
import { openMediaToolDialog, useMediaToolDialogStore } from './mediaToolDialogStore';
import type { MediaNodeChromeProps } from './MediaNodeChrome.types';

/**
 * 媒体节点选中态双层 chrome（设计层 prototypes/shared/node-chrome.js/css · D17–D27 + H1–H3）。
 *
 * 挂于 NodeCanvas 根容器（与 MarqueeSelectionOverlay 同层），覆盖**全部媒体节点**：
 * 资产节点（asset）与导入素材节点（imageInput/videoInput/audioInput）共用同一外壳（D27）。
 * 上层 = 媒体加工工具栏（图片 12 工具 A｜B 分组 / 视频 3 工具 / 音频不渲染），
 * 下层 = 路由动作栏（用作参考 toggle｜复用（仅生成资产）｜加入打包区｜删除 inline 确认）。
 * 多选隐藏顶栏（工具仅作用单资产），底栏锚选区 bbox；两类媒体节点可混选（混选不整体消失）。
 * 来源差异只在底栏：复用仅生成资产；替换仍由素材节点 hover 提供。
 * 表面样式在 globals.css（.node-chrome-top/.node-chrome-bottom）。
 */

const MEDIA_ARIA: Record<string, string> = {
  image: '图片加工工具',
  video: '视频加工工具',
  audio: '音频加工工具',
};

/**
 * 底栏动作钮（原 .usage-btn 退役后的共享 Button 组合，docs/ui-button-standard.md §4/§5）：
 * ghost 2xs（28px 高）+ 1px 透明边框，承载「用作参考」data-active 激活态的描边与
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
 * 删除确认填充钮的组件局部基座（docs/ui-button-standard.md §10 / editor visual-design §7.1
 * 登记例外）：`usage-btn confirm-fill` 类名与 globals.css 的 `.usage-btn.confirm-fill`
 * 填充规则（实底红 #b91c1c + 白字、两主题固定）原样保留；本常量只补位原 .usage-btn
 * 基座退役后的布局几何（inline-flex 28px / 6px gap / 10px 内距 / 12px 字号），不改例外视觉。
 */
const CONFIRM_FILL_BASE_CLASS = [
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-transparent px-2.5',
  'text-xs font-medium whitespace-nowrap transition-colors duration-150',
  'focus-visible:outline-2 focus-visible:outline-[var(--chrome-ring)] focus-visible:outline-offset-2',
].join(' ');

export const MediaNodeChrome = memo(function MediaNodeChrome({
  canvasRef,
}: MediaNodeChromeProps) {
  const state = useMediaChromeState();
  const { selection, bottomView, singleSubject, hasMedia, refAction } = state;
  const { selectNodes } = useCanvasSelectionBridge();

  const topBarRef = useRef<HTMLDivElement | null>(null);
  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  const subjectsRef = useRef(selection.subjects);
  subjectsRef.current = selection.subjects;

  const actions = useMediaChromeActions({ subjectsRef, bottomBarRef });
  const mediaDialogOpen = useMediaToolDialogStore((s) => s.open !== null);
  const [viewportTick, setViewportTick] = useState(0);

  const animateKey = useMemo(
    () => selection.subjects.map((s) => s.node.id).join('|'),
    [selection.subjects],
  );

  // 选中集变化：退出删除确认（D23 状态完整性）；工具弹窗由 MediaToolDialogHost 自行关闭。
  useEffect(() => {
    actions.setDeleteConfirm(false);
  }, [animateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 画布容器尺寸变化（右栏开合 / 窗口缩放）→ 重算 chrome 定位。
  useEffect(() => {
    const onResize = () => setViewportTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // D23 键盘链：chrome 激活时 Delete/Backspace 走底栏 inline 确认（拦截全局即时删除）；
  // 输入态（input/contenteditable）与弹窗打开时不拦截。
  const { deleteConfirm, requestDelete } = actions;
  useEffect(() => {
    if (!selection.active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (deleteConfirm || mediaDialogOpen) return;
      const target: EventTarget | null = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      requestDelete();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [selection.active, deleteConfirm, mediaDialogOpen, requestDelete]);

  const mediaType = singleSubject?.mediaType ?? null;
  const toolGroups = mediaType ? topToolGroupsFor(mediaType) : [];
  const showTop = selection.active && !selection.multi && toolGroups.length > 0 && hasMedia;

  useChromePlacement({
    canvasRef,
    topBarRef,
    bottomBarRef,
    selectedIds: animateKey ? animateKey.split('|') : [],
    showTop,
    animateKey,
    resizeTick: viewportTick,
  });

  const sourceUrl = singleSubject?.sourceUrl ?? '';
  const ctx = useMemo<ToolCtx | null>(() => {
    if (!selection.single || !singleSubject?.available || !sourceUrl) return null;
    return { subject: singleSubject, selectNodes };
  }, [selection.single, singleSubject, sourceUrl, selectNodes]);

  const openTool = (tool: MediaChromeTool) => {
    if (tool.kind === 'dialog') {
      if (selection.single) openMediaToolDialog(selection.single.node.id, tool.id);
      return;
    }
    if (ctx) {
      void actions.runDirectTool(tool.id, ctx);
    }
  };

  if (!selection.active) return null;

  const multi = selection.multi;

  return (
    <>
      {showTop && (
        <div
          ref={topBarRef}
          className="node-chrome-top"
          role="toolbar"
          data-media-node-chrome="top"
          aria-label={MEDIA_ARIA[mediaType ?? ''] ?? '媒体加工工具'}
          data-testid="media-chrome-top"
        >
          {toolGroups.map((group, gi) => (
            <div key={gi} style={{ display: 'contents' }}>
              {gi > 0 ? <div className="sep" aria-hidden="true" /> : null}
              <div className="grp">
                {group.map((tool) => {
                  const Icon = MEDIA_TOOL_ICONS[tool.icon];
                  const busy = actions.processingTool === tool.id;
                  const label = busy ? `${tool.label}（执行中）` : tool.label;
                  return (
                    <Tooltip key={tool.id}>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="2xs"
                          loading={busy}
                          disabled={Boolean(actions.processingTool) || !ctx}
                          aria-label={label}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!busy) openTool(tool);
                          }}
                        >
                          {busy ? null : <Icon size={16} />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="center">
                        {label}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div
        ref={bottomBarRef}
        className="node-chrome-bottom"
        role="toolbar"
        data-media-node-chrome="bottom"
        aria-label="所选素材的动作"
        data-testid="media-chrome-bottom"
      >
        {actions.deleteConfirm ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="2xs"
              className={CHROME_ACTION_BUTTON_CLASS}
              data-act="del-cancel"
              onClick={(e) => {
                e.stopPropagation();
                actions.cancelDelete();
              }}
            >
              <IconX size={14} className="size-3.5" />
              <span>取消</span>
            </Button>
            {/* 删除确认填充：ui-button-standard §10 登记例外（实底红两主题固定），
                类名与填充样式原样保留，基座几何由 CONFIRM_FILL_BASE_CLASS 组件局部承载 */}
            <button
              type="button"
              className={cn('usage-btn confirm-fill', CONFIRM_FILL_BASE_CLASS)}
              data-act="del-confirm"
              onClick={(e) => {
                e.stopPropagation();
                actions.confirmDelete();
              }}
            >
              <IconTrash size={14} />
              <span>{multi ? `确认删除 ${selection.subjects.length} 项` : '确认删除'}</span>
            </button>
          </>
        ) : (
          <>
            {!multi && (
              <Button
                type="button"
                variant="ghost"
                size="2xs"
                className={cn(CHROME_ACTION_BUTTON_CLASS, REF_ACTIVE_CLASS)}
                data-active={bottomView.refsActive ? 'true' : undefined}
                data-act="ref"
                disabled={!refAction.enabled}
                title={
                  bottomView.refsActive
                    ? '从参考区移除'
                    : refAction.enabled
                      ? '加入参考区'
                      : refAction.reason ?? '当前不能加入参考'
                }
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggleRefs();
                }}
              >
                {bottomView.refsActive ? <IconCheck size={14} className="size-3.5" /> : <IconBookmark size={14} className="size-3.5" />}
                <span>{bottomView.refsActive ? '取消参考' : '用作参考'}</span>
              </Button>
            )}
            {multi && (
              <Button
                type="button"
                variant="ghost"
                size="2xs"
                className={cn(CHROME_ACTION_BUTTON_CLASS, REF_ACTIVE_CLASS)}
                data-active={bottomView.refsActive ? 'true' : undefined}
                data-act="ref-batch"
                disabled={!refAction.enabled}
                title={refAction.enabled ? '加入参考区' : refAction.reason ?? '当前不能加入参考'}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggleRefs();
                }}
              >
                {bottomView.refsActive ? <IconCheck size={14} className="size-3.5" /> : <IconBookmark size={14} className="size-3.5" />}
                <span>
                  {bottomView.refsActive ? '取消参考' : '用作参考'} ·{' '}
                  {selection.subjects.length} 项
                </span>
              </Button>
            )}
            {bottomView.showReuse && (
              <Button
                type="button"
                variant="ghost"
                size="2xs"
                data-act="reuse"
                title="用这条资产的生成参数再生成一次"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.reuse();
                }}
              >
                <IconHistory size={14} className="size-3.5" />
                <span>复用</span>
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="2xs"
              data-act="package-area"
              title="把选中的素材加入打包区"
              onClick={(e) => {
                e.stopPropagation();
                actions.addToPackageArea();
              }}
            >
              <IconPackages size={14} className="size-3.5" />
              <span>加入打包区{multi ? ` · ${selection.subjects.length} 项` : ''}</span>
            </Button>
            <div className="sep" aria-hidden="true" />
            <Button
              type="button"
              variant="ghost-destructive"
              size="2xs"
              data-act="del"
              onClick={(e) => {
                e.stopPropagation();
                actions.requestDelete();
              }}
            >
              <IconTrash size={14} className="size-3.5" />
              <span>{multi ? `删除 ${selection.subjects.length} 项` : '删除'}</span>
            </Button>
          </>
        )}
      </div>

    </>
  );
});
export default MediaNodeChrome;

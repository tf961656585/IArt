'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconArrowsDiagonal,
  IconBorderOuter,
  IconBookmark,
  IconCheck,
  IconPackages,
  IconColorFilter,
  IconContrast,
  IconCrop,
  IconFlipHorizontal,
  IconFlipVertical,
  IconHistory,
  IconLayoutGrid,
  IconPencil,
  IconPhoto,
  IconResize,
  IconRotate,
  IconScissors,
  IconTrash,
  IconX,
} from '@tabler/icons-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { listRuntimeProjectedImageToImageModels } from '@/client/config/runtimeModelSelection';
import { cn } from '@/lib/utils';
import { useCanvasSelectionBridge } from '../canvas/useCanvasSelectionBridge';
import type { ImageMeta, VideoMeta } from '../../types/node';
import { topToolGroupsFor, type AssetChromeTool, type AssetChromeToolId } from './chromeModel';
import {
  useAssetChromeState,
  useAssetChromeActions,
  useChromePlacement,
} from './AssetNodeChrome.hooks';
import {
  runAnnotate,
  runChromaKey,
  runCrop,
  runDiffKey,
  runEdgeDetect,
  runFrameCapture,
  runOutpaint,
  runResize,
  runSmartSplit,
  runSplit,
  runSpriteSheet,
  runTrim,
  type ToolCtx,
} from './assetToolExecutors';
import { ImageCropDialog, type ImageCropRect } from '../dialogs/ImageCropDialog';
import { ImageResizeDialog } from '../dialogs/ImageResizeDialog';
import { ImageSplitDialog, type ImageSplitDialogPayload } from '../dialogs/ImageSplitDialog';
import { ImageSmartSplitDialog, type ImageSmartSplitDialogPayload } from '../dialogs/ImageSmartSplitDialog';
import { ImageAnnotateDialog } from '../dialogs/ImageAnnotateDialog';
import { ImageEdgeDetectDialog } from '../dialogs/ImageEdgeDetectDialog';
import { ImageChromaKeyDialog } from '../dialogs/ImageChromaKeyDialog';
import { ImageDifferenceKeyDialog } from '../dialogs/ImageDifferenceKeyDialog';
import { ImageOutpaintDialog } from '../dialogs/ImageOutpaintDialog';
import { VideoTrimDialog, type VideoTrimDialogPayload } from '../dialogs/VideoTrimDialog';
import { VideoFrameCaptureDialog, type VideoFrameCaptureDialogPayload } from '../dialogs/VideoFrameCaptureDialog';
import { VideoSpriteSheetDialog, type SpriteSheetDialogPayload } from '../dialogs/VideoSpriteSheetDialog';
import type { AssetNodeChromeProps } from './AssetNodeChrome.types';

/**
 * 资产节点选中态双层 chrome（设计层 prototypes/shared/node-chrome.js/css · D17–D27 + H1–H3）。
 *
 * 挂于 NodeCanvas 根容器（与 MarqueeSelectionOverlay 同层）：选中资产节点时，
 * 上层 = 媒体加工工具栏（图片 12 工具 A｜B 分组 / 视频 3 工具 / 音频不渲染），
 * 下层 = 路由动作栏（用作参考 toggle｜复用（仅生成资产）｜—｜删除 inline 确认）。
 * 多选隐藏顶栏（工具仅作用单资产），底栏锚选区 bbox。
 * 表面样式在 globals.css（.node-chrome-top/.node-chrome-bottom）。
 */

const TOOL_ICONS: Record<AssetChromeTool['icon'], typeof IconCrop> = {
  flipH: IconFlipHorizontal,
  flipV: IconFlipVertical,
  rotate: IconRotate,
  crop: IconCrop,
  resize: IconResize,
  grid: IconLayoutGrid,
  scissors: IconScissors,
  outpaint: IconArrowsDiagonal,
  borderOuter: IconBorderOuter,
  colorFilter: IconColorFilter,
  contrast: IconContrast,
  pencil: IconPencil,
  photo: IconPhoto,
};

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

export const AssetNodeChrome = memo(function AssetNodeChrome({
  canvasRef,
}: AssetNodeChromeProps) {
  const state = useAssetChromeState();
  const { selection, bottomView, singleAsset, hasMedia, singleMediaAsset } = state;
  const { selectNodes } = useCanvasSelectionBridge();

  const topBarRef = useRef<HTMLDivElement | null>(null);
  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  const assetNodesRef = useRef(selection.assetNodes);
  assetNodesRef.current = selection.assetNodes;

  const actions = useAssetChromeActions({ assetNodesRef, bottomBarRef });
  const [dialogOpen, setDialogOpen] = useState<AssetChromeToolId | null>(null);
  const [viewportTick, setViewportTick] = useState(0);

  const animateKey = useMemo(
    () => selection.assetNodes.map((n) => n.id).join('|'),
    [selection.assetNodes],
  );

  // 选中集变化：关闭弹窗与删除确认（D23 状态完整性）。
  useEffect(() => {
    setDialogOpen(null);
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
      if (deleteConfirm || dialogOpen !== null) return;
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
  }, [selection.active, deleteConfirm, dialogOpen, requestDelete]);

  const mediaType = singleAsset?.mediaType ?? null;
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

  const sourceUrl = singleMediaAsset?.original?.url ?? '';
  const ctx = useMemo<ToolCtx | null>(() => {
    if (!selection.single || !singleAsset || !sourceUrl) return null;
    return {
      node: selection.single,
      data: singleAsset,
      sourceUrl,
      asset: singleMediaAsset ?? undefined,
      selectNodes,
    };
  }, [selection.single, singleAsset, sourceUrl, singleMediaAsset, selectNodes]);

  const openTool = (tool: AssetChromeTool) => {
    if (tool.kind === 'dialog') {
      setDialogOpen(tool.id);
      return;
    }
    if (ctx) {
      void actions.runDirectTool(tool.id, ctx);
    }
  };

  const closeDialog = () => setDialogOpen(null);

  const originalMeta = useMemo<ImageMeta | null>(() => {
    const w = singleMediaAsset?.original?.width;
    const h = singleMediaAsset?.original?.height;
    if (!w || !h) return null;
    return { width: w, height: h, aspectRatio: w / h };
  }, [singleMediaAsset]);

  const videoMeta = useMemo<VideoMeta | null>(() => {
    const o = singleMediaAsset?.original;
    if (!o?.width || !o?.height) return null;
    return { width: o.width, height: o.height, aspectRatio: o.width / o.height, fps: o.fps ?? undefined };
  }, [singleMediaAsset]);

  if (!selection.active) return null;

  const multi = selection.multi;

  return (
    <>
      {showTop && (
        <div
          ref={topBarRef}
          className="node-chrome-top"
          role="toolbar"
          data-asset-node-chrome="top"
          aria-label={MEDIA_ARIA[mediaType ?? ''] ?? '媒体加工工具'}
          data-testid="asset-chrome-top"
        >
          {toolGroups.map((group, gi) => (
            <div key={gi} style={{ display: 'contents' }}>
              {gi > 0 ? <div className="sep" aria-hidden="true" /> : null}
              <div className="grp">
                {group.map((tool) => {
                  const Icon = TOOL_ICONS[tool.icon];
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
        data-asset-node-chrome="bottom"
        aria-label="资产动作"
        data-testid="asset-chrome-bottom"
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
              <span>{multi ? `确认删除 ${selection.assetNodes.length} 项` : '确认删除'}</span>
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
                title={bottomView.refsActive ? '从参考区移除' : '加入参考区'}
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
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggleRefs();
                }}
              >
                {bottomView.refsActive ? <IconCheck size={14} className="size-3.5" /> : <IconBookmark size={14} className="size-3.5" />}
                <span>
                  {bottomView.refsActive ? '取消参考' : '用作参考'} ·{' '}
                  {selection.assetNodes.length} 项
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
              <span>加入打包区{multi ? ` · ${selection.assetNodes.length} 项` : ''}</span>
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
              <span>{multi ? `删除 ${selection.assetNodes.length} 项` : '删除'}</span>
            </Button>
          </>
        )}
      </div>

      {/* 弹窗（与素材节点入口同一批 Dialog，参数与媒体同框；确认即加工产出资产节点） */}
      {ctx && mediaType === 'image' ? (
        <>
          <ImageCropDialog
            open={dialogOpen === 'crop'}
            onOpenChange={(o) => !o && closeDialog()}
            imageUrl={sourceUrl}
            onConfirm={async (rect: ImageCropRect) => {
              closeDialog();
              await runCrop(ctx, rect);
            }}
          />
          <ImageResizeDialog
            open={dialogOpen === 'resize'}
            onOpenChange={(o) => !o && closeDialog()}
            originalMeta={originalMeta}
            currentPercent={100}
            defaultKernel="lanczos3"
            onConfirm={async (percent, kernel) => {
              closeDialog();
              await runResize(ctx, percent, kernel);
            }}
          />
          <ImageSplitDialog
            open={dialogOpen === 'split'}
            onOpenChange={(o) => !o && closeDialog()}
            imageUrl={sourceUrl}
            onConfirm={async (payload: ImageSplitDialogPayload) => {
              closeDialog();
              await runSplit(ctx, payload);
            }}
          />
          <ImageSmartSplitDialog
            open={dialogOpen === 'smartSplit'}
            onOpenChange={(o) => !o && closeDialog()}
            imageUrl={sourceUrl}
            onConfirm={async (payload: ImageSmartSplitDialogPayload) => {
              closeDialog();
              await runSmartSplit(ctx, payload);
            }}
          />
          <ImageOutpaintDialog
            open={dialogOpen === 'outpaint'}
            onOpenChange={(o) => !o && closeDialog()}
            imageUrl={sourceUrl}
            initialModelId={undefined}
            modelOptions={outpaintModelOptions()}
            onConfirm={async (payload) => {
              closeDialog();
              await runOutpaint(ctx, payload);
            }}
          />
          <ImageEdgeDetectDialog
            open={dialogOpen === 'edgeDetect'}
            onOpenChange={(o) => !o && closeDialog()}
            defaultThreshold={128}
            onConfirm={async (threshold) => {
              closeDialog();
              await runEdgeDetect(ctx, threshold);
            }}
          />
          <ImageChromaKeyDialog
            open={dialogOpen === 'chromaKey'}
            onOpenChange={(o) => !o && closeDialog()}
            imageUrl={sourceUrl}
            onConfirm={async (params) => {
              closeDialog();
              await runChromaKey(ctx, params);
            }}
          />
          <ImageDifferenceKeyDialog
            open={dialogOpen === 'diffKey'}
            onOpenChange={(o) => !o && closeDialog()}
            imageUrl={sourceUrl}
            onConfirm={async (params) => {
              closeDialog();
              await runDiffKey(ctx, params);
            }}
          />
          <ImageAnnotateDialog
            open={dialogOpen === 'annotate'}
            onOpenChange={(o) => !o && closeDialog()}
            imageUrl={sourceUrl}
            onConfirm={async (blob) => {
              closeDialog();
              await runAnnotate(ctx, blob);
            }}
          />
        </>
      ) : null}
      {ctx && mediaType === 'video' ? (
        <>
          <VideoTrimDialog
            open={dialogOpen === 'trim'}
            onOpenChange={(o) => !o && closeDialog()}
            videoUrl={sourceUrl}
            onConfirm={async (payload: VideoTrimDialogPayload) => {
              closeDialog();
              await runTrim(ctx, payload);
            }}
          />
          <VideoFrameCaptureDialog
            open={dialogOpen === 'frameCapture'}
            onOpenChange={(o) => !o && closeDialog()}
            videoUrl={sourceUrl}
            onConfirm={async (payload: VideoFrameCaptureDialogPayload) => {
              closeDialog();
              await runFrameCapture(ctx, payload.timeSec);
            }}
          />
          <VideoSpriteSheetDialog
            open={dialogOpen === 'spriteSheet'}
            onOpenChange={(o) => !o && closeDialog()}
            videoUrl={sourceUrl}
            videoMeta={videoMeta}
            fps={videoMeta?.fps}
            onConfirm={(payload: SpriteSheetDialogPayload) => {
              closeDialog();
              void runSpriteSheet(ctx, payload);
            }}
          />
        </>
      ) : null}
    </>
  );
});

const outpaintModelOptions = () =>
  listRuntimeProjectedImageToImageModels().map((config) => ({
    modelId: config.modelId,
    label: config.label,
  }));

export default AssetNodeChrome;

'use client';

import { useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { IconFolder } from '@tabler/icons-react';

import { revealFilesUrlWithToast } from '@/client/utils/revealFilesUrlWithToast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ZoomableImagePreview } from '@/components/ui/zoomable-image-preview/ZoomableImagePreview';
import { classifyMediaUrl } from '@/features/models/shared/mediaResolutionTypes';

/**
 * 会话内资产预览（spec docs/agent/02「会话视图与多轮历史」：产物引用可预览）。
 *
 * 轻量预览弹层：图片复用共享的 ZoomableImagePreview（缩放/平移行为与其他预览入口一致），
 * 视频就地播放（controls，静音），音频给播放控件。受控 open，无 trigger——触发按钮
 * （产物缩略图 / 相册格）由调用方渲染，弹层只负责内容；这样「用作参考」等覆盖按钮可以与触发
 * 按钮共存而不嵌套按钮。
 *
 * 尺寸口径：DialogContent 走 form="canvas" + fill（guard:dialog-sizing 合规，className 不写尺寸）；
 * 图片分支的预览面以 flex-1 min-h-0 撑满剩余高度，高度目标由 docs/runtime/媒体放大预览交互契约.md
 * 「初始尺寸契约」定义——只有 max-h 时百分比链退化为 auto，图片会按自身比例撑开并被裁切。
 *
 * 相册预览层的三个扩展槽（连续生成相册，docs/runtime/媒体放大预览交互契约「导航契约」）：
 * - `bottomStartSlot`：放大预览左下角导航槽（导航控件常驻可见，不跟随缩放 HUD 淡出）；
 * - `metaSlot`：媒体面下方的归属信息（当前图完整 prompt + 该次调用的参考图 chips）；
 * - `faceSlot`：替代媒体面（失败调用的错误详情复用同一预览壳，不做第二套弹层）；
 * - `onKeyDownExtra`：追加键盘处理（相册 ← → 翻页）。挂在本层 DialogContent 的 capture 阶段：
 *   放大预览内部的按键宿主只覆盖媒体面，导航槽在其之外，焦点落在导航控件上的方向键必须由
 *   对话框层接住。Esc 不在其中（浮层栈统一分发）。
 *
 * 定位入口（docs/editor/本地文件快捷跳转.md 判据二/三、LFJ-004）：媒体面右下角提供
 * 「打开文件所在位置」图标按钮，三类媒体同位同形；仅当预览地址经能力门
 * （classifyMediaUrl().capabilities.canRevealFile）判定为项目媒体目录内本地文件才渲染，
 * 远端 / 空 / 相对地址不呈现。点击复用共享封装 revealFilesUrlWithToast（失败分级 toast
 * 由封装承载，本层不新写文案）。按钮是媒体容器的直接子节点（ZoomableImagePreview surface
 * 的兄弟），pointerdown 不经过 surface 根，不受其指针捕获重定向影响。
 */

export type AssetPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaType: 'image' | 'video' | 'audio';
  /** 预览源（local-media 作用域地址）；null 时不渲染媒体面 */
  previewUrl: string | null;
  /** 资产名（无障碍名与说明用） */
  name: string;
  /** 空态文案（预览地址缺失时的占位；不传走 ZoomableImagePreview 缺省） */
  emptyText?: string;
  /** 媒体面槽：给定时替代内置媒体面（相册失败格用同一预览壳呈现错误详情） */
  faceSlot?: ReactNode;
  /** 媒体面下方的归属信息槽（相册：完整 prompt + 参考图 chips） */
  metaSlot?: ReactNode;
  /** 左下角导航槽（bottomStartSlot）：序列长度 ≥ 2 的翻页控件，常驻可见 */
  bottomStartSlot?: ReactNode;
  /** 追加键盘处理（相册 ← → 翻页） */
  onKeyDownExtra?: (event: ReactKeyboardEvent<Element>) => void;
};

export function AssetPreviewDialog({
  open,
  onOpenChange,
  mediaType,
  previewUrl,
  name,
  emptyText,
  faceSlot,
  metaSlot,
  bottomStartSlot,
  onKeyDownExtra,
}: AssetPreviewDialogProps) {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
  }, [previewUrl, open]);

  // 无预览地址（空串 = 该页没有可预览的媒体）不是「加载中」：交给空态呈现，
  // 否则相册里的占位页会永远停在加载中。
  const isLoadingMedia = isLoading && previewUrl !== null && previewUrl !== '';

  // 追加键盘处理走本层 DialogContent 的 onKeyDownCapture（与 ZoomableImagePreview 的
  // 缩放键盘互不重叠：那边只管缩放键）。签名统一成上游约定的「只做副作用」写法。
  const extraKeyDown =
    onKeyDownExtra === undefined
      ? undefined
      : (event: ReactKeyboardEvent<Element>): undefined => {
          onKeyDownExtra(event);
          return undefined;
        };

  // 定位入口能力门（docs/editor/本地文件快捷跳转.md 判据三）：空地址（相册占位页）与
  // 非项目本地媒体（远端 / data / blob / 相对地址）一律不呈现，不让用户点击后才失败。
  const canRevealFile =
    previewUrl !== null && previewUrl !== '' && classifyMediaUrl(previewUrl).capabilities.canRevealFile;

  // 三类媒体共用同一颗定位按钮（右下角，与左下角导航槽 / 右上角关闭钮不争位）；
  // 形态与画布资产节点预览工具栏的定位按钮一致（variant secondary + 圆形 icon 钮）。
  const revealAction =
    canRevealFile && previewUrl !== null ? (
      <Button
        type="button"
        variant="secondary"
        size="icon"
        className="absolute right-3 bottom-3 rounded-full"
        aria-label="打开文件所在位置"
        title="打开文件所在位置"
        data-testid="asset-preview-reveal"
        onClick={(event) => {
          event.stopPropagation();
          void revealFilesUrlWithToast(previewUrl, undefined);
        }}
      >
        <IconFolder size={18} />
      </Button>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        form="canvas"
        // 图片预览容器必须撑满可用视口（docs/runtime/媒体放大预览交互契约.md「初始尺寸契约」）：
        // 高度只有 max-h 时百分比链退化为 auto，图片按自身比例撑开后被 overflow-hidden 裁切。
        // 视频分支维持自身高度（max-h-[70vh]），不进 fill。
        fill={mediaType === "image"}
        // 透明视觉样式（合法 className 用途）；宽度由 canvas 形态内置约束。
        className="bg-transparent border-none p-0 shadow-none"
        showCloseButton
        onKeyDownCapture={extraKeyDown}
      >
        <span className="sr-only">
          <DialogTitle>预览</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </span>
        {faceSlot !== undefined ? (
          <div className="flex flex-col items-center justify-center p-4">
            {faceSlot}
            {metaSlot}
          </div>
        ) : previewUrl === null ? null : mediaType === 'image' ? (
          <>
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              <ZoomableImagePreview
                // 翻页换图即重挂：切换图片回到 fit 档（契约「切换时的状态重置」），
                // 不继承上一张的缩放与平移。
                key={previewUrl}
                src={previewUrl}
                alt={name}
                zoomable
                isLoading={isLoadingMedia}
                onLoad={() => setIsLoading(false)}
                emptyText={emptyText}
                bottomStartSlot={bottomStartSlot}
                // 导航控件常驻可见（契约「导航可见性」）：有导航槽即不跟随缩放 HUD 淡出。
                slotAlwaysVisible={bottomStartSlot !== undefined}
              />
              {revealAction}
            </div>
            {metaSlot}
          </>
        ) : mediaType === 'video' ? (
          <>
            <div className="relative flex items-center justify-center p-4">
              <video
                src={previewUrl}
                controls
                autoPlay
                muted
                loop
                playsInline
                tabIndex={-1}
                className="max-h-[70vh] max-w-[70vw] rounded-md"
              >
                {/* 预览的是用户自己的资产，无字幕轨可用；空 captions 轨满足 media-has-caption（VideoTrimDialog 同款） */}
                <track kind="captions" />
              </video>
              {revealAction}
            </div>
            {metaSlot}
          </>
        ) : (
          <>
            <div className="relative flex items-center justify-center p-4">
              {/* 用户自有音频的播放控件，无字幕轨可挂（AudioInputNode 同款豁免） */}
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio src={previewUrl} controls className="w-80" />
              {revealAction}
            </div>
            {metaSlot}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

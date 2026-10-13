"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 媒体工具弹窗共享壳层。
 * spec: docs/editor/dialog-sizing-contract.md「媒体工具弹窗一屏布局（场景特化）」节。
 *
 * 一屏目标：≥720px 高视口下弹窗内完整可用，外部滚动容器为零。
 * 结构：Header（标题 + 可选一行描述）/ Body（左舞台列 flex-1 + 右参数栏 w-80）/ 可选 Notice / Footer。
 * 舞台媒体由容器约束（object-contain + max-w-full max-h-full），禁止 65vh/480px 固定值；
 * 参数栏超出时 overflow-y-auto 兜底，≥720 视口不得出现滚动。
 */

export interface MediaToolDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 一行描述；超行文案应压缩或移入舞台空态/参数栏顶部 */
  description?: string;
  /** 左列：舞台区（媒体预览/交互画布）+ 可选舞台工具条 */
  stage: ReactNode;
  /** 右列：参数栏内容（分组卡片） */
  rail: ReactNode;
  /** 舞台列底部工具条（时间轴、选区信息等宽控件），shrink-0 */
  stageToolbar?: ReactNode;
  /** 就地反馈（执行错误等），独立槽位，shrink-0 */
  notice?: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  confirmLoadingLabel?: string;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const STAGE_PLACEHOLDER_BASE =
  "flex w-full h-full items-center justify-center text-sm text-muted-foreground";

export function MediaToolDialogShell({
  open,
  onOpenChange,
  title,
  description,
  stage,
  rail,
  stageToolbar,
  notice,
  cancelLabel = "取消",
  confirmLabel,
  confirmDisabled = false,
  confirmLoadingLabel,
  loading = false,
  onCancel,
  onConfirm,
}: MediaToolDialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="canvas" fill className="p-0 gap-0">
        <DialogHeader className="shrink-0 px-6 pt-5 pb-3">
          <DialogTitle className="pr-8">{title}</DialogTitle>
          {description ? (
            <p className="pr-8 text-sm text-muted-foreground line-clamp-1">{description}</p>
          ) : null}
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-6 py-4">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border bg-muted/10 p-2">
              {stage}
            </div>
            {stageToolbar ? <div className="shrink-0 nodrag nopan">{stageToolbar}</div> : null}
          </div>

          <div className="w-80 shrink-0 space-y-3 overflow-y-auto overscroll-contain">
            {rail}
          </div>
        </div>

        {notice ? <div className="shrink-0 px-6 pb-3">{notice}</div> : null}

        <DialogFooter className="gap-2 px-6 pb-5 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button type="button" disabled={confirmDisabled} onClick={onConfirm}>
            {loading && confirmLoadingLabel ? confirmLoadingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 舞台 contain 适配盒：测量舞台可用区，按媒体自然尺寸计算 contain 后的显式像素盒。
 *
 * 修复图片裁切根因：`<img max-h-full>` 包在 auto 高度 wrapper（如 inline-block）里时，
 * 百分比 max-height 按 CSS 规范解析为 none，高度约束静默失效，图片只被宽度约束，
 * 超出舞台容器（overflow-hidden）的部分被裁切。
 * 本盒给媒体一个显式像素尺寸的定高父级，img/canvas 用 h-full w-full 填满即精确等于
 * contain 后的显示矩形，叠层（absolute inset-0）与图片天然对齐。
 * 自然尺寸未知（加载中/未测量）时盒子拉伸填满舞台，占位态照常 work。
 * spec: docs/editor/dialog-sizing-contract.md「媒体工具弹窗一屏布局」舞台容器约束尺寸。
 */
export function MediaStageFitBox({
  naturalWidth,
  naturalHeight,
  className,
  boxRef,
  children,
}: {
  naturalWidth: number | null | undefined;
  naturalHeight: number | null | undefined;
  className?: string;
  /** 内层显式尺寸盒的 ref（供调用方测量/定位叠层，如标注画布坐标系） */
  boxRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setAvailable((prev) =>
        prev !== null && prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const boxStyle = useMemo<CSSProperties | undefined>(() => {
    if (!available || !naturalWidth || !naturalHeight) return undefined;
    const scale = Math.min(
      available.width / naturalWidth,
      available.height / naturalHeight,
    );
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    return {
      width: `${Math.max(1, Math.floor(naturalWidth * scale))}px`,
      height: `${Math.max(1, Math.floor(naturalHeight * scale))}px`,
    };
  }, [available, naturalHeight, naturalWidth]);

  return (
    <div ref={measureRef} className="flex h-full w-full min-h-0 min-w-0 items-center justify-center">
      <div
        ref={boxRef}
        className={cn("relative", boxStyle === undefined && "h-full w-full", className)}
        style={boxStyle}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 舞台三态占位：填满舞台容器（w-full h-full），不写死占位尺寸。
 * loading（带进度提示）/ empty（指引）/ error（destructive）三态语义分离。
 */
export function MediaStagePlaceholder({
  state,
  message,
  hint,
}: {
  state: "loading" | "empty" | "error";
  message: string;
  hint?: string;
}) {
  return (
    <div
      className={cn(
        STAGE_PLACEHOLDER_BASE,
        state === "error" && "text-destructive",
      )}
    >
      <div className="space-y-1 text-center">
        <div>{message}</div>
        {hint ? <div className="text-xs opacity-80">{hint}</div> : null}
      </div>
    </div>
  );
}

/**
 * 舞台叠层徽标：底色 bg-black/70 + text-xs 底线（spec 叠层文字条目）。
 */
export function MediaStageBadge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded bg-black/70 px-2 py-0.5 text-xs text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}

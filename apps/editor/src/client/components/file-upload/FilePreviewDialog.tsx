import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ZoomableImagePreview } from "@/components/ui/zoomable-image-preview";
import type {
  FilePreviewTitleResolver,
  UploadFileItem,
} from "./fileUploadTypes";

const isVideoLike = (item: UploadFileItem | null | undefined): boolean => {
  if (!item) return false;
  const rawType = (item.file !== null && item.file !== undefined ? item.file.type : undefined) ?? "";
  if (rawType.startsWith("video/")) return true;
  const src = (item.src ?? "").trim();
  return (
    Boolean(src) &&
    (src.startsWith("data:video") || /\.(mp4|mov|webm|m4v)(\?.*)?$/i.test(src))
  );
};

export const useFilePreview = (options: {
  getTitle: FilePreviewTitleResolver | undefined;
} | undefined = undefined) => {
  const [previewItem, setPreviewItem] = useState<UploadFileItem | null>(null);
  const titleResolver = (options !== null && options !== undefined ? options.getTitle : undefined);
  const previewTitle = useMemo(() => {
    if (!previewItem) return "";
    return titleResolver
      ? titleResolver(previewItem)
      : ((previewItem.file !== null && previewItem.file !== undefined ? previewItem.file.name : undefined) ?? previewItem.id ?? "预览");
  }, [previewItem, titleResolver]);
  const previewSrc = useMemo(
    () => ((previewItem !== null && previewItem !== undefined ? previewItem.src : undefined) ?? "").trim(),
    [previewItem],
  );
  const isVideoPreview = useMemo(() => isVideoLike(previewItem), [previewItem]);
  const openPreview = useCallback(
    (item: UploadFileItem) => setPreviewItem(item),
    [],
  );
  const closePreview = useCallback(() => setPreviewItem(null), []);
  return {
    previewItem,
    previewTitle,
    previewSrc,
    isVideoPreview,
    openPreview,
    closePreview,
  };
};

export interface FilePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  src: string;
  isVideo: boolean | undefined;
  emptyText: string | undefined;
  closeText: string | undefined;
}

export const FilePreviewDialog: React.FC<FilePreviewDialogProps> = ({
  open,
  onOpenChange,
  title,
  src,
  isVideo = false,
  emptyText = "这个文件暂时无法预览",
  closeText = "关闭预览",
}) => {
  // canvas 形态承载可缩放图片；视频沿用 standard 形态以保留原生 controls 与底部关闭按钮。
  if (!isVideo) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          form="canvas"
          // 图片预览容器必须撑满可用视口（docs/runtime/媒体放大预览交互契约.md「初始尺寸契约」）：
          // 高度只有 max-h 时百分比链退化为 auto，图片按自身比例撑开后被 overflow-hidden 裁切。
          fill
          showCloseButton={false}
          className="border-none bg-transparent p-0 shadow-none"
        >
          <DialogDescription className="sr-only">图片预览</DialogDescription>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <ZoomableImagePreview
              src={src}
              alt={title || "preview"}
              zoomable={Boolean(src)}
              emptyText={emptyText}
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="standard">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">视频预览</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center bg-black">
          {src ? (
            <video
              src={src}
              controls
              autoPlay
              className="max-h-[75vh] max-w-full"
            >
              <track kind="captions" />
            </video>
          ) : (
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            asChild={undefined}
            onClick={() => onOpenChange(false)}
          >
            {closeText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

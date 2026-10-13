"use client";

/* eslint-disable @next/next/no-img-element */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ensureLocalFilesImageUrl } from "../../utils/mediaUtils";
import { isEditableTarget } from "./imageAnnotateDialogTypes";
import {
  MediaStageBadge,
  MediaStageFitBox,
  MediaStagePlaceholder,
  MediaToolDialogShell,
} from "./MediaToolDialogShell";
import {
  buildImageCropPreviewStyle,
  buildImageCropRect,
  constrainToRatio,
  buildRuleOfThirdsLines,
  type AspectRatioPreset,
  getAspectRatioValue,
} from "./imageCropGeometry";
import { ImageCropAspectRatioSelector } from "./ImageCropAspectRatioSelector";
import {
  useCropInteraction,
  hasValidRect,
  type NormalizedRect,
} from "./useCropInteraction";

export type ImageCropRect = { x: number; y: number; width: number; height: number };

interface ImageCropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string | null;
  onConfirm: (rect: ImageCropRect) => Promise<void>;
}

export const ImageCropDialog = memo(function ImageCropDialog({ open, onOpenChange, imageUrl, onConfirm }: ImageCropDialogProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [selection, setSelection] = useState<NormalizedRect | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioPreset>("free");

  const {
    cursor,
    setCursor,
    interactionRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  } = useCropInteraction({
    imageRef,
    selection,
    setSelection,
    naturalSize,
    loading,
    saving,
    aspectRatio,
  });

  useEffect(() => {
    if (!open) {
      setLocalUrl(null);
      setLoadError(null);
      setLoading(false);
      setSaving(false);
      setExportError(null);
      setNaturalSize(null);
      setSelection(null);
      setCursor("crosshair");
      setAspectRatio("free");
      interactionRef.current = { type: "none" };
      return;
    }
    setExportError(null);
    setSelection(null);
    setCursor("crosshair");
    setAspectRatio("free");
    interactionRef.current = { type: "none" };
  }, [open, setCursor, interactionRef]);

  useEffect(() => {
    let alive = true;
    if (!open || !imageUrl) return;

    setLoading(true);
    setLoadError(null);
    setLocalUrl(null);
    setNaturalSize(null);

    void (async () => {
      try {
        const local = await ensureLocalFilesImageUrl(imageUrl);
        if (alive) setLocalUrl(local);
      } catch (error) {
        console.warn("[ImageCropDialog] ensureLocalFilesImageUrl failed", error);
        if (alive) {
          setLocalUrl(imageUrl);
          setLoadError("当前图片可能无法裁剪，请换一张图片后重试。");
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [open, imageUrl]);

  const handleAspectRatioChange = useCallback((preset: AspectRatioPreset) => {
    setAspectRatio(preset);
    if (preset !== "free" && hasValidRect(selection) && naturalSize !== null) {
      const ratio = getAspectRatioValue(preset);
      if (ratio !== null) {
        const imageRatio = naturalSize.width / naturalSize.height;
        const centerX = selection.x + selection.w / 2;
        const centerY = selection.y + selection.h / 2;
        const constrained = constrainToRatio({
          selection,
          anchor: { x: centerX, y: centerY },
          ratio,
          imageRatio,
        });
        setSelection(constrained);
      }
    }
  }, [naturalSize, selection]);

  const cropRect = useMemo<ImageCropRect | null>(() => {
    if (!hasValidRect(selection)) return null;
    const width = (naturalSize !== null && naturalSize !== undefined ? naturalSize.width : undefined) ?? 0;
    const height = (naturalSize !== null && naturalSize !== undefined ? naturalSize.height : undefined) ?? 0;
    if (!width || !height) return null;
    return buildImageCropRect(selection, { width, height });
  }, [naturalSize, selection]);

  const canConfirm = Boolean(!loading && !saving && localUrl && cropRect);

  const handleConfirm = useCallback(async () => {
    if (!cropRect) return;
    setSaving(true);
    setExportError(null);
    try {
      await onConfirm(cropRect);
      onOpenChange(false);
    } catch (error) {
      console.error("[ImageCropDialog] crop failed", error);
      setExportError(error instanceof Error ? error.message : "裁剪失败");
    } finally {
      setSaving(false);
    }
  }, [cropRect, onConfirm, onOpenChange]);

  const previewStyle = useMemo<React.CSSProperties | null>(() => {
    if (!localUrl || !hasValidRect(selection) || !naturalSize) return null;

    return buildImageCropPreviewStyle({
      localUrl,
      selection,
      naturalSize,
      maxBoxWidth: 220,
      maxBoxHeight: 240,
    });
  }, [localUrl, naturalSize, selection]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (saving || loading) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (canConfirm) void handleConfirm();
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, saving, loading, canConfirm, handleConfirm]);

  if (!open) return null;

  const stagePlaceholderState = loadError ? "error" : loading ? "loading" : "empty";

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="裁剪图片"
      description="在图片上拖动建立裁剪选区"
      loading={saving || loading}
      confirmLabel="确认"
      confirmLoadingLabel="处理中..."
      confirmDisabled={!canConfirm}
      onCancel={() => onOpenChange(false)}
      onConfirm={() => void handleConfirm()}
      notice={exportError ? <div className="text-sm text-destructive">{exportError}</div> : null}
      stage={
        localUrl ? (
          <MediaStageFitBox
            naturalWidth={naturalSize?.width}
            naturalHeight={naturalSize?.height}
            className="select-none"
          >
            <img
              ref={imageRef}
              src={localUrl}
              alt="图片裁剪"
              crossOrigin="anonymous"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              onLoad={() => {
                const img = imageRef.current;
                if (!img) return;
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (w && h) setNaturalSize({ width: w, height: h });
              }}
              className="block h-full w-full object-contain"
            />

            <div
              className="absolute inset-0 touch-none"
              style={{ cursor: loading || saving ? "default" : cursor }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onPointerLeave={() => {
                if (interactionRef.current.type === "none") setCursor("crosshair");
              }}
            >
              {hasValidRect(selection) ? (
                <div
                  className="group absolute border-2 border-primary"
                  style={{
                    left: `${selection.x * 100}%`,
                    top: `${selection.y * 100}%`,
                    width: `${selection.w * 100}%`,
                    height: `${selection.h * 100}%`,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
                  }}
                >
                  {/* Handles (visual only; hit-test via pointer position) */}
                  <div className="pointer-events-none absolute left-0 top-0 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  <div className="pointer-events-none absolute left-1/2 top-0 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  <div className="pointer-events-none absolute left-full top-0 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  <div className="pointer-events-none absolute left-full top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  <div className="pointer-events-none absolute left-full top-full h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  <div className="pointer-events-none absolute left-1/2 top-full h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  <div className="pointer-events-none absolute left-0 top-full h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  <div className="pointer-events-none absolute left-0 top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary transition-transform group-hover:scale-125" />
                  {/* 三分线 */}
                  {(() => {
                    if (!hasValidRect(selection)) return null;
                    const thirds = buildRuleOfThirdsLines(selection);
                    return (
                      <>
                        <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-white/30" style={{ top: `${((thirds.horizontal[0] - selection.y) / selection.h) * 100}%` }} />
                        <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-white/30" style={{ top: `${((thirds.horizontal[1] - selection.y) / selection.h) * 100}%` }} />
                        <div className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-white/30" style={{ left: `${((thirds.vertical[0] - selection.x) / selection.w) * 100}%` }} />
                        <div className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-white/30" style={{ left: `${((thirds.vertical[1] - selection.x) / selection.w) * 100}%` }} />
                      </>
                    );
                  })()}
                </div>
              ) : null}
              {/* 空状态引导 */}
              {!hasValidRect(selection) && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <MediaStageBadge>拖动以建立选区</MediaStageBadge>
                </div>
              )}
            </div>
          </MediaStageFitBox>
        ) : (
          <MediaStagePlaceholder
            state={stagePlaceholderState}
            message={loadError ?? (loading ? "加载图片中..." : "无可裁剪图片")}
          />
        )
      }
      rail={
        <>
          <div className="rounded-md border p-3 space-y-3">
            <Label className="text-sm">裁剪比例</Label>
            <ImageCropAspectRatioSelector current={aspectRatio} onSelect={handleAspectRatioChange} />
          </div>

          <div className="rounded-md border p-3 space-y-3">
            <div className="mb-1 text-xs text-muted-foreground">预览</div>
            <div className="flex justify-center">
              {previewStyle ? (
                <div className="overflow-hidden rounded-md border bg-muted/20" style={previewStyle} role="img" aria-label="裁剪预览" />
              ) : (
                <div className="flex h-[180px] w-full items-center justify-center rounded-md border bg-muted/20 text-xs text-muted-foreground">{localUrl ? "请拖动建立选区" : "无可预览"}</div>
              )}
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-2 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>原图尺寸</span>
              <span className="tabular-nums">{naturalSize ? `${naturalSize.width} × ${naturalSize.height}` : "-"}</span>
            </div>
            <div className="flex justify-between">
              <span>裁剪区域</span>
              <span className="tabular-nums">{cropRect ? `${cropRect.width} × ${cropRect.height}` : "-"}</span>
            </div>
            <Button type="button" variant="outline" size="sm" className="w-full" disabled={saving || loading || !hasValidRect(selection)} onClick={() => setSelection(null)}>
              清除选择
            </Button>
          </div>
        </>
      }
    />
  );
});

export default ImageCropDialog;

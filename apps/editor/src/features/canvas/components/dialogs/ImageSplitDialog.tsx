"use client";

/* eslint-disable @next/next/no-img-element */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ensureLocalFilesImageUrl } from "../../utils/mediaUtils";
import { isEditableTarget } from "./imageAnnotateDialogTypes";
import {
  getImageContentFrameFromElement,
} from "../../utils/imageGeometry";
import {
  getSplitAxisPositionFromClientPoint,
  toImageSplitPercent,
  type LineItem,
  type LineAxis,
  sortByPos,
  createLineId,
  computeBestInsertPos,
  buildEvenLines,
  buildGridPreset,
  clampLineWithNeighbors,
  fromPercent,
  hasDuplicateInt,
  MAX_LINES_PER_AXIS,
  clamp01,
} from "./imageSplitGeometry";
import { GridPresetSelector } from "./ImageSplitGridPresetSelector";
import { ImageSplitTileOverlay } from "./ImageSplitTileOverlay";
import { ImageSplitLineEditor } from "./ImageSplitLineEditor";
import { MediaStageBadge, MediaStageFitBox, MediaStagePlaceholder, MediaToolDialogShell } from "./MediaToolDialogShell";

export type ImageSplitDialogPayload = {
  horizontalPercents: number[];
  verticalPercents: number[];
  rows: number;
  cols: number;
};

interface ImageSplitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string | null;
  onConfirm: (payload: ImageSplitDialogPayload) => Promise<void>;
}

type SplitMode = "preset" | "custom";
type LineEditorTab = "vertical" | "horizontal";

type DragState = { type: "none" } | { type: "dragging"; axis: LineAxis; lineId: string; pointerId: number };

export const ImageSplitDialog = memo(function ImageSplitDialog({ open, onOpenChange, imageUrl, onConfirm }: ImageSplitDialogProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState>({ type: "none" });

  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const [verticalLines, setVerticalLines] = useState<LineItem[]>([]);
  const [horizontalLines, setHorizontalLines] = useState<LineItem[]>([]);
  const [verticalCount, setVerticalCount] = useState(0);
  const [horizontalCount, setHorizontalCount] = useState(0);
  const [pixelMode, setPixelMode] = useState(false);
  const [mode, setMode] = useState<SplitMode>("preset");
  const [lineTab, setLineTab] = useState<LineEditorTab>("vertical");

  useEffect(() => {
    if (!open) {
      setLocalUrl(null);
      setLoadError(null);
      setLoading(false);
      setSaving(false);
      setExportError(null);
      setNaturalSize(null);
      setVerticalLines([]);
      setHorizontalLines([]);
      setVerticalCount(0);
      setHorizontalCount(0);
      setPixelMode(false);
      setMode("preset");
      setLineTab("vertical");
      dragRef.current = { type: "none" };
      return;
    }
    setExportError(null);
    dragRef.current = { type: "none" };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setVerticalCount(verticalLines.length);
  }, [open, verticalLines.length]);

  useEffect(() => {
    if (!open) return;
    setHorizontalCount(horizontalLines.length);
  }, [open, horizontalLines.length]);

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
        console.warn("[ImageSplitDialog] ensureLocalFilesImageUrl failed", error);
        if (alive) {
          setLocalUrl(imageUrl);
          setLoadError("当前图片可能无法精确切片，请换一张图片后重试。");
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [open, imageUrl]);

  const sortedVertical = useMemo(() => [...verticalLines].sort(sortByPos), [verticalLines]);
  const sortedHorizontal = useMemo(() => [...horizontalLines].sort(sortByPos), [horizontalLines]);

  const rows = sortedHorizontal.length + 1;
  const cols = sortedVertical.length + 1;
  const tileCount = rows * cols;

  const validationError = useMemo((): string | null => {
    if (!imageUrl) return "还没有可分割的图片";
    if (sortedVertical.length === 0 && sortedHorizontal.length === 0) return "请至少添加 1 条分割线";
    if (sortedVertical.length > MAX_LINES_PER_AXIS || sortedHorizontal.length > MAX_LINES_PER_AXIS) {
      return `分割线最多 ${MAX_LINES_PER_AXIS} 条（最多 5×5=25 块）`;
    }
    if (rows > 5 || cols > 5) return "块数太多，最多 5×5=25 块，请减少分割线";
    if (tileCount > 25) return "图块太多，最多 25 块，请减少分割线";
    if (!naturalSize || !naturalSize.width || !naturalSize.height) return "图片还没加载完，请稍候";

    const xPixels = sortedVertical.map((l) => Math.round(l.pos * naturalSize.width));
    const yPixels = sortedHorizontal.map((l) => Math.round(l.pos * naturalSize.height));
    if (xPixels.some((x) => x <= 0 || x >= naturalSize.width)) return "有竖向分割线超出了图片范围";
    if (yPixels.some((y) => y <= 0 || y >= naturalSize.height)) return "有横向分割线超出了图片范围";
    if (hasDuplicateInt(xPixels)) return "有两条竖向分割线落在同一位置，请拉开间距";
    if (hasDuplicateInt(yPixels)) return "有两条横向分割线落在同一位置，请拉开间距";

    return null;
  }, [cols, imageUrl, naturalSize, rows, sortedHorizontal, sortedVertical, tileCount]);

  const updateLinePos = useCallback(
    (axis: LineAxis, lineId: string, nextPos: number) => {
      if (axis === "vertical") {
        setVerticalLines((prev) => {
          const clamped = clampLineWithNeighbors(axis, prev, lineId, nextPos, naturalSize);
          return prev.map((l) => (l.id === lineId ? { ...l, pos: clamped } : l));
        });
        return;
      }
      setHorizontalLines((prev) => {
        const clamped = clampLineWithNeighbors(axis, prev, lineId, nextPos, naturalSize);
        return prev.map((l) => (l.id === lineId ? { ...l, pos: clamped } : l));
      });
    },
    [naturalSize],
  );

  const handleOverlayPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag.type !== "dragging") return;
      if (drag.pointerId !== event.pointerId) return;
      const image = imageRef.current;
      if (!image) return;
      const frame = getImageContentFrameFromElement(image);
      if (frame === null) return;
      const axisPosition = getSplitAxisPositionFromClientPoint({
        axis: drag.axis,
        clientX: event.clientX,
        clientY: event.clientY,
        frame,
      });
      if (axisPosition === null) {
        console.debug("[ImageSplitDialog] ignore pointer outside image content", {
          clientX: event.clientX,
          clientY: event.clientY,
        });
        return;
      }
      if (drag.axis === "vertical") {
        updateLinePos("vertical", drag.lineId, axisPosition);
      } else {
        updateLinePos("horizontal", drag.lineId, axisPosition);
      }
      event.preventDefault();
    },
    [updateLinePos],
  );

  const handleOverlayPointerUp = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag.type !== "dragging") return;
    if (drag.pointerId !== event.pointerId) return;
    dragRef.current = { type: "none" };
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    event.preventDefault();
  }, []);

  const handleOverlayPointerCancel = useCallback(() => {
    dragRef.current = { type: "none" };
  }, []);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, axis: LineAxis, lineId: string) => {
      if (loading || saving) return;
      if (event.button !== 0) return;
      dragRef.current = { type: "dragging", axis, lineId, pointerId: event.pointerId };
      try {
        (overlayRef.current ?? (event.currentTarget as HTMLElement)).setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [loading, saving],
  );

  const removeLine = useCallback((axis: LineAxis, lineId: string) => {
    if (axis === "vertical") {
      setVerticalLines((prev) => prev.filter((l) => l.id !== lineId));
      return;
    }
    setHorizontalLines((prev) => prev.filter((l) => l.id !== lineId));
  }, []);

  const addLine = useCallback(
    (axis: LineAxis) => {
      const axisLines = axis === "vertical" ? verticalLines : horizontalLines;
      if (axisLines.length >= MAX_LINES_PER_AXIS) return;

      const candidate = computeBestInsertPos(axisLines);
      const id = createLineId(axis);

      if (axis === "vertical") {
        setVerticalLines((prev) => {
          const nextPos = clampLineWithNeighbors(axis, prev, id, candidate, naturalSize);
          return [...prev, { id, pos: nextPos }];
        });
      } else {
        setHorizontalLines((prev) => {
          const nextPos = clampLineWithNeighbors(axis, prev, id, candidate, naturalSize);
          return [...prev, { id, pos: nextPos }];
        });
      }
    },
    [horizontalLines, naturalSize, verticalLines],
  );

  const applyEvenSplit = useCallback(() => {
    const v = Math.max(0, Math.min(MAX_LINES_PER_AXIS, Math.round(verticalCount)));
    const h = Math.max(0, Math.min(MAX_LINES_PER_AXIS, Math.round(horizontalCount)));
    setVerticalLines(buildEvenLines(v, "vertical"));
    setHorizontalLines(buildEvenLines(h, "horizontal"));
  }, [horizontalCount, verticalCount]);

  const updateLineValue = useCallback(
    (axis: LineAxis, lineId: string, value: number) => {
      if (!Number.isFinite(value)) return;
      if (pixelMode) {
        if (!naturalSize) return;
        const px = axis === "vertical" ? naturalSize.width : naturalSize.height;
        const pos = clamp01(value / px);
        updateLinePos(axis, lineId, pos);
        return;
      }
      updateLinePos(axis, lineId, fromPercent(value));
    },
    [naturalSize, pixelMode, updateLinePos],
  );

  const handlePresetSelect = useCallback((presetRows: number, presetCols: number) => {
    setMode("preset");
    const result = buildGridPreset(presetRows, presetCols);
    setVerticalLines(result.verticalLines);
    setHorizontalLines(result.horizontalLines);
  }, []);

  const handleConfirm = useCallback(async () => {
    setSaving(true);
    setExportError(null);
    try {
      const horizontalPercents = sortedHorizontal.map((l) => toImageSplitPercent(l.pos));
      const verticalPercents = sortedVertical.map((l) => toImageSplitPercent(l.pos));
      await onConfirm({ horizontalPercents, verticalPercents, rows, cols });
      onOpenChange(false);
    } catch (error) {
      console.error("[ImageSplitDialog] split failed", error);
      setExportError(error instanceof Error ? error.message : "图片分割失败");
    } finally {
      setSaving(false);
    }
  }, [cols, onConfirm, onOpenChange, rows, sortedHorizontal, sortedVertical]);

  const canConfirm = Boolean(!loading && !saving && !validationError);

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
        setVerticalLines([]);
        setHorizontalLines([]);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, saving, loading, canConfirm, handleConfirm]);

  if (!open) return null;

  const stagePlaceholderState = loadError ? "error" : loading ? "loading" : "empty";
  const activeAxis: LineAxis = lineTab;

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="图片分割"
      description="最多 5×5=25 块；支持网格预设、拖拽分割线与参数微调。"
      loading={saving}
      confirmLabel="确认分割并生成节点"
      confirmLoadingLabel="处理中..."
      confirmDisabled={!canConfirm}
      onCancel={() => onOpenChange(false)}
      onConfirm={() => void handleConfirm()}
      notice={
        <>
          {loadError ? <div className="text-sm text-[var(--color-warning)]">{loadError}</div> : null}
          {exportError ? <div className="text-sm text-destructive">{exportError}</div> : null}
          {validationError ? <div className="text-sm text-destructive">{validationError}</div> : null}
        </>
      }
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
              alt="图片分割预览"
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
              ref={overlayRef}
              className={cn("absolute inset-0 touch-none", loading || saving ? "cursor-default" : "cursor-crosshair")}
              onPointerMove={handleOverlayPointerMove}
              onPointerUp={handleOverlayPointerUp}
              onPointerCancel={handleOverlayPointerCancel}
            >
              {/* 竖线 */}
              {sortedVertical.map((line, idx) => (
                <div key={line.id} className="absolute inset-y-0" style={{ left: `${line.pos * 100}%` }}>
                  <div className="absolute -left-2 top-0 h-full w-4 cursor-ew-resize" onPointerDown={(e) => startDrag(e, "vertical", line.id)} />
                  <div className="h-full w-0.5 bg-primary shadow-sm" />
                  <div className="absolute left-2 top-2"><MediaStageBadge>V{idx + 1}</MediaStageBadge></div>
                </div>
              ))}

              {/* 横线 */}
              {sortedHorizontal.map((line, idx) => (
                <div key={line.id} className="absolute inset-x-0" style={{ top: `${line.pos * 100}%` }}>
                  <div className="absolute -top-2 left-0 h-4 w-full cursor-ns-resize" onPointerDown={(e) => startDrag(e, "horizontal", line.id)} />
                  <div className="h-0.5 w-full bg-primary shadow-sm" />
                  <div className="absolute left-2 top-2"><MediaStageBadge>H{idx + 1}</MediaStageBadge></div>
                </div>
              ))}

              {/* 瓦片尺寸叠加层 */}
              {naturalSize !== null && (
                <ImageSplitTileOverlay
                  verticalLines={sortedVertical}
                  horizontalLines={sortedHorizontal}
                  naturalSize={naturalSize}
                />
              )}

              {/* 空状态引导 */}
              {sortedVertical.length === 0 && sortedHorizontal.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <MediaStageBadge>选择右侧网格预设，或在图上添加线条</MediaStageBadge>
                </div>
              )}
            </div>

            <div className="pointer-events-none absolute bottom-2 left-2">
              <MediaStageBadge>{rows} × {cols} = {tileCount} 块</MediaStageBadge>
            </div>
          </MediaStageFitBox>
        ) : (
          <MediaStagePlaceholder
            state={stagePlaceholderState}
            message={loadError ?? (loading ? "加载中..." : "无图片")}
          />
        )
      }
      rail={
        <>
          <div className="rounded-md border p-3 space-y-3">
            <Label className="text-sm">网格预设</Label>
            <GridPresetSelector
              currentRows={rows}
              currentCols={cols}
              onSelect={handlePresetSelect}
              onCustom={() => setMode("custom")}
              isCustom={mode === "custom"}
            />
          </div>

          {mode === "custom" && (
            <>
              {/* 平均分：两轴计数 + 生成等分线 */}
              <div className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">平均分</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">%</span>
                    <Switch
                      checked={pixelMode}
                      onCheckedChange={(checked) => {
                        if (checked && !naturalSize) return;
                        setPixelMode(checked);
                      }}
                      disabled={!naturalSize || saving || loading}
                    />
                    <span className="text-xs text-muted-foreground">px</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">竖向（0~4）</Label>
                    <Input type="number" min={0} max={MAX_LINES_PER_AXIS} value={String(verticalCount)} onChange={(e) => setVerticalCount(Number(e.target.value))} disabled={saving || loading} className="h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">横向（0~4）</Label>
                    <Input type="number" min={0} max={MAX_LINES_PER_AXIS} value={String(horizontalCount)} onChange={(e) => setHorizontalCount(Number(e.target.value))} disabled={saving || loading} className="h-8" />
                  </div>
                </div>
                <Button type="button" variant="secondary" disabled={saving || loading} onClick={applyEvenSplit}>
                  生成等分线
                </Button>
              </div>

              {/* 线条编辑器：竖向/横向分轴切换，校验错误固定在 notice 槽位 */}
              <div className="rounded-md border p-3 space-y-3">
                <ToggleGroup
                  type="single"
                  value={lineTab}
                  onValueChange={(value) => {
                    if (value === "vertical" || value === "horizontal") setLineTab(value);
                  }}
                  variant="outline"
                  className="w-full"
                >
                  <ToggleGroupItem value="vertical" className="flex-1">
                    竖线 {sortedVertical.length}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="horizontal" className="flex-1">
                    横线 {sortedHorizontal.length}
                  </ToggleGroupItem>
                </ToggleGroup>

                {naturalSize ? (
                  <div className="text-xs text-muted-foreground">
                    原图尺寸：{naturalSize.width} × {naturalSize.height}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">图片加载完成后可切换像素输入</div>
                )}

                <ImageSplitLineEditor
                  axis={activeAxis}
                  lines={activeAxis === "vertical" ? sortedVertical : sortedHorizontal}
                  naturalSize={naturalSize}
                  pixelMode={pixelMode}
                  saving={saving}
                  loading={loading}
                  onAddLine={addLine}
                  onRemoveLine={removeLine}
                  onUpdateLineValue={updateLineValue}
                />
              </div>
            </>
          )}
        </>
      }
    />
  );
});

export default ImageSplitDialog;

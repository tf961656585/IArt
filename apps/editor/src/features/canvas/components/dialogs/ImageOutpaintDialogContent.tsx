import Image from "next/image";
import type { Dispatch, PointerEvent, RefObject, SetStateAction } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  IMAGE_GENERATION_ASPECT_RATIO_OPTIONS,
  IMAGE_GENERATION_SIZE_OPTIONS,
  ensureImageGenerationAspectRatio,
  ensureImageGenerationSize,
  type ImageGenerationAspectRatio,
  type ImageGenerationSize,
} from "@/features/models/shared/imageGenerationOptions";
import {
  normalizeOutpaintCount,
  type ImageOutpaintModelOption,
  type OutpaintRectPx,
  type OutpaintPreviewState,
} from "./imageOutpaintDialogTypes";

export function ImageOutpaintDialogContent(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadError: string | null;
  exportError: string | null;
  stageOuterRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  imageElRef: RefObject<HTMLImageElement | null>;
  preview: OutpaintPreviewState | null;
  localUrl: string | null;
  loading: boolean;
  saving: boolean;
  mode: "canvas" | "image";
  setMode: Dispatch<SetStateAction<"canvas" | "image">>;
  targetDims: { width: number; height: number };
  selectionPx: OutpaintRectPx | null;
  imagePx: OutpaintRectPx | null;
  aspectRatio: ImageGenerationAspectRatio;
  setAspectRatio: Dispatch<SetStateAction<ImageGenerationAspectRatio>>;
  imageSize: ImageGenerationSize;
  setImageSize: Dispatch<SetStateAction<ImageGenerationSize>>;
  modelId: string;
  setModelId: Dispatch<SetStateAction<string>>;
  modelOptions: ImageOutpaintModelOption[];
  draftCount: string;
  setDraftCount: Dispatch<SetStateAction<string>>;
  count: number;
  setCount: Dispatch<SetStateAction<number>>;
  maxAllowedCount: number;
  userPrompt: string;
  setUserPrompt: Dispatch<SetStateAction<string>>;
  imageUrl: string | null;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onResetLayout: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const {
    open,
    onOpenChange,
    loadError,
    exportError,
    stageOuterRef,
    stageRef,
    imageElRef,
    preview,
    localUrl,
    loading,
    saving,
    mode,
    setMode,
    targetDims,
    selectionPx,
    imagePx,
    aspectRatio,
    setAspectRatio,
    imageSize,
    setImageSize,
    modelId,
    setModelId,
    modelOptions,
    draftCount,
    setDraftCount,
    count,
    setCount,
    maxAllowedCount,
    userPrompt,
    setUserPrompt,
    imageUrl,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onResetLayout,
    onCancel,
    onConfirm,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="canvas" fill className="p-0 gap-0">
        <DialogHeader className="shrink-0 px-6 pt-5 pb-3">
          <DialogTitle className="pr-8">扩图（补全空白区域）</DialogTitle>
          <p className="pr-8 text-sm text-muted-foreground line-clamp-1">
            把画布选区往外扩，新增区域先用白色底图占位；确认后由模型补全，结果放到画布上。
          </p>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden px-6 py-4">
          {loadError ? (
            <div className="text-sm text-[var(--color-warning)]">{loadError}</div>
          ) : null}
          {exportError ? (
            <div className="text-sm text-destructive">{exportError}</div>
          ) : null}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[1fr,320px]">
              <div
                ref={stageOuterRef}
                className="flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-md border bg-muted/20 p-2"
              >
                {preview && localUrl && !loading ? (
                  <div
                    ref={stageRef}
                    className="relative touch-none select-none bg-muted/30 overflow-hidden rounded"
                    style={{
                      width: preview.stage.width,
                      height: preview.stage.height,
                    }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                  >
                    <div
                      className="absolute bg-white"
                      style={{
                        left: `${preview.selection.x * 100}%`,
                        top: `${preview.selection.y * 100}%`,
                        width: `${preview.selection.w * 100}%`,
                        height: `${preview.selection.h * 100}%`,
                      }}
                    />
                    <Image
                      ref={imageElRef}
                      src={localUrl}
                      alt="扩图预览"
                      width={1}
                      height={1}
                      unoptimized
                      crossOrigin="anonymous"
                      draggable={false}
                      onDragStart={(event) => event.preventDefault()}
                      className="absolute"
                      style={{
                        left: `${preview.image.x * 100}%`,
                        top: `${preview.image.y * 100}%`,
                        width: `${preview.image.w * 100}%`,
                        height: `${preview.image.h * 100}%`,
                        cursor: mode === "image" ? "grab" : "default",
                      }}
                    />
                    <div
                      className="absolute border-2 border-primary"
                      style={{
                        left: `${preview.selection.x * 100}%`,
                        top: `${preview.selection.y * 100}%`,
                        width: `${preview.selection.w * 100}%`,
                        height: `${preview.selection.h * 100}%`,
                        boxShadow: "0 0 0 9999px rgba(0,0,0,0.18)",
                        cursor: mode === "canvas" ? "nwse-resize" : "default",
                      }}
                    >
                      <div className="pointer-events-none absolute left-0 top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary" />
                      <div className="pointer-events-none absolute left-full top-0 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary" />
                      <div className="pointer-events-none absolute left-full top-full h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary" />
                      <div className="pointer-events-none absolute left-0 top-full h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary" />
                    </div>
                    <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap items-center gap-2 text-[10px] text-white/80">
                      <span className="rounded bg-black/55 px-2 py-1">
                        白色区域将被补全
                      </span>
                      <span className="rounded bg-black/55 px-2 py-1">
                        目标输出: {targetDims.width}×{targetDims.height}
                      </span>
                      {selectionPx && imagePx ? (
                        <span className="rounded bg-black/55 px-2 py-1">
                          扩展:{" "}
                          {(
                            Math.max(
                              selectionPx.width / imagePx.width,
                              selectionPx.height / imagePx.height,
                            ) * 100
                          ).toFixed(0)}
                          %
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
                    {loading ? "加载图片中..." : "无可扩图图片"}
                  </div>
                )}
              </div>
              <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain">
                <div className="space-y-2">
                  <Label>操作模式</Label>
                  <ToggleGroup
                    type="single"
                    value={mode}
                    onValueChange={(value) => {
                      if (value === "canvas" || value === "image")
                        setMode(value);
                    }}
                    variant="outline"
                    size="sm"
                    spacing={0}
                  >
                    <ToggleGroupItem value="canvas" aria-label="调整画布选区">
                      调整画布
                    </ToggleGroupItem>
                    <ToggleGroupItem value="image" aria-label="移动原图位置">
                      移动原图
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <p className="text-xs text-muted-foreground">
                    {mode === "canvas"
                      ? "拖动角点扩展画布选区（比例锁定）"
                      : "拖动原图改变留白方向"}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>尺寸（比例）</Label>
                    <Select
                      value={aspectRatio}
                      onValueChange={(value) =>
                        setAspectRatio(ensureImageGenerationAspectRatio(value))
                      }
                      disabled={saving}
                    >
                      <SelectTrigger className="w-full" size="default">
                        <SelectValue placeholder="选择比例" />
                      </SelectTrigger>
                      <SelectContent>
                        {IMAGE_GENERATION_ASPECT_RATIO_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>像素（质量）</Label>
                    <Select
                      value={imageSize}
                      onValueChange={(value) =>
                        setImageSize(ensureImageGenerationSize(value))
                      }
                      disabled={saving}
                    >
                      <SelectTrigger className="w-full" size="default">
                        <SelectValue placeholder="选择像素" />
                      </SelectTrigger>
                      <SelectContent>
                        {IMAGE_GENERATION_SIZE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>扩图模型</Label>
                  <Select
                    value={modelId}
                    onValueChange={setModelId}
                    disabled={saving || modelOptions.length === 0}
                  >
                    <SelectTrigger className="w-full" size="default">
                      <SelectValue placeholder="请选择补图模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.map((option) => (
                        <SelectItem key={option.modelId} value={option.modelId}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {modelOptions.length === 0 ? (
                    <p className="text-xs text-destructive">
                      还没有可用的补图模型。
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="outpaint-count">扩图张数</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="outpaint-count"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={draftCount}
                      className="w-24"
                      disabled={saving}
                      onChange={(event) => {
                        const next = (event.target as HTMLInputElement).value;
                        setDraftCount(next);
                        const parsed = normalizeOutpaintCount(next, count);
                        setCount(
                          Math.min(Math.max(parsed, 1), maxAllowedCount),
                        );
                      }}
                      onBlur={() => {
                        const parsed = normalizeOutpaintCount(
                          draftCount,
                          count,
                        );
                        const clamped = Math.min(
                          Math.max(parsed, 1),
                          maxAllowedCount,
                        );
                        setDraftCount(String(clamped));
                        setCount(clamped);
                      }}
                    />
                    <span className="text-xs text-muted-foreground">
                      最多 {maxAllowedCount}
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="outpaint-user-prompt">补充提示词</Label>
                  <Textarea
                    id="outpaint-user-prompt"
                    value={userPrompt}
                    onChange={(event) => setUserPrompt(event.target.value)}
                    placeholder="例如：延展为同一房间的墙面与地面；补全背景为连续的天空与远山；保持原风格与光照一致……"
                    rows={5}
                    className="resize-none"
                    disabled={saving}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onResetLayout}
                    disabled={saving || loading}
                  >
                    重置布局
                  </Button>
                </div>
              </div>
            </div>
        </div>
        <DialogFooter className="shrink-0 gap-2 px-6 pb-5 sm:gap-0">
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={onConfirm}
            disabled={
              saving || loading || !imageUrl || modelOptions.length === 0
            }
          >
            {saving ? "生成中..." : "确认扩图"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

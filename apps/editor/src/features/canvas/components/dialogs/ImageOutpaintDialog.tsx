"use client";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { toast } from "sonner";
import { ensureLocalFilesImageUrl } from "../../utils/mediaUtils";
import { loadImageElement } from "@/client/components/file-upload/imageConstraints";
import {
  clientPointToImageNorm,
  fitSizeIntoBox,
  getElementBoxFrame,
  type ImageContentFrame,
} from "../../utils/imageGeometry";
import {
  DEFAULT_MAX_BATCH_TASKS,
  getResolvedMaxBatchTasks,
} from "@/client/utils/hubBatchConfig";
import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  DEFAULT_IMAGE_GENERATION_SIZE,
  computeImageGenerationTargetDimensions,
  ensureImageGenerationAspectRatio,
  ensureImageGenerationSize,
  parseAspectRatio,
  type ImageGenerationAspectRatio,
  type ImageGenerationSize,
} from "@/features/models/shared/imageGenerationOptions";
import {
  DEFAULT_OUTPAINT_COUNT,
  OUTPAINT_COUNT_STORAGE_KEY,
  clamp01,
  clampRect,
  getOutpaintPreviewRects,
  isPointInRect,
  normalizeOutpaintCount,
  type ImageOutpaintDialogProps,
  type NormalizedRect,
  type OutpaintPreviewState,
} from "./imageOutpaintDialogTypes";
import {
  buildOutpaintInitialPreview,
  resizeOutpaintSelectionFromPoint,
} from "./imageOutpaintGeometry";
import { ImageOutpaintDialogContent } from "./ImageOutpaintDialogContent";
import { exportOutpaintSourceBlob } from "./imageOutpaintExport";
export type {
  ImageOutpaintDialogConfirmPayload,
  ImageOutpaintDialogProps,
  ImageOutpaintModelOption,
} from "./imageOutpaintDialogTypes";
export const ImageOutpaintDialog = memo(function ImageOutpaintDialog({
  open,
  onOpenChange,
  imageUrl,
  initialModelId,
  modelOptions,
  onConfirm,
}: ImageOutpaintDialogProps) {
  const stageOuterRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageElRef = useRef<HTMLImageElement | null>(null);
  const interactionRef = useRef<
    | { type: "none" }
    | { type: "resizeSelection"; pointerId: number }
    | {
        type: "dragImage";
        pointerId: number;
        start: { x: number; y: number };
        startRect: NormalizedRect;
      }
  >({ type: "none" });
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<ImageGenerationAspectRatio>(
    DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  );
  const [imageSize, setImageSize] = useState<ImageGenerationSize>(
    DEFAULT_IMAGE_GENERATION_SIZE,
  );
  const [modelId, setModelId] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [count, setCount] = useState<number>(DEFAULT_OUTPAINT_COUNT);
  const [draftCount, setDraftCount] = useState<string>(
    String(DEFAULT_OUTPAINT_COUNT),
  );
  const [maxBatchTasks, setMaxBatchTasks] = useState<number>(
    DEFAULT_MAX_BATCH_TASKS,
  );
  const maxAllowedCount = useMemo(
    () => Math.max(1, Math.floor(maxBatchTasks)),
    [maxBatchTasks],
  );
  const [mode, setMode] = useState<"canvas" | "image">("canvas");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<OutpaintPreviewState | null>(null);
  const targetDims = useMemo(
    () => computeImageGenerationTargetDimensions(aspectRatio, imageSize),
    [aspectRatio, imageSize],
  );
  const targetRatio = useMemo(() => {
    const parsed = parseAspectRatio(aspectRatio);
    const ratio = parsed ? parsed.width / parsed.height : 1;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }, [aspectRatio]);
  const measureStage = useCallback(() => {
    const outer = stageOuterRef.current;
    if (!outer) return null;
    const frame = getElementBoxFrame(outer);
    if (frame === null) return null;
    const maxW = Math.floor(frame.width);
    const maxH = Math.floor(frame.height);
    const fitted = fitSizeIntoBox(targetRatio, maxW, maxH);
    return {
      width: Math.max(240, fitted.width),
      height: Math.max(180, fitted.height),
    };
  }, [targetRatio]);
  const rebuildPreview = useCallback(
    (params: {
      stage: { width: number; height: number };
      natural: { width: number; height: number };
      aspectRatio: ImageGenerationAspectRatio;
    }) => {
      const { stage, natural, aspectRatio } = params;
      const parsed = parseAspectRatio(aspectRatio);
      const ratio = parsed ? parsed.width / parsed.height : 1;
      setPreview(
        buildOutpaintInitialPreview({
          stage,
          natural,
          targetRatio: ratio,
        }),
      );
    },
    [],
  );
  useEffect(() => {
    if (open) return;
    setLocalUrl(null);
    setNaturalSize(null);
    setLoadError(null);
    setExportError(null);
    setLoading(false);
    setSaving(false);
    setMode("canvas");
    setModelId("");
    setUserPrompt("");
    setAspectRatio(DEFAULT_IMAGE_GENERATION_ASPECT_RATIO);
    setImageSize(DEFAULT_IMAGE_GENERATION_SIZE);
    setCount(DEFAULT_OUTPAINT_COUNT);
    setDraftCount(String(DEFAULT_OUTPAINT_COUNT));
    setPreview(null);
    interactionRef.current = { type: "none" };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (
      initialModelId &&
      modelOptions.some((item) => item.modelId === initialModelId)
    ) {
      setModelId(initialModelId);
      return;
    }
    setModelId("");
  }, [initialModelId, modelOptions, open]);
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    void getResolvedMaxBatchTasks()
      .then((value) => {
        if (!mounted) return;
        setMaxBatchTasks(value);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem(OUTPAINT_COUNT_STORAGE_KEY);
      if (!raw) return;
      const parsed = normalizeOutpaintCount(raw, DEFAULT_OUTPAINT_COUNT);
      const clamped = Math.min(Math.max(parsed, 1), maxAllowedCount);
      setCount(clamped);
      setDraftCount(String(clamped));
    } catch {
      void 0;
    }
  }, [maxAllowedCount, open]);
  useEffect(() => {
    if (!open) return;
    const normalized = normalizeOutpaintCount(count, DEFAULT_OUTPAINT_COUNT);
    const clamped = Math.min(Math.max(normalized, 1), maxAllowedCount);
    if (clamped !== count) {
      toast.info(`已按当前最大生成数量调整为 ${clamped}`);
      setCount(clamped);
      setDraftCount(String(clamped));
      return;
    }
    try {
      localStorage.setItem(OUTPAINT_COUNT_STORAGE_KEY, String(clamped));
    } catch {
      void 0;
    }
  }, [count, maxAllowedCount, open]);
  useEffect(() => {
    let alive = true;
    if (!open || !imageUrl) return;
    setLoading(true);
    setLoadError(null);
    setExportError(null);
    setLocalUrl(null);
    setNaturalSize(null);
    setPreview(null);
    void (async () => {
      try {
        const local = await ensureLocalFilesImageUrl(imageUrl);
        if (!alive) return;
        setLocalUrl(local);
        const img = await loadImageElement(local);
        if (!alive) return;
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) throw new Error("IMAGE_DIMENSION_UNAVAILABLE");
        setNaturalSize({ width: w, height: h });
      } catch (error) {
        console.warn("[ImageOutpaintDialog] image load failed", error);
        if (!alive) return;
        setLocalUrl(imageUrl);
        setLoadError("这张图片来自外部链接，无法保存到本地，扩图可能失败。");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, imageUrl]);
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const measured = measureStage();
      if (!measured) return;
      if (!naturalSize) {
        setPreview((prev) => (prev ? { ...prev, stage: measured } : prev));
        return;
      }
      rebuildPreview({ stage: measured, natural: naturalSize, aspectRatio });
    };
    update();
    const onResize = () => update();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [aspectRatio, measureStage, naturalSize, open, rebuildPreview]);
  const { selectionPx, imagePx } = useMemo(
    () => getOutpaintPreviewRects(preview),
    [preview],
  );
  const getPointerInfo = useCallback((event: PointerEvent<HTMLElement>) => {
    const target = stageRef.current;
    if (!target) return null;
    const frame = getElementBoxFrame(target);
    if (frame === null) return null;
    const point = clientPointToImageNorm(
      { x: event.clientX, y: event.clientY },
      frame,
    );
    if (point === null) {
      return null;
    }
    return { point, frame };
  }, []);
  const isNearCornerHandle = useCallback(
    (
      info: { point: { x: number; y: number }; frame: ImageContentFrame },
      rect: NormalizedRect,
    ) => {
      const slopX = clamp01(10 / info.frame.width);
      const slopY = clamp01(10 / info.frame.height);
      const corners = [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.w, y: rect.y },
        { x: rect.x + rect.w, y: rect.y + rect.h },
        { x: rect.x, y: rect.y + rect.h },
      ];
      return corners.some(
        (c) =>
          Math.abs(info.point.x - c.x) <= slopX &&
          Math.abs(info.point.y - c.y) <= slopY,
      );
    },
    [],
  );
  const resizeSelectionFromPointer = useCallback(
    (info: { point: { x: number; y: number } }) => {
      if (!preview) return;
      const parsed = parseAspectRatio(aspectRatio);
      const ratio = parsed ? parsed.width / parsed.height : 1;
      setPreview(
        resizeOutpaintSelectionFromPoint({
          preview,
          point: info.point,
          targetRatio: ratio,
        }),
      );
    },
    [aspectRatio, preview],
  );
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!preview || loading || saving) return;
      const info = getPointerInfo(event);
      if (!info) return;
      const pointerId = event.pointerId;
      if (mode === "canvas") {
        if (!isNearCornerHandle(info, preview.selection)) return;
        interactionRef.current = { type: "resizeSelection", pointerId };
      } else {
        if (!isPointInRect(info.point, preview.image)) return;
        interactionRef.current = {
          type: "dragImage",
          pointerId,
          start: info.point,
          startRect: preview.image,
        };
      }
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(pointerId);
      } catch {
        void 0;
      }
      event.preventDefault();
    },
    [getPointerInfo, isNearCornerHandle, loading, mode, preview, saving],
  );
  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const info = getPointerInfo(event);
      if (!info || !preview) return;
      const interaction = interactionRef.current;
      if (interaction.type === "none") return;
      if (interaction.pointerId !== event.pointerId) return;
      if (interaction.type === "resizeSelection") {
        resizeSelectionFromPointer(info);
        event.preventDefault();
        return;
      }
      if (interaction.type === "dragImage") {
        const { stage, selection } = preview;
        const dx = info.point.x - interaction.start.x;
        const dy = info.point.y - interaction.start.y;
        const candidate: NormalizedRect = {
          ...interaction.startRect,
          x: interaction.startRect.x + dx,
          y: interaction.startRect.y + dy,
        };
        const clamped: NormalizedRect = {
          ...candidate,
          x: Math.min(
            Math.max(candidate.x, selection.x),
            selection.x + selection.w - candidate.w,
          ),
          y: Math.min(
            Math.max(candidate.y, selection.y),
            selection.y + selection.h - candidate.h,
          ),
        };
        setPreview({ stage, selection, image: clampRect(clamped) });
        event.preventDefault();
      }
    },
    [getPointerInfo, preview, resizeSelectionFromPointer],
  );
  const handlePointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (interaction.type === "none") return;
    if (interaction.pointerId !== event.pointerId) return;
    interactionRef.current = { type: "none" };
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(
        event.pointerId,
      );
    } catch {
      void 0;
    }
  }, []);
  const handlePointerCancel = useCallback(() => {
    interactionRef.current = { type: "none" };
  }, []);
  const buildSourceBlob = useCallback(async (): Promise<Blob> => {
    return exportOutpaintSourceBlob({
      imageElement: imageElRef.current,
      preview,
      aspectRatio,
      imageSize,
    });
  }, [aspectRatio, imageSize, preview]);
  const handleConfirm = useCallback(async () => {
    const prompt = userPrompt.trim();
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) {
      toast.error("还没有选择扩图模型");
      return;
    }
    setSaving(true);
    setExportError(null);
    try {
      const sourceImage = await buildSourceBlob();
      onOpenChange(false);
      const resolvedCount = Math.min(
        Math.max(normalizeOutpaintCount(count, DEFAULT_OUTPAINT_COUNT), 1),
        maxAllowedCount,
      );
      void Promise.resolve(
        onConfirm({
          sourceImage,
          modelId: normalizedModelId,
          aspectRatio: ensureImageGenerationAspectRatio(aspectRatio),
          imageSize: ensureImageGenerationSize(imageSize),
          userPrompt: prompt,
          count: resolvedCount,
        }),
      ).catch((error) => {
        console.error("[ImageOutpaintDialog] onConfirm failed", error);
        toast.error(error instanceof Error ? error.message : "扩图失败");
      });
    } catch (error) {
      console.error("[ImageOutpaintDialog] confirm failed", error);
      const msg = error instanceof Error ? error.message : String(error);
      setExportError(msg || "扩图失败");
    } finally {
      setSaving(false);
    }
  }, [
    aspectRatio,
    buildSourceBlob,
    count,
    imageSize,
    maxAllowedCount,
    modelId,
    onConfirm,
    onOpenChange,
    userPrompt,
  ]);
  const handleResetLayout = useCallback(() => {
    if (!preview || !naturalSize) return;
    const measured = measureStage();
    if (!measured) return;
    rebuildPreview({ stage: measured, natural: naturalSize, aspectRatio });
  }, [aspectRatio, measureStage, naturalSize, preview, rebuildPreview]);
  if (!open) return null;
  return (
    <ImageOutpaintDialogContent
      open={open}
      onOpenChange={onOpenChange}
      loadError={loadError}
      exportError={exportError}
      stageOuterRef={stageOuterRef}
      stageRef={stageRef}
      imageElRef={imageElRef}
      preview={preview}
      localUrl={localUrl}
      loading={loading}
      saving={saving}
      mode={mode}
      setMode={setMode}
      targetDims={targetDims}
      selectionPx={selectionPx}
      imagePx={imagePx}
      aspectRatio={aspectRatio}
      setAspectRatio={setAspectRatio}
      imageSize={imageSize}
      setImageSize={setImageSize}
      modelId={modelId}
      setModelId={setModelId}
      modelOptions={modelOptions}
      draftCount={draftCount}
      setDraftCount={setDraftCount}
      count={count}
      setCount={setCount}
      maxAllowedCount={maxAllowedCount}
      userPrompt={userPrompt}
      setUserPrompt={setUserPrompt}
      imageUrl={imageUrl}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onResetLayout={handleResetLayout}
      onCancel={() => onOpenChange(false)}
      onConfirm={handleConfirm}
    />
  );
});
export default ImageOutpaintDialog;

"use client";
/* eslint-disable @next/next/no-img-element */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { ensureLocalFilesImageUrl } from "../../utils/mediaUtils";
import { MediaStageFitBox, MediaStagePlaceholder, MediaToolDialogShell } from "./MediaToolDialogShell";

export type ImageSmartSplitDialogPayload = {
  alphaThreshold: number;
  minArea: number;
  dilateIterations: number;
  padding: number;
};

interface ImageSmartSplitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string | null;
  onConfirm: (payload: ImageSmartSplitDialogPayload) => Promise<void>;
}

type BBox = { x: number; y: number; width: number; height: number };

function binarizeAlpha(data: Uint8ClampedArray, threshold: number): Uint8Array {
  const pixelCount = data.length / 4;
  const binary = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    binary[i] = (data[i * 4 + 3] ?? 0) > threshold ? 255 : 0;
  }
  return binary;
}

function dilateBinary(binary: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let current = new Uint8Array(binary);
  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Uint8Array(current);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (current[y * w + x] === 255) continue;
        let found = false;
        for (let ky = -1; ky <= 1 && !found; ky += 1) {
          for (let kx = -1; kx <= 1 && !found; kx += 1) {
            const ny = y + ky;
            const nx = x + kx;
            if (ny >= 0 && ny < h && nx >= 0 && nx < w && current[ny * w + nx] === 255) {
              found = true;
            }
          }
        }
        if (found) next[y * w + x] = 255;
      }
    }
    current = next;
  }
  return current;
}

function detectComponents(binary: Uint8Array, w: number, h: number, minArea: number): BBox[] {
  const visited = new Uint8Array(w * h);
  const boxes: BBox[] = [];
  const queue: number[] = [];

  for (let sy = 0; sy < h; sy += 1) {
    for (let sx = 0; sx < w; sx += 1) {
      const si = sy * w + sx;
      if (binary[si] !== 255 || visited[si]) continue;
      queue.length = 0;
      queue.push(si);
      visited[si] = 1;
      let minX = sx; let maxX = sx; let minY = sy; let maxY = sy; let area = 0;
      while (queue.length > 0) {
        const idx = queue.pop();
        if (idx === undefined) break;
        const cy = (idx / w) | 0;
        const cx = idx % w;
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neighbors = [
          cy > 0 ? idx - w : -1,
          cy < h - 1 ? idx + w : -1,
          cx > 0 ? idx - 1 : -1,
          cx < w - 1 ? idx + 1 : -1,
        ];
        for (const ni of neighbors) {
          if (ni >= 0 && binary[ni] === 255 && !visited[ni]) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }
      if (area >= minArea) {
        boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
      }
    }
  }
  return boxes.sort((a, b) => (b.width * b.height) - (a.width * a.height));
}

function runDetection(
  imageData: ImageData | null,
  alphaThreshold: number,
  minArea: number,
  dilateIterations: number,
): BBox[] {
  if (!imageData) return [];
  const binary = binarizeAlpha(imageData.data, alphaThreshold);
  const dilated = dilateBinary(binary, imageData.width, imageData.height, dilateIterations);
  return detectComponents(dilated, imageData.width, imageData.height, minArea);
}

export const ImageSmartSplitDialog = memo(function ImageSmartSplitDialog({
  open,
  onOpenChange,
  imageUrl,
  onConfirm,
}: ImageSmartSplitDialogProps) {
  const [alphaThreshold, setAlphaThreshold] = useState(1);
  const [minArea, setMinArea] = useState(100);
  const [dilateIterations, setDilateIterations] = useState(2);
  const [padding, setPadding] = useState(4);
  const [boxes, setBoxes] = useState<BBox[]>([]);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const displayImgRef = useRef<HTMLImageElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadImageData = useCallback(async (url: string) => {
    const localUrl = await ensureLocalFilesImageUrl(url);
    const img = new Image();
    img.crossOrigin = "anonymous";
    imgRef.current = img;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.src = localUrl;
    });
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    imageDataRef.current = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
  }, []);

  const redrawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    const img = imgRef.current;
    if (!overlay || !img || !displaySize || !imageSize) return;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(displaySize.w * dpr);
    overlay.height = Math.round(displaySize.h * dpr);
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const scaleX = displaySize.w / imageSize.w;
    const scaleY = displaySize.h / imageSize.h;
    ctx.clearRect(0, 0, displaySize.w, displaySize.h);
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (!box) continue;
      const x = box.x * scaleX;
      const y = box.y * scaleY;
      const w = box.width * scaleX;
      const h = box.height * scaleY;
      ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(59, 130, 246, 0.85)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      const label = `${i + 1}`;
      ctx.font = "bold 12px sans-serif";
      const metrics = ctx.measureText(label);
      const padX = 4;
      const labelW = metrics.width + padX * 2;
      const labelH = 16;
      ctx.fillStyle = "rgba(59, 130, 246, 0.9)";
      ctx.fillRect(x + 2, y + 2, labelW, labelH);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 2 + padX, y + 2 + 12);
    }
  }, [boxes, displaySize, imageSize]);

  useEffect(() => {
    redrawOverlay();
  }, [redrawOverlay]);

  useEffect(() => {
    const el = displayImgRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDisplaySize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [imageSize]);

  useEffect(() => {
    const sourceCanvas = canvasRef.current;
    if (!sourceCanvas || boxes.length === 0) {
      setThumbnails([]);
      return;
    }
    const urls: string[] = [];
    const thumbCanvas = document.createElement("canvas");
    const thumbCtx = thumbCanvas.getContext("2d");
    if (!thumbCtx) { setThumbnails([]); return; }
    for (const box of boxes) {
      const px = Math.max(0, box.x - padding);
      const py = Math.max(0, box.y - padding);
      const right = Math.min(sourceCanvas.width, box.x + box.width + padding);
      const bottom = Math.min(sourceCanvas.height, box.y + box.height + padding);
      const pw = right - px;
      const ph = bottom - py;
      if (pw <= 0 || ph <= 0) continue;
      thumbCanvas.width = pw;
      thumbCanvas.height = ph;
      thumbCtx.clearRect(0, 0, pw, ph);
      thumbCtx.drawImage(sourceCanvas, px, py, pw, ph, 0, 0, pw, ph);
      const innerX = box.x - px;
      const innerY = box.y - py;
      thumbCtx.setLineDash([4, 4]);
      thumbCtx.strokeStyle = "rgba(255, 200, 0, 0.8)";
      thumbCtx.lineWidth = 2;
      thumbCtx.strokeRect(innerX, innerY, box.width, box.height);
      thumbCtx.setLineDash([]);
      urls.push(thumbCanvas.toDataURL());
    }
    setThumbnails(urls);
  }, [boxes, padding]);

  useEffect(() => {
    if (!open) {
      setAlphaThreshold(1);
      setMinArea(100);
      setDilateIterations(2);
      setPadding(4);
      setBoxes([]);
      setImageSize(null);
      setDisplaySize(null);
      setThumbnails([]);
      setError(null);
      setLoading(false);
      setConfirming(false);
      imageDataRef.current = null;
      imgRef.current = null;
      displayImgRef.current = null;
      return;
    }
    if (!imageUrl) return;
    setLoading(true);
    setError(null);
    loadImageData(imageUrl)
      .then(() => {
        const detected = runDetection(imageDataRef.current, 1, 100, 2);
        setBoxes(detected);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "图片加载失败");
      })
      .finally(() => setLoading(false));
  }, [open, imageUrl, loadImageData]);

  const scheduleDetection = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const detected = runDetection(imageDataRef.current, alphaThreshold, minArea, dilateIterations);
      setBoxes(detected);
    }, 80);
  }, [alphaThreshold, minArea, dilateIterations]);

  const handleParamChange = useCallback(() => {
    scheduleDetection();
  }, [scheduleDetection]);

  const handleConfirm = useCallback(async () => {
    setConfirming(true);
    setError(null);
    try {
      await onConfirm({ alphaThreshold, minArea, dilateIterations, padding });
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "智能切图失败");
    } finally {
      setConfirming(false);
    }
  }, [alphaThreshold, minArea, dilateIterations, padding, onConfirm, onOpenChange]);

  const hasElements = boxes.length > 0;

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="智能切图"
      description="检测透明背景中的独立元素并切分为多个素材节点。"
      loading={confirming}
      confirmLabel="确认切图"
      confirmLoadingLabel="处理中…"
      confirmDisabled={confirming || loading || !hasElements}
      onCancel={() => onOpenChange(false)}
      onConfirm={() => void handleConfirm()}
      notice={error ? <p className="text-sm text-destructive">{error}</p> : null}
      stage={
        imageSize ? (
          <MediaStageFitBox
            naturalWidth={imageSize.w}
            naturalHeight={imageSize.h}
            className="select-none"
          >
            {imgRef.current && (
              <img
                ref={displayImgRef}
                src={imgRef.current.src}
                alt="预览"
                className="block h-full w-full object-contain"
                draggable={false}
              />
            )}
            <canvas
              ref={overlayRef}
              className="absolute inset-0 pointer-events-none"
              style={{ width: "100%", height: "100%" }}
            />
          </MediaStageFitBox>
        ) : (
          <MediaStagePlaceholder state={loading ? "loading" : "empty"} message={loading ? "加载中…" : "无图片"} />
        )
      }
      stageToolbar={
        thumbnails.length > 0 ? (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <span className="shrink-0 text-xs text-muted-foreground">切分预览 ({thumbnails.length})</span>
            {thumbnails.map((url, i) => (
              <div key={i} className="relative shrink-0 rounded border bg-background p-1">
                <img src={url} alt={`元素 ${i + 1}`} className="block max-h-20 max-w-20 object-contain" draggable={false} />
                <span className="absolute top-0.5 left-0.5 text-[10px] leading-none bg-blue-500 text-white rounded px-1 py-0.5">
                  {i + 1}
                </span>
              </div>
            ))}
          </div>
        ) : null
      }
      rail={
        <>
          <div className="rounded-md border p-3 space-y-3">
            <div className="text-sm font-medium">参数设置</div>

            <div className="space-y-2">
              <label htmlFor="smart-split-alpha" className="text-xs text-muted-foreground">透明判定阈值</label>
              <div className="flex items-center gap-2">
                <Slider
                  min={1} max={254} step={1}
                  value={[alphaThreshold]}
                  onValueChange={([v]) => { if (v !== undefined) { setAlphaThreshold(v); handleParamChange(); } }}
                  className="flex-1"
                />
                <Input
                  id="smart-split-alpha"
                  type="number" min={1} max={254}
                  value={alphaThreshold}
                  onChange={(e) => { const v = Math.max(1, Math.min(254, Number(e.target.value) || 1)); setAlphaThreshold(v); handleParamChange(); }}
                  className="w-16 h-8 text-xs"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="smart-split-minarea" className="text-xs text-muted-foreground">最小面积 (px)</label>
              <div className="flex items-center gap-2">
                <Slider
                  min={1} max={10000} step={1}
                  value={[minArea]}
                  onValueChange={([v]) => { if (v !== undefined) { setMinArea(v); handleParamChange(); } }}
                  className="flex-1"
                />
                <Input
                  id="smart-split-minarea"
                  type="number" min={1} max={10000}
                  value={minArea}
                  onChange={(e) => { const v = Math.max(1, Math.min(10000, Number(e.target.value) || 1)); setMinArea(v); handleParamChange(); }}
                  className="w-20 h-8 text-xs"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="smart-split-dilate" className="text-xs text-muted-foreground">边缘扩展次数</label>
              <div className="flex items-center gap-2">
                <Slider
                  min={0} max={10} step={1}
                  value={[dilateIterations]}
                  onValueChange={([v]) => { if (v !== undefined) { setDilateIterations(v); handleParamChange(); } }}
                  className="flex-1"
                />
                <Input
                  id="smart-split-dilate"
                  type="number" min={0} max={10}
                  value={dilateIterations}
                  onChange={(e) => { const v = Math.max(0, Math.min(10, Number(e.target.value) || 0)); setDilateIterations(v); handleParamChange(); }}
                  className="w-16 h-8 text-xs"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="smart-split-padding" className="text-xs text-muted-foreground">裁切留白 (px)</label>
              <div className="flex items-center gap-2">
                <Slider
                  min={0} max={50} step={1}
                  value={[padding]}
                  onValueChange={([v]) => { if (v !== undefined) setPadding(v); }}
                  className="flex-1"
                />
                <Input
                  id="smart-split-padding"
                  type="number" min={0} max={50}
                  value={padding}
                  onChange={(e) => setPadding(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
                  className="w-16 h-8 text-xs"
                />
              </div>
            </div>
          </div>

          <div className="rounded-md border p-3 text-sm">
            {loading ? "检测中…" : hasElements ? `检测到 ${boxes.length} 个元素` : imageSize ? "未检测到元素" : ""}
          </div>
        </>
      }
    />
  );
});

export default ImageSmartSplitDialog;

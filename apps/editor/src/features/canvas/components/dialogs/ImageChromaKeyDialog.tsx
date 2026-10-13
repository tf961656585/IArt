'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { IconColorPicker } from '@tabler/icons-react';
import { MediaToolDialogShell } from './MediaToolDialogShell';

interface ImageChromaKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageUrl: string;
  onConfirm: (params: {
    targetColor: { r: number; g: number; b: number };
    tolerance: number;
    feather: number;
  }) => Promise<void>;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const MAX_PREVIEW_DIMENSION = 800;
const DEFAULT_TOLERANCE = 30;
const DEFAULT_FEATHER = 2;

function computeChromaKeyPreview(
  imageData: ImageData,
  targetColor: RGB,
  tolerance: number,
  feather: number,
): ImageData {
  const maxDistance = Math.sqrt(3) * 255;
  const threshold = (tolerance / 100) * maxDistance;
  const featherMapped = feather * (maxDistance / 100);
  const { data, width, height } = imageData;
  const output = new ImageData(width, height);
  for (let i = 0; i < data.length; i += 4) {
    const srcR = data[i] ?? 0;
    const srcG = data[i + 1] ?? 0;
    const srcB = data[i + 2] ?? 0;
    const dr = srcR - targetColor.r;
    const dg = srcG - targetColor.g;
    const db = srcB - targetColor.b;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    let alpha: number;
    if (distance <= threshold) {
      alpha = 0;
    } else if (featherMapped > 0 && distance < threshold + featherMapped) {
      alpha = Math.round((255 * (distance - threshold)) / featherMapped);
    } else {
      alpha = 255;
    }
    output.data[i] = srcR;
    output.data[i + 1] = srcG;
    output.data[i + 2] = srcB;
    output.data[i + 3] = alpha;
  }
  return output;
}

function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const size = 10;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = (Math.floor(x / size) + Math.floor(y / size)) % 2 === 0 ? '#e0e0e0' : '#ffffff';
      ctx.fillRect(x, y, size, size);
    }
  }
}

function rgbToHex(color: RGB): string {
  const r = color.r.toString(16).padStart(2, '0');
  const g = color.g.toString(16).padStart(2, '0');
  const b = color.b.toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

export const ImageChromaKeyDialog = memo(function ImageChromaKeyDialog({
  open,
  onOpenChange,
  imageUrl,
  onConfirm,
}: ImageChromaKeyDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [eyedropperMode, setEyedropperMode] = useState(false);
  const [targetColor, setTargetColor] = useState<RGB>({ r: 0, g: 255, b: 0 });
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [feather, setFeather] = useState(DEFAULT_FEATHER);
  const [loading, setLoading] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  // 加载源图到 canvas
  useEffect(() => {
    if (!open || !imageUrl) {
      setImageLoaded(false);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageRef.current = img;

      // 缩放到最长边 MAX_PREVIEW_DIMENSION
      let drawWidth = img.naturalWidth;
      let drawHeight = img.naturalHeight;
      if (Math.max(drawWidth, drawHeight) > MAX_PREVIEW_DIMENSION) {
        const scale = MAX_PREVIEW_DIMENSION / Math.max(drawWidth, drawHeight);
        drawWidth = Math.round(drawWidth * scale);
        drawHeight = Math.round(drawHeight * scale);
      }

      // 存储原始缩放后的像素数据到 sourceCanvas
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = drawWidth;
      srcCanvas.height = drawHeight;
      const srcCtx = srcCanvas.getContext('2d');
      if (srcCtx) {
        srcCtx.drawImage(img, 0, 0, drawWidth, drawHeight);
      }
      sourceCanvasRef.current = srcCanvas;

      // 设置显示 canvas 尺寸
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = drawWidth;
        canvas.height = drawHeight;
      }

      setImageLoaded(true);
    };
    img.onerror = () => {
      console.error('[ImageChromaKeyDialog] failed to load image');
      setImageLoaded(false);
    };
    img.src = imageUrl;
  }, [open, imageUrl]);

  // 参数变更时重新绘制预览
  useEffect(() => {
    if (!imageLoaded || !sourceCanvasRef.current || !canvasRef.current) return;

    const srcCanvas = sourceCanvasRef.current;
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sourceData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const previewData = computeChromaKeyPreview(sourceData, targetColor, tolerance, feather);

    // 清空画布并绘制棋盘格背景
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawCheckerboard(ctx, canvas.width, canvas.height);

    // 绘制预览结果
    ctx.putImageData(previewData, 0, 0);
  }, [imageLoaded, targetColor, tolerance, feather]);

  // 吸管取色
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!eyedropperMode) return;
      const srcCanvas = sourceCanvasRef.current;
      if (!srcCanvas) return;
      const srcCtx = srcCanvas.getContext('2d');
      if (!srcCtx) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * scaleX);
      const y = Math.round((e.clientY - rect.top) * scaleY);
      const pixel = srcCtx.getImageData(x, y, 1, 1).data;
      setTargetColor({ r: pixel[0] ?? 0, g: pixel[1] ?? 0, b: pixel[2] ?? 0 });
      setEyedropperMode(false);
    },
    [eyedropperMode],
  );

  const handleToleranceChange = useCallback((value: number[]) => {
    setTolerance(value[0] ?? DEFAULT_TOLERANCE);
  }, []);

  const handleFeatherChange = useCallback((value: number[]) => {
    setFeather(value[0] ?? DEFAULT_FEATHER);
  }, []);

  // 重置参数
  useEffect(() => {
    if (!open) return;
    setTargetColor({ r: 0, g: 255, b: 0 });
    setTolerance(DEFAULT_TOLERANCE);
    setFeather(DEFAULT_FEATHER);
    setEyedropperMode(false);
    setImageLoaded(false);
  }, [open]);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    try {
      await onConfirm({ targetColor, tolerance, feather });
      onOpenChange(false);
    } catch (error) {
      console.error('[ImageChromaKeyDialog] chroma key failed:', error);
    } finally {
      setLoading(false);
    }
  }, [onConfirm, onOpenChange, targetColor, tolerance, feather]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="色度抠图"
      description="用吸管选取要抠除的背景色，调整容差与羽化后生成透明背景图。"
      loading={loading}
      confirmLabel="确认"
      confirmLoadingLabel="处理中..."
      confirmDisabled={loading || !imageLoaded}
      onCancel={handleCancel}
      onConfirm={() => void handleConfirm()}
      stage={
        <canvas
          ref={canvasRef}
          className="block max-h-full max-w-full object-contain"
          style={{
            cursor: eyedropperMode ? 'crosshair' : 'default',
            imageRendering: 'auto',
          }}
          onClick={handleCanvasClick}
        />
      }
      stageToolbar={
        <div className="flex items-center gap-2">
          <Button
            variant={eyedropperMode ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setEyedropperMode(!eyedropperMode)}
            disabled={loading || !imageLoaded}
          >
            <IconColorPicker size={16} className="mr-1" />
            {eyedropperMode ? '点击图片取色...' : '吸管取色'}
          </Button>
        </div>
      }
      rail={
        <>
          <div className="rounded-md border p-3 space-y-3">
            <div className="flex items-center gap-3">
              <Label>目标颜色</Label>
              <div
                className="h-6 w-6 shrink-0 rounded border"
                style={{ backgroundColor: rgbToHex(targetColor) }}
              />
              <span className="text-xs text-muted-foreground tabular-nums">
                R:{targetColor.r} G:{targetColor.g} B:{targetColor.b}
              </span>
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label>容差</Label>
              <span className="text-sm text-muted-foreground tabular-nums">{tolerance}</span>
            </div>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[tolerance]}
              onValueChange={handleToleranceChange}
              disabled={loading}
            />
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label>羽化</Label>
              <span className="text-sm text-muted-foreground tabular-nums">{feather}</span>
            </div>
            <Slider
              min={0}
              max={20}
              step={1}
              value={[feather]}
              onValueChange={handleFeatherChange}
              disabled={loading}
            />
          </div>
        </>
      }
    />
  );
});

export default ImageChromaKeyDialog;

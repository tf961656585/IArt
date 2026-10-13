'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { IconPhotoUp } from '@tabler/icons-react';
import { importLocalFile } from '../../services/localMediaImport';
import { MediaStagePlaceholder, MediaToolDialogShell } from './MediaToolDialogShell';

interface ImageDifferenceKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 背景A(顶层 source),来自选中节点的图 */
  imageUrl: string;
  onConfirm: (params: {
    threshold: number;
    softness: number;
    secondSourceUrl: string;
    secondSourceAssetId: string;
  }) => Promise<void>;
}

const MAX_PREVIEW_DIMENSION = 800;
const DEFAULT_THRESHOLD = 24;
const DEFAULT_SOFTNESS = 18;

/**
 * 差异抠图预览:逐像素比较两图 RGB 欧氏距离。
 * 与后端 applyDifferenceKey 算法一致(差异大→背景 alpha=0,差异小→前景 alpha=255)。
 */
function computeDifferenceKeyPreview(
  imageDataA: ImageData,
  imageDataB: ImageData,
  threshold: number,
  softness: number,
): ImageData {
  const { data: dataA, width, height } = imageDataA;
  const dataB = imageDataB.data;
  const output = new ImageData(width, height);
  const maxDistance = Math.sqrt(3) * 255;
  const thresholdNormalized = (threshold / 100) * maxDistance;
  const softnessNormalized = softness * (maxDistance / 100);

  for (let i = 0; i < dataA.length; i += 4) {
    const ar = dataA[i] ?? 0;
    const ag = dataA[i + 1] ?? 0;
    const ab = dataA[i + 2] ?? 0;
    const br = dataB[i] ?? 0;
    const bg = dataB[i + 1] ?? 0;
    const bb = dataB[i + 2] ?? 0;
    const dr = ar - br;
    const dg = ag - bg;
    const db = ab - bb;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);

    let alpha: number;
    if (distance >= thresholdNormalized + softnessNormalized) {
      alpha = 0;
    } else if (softnessNormalized > 0 && distance <= thresholdNormalized) {
      alpha = 255;
    } else if (softnessNormalized > 0) {
      alpha = Math.round(255 * (1 - (distance - thresholdNormalized) / softnessNormalized));
    } else {
      alpha = distance >= thresholdNormalized ? 0 : 255;
    }

    output.data[i] = ar;
    output.data[i + 1] = ag;
    output.data[i + 2] = ab;
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

type LoadedImageSource = {
  /** 缩放后的原始像素(用于 diff 计算) */
  sourceCanvas: HTMLCanvasElement;
  width: number;
  height: number;
};

/**
 * 把一张图加载到离屏 canvas,缩放到最长边 MAX_PREVIEW_DIMENSION。
 * 返回缩放后的尺寸供对齐校验。
 */
function loadImageToSourceCanvas(
  url: string,
): Promise<LoadedImageSource | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let drawWidth = img.naturalWidth;
      let drawHeight = img.naturalHeight;
      if (Math.max(drawWidth, drawHeight) > MAX_PREVIEW_DIMENSION) {
        const scale = MAX_PREVIEW_DIMENSION / Math.max(drawWidth, drawHeight);
        drawWidth = Math.round(drawWidth * scale);
        drawHeight = Math.round(drawHeight * scale);
      }
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = drawWidth;
      srcCanvas.height = drawHeight;
      const srcCtx = srcCanvas.getContext('2d');
      if (srcCtx) {
        srcCtx.drawImage(img, 0, 0, drawWidth, drawHeight);
      }
      resolve({ sourceCanvas: srcCanvas, width: drawWidth, height: drawHeight });
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export const ImageDifferenceKeyDialog = memo(function ImageDifferenceKeyDialog({
  open,
  onOpenChange,
  imageUrl,
  onConfirm,
}: ImageDifferenceKeyDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceARef = useRef<LoadedImageSource | null>(null);
  const sourceBRef = useRef<LoadedImageSource | null>(null);

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [softness, setSoftness] = useState(DEFAULT_SOFTNESS);
  const [loading, setLoading] = useState(false);
  const [secondSourceUrl, setSecondSourceUrl] = useState<string>('');
  const [secondSourceAssetId, setSecondSourceAssetId] = useState<string>('');
  const [secondSourceLoaded, setSecondSourceLoaded] = useState(false);
  const [firstSourceLoaded, setFirstSourceLoaded] = useState(false);
  const [sizeMismatch, setSizeMismatch] = useState(false);
  const [selectingSecond, setSelectingSecond] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 加载背景A(选中节点的图)
  useEffect(() => {
    if (!open || !imageUrl) {
      setFirstSourceLoaded(false);
      return;
    }
    let cancelled = false;
    loadImageToSourceCanvas(imageUrl)
      .then((result) => {
        if (cancelled) return;
        sourceARef.current = result;
        setFirstSourceLoaded(result !== null);
      })
      .catch(() => {
        if (cancelled) return;
        setFirstSourceLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, imageUrl]);

  // 加载背景B(用户选择的第二图)
  useEffect(() => {
    if (!open || !secondSourceUrl) {
      setSecondSourceLoaded(false);
      return;
    }
    let cancelled = false;
    loadImageToSourceCanvas(secondSourceUrl)
      .then((result) => {
        if (cancelled) return;
        sourceBRef.current = result;
        setSecondSourceLoaded(result !== null);
      })
      .catch(() => {
        if (cancelled) return;
        setSecondSourceLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, secondSourceUrl]);

  // 尺寸对齐预检(两图缩放后尺寸必须一致;缩放比例相同即原尺寸也一致)
  useEffect(() => {
    if (!firstSourceLoaded || !secondSourceLoaded) {
      setSizeMismatch(false);
      return;
    }
    const a = sourceARef.current;
    const b = sourceBRef.current;
    if (!a || !b) {
      setSizeMismatch(false);
      return;
    }
    setSizeMismatch(a.width !== b.width || a.height !== b.height);
  }, [firstSourceLoaded, secondSourceLoaded]);

  // 参数或图变化时重新绘制预览
  useEffect(() => {
    const a = sourceARef.current;
    const b = sourceBRef.current;
    const canvas = canvasRef.current;
    if (!a || !b || !canvas || sizeMismatch) return;

    const aCtx = a.sourceCanvas.getContext('2d');
    const bCtx = b.sourceCanvas.getContext('2d');
    if (!aCtx || !bCtx) return;

    // 两图缩放后尺寸一致(已过 sizeMismatch 预检),直接对齐像素
    canvas.width = a.width;
    canvas.height = a.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dataA = aCtx.getImageData(0, 0, a.width, a.height);
    const dataB = bCtx.getImageData(0, 0, b.width, b.height);
    const previewData = computeDifferenceKeyPreview(dataA, dataB, threshold, softness);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawCheckerboard(ctx, canvas.width, canvas.height);
    ctx.putImageData(previewData, 0, 0);
  }, [firstSourceLoaded, secondSourceLoaded, threshold, softness, sizeMismatch]);

  // 重置参数
  useEffect(() => {
    if (!open) return;
    setThreshold(DEFAULT_THRESHOLD);
    setSoftness(DEFAULT_SOFTNESS);
    setSecondSourceUrl('');
    setSecondSourceAssetId('');
    setSecondSourceLoaded(false);
    setFirstSourceLoaded(false);
    setSizeMismatch(false);
  }, [open]);

  const handleSelectSecondFile = useCallback(() => {
    if (fileInputRef.current) {
      setSelectingSecond(true);
      fileInputRef.current.click();
    }
  }, []);

  const handleSecondFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files && event.target.files[0];
      // 重置 input value 以便重复选择同一文件
      event.target.value = '';
      setSelectingSecond(false);
      if (!file) return;
      try {
        const result = await importLocalFile(file);
        setSecondSourceUrl(result.persistentUrl);
        setSecondSourceAssetId(result.assetId);
      } catch (error) {
        console.error('[ImageDifferenceKeyDialog] failed to import second image:', error);
      }
    },
    [],
  );

  const handleThresholdChange = useCallback((value: number[]) => {
    setThreshold(value[0] ?? DEFAULT_THRESHOLD);
  }, []);

  const handleSoftnessChange = useCallback((value: number[]) => {
    setSoftness(value[0] ?? DEFAULT_SOFTNESS);
  }, []);

  const canConfirm =
    firstSourceLoaded && secondSourceLoaded && !sizeMismatch && !loading;

  const handleConfirm = useCallback(async () => {
    if (!secondSourceUrl || !secondSourceAssetId) return;
    setLoading(true);
    try {
      await onConfirm({
        threshold,
        softness,
        secondSourceUrl,
        secondSourceAssetId,
      });
      onOpenChange(false);
    } catch (error) {
      console.error('[ImageDifferenceKeyDialog] difference key failed:', error);
    } finally {
      setLoading(false);
    }
  }, [onConfirm, onOpenChange, threshold, softness, secondSourceUrl, secondSourceAssetId]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const sizeMismatchWarning = sizeMismatch ? (
    <div className="text-sm text-[var(--color-warning)]">
      两图尺寸不一致,无法精确抠图。请确保两张图是同一画幅、同一分辨率的对齐图。
    </div>
  ) : null;

  return (
    <MediaToolDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="差异抠图"
      description="选择同一角色、不同纯色背景的第二张图。两图角色像素级对齐(相同姿态、位置、缩放)时,可精确抠出透明背景 PNG。"
      loading={loading}
      confirmLabel="确认抠图"
      confirmLoadingLabel="处理中..."
      confirmDisabled={!canConfirm}
      onCancel={handleCancel}
      onConfirm={() => void handleConfirm()}
      notice={sizeMismatchWarning}
      stage={
        firstSourceLoaded || secondSourceLoaded ? (
          <canvas
            ref={canvasRef}
            className="block max-h-full max-w-full object-contain"
            style={{ imageRendering: 'auto' }}
          />
        ) : (
          <MediaStagePlaceholder state="empty" message="等待背景图加载" hint="选择背景图后开始抠图预览" />
        )
      }
      stageToolbar={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSelectSecondFile}
            disabled={loading || selectingSecond}
          >
            <IconPhotoUp size={16} className="mr-1" />
            {secondSourceLoaded ? '更换背景图' : '选择背景图'}
          </Button>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            onChange={handleSecondFileChange}
            tabIndex={-1}
          />
          {secondSourceLoaded && (
            <span className="text-sm text-muted-foreground">已选择</span>
          )}
        </div>
      }
      rail={
        <>
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label>差异门槛</Label>
              <span className="text-sm text-muted-foreground tabular-nums">{threshold}</span>
            </div>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[threshold]}
              onValueChange={handleThresholdChange}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              差异大于此值视为背景丢弃。值越小,保留的前景越多。
            </p>
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label>边缘羽化</Label>
              <span className="text-sm text-muted-foreground tabular-nums">{softness}</span>
            </div>
            <Slider
              min={0}
              max={50}
              step={1}
              value={[softness]}
              onValueChange={handleSoftnessChange}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              门槛附近的过渡宽度,羽化越大边缘越柔和。
            </p>
          </div>
        </>
      }
    />
  );
});

export default ImageDifferenceKeyDialog;

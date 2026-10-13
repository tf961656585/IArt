'use client';

import { memo, useCallback, useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { ResizeKernel } from '@iart/contracts/media-processing-contract';
import type { ImageMeta } from '../../types';

interface ImageResizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalMeta: ImageMeta | null;
  currentPercent: number;
  defaultKernel: ResizeKernel;
  onConfirm: (percent: number, kernel: ResizeKernel) => Promise<void>;
}

export const ImageResizeDialog = memo(function ImageResizeDialog({
  open,
  onOpenChange,
  originalMeta,
  currentPercent,
  defaultKernel,
  onConfirm,
}: ImageResizeDialogProps) {
  const [percent, setPercent] = useState(currentPercent);
  const [inputValue, setInputValue] = useState(String(currentPercent));
  const [kernel, setKernel] = useState<ResizeKernel>(defaultKernel);
  const [loading, setLoading] = useState(false);

  // 当弹窗打开时，重置为当前百分比
  useEffect(() => {
    if (open) {
      setPercent(currentPercent);
      setInputValue(String(currentPercent));
      setKernel(defaultKernel);
    }
  }, [open, currentPercent, defaultKernel]);

  const newWidth = originalMeta ? Math.round(originalMeta.width * percent / 100) : 0;
  const newHeight = originalMeta ? Math.round(originalMeta.height * percent / 100) : 0;

  const handleSliderChange = useCallback((value: number[]) => {
    const newPercent = value[0] ?? 100;
    setPercent(newPercent);
    setInputValue(String(newPercent));
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    const num = Number(value);
    if (Number.isFinite(num) && num >= 10 && num <= 100) {
      setPercent(Math.round(num));
    }
  }, []);

  const handleInputBlur = useCallback(() => {
    // 确保输入值在有效范围内
    let num = Number(inputValue);
    if (!Number.isFinite(num)) {
      num = currentPercent;
    }
    num = Math.max(10, Math.min(100, Math.round(num)));
    setPercent(num);
    setInputValue(String(num));
  }, [inputValue, currentPercent]);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    try {
      await onConfirm(percent, kernel);
      onOpenChange(false);
    } catch (error) {
      console.error('Resize failed:', error);
    } finally {
      setLoading(false);
    }
  }, [percent, kernel, onConfirm, onOpenChange]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  if (!originalMeta) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle>调整图片尺寸</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* 尺寸显示 */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">原始尺寸:</span>
              <span className="font-medium">
                {originalMeta.width} × {originalMeta.height}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">调整后:</span>
              <span className="font-medium text-primary">
                {newWidth} × {newHeight}
              </span>
            </div>
          </div>

          {/* 滑动条 */}
          <div className="space-y-3">
            <Label htmlFor="resize-slider">缩放比例</Label>
            <Slider
              id="resize-slider"
              min={10}
              max={100}
              step={1}
              value={[percent]}
              onValueChange={handleSliderChange}
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <Label>缩放方式</Label>
            <ToggleGroup
              type="single"
              value={kernel}
              onValueChange={(value) => {
                if (value === 'lanczos3' || value === 'nearest') {
                  setKernel(value);
                }
              }}
              disabled={loading}
              className="grid grid-cols-2"
            >
              <ToggleGroupItem value="lanczos3">平滑</ToggleGroupItem>
              <ToggleGroupItem value="nearest">像素</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* 精确输入 */}
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={10}
              max={100}
              value={inputValue}
              onChange={handleInputChange}
              onBlur={handleInputBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleInputBlur();
                }
              }}
              className="w-20 text-center"
              disabled={loading}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={loading}>
            {loading ? '处理中...' : '确认'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export default ImageResizeDialog;

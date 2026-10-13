'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ImageEdgeDetectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultThreshold: number | undefined;
  onConfirm: (threshold: number) => Promise<void>;
}

const clampThreshold = (value: number): number =>
  Math.max(0, Math.min(255, Math.round(value)));

export const ImageEdgeDetectDialog = memo(function ImageEdgeDetectDialog({
  open,
  onOpenChange,
  defaultThreshold = 128,
  onConfirm,
}: ImageEdgeDetectDialogProps) {
  const [threshold, setThreshold] = useState(() => clampThreshold(defaultThreshold));
  const [inputValue, setInputValue] = useState(String(clampThreshold(defaultThreshold)));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const initial = clampThreshold(defaultThreshold);
    setThreshold(initial);
    setInputValue(String(initial));
  }, [defaultThreshold, open]);

  const handleSliderChange = useCallback((value: number[]) => {
    const next = clampThreshold(value[0] ?? 0);
    setThreshold(next);
    setInputValue(String(next));
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    const num = Number(value);
    if (Number.isFinite(num)) {
      setThreshold(clampThreshold(num));
    }
  }, []);

  const handleInputBlur = useCallback(() => {
    const num = Number(inputValue);
    if (!Number.isFinite(num)) {
      setInputValue(String(threshold));
      return;
    }
    const next = clampThreshold(num);
    setThreshold(next);
    setInputValue(String(next));
  }, [inputValue, threshold]);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    try {
      await onConfirm(threshold);
      onOpenChange(false);
    } catch (error) {
      console.error('Edge detect failed:', error);
    } finally {
      setLoading(false);
    }
  }, [onConfirm, onOpenChange, threshold]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle>边缘效果</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            会生成一张边缘效果图，放到画布上。
          </p>

          <div className="space-y-3">
            <Label htmlFor="edge-threshold-slider">阈值</Label>
            <Slider
              id="edge-threshold-slider"
              min={0}
              max={255}
              step={1}
              value={[threshold]}
              onValueChange={handleSliderChange}
              disabled={loading}
            />
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={255}
              value={inputValue}
              onChange={handleInputChange}
              onBlur={handleInputBlur}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleInputBlur();
                }
              }}
              className="w-24 text-center"
              disabled={loading}
            />
            <span className="text-sm text-muted-foreground">(0 ~ 255)</span>
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

export default ImageEdgeDetectDialog;

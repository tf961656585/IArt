"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  toImageSplitPercent,
  type LineItem,
  type LineAxis,
  MAX_LINES_PER_AXIS,
} from "./imageSplitGeometry";

interface ImageSplitLineEditorProps {
  axis: LineAxis;
  lines: LineItem[];
  naturalSize: { width: number; height: number } | null;
  pixelMode: boolean;
  saving: boolean;
  loading: boolean;
  onAddLine: (axis: LineAxis) => void;
  onRemoveLine: (axis: LineAxis, lineId: string) => void;
  onUpdateLineValue: (axis: LineAxis, lineId: string, value: number) => void;
}

export const ImageSplitLineEditor = memo(function ImageSplitLineEditor({
  axis,
  lines,
  naturalSize,
  pixelMode,
  saving,
  loading,
  onAddLine,
  onRemoveLine,
  onUpdateLineValue,
}: ImageSplitLineEditorProps) {
  const axisLabel = axis === "vertical" ? "竖线" : "横线";
  const axisPx = axis === "vertical"
    ? (naturalSize !== null && naturalSize !== undefined ? naturalSize.width : undefined)
    : (naturalSize !== null && naturalSize !== undefined ? naturalSize.height : undefined);

  const sliderMin = pixelMode ? 1 : 0.1;
  const sliderMax = pixelMode && axisPx !== undefined ? Math.max(1, axisPx - 1) : 99.9;
  const sliderStep = pixelMode ? 1 : 0.1;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">{axisLabel}</Label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={saving || loading || lines.length >= MAX_LINES_PER_AXIS}
          onClick={() => onAddLine(axis)}
        >
          添加{axisLabel}
        </Button>
      </div>

      {lines.length === 0 ? (
        <div className="text-xs text-muted-foreground">未添加</div>
      ) : (
        <div className="space-y-2">
          {lines.map((line, idx) => {
            const displayValue = pixelMode && axisPx !== undefined
              ? Math.round(line.pos * axisPx)
              : toImageSplitPercent(line.pos);
            const sliderValue = pixelMode && axisPx !== undefined
              ? Math.round(line.pos * axisPx)
              : toImageSplitPercent(line.pos);

            return (
              <div
                key={line.id}
                className="flex items-center gap-2 rounded-md border bg-muted/10 px-2 py-2"
              >
                <div className="w-12 text-xs text-muted-foreground shrink-0">
                  {axisLabel}{idx + 1}
                </div>

                <div
                  className="flex-1 min-w-0"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Slider
                    value={[sliderValue]}
                    min={sliderMin}
                    max={sliderMax}
                    step={sliderStep}
                    disabled={saving || loading}
                    onValueChange={(values: number[]) => {
                      const v = values[0];
                      if (v !== undefined) {
                        onUpdateLineValue(axis, line.id, v);
                      }
                    }}
                  />
                </div>

                <Input
                  type="number"
                  value={String(displayValue)}
                  step={sliderStep}
                  min={sliderMin}
                  max={sliderMax}
                  onChange={(e) => {
                    const num = Number(e.target.value);
                    if (Number.isFinite(num)) onUpdateLineValue(axis, line.id, num);
                  }}
                  className="h-8 w-20 text-center text-xs shrink-0"
                  disabled={saving || loading}
                />

                <div className="text-xs text-muted-foreground w-8 shrink-0">{pixelMode ? "px" : "%"}</div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-destructive hover:text-destructive"
                  disabled={saving || loading}
                  onClick={() => onRemoveLine(axis, line.id)}
                >
                  ×
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

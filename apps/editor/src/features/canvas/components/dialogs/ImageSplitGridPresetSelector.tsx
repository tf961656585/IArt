"use client";

import { memo, useCallback } from "react";
import { Button } from "@/components/ui/button";

interface GridPresetSelectorProps {
  currentRows: number;
  currentCols: number;
  onSelect: (rows: number, cols: number) => void;
  onCustom: () => void;
  isCustom: boolean;
}

const PRESETS: Array<{ rows: number; cols: number; label: string }> = [
  { rows: 1, cols: 2, label: "1×2" },
  { rows: 2, cols: 1, label: "2×1" },
  { rows: 2, cols: 2, label: "2×2" },
  { rows: 3, cols: 3, label: "3×3" },
];

interface GridIconProps {
  rows: number;
  cols: number;
}

const GridIcon = memo(function GridIcon({ rows, cols }: GridIconProps) {
  return (
    <div
      className="grid gap-px"
      style={{
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        width: 20,
        height: 20,
      }}
    >
      {Array.from({ length: rows * cols }, (_, i) => (
        <div key={i} className="bg-primary/80 rounded-[1px]" />
      ))}
    </div>
  );
});

export const GridPresetSelector = memo(function GridPresetSelector({
  currentRows,
  currentCols,
  onSelect,
  onCustom,
  isCustom,
}: GridPresetSelectorProps) {
  const handleCustom = useCallback(() => {
    onCustom();
  }, [onCustom]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((preset) => {
        const isActive =
          !isCustom &&
          currentRows === preset.rows &&
          currentCols === preset.cols;
        return (
          <Button
            key={preset.label}
            type="button"
            variant={isActive ? "default" : "outline"}
            size="sm"
            className="gap-1.5 px-3"
            onClick={() => onSelect(preset.rows, preset.cols)}
          >
            <GridIcon rows={preset.rows} cols={preset.cols} />
            {preset.label}
          </Button>
        );
      })}
      <Button
        type="button"
        variant={isCustom ? "default" : "outline"}
        size="sm"
        className="gap-1.5 px-3"
        onClick={handleCustom}
      >
        自定义
      </Button>
    </div>
  );
});

export default GridPresetSelector;

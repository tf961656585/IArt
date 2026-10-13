"use client";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { ASPECT_RATIOS, type AspectRatioPreset } from "./imageCropGeometry";

interface ImageCropAspectRatioSelectorProps {
  current: AspectRatioPreset;
  onSelect: (preset: AspectRatioPreset) => void;
}

export const ImageCropAspectRatioSelector = memo(function ImageCropAspectRatioSelector({
  current,
  onSelect,
}: ImageCropAspectRatioSelectorProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ASPECT_RATIOS.map((entry) => (
        <Button
          key={entry.preset}
          type="button"
          variant={current === entry.preset ? "default" : "outline"}
          size="sm"
          className="px-3"
          onClick={() => onSelect(entry.preset)}
        >
          {entry.label}
        </Button>
      ))}
    </div>
  );
});

export default ImageCropAspectRatioSelector;

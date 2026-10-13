"use client";

import { memo, useMemo } from "react";
import type { LineItem } from "./imageSplitGeometry";
import { computeTileRects, sortByPos } from "./imageSplitGeometry";

interface ImageSplitTileOverlayProps {
  verticalLines: LineItem[];
  horizontalLines: LineItem[];
  naturalSize: { width: number; height: number };
}

export const ImageSplitTileOverlay = memo(function ImageSplitTileOverlay({
  verticalLines,
  horizontalLines,
  naturalSize,
}: ImageSplitTileOverlayProps) {
  const tileRects = useMemo(
    () => computeTileRects({ verticalLines, horizontalLines, naturalSize }),
    [verticalLines, horizontalLines, naturalSize],
  );

  const sortedV = useMemo(() => [...verticalLines].sort(sortByPos), [verticalLines]);
  const sortedH = useMemo(() => [...horizontalLines].sort(sortByPos), [horizontalLines]);

  const xStops = useMemo((): number[] => [0, ...sortedV.map((l) => l.pos), 1], [sortedV]);
  const yStops = useMemo((): number[] => [0, ...sortedH.map((l) => l.pos), 1], [sortedH]);

  const tileOverlays = useMemo(() => {
    const overlays: Array<{
      key: string;
      leftPercent: number;
      topPercent: number;
      widthPercent: number;
      heightPercent: number;
      label: string;
    }> = [];

    for (const tile of tileRects) {
      const rowIdx = tile.row - 1;
      const colIdx = tile.col - 1;
      const x0 = xStops[colIdx];
      const x1 = xStops[colIdx + 1];
      const y0 = yStops[rowIdx];
      const y1 = yStops[rowIdx + 1];
      if (
        x0 === undefined || x1 === undefined ||
        y0 === undefined || y1 === undefined
      ) {
        continue;
      }
      overlays.push({
        key: `tile-${tile.row}-${tile.col}`,
        leftPercent: x0 * 100,
        topPercent: y0 * 100,
        widthPercent: (x1 - x0) * 100,
        heightPercent: (y1 - y0) * 100,
        label: `${tile.width}×${tile.height}`,
      });
    }

    return overlays;
  }, [tileRects, xStops, yStops]);

  if (tileRects.length === 0) {
    return null;
  }

  return (
    <div className="absolute inset-0 pointer-events-none">
      {tileOverlays.map((overlay) => (
        <div
          key={overlay.key}
          className="absolute flex items-center justify-center"
          style={{
            left: `${overlay.leftPercent}%`,
            top: `${overlay.topPercent}%`,
            width: `${overlay.widthPercent}%`,
            height: `${overlay.heightPercent}%`,
          }}
        >
          <span className="bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded pointer-events-none whitespace-nowrap">
            {overlay.label}
          </span>
        </div>
      ))}
    </div>
  );
});

export default ImageSplitTileOverlay;

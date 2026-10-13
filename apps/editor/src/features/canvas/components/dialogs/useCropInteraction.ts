import { useCallback, useRef, useState } from "react";
import { clientPointToImageNorm, getImageContentFrameFromElement } from "../../utils/imageGeometry";
import { constrainToRatio, type AspectRatioPreset, getAspectRatioValue } from "./imageCropGeometry";

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type NormalizedPoint = { x: number; y: number };
export type NormalizedRect = { x: number; y: number; w: number; h: number };

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const normalizeRect = (a: NormalizedPoint, b: NormalizedPoint): NormalizedRect => {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  return {
    x: clamp01(left),
    y: clamp01(top),
    w: clamp01(right) - clamp01(left),
    h: clamp01(bottom) - clamp01(top),
  };
};

export const hasValidRect = (rect: NormalizedRect | null): rect is NormalizedRect => {
  return Boolean(rect && rect.w > 0.001 && rect.h > 0.001);
};

type PointerInfo = {
  point: NormalizedPoint;
  bounds: { width: number; height: number };
};

type InteractionState =
  | { type: "none" }
  | {
      type: "creating";
      pointerId: number;
      start: NormalizedPoint;
      startClient: { x: number; y: number };
      moved: boolean;
      previousSelection: NormalizedRect | null;
    }
  | {
      type: "moving";
      pointerId: number;
      startClient: { x: number; y: number };
      startSelection: NormalizedRect;
      offset: NormalizedPoint;
    }
  | {
      type: "resizing";
      pointerId: number;
      startClient: { x: number; y: number };
      startPoint: NormalizedPoint;
      startSelection: NormalizedRect;
      handle: ResizeHandle;
    };

interface UseCropInteractionParams {
  imageRef: React.RefObject<HTMLImageElement | null>;
  selection: NormalizedRect | null;
  setSelection: (s: NormalizedRect | null) => void;
  naturalSize: { width: number; height: number } | null;
  loading: boolean;
  saving: boolean;
  aspectRatio: AspectRatioPreset;
}

export function useCropInteraction(params: UseCropInteractionParams) {
  const { imageRef, selection, setSelection, naturalSize, loading, saving, aspectRatio } = params;
  const interactionRef = useRef<InteractionState>({ type: "none" });
  const [cursor, setCursor] = useState<"default" | "crosshair" | "move" | string>("crosshair");

  const getPointerInfo = useCallback((event: React.PointerEvent<HTMLElement>): PointerInfo | null => {
    const image = imageRef.current;
    if (!image) return null;
    const frame = getImageContentFrameFromElement(image);
    if (frame === null) return null;
    const point = clientPointToImageNorm(
      { x: event.clientX, y: event.clientY },
      frame,
    );
    if (point === null) {
      console.debug("[ImageCropDialog] ignore pointer outside image content", {
        clientX: event.clientX,
        clientY: event.clientY,
      });
      return null;
    }
    return {
      point,
      bounds: { width: frame.width, height: frame.height },
    };
  }, [imageRef]);

  const hitTestSelection = useCallback((info: PointerInfo, rect: NormalizedRect | null): { kind: "outside" | "inside" | "handle"; handle: ResizeHandle | undefined } => {
    if (!hasValidRect(rect)) return { kind: "outside", handle: undefined };
    const { point, bounds } = info;

    const left = rect.x;
    const right = rect.x + rect.w;
    const top = rect.y;
    const bottom = rect.y + rect.h;

    const slopX = clamp01(16 / bounds.width);
    const slopY = clamp01(16 / bounds.height);

    const nearLeft = Math.abs(point.x - left) <= slopX;
    const nearRight = Math.abs(point.x - right) <= slopX;
    const nearTop = Math.abs(point.y - top) <= slopY;
    const nearBottom = Math.abs(point.y - bottom) <= slopY;
    const withinX = point.x >= left - slopX && point.x <= right + slopX;
    const withinY = point.y >= top - slopY && point.y <= bottom + slopY;

    // Corners first
    if (nearLeft && nearTop) return { kind: "handle", handle: "nw" };
    if (nearRight && nearTop) return { kind: "handle", handle: "ne" };
    if (nearRight && nearBottom) return { kind: "handle", handle: "se" };
    if (nearLeft && nearBottom) return { kind: "handle", handle: "sw" };

    // Edges
    if (nearTop && withinX) return { kind: "handle", handle: "n" };
    if (nearRight && withinY) return { kind: "handle", handle: "e" };
    if (nearBottom && withinX) return { kind: "handle", handle: "s" };
    if (nearLeft && withinY) return { kind: "handle", handle: "w" };

    // Inside (excluding edge slop to avoid fighting with resize)
    const inside = point.x > left + slopX && point.x < right - slopX && point.y > top + slopY && point.y < bottom - slopY;
    return inside
      ? { kind: "inside", handle: undefined }
      : { kind: "outside", handle: undefined };
  }, []);

  const getCursorForHitTest = useCallback((hit: { kind: "outside" | "inside" | "handle"; handle: ResizeHandle | undefined }): string => {
    if (hit.kind === "inside") return "move";
    if (hit.kind !== "handle" || !hit.handle) return "crosshair";
    switch (hit.handle) {
      case "n":
      case "s":
        return "ns-resize";
      case "e":
      case "w":
        return "ew-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "nw":
      case "se":
        return "nwse-resize";
    }
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (loading || saving) return;
      if (event.button !== 0) return;

      const info = getPointerInfo(event);
      if (!info) return;

      const hit = hitTestSelection(info, selection);
      const pointerId = event.pointerId;

      if (hit.kind === "handle" && hit.handle && hasValidRect(selection)) {
        interactionRef.current = {
          type: "resizing",
          pointerId,
          startClient: { x: event.clientX, y: event.clientY },
          startPoint: info.point,
          startSelection: selection,
          handle: hit.handle,
        };
      } else if (hit.kind === "inside" && hasValidRect(selection)) {
        interactionRef.current = {
          type: "moving",
          pointerId,
          startClient: { x: event.clientX, y: event.clientY },
          startSelection: selection,
          offset: { x: info.point.x - selection.x, y: info.point.y - selection.y },
        };
      } else {
        // Outside selection: drag to create a new selection (do not clear existing until actual drag starts)
        interactionRef.current = {
          type: "creating",
          pointerId,
          start: info.point,
          startClient: { x: event.clientX, y: event.clientY },
          moved: false,
          previousSelection: selection,
        };
      }

      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      event.preventDefault();
    },
    [getPointerInfo, hitTestSelection, loading, saving, selection],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const info = getPointerInfo(event);
      if (!info) return;

      const interaction = interactionRef.current;
      if (interaction.type === "none") {
        if (loading || saving) {
          if (cursor !== "default") setCursor("default");
          return;
        }
        const nextCursor = getCursorForHitTest(hitTestSelection(info, selection));
        if (nextCursor !== cursor) setCursor(nextCursor);
        return;
      }

      if (interaction.pointerId !== event.pointerId) return;

      if (interaction.type === "creating") {
        const dx = event.clientX - interaction.startClient.x;
        const dy = event.clientY - interaction.startClient.y;
        const moved = interaction.moved || dx * dx + dy * dy > 4; // 2px threshold
        if (!moved) return;
        interaction.moved = true;
        let newSelection = normalizeRect(interaction.start, info.point);
        // 比例约束
        if (aspectRatio !== "free") {
          const ratio = getAspectRatioValue(aspectRatio);
          const imageRatio = naturalSize !== null ? naturalSize.width / naturalSize.height : 1;
          if (ratio !== null) {
            newSelection = constrainToRatio({
              selection: newSelection,
              anchor: interaction.start,
              ratio,
              imageRatio,
            });
          }
        }
        setSelection(newSelection);
        event.preventDefault();
        return;
      }

      if (interaction.type === "moving") {
        const start = interaction.startSelection;
        const nextX = clamp(info.point.x - interaction.offset.x, 0, 1 - start.w);
        const nextY = clamp(info.point.y - interaction.offset.y, 0, 1 - start.h);
        setSelection({ x: nextX, y: nextY, w: start.w, h: start.h });
        event.preventDefault();
        return;
      }

      if (interaction.type === "resizing") {
        const start = interaction.startSelection;
        const dx = info.point.x - interaction.startPoint.x;
        const dy = info.point.y - interaction.startPoint.y;

        const left0 = start.x;
        const right0 = start.x + start.w;
        const top0 = start.y;
        const bottom0 = start.y + start.h;

        const minSize = 0.001;

        let left = left0;
        let right = right0;
        let top = top0;
        let bottom = bottom0;

        const handle = interaction.handle;
        if (handle.includes("w")) {
          left = clamp(left0 + dx, 0, right - minSize);
        }
        if (handle.includes("e")) {
          right = clamp(right0 + dx, left + minSize, 1);
        }
        if (handle.includes("n")) {
          top = clamp(top0 + dy, 0, bottom - minSize);
        }
        if (handle.includes("s")) {
          bottom = clamp(bottom0 + dy, top + minSize, 1);
        }

        let result = { x: left, y: top, w: right - left, h: bottom - top };
        if (aspectRatio !== "free") {
          const ratio = getAspectRatioValue(aspectRatio);
          const imageRatio = naturalSize !== null ? naturalSize.width / naturalSize.height : 1;
          if (ratio !== null) {
            // 确定锚点：对角固定点
            const startSel = interaction.startSelection;
            let anchorX: number;
            let anchorY: number;
            if (handle.includes("w")) {
              anchorX = startSel.x + startSel.w;
            } else {
              anchorX = startSel.x;
            }
            if (handle.includes("n")) {
              anchorY = startSel.y + startSel.h;
            } else {
              anchorY = startSel.y;
            }
            result = constrainToRatio({
              selection: result,
              anchor: { x: anchorX, y: anchorY },
              ratio,
              imageRatio,
            });
          }
        }
        setSelection(result);
        event.preventDefault();
      }
    },
    [cursor, getCursorForHitTest, getPointerInfo, hitTestSelection, loading, saving, selection, aspectRatio, naturalSize, setSelection],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const info = getPointerInfo(event);
      const interaction = interactionRef.current;
      if (interaction.type === "none") return;
      if (interaction.pointerId !== event.pointerId) return;

      if (interaction.type === "creating") {
        if (interaction.moved && info) {
          const next = normalizeRect(interaction.start, info.point);
          if (hasValidRect(next)) {
            setSelection(next);
          } else {
            setSelection(interaction.previousSelection);
          }
        } else {
          // Click without drag: keep previous selection (if any)
          setSelection(interaction.previousSelection);
        }
      }

      interactionRef.current = { type: "none" };
      try {
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      event.preventDefault();
    },
    [getPointerInfo, setSelection],
  );

  const handlePointerCancel = useCallback(() => {
    const interaction = interactionRef.current;
    if (interaction.type === "creating") {
      setSelection(interaction.previousSelection);
    } else if (interaction.type === "moving" || interaction.type === "resizing") {
      setSelection(interaction.startSelection);
    }
    interactionRef.current = { type: "none" };
  }, [setSelection]);

  return {
    cursor,
    setCursor,
    interactionRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
}

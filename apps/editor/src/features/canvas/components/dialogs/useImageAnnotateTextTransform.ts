import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import {
  shortSideRatioToCssPx,
  type ImageContentFrame,
} from "../../utils/imageGeometry";
import {
  clamp,
  type AnnotationSnapshot,
  type Stroke,
  type TextBox,
  type TextTransformType,
} from "./imageAnnotateDialogTypes";

type TransformSession = {
  id: string;
  type: TextTransformType;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startItem: TextBox;
  frame: ImageContentFrame;
  startWidthPx: number;
  startAngleRad: number;
  startDistancePx: number;
  moved: boolean;
};

export function useImageAnnotateTextTransform(params: {
  open: boolean;
  loading: boolean;
  saving: boolean;
  editingTextId: string | null;
  getContentFrame: () => ImageContentFrame | null;
  textsRef: MutableRefObject<TextBox[]>;
  strokesRef: MutableRefObject<Stroke[]>;
  setTexts: Dispatch<SetStateAction<TextBox[]>>;
  setSelectedTextId: Dispatch<SetStateAction<string | null>>;
  pushSnapshot: (snapshot: AnnotationSnapshot) => void;
}) {
  const {
    open,
    loading,
    saving,
    editingTextId,
    getContentFrame,
    textsRef,
    strokesRef,
    setTexts,
    setSelectedTextId,
    pushSnapshot,
  } = params;
  const transformSessionRef = useRef<TransformSession | null>(null);

  const startTransform = useCallback(
    (event: ReactPointerEvent, id: string, type: TextTransformType) => {
      if (loading || saving) return;
      if (editingTextId) return;
      const frame = getContentFrame();
      if (frame === null) return;
      const item = textsRef.current.find((textBox) => textBox.id === id);
      if (!item) return;
      const centerX = frame.left + item.x * frame.width;
      const centerY = frame.top + item.y * frame.height;
      const startAngleRad = Math.atan2(
        event.clientY - centerY,
        event.clientX - centerX,
      );
      const startDistancePx =
        Math.hypot(event.clientX - centerX, event.clientY - centerY) || 1;
      transformSessionRef.current = {
        id,
        type,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startItem: item,
        frame,
        startWidthPx: item.widthRatio * frame.width,
        startAngleRad,
        startDistancePx,
        moved: false,
      };
      setSelectedTextId(id);
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        void 0;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [editingTextId, getContentFrame, loading, saving, setSelectedTextId, textsRef],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerMove = (event: PointerEvent) => {
      const session = transformSessionRef.current;
      if (!session) return;
      if (event.pointerId !== session.pointerId) return;
      const frame = session.frame;
      const centerX = frame.left + session.startItem.x * frame.width;
      const centerY = frame.top + session.startItem.y * frame.height;
      const dx = event.clientX - session.startClientX;
      const dy = event.clientY - session.startClientY;
      const distMoved = Math.hypot(dx, dy);
      if (!session.moved && distMoved > 2) {
        session.moved = true;
      }
      if (!session.moved) {
        event.preventDefault();
        return;
      }
      const currentItem = textsRef.current.find(
        (textBox) => textBox.id === session.id,
      );
      if (!currentItem) return;
      let next: TextBox | null = null;
      if (session.type === "move") {
        const nx = clamp(session.startItem.x + dx / frame.width, 0, 1);
        const ny = clamp(session.startItem.y + dy / frame.height, 0, 1);
        next = { ...currentItem, x: nx, y: ny };
      } else if (session.type === "rotate") {
        const angle = Math.atan2(
          event.clientY - centerY,
          event.clientX - centerX,
        );
        next = {
          ...currentItem,
          rotation: session.startItem.rotation + (angle - session.startAngleRad),
        };
      } else if (session.type === "scale") {
        const dist =
          Math.hypot(event.clientX - centerX, event.clientY - centerY) || 1;
        const scale = clamp(dist / session.startDistancePx, 0.2, 6);
        const nextWidthPx = session.startWidthPx * scale;
        const nextFontSizePx = clamp(
          shortSideRatioToCssPx(session.startItem.fontSizeRatio, frame) * scale,
          8,
          256,
        );
        next = {
          ...currentItem,
          widthRatio: clamp(nextWidthPx / frame.width, 0.05, 0.95),
          fontSizeRatio:
            nextFontSizePx / Math.max(1, Math.min(frame.width, frame.height)),
        };
      } else if (session.type === "resize-l" || session.type === "resize-r") {
        const cos = Math.cos(session.startItem.rotation);
        const sin = Math.sin(session.startItem.rotation);
        const localDx = dx * cos + dy * sin;
        const deltaWidth = localDx * 2 * (session.type === "resize-r" ? 1 : -1);
        const minWidthPx = Math.max(
          20,
          shortSideRatioToCssPx(session.startItem.fontSizeRatio, frame) * 1.2,
        );
        const widthPx = clamp(
          session.startWidthPx + deltaWidth,
          minWidthPx,
          frame.width * 0.95,
        );
        next = { ...currentItem, widthRatio: widthPx / frame.width };
      }
      if (!next) return;
      const nextTexts = textsRef.current.map((textBox) => {
        return textBox.id === next.id ? next : textBox;
      });
      textsRef.current = nextTexts;
      setTexts(nextTexts);
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      const session = transformSessionRef.current;
      if (!session) return;
      if (event.pointerId !== session.pointerId) return;
      transformSessionRef.current = null;
      if (!session.moved) return;
      pushSnapshot({ strokes: strokesRef.current, texts: textsRef.current });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [open, pushSnapshot, setTexts, strokesRef, textsRef]);

  return startTransform;
}

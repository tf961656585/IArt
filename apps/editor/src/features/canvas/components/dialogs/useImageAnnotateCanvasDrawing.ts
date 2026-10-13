import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  clientPointToImageNorm,
  cssPxToShortSideRatio,
  shortSideRatioToCssPx,
  type ImageContentFrame,
} from "../../utils/imageGeometry";
import {
  clamp,
  createId,
  type AnnotationSnapshot,
  type Stroke,
  type TextBox,
} from "./imageAnnotateDialogTypes";

type CommitEditing = (options: {
  reason: "shortcut" | "blur" | "confirm" | undefined;
  force: boolean | undefined;
} | undefined) => void;

export function useImageAnnotateCanvasDrawing(params: {
  open: boolean;
  activeTool: "brush" | "text";
  brushColor: string;
  brushSize: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  commitEditing: CommitEditing;
  getContentFrame: () => ImageContentFrame | null;
  loading: boolean;
  pushSnapshot: (snapshot: AnnotationSnapshot) => void;
  saving: boolean;
  selectedTextId: string | null;
  setSelectedTextId: Dispatch<SetStateAction<string | null>>;
  startEditingText: (id: string, options: { isNew: boolean | undefined } | undefined) => void;
  strokesRef: MutableRefObject<Stroke[]>;
  syncCanvasSize: () => void;
  textFontSize: number;
  textsRef: MutableRefObject<TextBox[]>;
}) {
  const {
    open,
    activeTool,
    brushColor,
    brushSize,
    canvasRef,
    commitEditing,
    getContentFrame,
    loading,
    pushSnapshot,
    saving,
    selectedTextId,
    setSelectedTextId,
    startEditingText,
    strokesRef,
    syncCanvasSize,
    textFontSize,
    textsRef,
  } = params;
  const currentStrokeRef = useRef<Stroke | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const strokeFrameRef = useRef<ImageContentFrame | null>(null);

  useEffect(() => {
    if (open) return;
    currentStrokeRef.current = null;
    lastPointRef.current = null;
    strokeFrameRef.current = null;
  }, [open]);

  const getCanvasPoint = useCallback(
    (
      event: PointerEvent<HTMLCanvasElement>,
      frame: ImageContentFrame | null,
    ) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      if (frame === null) return null;
      const norm = clientPointToImageNorm(
        { x: event.clientX, y: event.clientY },
        frame,
      );
      if (norm === null) {
        console.debug("[ImageAnnotateDialog] ignore pointer outside image content", {
          clientX: event.clientX,
          clientY: event.clientY,
        });
        return null;
      }
      return {
        css: {
          x: norm.x * frame.width,
          y: norm.y * frame.height,
        },
        norm,
        frame,
      };
    },
    [canvasRef],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (loading || saving) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (event.button !== 0) return;
      syncCanvasSize();
      const frame = getContentFrame();
      const point = getCanvasPoint(event, frame);
      if (!point) return;
      if (activeTool === "text") {
        commitEditing({ reason: "blur", force: undefined });
        const id = createId();
        const nextItem: TextBox = {
          id,
          x: clamp(point.norm.x, 0, 1),
          y: clamp(point.norm.y, 0, 1),
          widthRatio: clamp(0.4, 0.05, 0.95),
          rotation: 0,
          fontSizeRatio: clamp(
            cssPxToShortSideRatio(textFontSize, point.frame),
            cssPxToShortSideRatio(8, point.frame),
            cssPxToShortSideRatio(256, point.frame),
          ),
          color: brushColor,
          text: "",
        };
        const nextTexts = [...textsRef.current, nextItem];
        pushSnapshot({ strokes: strokesRef.current, texts: nextTexts });
        setSelectedTextId(id);
        startEditingText(id, { isNew: true });
        event.preventDefault();
        return;
      }
      if (selectedTextId) setSelectedTextId(null);
      strokeFrameRef.current = point.frame;
      currentStrokeRef.current = {
        color: brushColor,
        widthRatio: cssPxToShortSideRatio(brushSize, point.frame),
        points: [point.norm],
      };
      lastPointRef.current = point.css;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.strokeStyle = brushColor;
        ctx.lineWidth = brushSize;
        ctx.beginPath();
        ctx.moveTo(point.css.x, point.css.y);
        ctx.lineTo(point.css.x, point.css.y);
        ctx.stroke();
      }
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [
      activeTool,
      brushColor,
      brushSize,
      canvasRef,
      commitEditing,
      getCanvasPoint,
      loading,
      pushSnapshot,
      saving,
      selectedTextId,
      setSelectedTextId,
      startEditingText,
      strokesRef,
      syncCanvasSize,
      textFontSize,
      textsRef,
      getContentFrame,
    ],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (loading || saving) return;
      const canvas = canvasRef.current;
      const stroke = currentStrokeRef.current;
      if (!canvas || !stroke) return;
      const point = getCanvasPoint(event, strokeFrameRef.current);
      if (!point) return;
      stroke.points.push(point.norm);
      const ctx = canvas.getContext("2d");
      const last = lastPointRef.current;
      if (ctx && last) {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = shortSideRatioToCssPx(stroke.widthRatio, point.frame);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(point.css.x, point.css.y);
        ctx.stroke();
      }
      lastPointRef.current = point.css;
      event.preventDefault();
    },
    [canvasRef, getCanvasPoint, loading, saving],
  );

  const finalizeStroke = useCallback(() => {
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    lastPointRef.current = null;
    strokeFrameRef.current = null;
    if (!stroke) return;
    if (stroke.points.length < 1) return;
    const nextStrokes = [...strokesRef.current, stroke];
    pushSnapshot({ strokes: nextStrokes, texts: textsRef.current });
  }, [pushSnapshot, strokesRef, textsRef]);

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (saving) return;
      try {
        const canvas = canvasRef.current;
        if (canvas) canvas.releasePointerCapture(event.pointerId);
      } catch {
        void 0;
      }
      finalizeStroke();
      event.preventDefault();
    },
    [canvasRef, finalizeStroke, saving],
  );

  const handlePointerCancel = useCallback(() => {
    finalizeStroke();
  }, [finalizeStroke]);

  return {
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}

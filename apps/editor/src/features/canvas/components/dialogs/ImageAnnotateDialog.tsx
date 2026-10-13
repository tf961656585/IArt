"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ensureLocalFilesImageUrl } from "../../utils/mediaUtils";
import {
  getImageContentFrameFromElement,
  type ImageContentFrame,
} from "../../utils/imageGeometry";
import { ImageAnnotateDialogBody } from "./ImageAnnotateDialogBody";
import { exportAnnotatedImageBlob } from "./imageAnnotateExport";
import { renderImageAnnotationToCanvas } from "./imageAnnotationRenderer";
import {
  DEFAULT_BRUSH_COLOR,
  DEFAULT_BRUSH_SIZE_PX,
  DEFAULT_TEXT_FONT_SIZE_PX,
  TEXT_FONT_SIZE_STORAGE_KEY,
  clamp,
  isEditableTarget,
  type AnnotationSnapshot,
  type ImageAnnotateDialogProps,
  type Stroke,
  type TextBox,
} from "./imageAnnotateDialogTypes";
import { useImageAnnotateCanvasDrawing } from "./useImageAnnotateCanvasDrawing";
import { useImageAnnotateTextTransform } from "./useImageAnnotateTextTransform";
import { labelResizeObserverCallback } from "@/client/utils/resizeObserverDebugLabel";
export const ImageAnnotateDialog = memo(function ImageAnnotateDialog({
  open,
  onOpenChange,
  imageUrl,
  onConfirm,
}: ImageAnnotateDialogProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const textsRef = useRef<TextBox[]>([]);
  const historyRef = useRef<AnnotationSnapshot[]>([{ strokes: [], texts: [] }]);
  const contentFrameRef = useRef<ImageContentFrame | null>(null);
  const editSessionRef = useRef<null | {
    id: string;
    isNew: boolean;
    originalText: string;
  }>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [brushColor, setBrushColor] = useState(DEFAULT_BRUSH_COLOR);
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE_PX);
  const [strokeCount, setStrokeCount] = useState(0);
  const [activeTool, setActiveTool] = useState<"brush" | "text">("brush");
  const [textFontSize, setTextFontSize] = useState(DEFAULT_TEXT_FONT_SIZE_PX);
  const [contentFrameInStage, setContentFrameInStage] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [texts, setTexts] = useState<TextBox[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const selectedText = useMemo(() => {
    if (!selectedTextId) return null;
    return textsRef.current.find((t) => t.id === selectedTextId) ?? null;
  }, [selectedTextId]);
  const effectiveTextCount = useMemo(() => {
    return textsRef.current.reduce((count, t) => {
      const value =
        t.id === editingTextId ? (editingValue ?? "") : (t.text ?? "");
      return value.trim() ? count + 1 : count;
    }, 0);
  }, [editingTextId, editingValue]);
  const canConfirm = useMemo(() => {
    return (
      !loading &&
      !saving &&
      Boolean(localUrl) &&
      (strokeCount > 0 || effectiveTextCount > 0)
    );
  }, [loading, saving, localUrl, strokeCount, effectiveTextCount]);
  const clearOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);
  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    const stage = stageRef.current;
    if (!canvas || !img || !stage) return null;
    const frame = getImageContentFrameFromElement(img);
    const stageRect = stage.getBoundingClientRect();
    if (frame === null || !stageRect.width || !stageRect.height) {
      return null;
    }
    contentFrameRef.current = frame;
    const nextFrameInStage = {
      left: frame.left - stageRect.left,
      top: frame.top - stageRect.top,
      width: frame.width,
      height: frame.height,
    };
    setContentFrameInStage((prev) => {
      if (
        prev !== null &&
        prev.left === nextFrameInStage.left &&
        prev.top === nextFrameInStage.top &&
        prev.width === nextFrameInStage.width &&
        prev.height === nextFrameInStage.height
      ) {
        return prev;
      }
      return nextFrameInStage;
    });
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.round(frame.width * dpr);
    const nextH = Math.round(frame.height * dpr);
    if (canvas.width !== nextW) canvas.width = nextW;
    if (canvas.height !== nextH) canvas.height = nextH;
    canvas.style.left = `${nextFrameInStage.left}px`;
    canvas.style.top = `${nextFrameInStage.top}px`;
    canvas.style.width = `${frame.width}px`;
    canvas.style.height = `${frame.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return frame;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    return frame;
  }, []);
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const frame = syncCanvasSize();
    if (frame === null) return;
    ctx.clearRect(0, 0, frame.width, frame.height);
    renderImageAnnotationToCanvas({
      ctx,
      targetWidth: frame.width,
      targetHeight: frame.height,
      strokes: strokesRef.current,
      texts: textsRef.current,
      editingTextId,
      editingValue,
    });
  }, [editingTextId, editingValue, syncCanvasSize]);
  const applySnapshot = useCallback(
    (snapshot: AnnotationSnapshot) => {
      strokesRef.current = snapshot.strokes;
      textsRef.current = snapshot.texts;
      setStrokeCount(snapshot.strokes.length);
      setTexts(snapshot.texts);
      redraw();
    },
    [redraw],
  );
  const pushSnapshot = useCallback(
    (snapshot: AnnotationSnapshot) => {
      historyRef.current.push(snapshot);
      applySnapshot(snapshot);
    },
    [applySnapshot],
  );
  const replaceLastSnapshot = useCallback(
    (snapshot: AnnotationSnapshot) => {
      historyRef.current[historyRef.current.length - 1] = snapshot;
      applySnapshot(snapshot);
    },
    [applySnapshot],
  );
  const resetDrawingState = useCallback(() => {
    strokesRef.current = [];
    setStrokeCount(0);
    textsRef.current = [];
    setTexts([]);
    contentFrameRef.current = null;
    setContentFrameInStage(null);
    setSelectedTextId(null);
    setEditingTextId(null);
    setEditingValue("");
    editSessionRef.current = null;
    historyRef.current = [{ strokes: [], texts: [] }];
    setActiveTool("brush");
    setExportError(null);
    clearOverlay();
  }, [clearOverlay]);
  useEffect(() => {
    if (!open) {
      setLocalUrl(null);
      setLoadError(null);
      setLoading(false);
      setSaving(false);
      setExportError(null);
      resetDrawingState();
      return;
    }
    resetDrawingState();
  }, [open, resetDrawingState]);
  useEffect(() => {
    let alive = true;
    if (!open || !imageUrl) return;
    setLoading(true);
    setLoadError(null);
    setExportError(null);
    setLocalUrl(null);
    void (async () => {
      try {
        const local = await ensureLocalFilesImageUrl(imageUrl);
        if (alive) setLocalUrl(local);
      } catch (error) {
        console.warn(
          "[ImageAnnotateDialog] ensureLocalFilesImageUrl failed",
          error,
        );
        if (alive) {
          setLocalUrl(imageUrl);
          setLoadError("这张图片来自外部链接，无法保存到本地，导出可能失败。");
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, imageUrl]);
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(
      labelResizeObserverCallback(() => {
        syncCanvasSize();
        redraw();
      }, "ImageAnnotateDialog.stage"),
    );
    ro.observe(stage);
    return () => ro.disconnect();
  }, [open, redraw, syncCanvasSize]);
  useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem(TEXT_FONT_SIZE_STORAGE_KEY);
      if (!raw) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      setTextFontSize(clamp(Math.round(n), 8, 256));
    } catch {
      void 0;
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    try {
      localStorage.setItem(TEXT_FONT_SIZE_STORAGE_KEY, String(textFontSize));
    } catch {
      void 0;
    }
  }, [open, textFontSize]);
  const startEditingText = useCallback(
    (id: string, options: { isNew: boolean | undefined } | undefined) => {
      const item = textsRef.current.find((t) => t.id === id);
      if (!item) return;
      const isNew = Boolean((options !== null && options !== undefined ? options.isNew : undefined));
      editSessionRef.current = { id, isNew, originalText: item.text };
      setEditingTextId(id);
      setEditingValue(item.text);
    },
    [],
  );
  const cancelNewTextByUndoIfPossible = useCallback(
    (id: string) => {
      if (historyRef.current.length <= 1) return false;
      const current = historyRef.current[historyRef.current.length - 1];
      const prev = historyRef.current[historyRef.current.length - 2];
      if (!current || !prev) return false;
      const prevHas = prev.texts.some((t) => t.id === id);
      const currHas = current.texts.some((t) => t.id === id);
      if (prevHas || !currHas) return false;
      if (current.strokes.length !== prev.strokes.length) return false;
      historyRef.current.pop();
      applySnapshot(prev);
      return true;
    },
    [applySnapshot],
  );
  const commitEditing = useCallback(
    (options: {
      reason: "shortcut" | "blur" | "confirm" | undefined;
      force: boolean | undefined;
    } | undefined) => {
      const id = editingTextId;
      if (!id) return;
      const session = editSessionRef.current;
      const nextText = editingValue;
      const shouldForce = Boolean((options !== null && options !== undefined ? options.force : undefined));
      const existingText = textsRef.current.find((t) => t.id === id);
      const isSameAsCurrent =
        (existingText !== null && existingText !== undefined ? existingText.text : "") === nextText;
      if (!shouldForce && isSameAsCurrent && (options !== null && options !== undefined ? options.reason : undefined) !== "confirm") {
        setEditingTextId(null);
        setEditingValue("");
        editSessionRef.current = null;
        return;
      }
      const normalized = nextText.replace(/\r\n/g, "\n");
      const isEmpty = normalized.trim().length === 0;
      const currentTexts = textsRef.current;
      const target = currentTexts.find((t) => t.id === id);
      if (!target) {
        setEditingTextId(null);
        setEditingValue("");
        editSessionRef.current = null;
        return;
      }
      if (isEmpty) {
        if ((session !== null && session !== undefined ? session.isNew : undefined)) {
          const undone = cancelNewTextByUndoIfPossible(id);
          if (!undone) {
            const nextTexts = currentTexts.filter((t) => t.id !== id);
            pushSnapshot({ strokes: strokesRef.current, texts: nextTexts });
          }
          setSelectedTextId(null);
        } else {
          const nextTexts = currentTexts.filter((t) => t.id !== id);
          pushSnapshot({ strokes: strokesRef.current, texts: nextTexts });
          setSelectedTextId(null);
        }
        setEditingTextId(null);
        setEditingValue("");
        editSessionRef.current = null;
        return;
      }
      const updated: TextBox = { ...target, text: normalized };
      const nextTexts = currentTexts.map((t) => (t.id === id ? updated : t));
      if ((session !== null && session !== undefined ? session.isNew : undefined)) {
        replaceLastSnapshot({ strokes: strokesRef.current, texts: nextTexts });
      } else {
        pushSnapshot({ strokes: strokesRef.current, texts: nextTexts });
      }
      setEditingTextId(null);
      setEditingValue("");
      editSessionRef.current = null;
    },
    [
      cancelNewTextByUndoIfPossible,
      editingTextId,
      editingValue,
      pushSnapshot,
      replaceLastSnapshot,
    ],
  );
  const deleteSelectedText = useCallback(() => {
    if (saving) return;
    if (!selectedTextId) return;
    if (editingTextId) return;
    const nextTexts = textsRef.current.filter((t) => t.id !== selectedTextId);
    if (nextTexts.length === textsRef.current.length) return;
    setSelectedTextId(null);
    pushSnapshot({ strokes: strokesRef.current, texts: nextTexts });
  }, [editingTextId, pushSnapshot, saving, selectedTextId]);
  const updateSelectedTextStyle = useCallback(
    (patch: Partial<Pick<TextBox, "color" | "fontSizeRatio">>) => {
      if (saving) return;
      if (!selectedTextId) return;
      if (editingTextId) return;
      const current = textsRef.current.find((t) => t.id === selectedTextId);
      if (!current) return;
      const updated: TextBox = { ...current, ...patch };
      const nextTexts = textsRef.current.map((t) =>
        t.id === selectedTextId ? updated : t,
      );
      pushSnapshot({ strokes: strokesRef.current, texts: nextTexts });
    },
    [editingTextId, pushSnapshot, saving, selectedTextId],
  );
  const startTransform = useImageAnnotateTextTransform({
    open,
    loading,
    saving,
    editingTextId,
    getContentFrame: () => contentFrameRef.current,
    textsRef,
    strokesRef,
    setTexts,
    setSelectedTextId,
    pushSnapshot,
  });
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (saving) return;
      if (!selectedTextId) return;
      if (editingTextId) return;
      if (isEditableTarget(event.target)) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedText();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelectedText, editingTextId, open, saving, selectedTextId]);
  const {
    handlePointerCancel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  } = useImageAnnotateCanvasDrawing({
    open,
    activeTool,
    brushColor,
    brushSize,
    canvasRef,
    commitEditing,
    getContentFrame: () => contentFrameRef.current,
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
  });
  const handleUndo = useCallback(() => {
    if (saving) return;
    if (historyRef.current.length <= 1) return;
    if (editingTextId) {
      setEditingTextId(null);
      setEditingValue("");
      editSessionRef.current = null;
    }
    historyRef.current.pop();
    const snapshot = historyRef.current[historyRef.current.length - 1];
    if (snapshot) applySnapshot(snapshot);
  }, [applySnapshot, editingTextId, saving]);
  const handleClear = useCallback(() => {
    if (saving) return;
    if (strokeCount === 0 && effectiveTextCount === 0) return;
    if (editingTextId) {
      setEditingTextId(null);
      setEditingValue("");
      editSessionRef.current = null;
    }
    setSelectedTextId(null);
    pushSnapshot({ strokes: [], texts: [] });
  }, [editingTextId, effectiveTextCount, pushSnapshot, saving, strokeCount]);
  const handleConfirm = useCallback(async () => {
    const img = imageRef.current;
    if (!img) return;
    if (strokesRef.current.length === 0 && effectiveTextCount === 0) return;
    setSaving(true);
    setExportError(null);
    try {
      const blob = await exportAnnotatedImageBlob({
        image: img,
        strokes: strokesRef.current,
        texts: textsRef.current,
        editingTextId,
        editingValue,
      });
      await onConfirm(blob);
      onOpenChange(false);
    } catch (error) {
      console.error("[ImageAnnotateDialog] export failed", error);
      setExportError(error instanceof Error ? error.message : "导出失败");
    } finally {
      setSaving(false);
    }
  }, [
    editingTextId,
    editingValue,
    effectiveTextCount,
    onConfirm,
    onOpenChange,
  ]);
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {" "}
      <DialogContent form="canvas" fill className="p-0 gap-0">
        <DialogHeader className="shrink-0 px-6 pt-5 pb-3">
          {" "}
          <DialogTitle className="pr-8">画笔标注</DialogTitle>{" "}
        </DialogHeader>{" "}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 py-4">
        <ImageAnnotateDialogBody
          activeTool={activeTool}
          brushColor={brushColor}
          brushSize={brushSize}
          canvasRef={canvasRef}
          commitEditing={commitEditing}
          deleteSelectedText={deleteSelectedText}
          editingTextId={editingTextId}
          editingValue={editingValue}
          effectiveTextCount={effectiveTextCount}
          exportError={exportError}
          handleCanvasPointerCancel={handlePointerCancel}
          handleCanvasPointerDown={handlePointerDown}
          handleCanvasPointerMove={handlePointerMove}
          handleCanvasPointerUp={handlePointerUp}
          handleClear={handleClear}
          handleUndo={handleUndo}
          historyCanUndo={historyRef.current.length > 1}
          imageRef={imageRef}
          stageRef={stageRef}
          loadError={loadError}
          loading={loading}
          localUrl={localUrl}
          pushSnapshot={pushSnapshot}
          redraw={redraw}
          saving={saving}
          selectedText={selectedText}
          selectedTextId={selectedTextId}
          setActiveTool={setActiveTool}
          setBrushColor={setBrushColor}
          setBrushSize={setBrushSize}
          setEditingTextId={setEditingTextId}
          setEditingValue={setEditingValue}
          setSelectedTextId={setSelectedTextId}
          setTextFontSize={setTextFontSize}
          startEditingText={startEditingText}
          startTransform={startTransform}
          strokeCount={strokeCount}
          strokesRef={strokesRef}
          syncCanvasSize={syncCanvasSize}
          textFontSize={textFontSize}
          texts={texts}
          textsRef={textsRef}
          updateSelectedTextStyle={updateSelectedTextStyle}
          contentFrameInStage={contentFrameInStage}
          cancelNewTextByUndoIfPossible={cancelNewTextByUndoIfPossible}
          editSessionRef={editSessionRef}
        />
        </div>
        <DialogFooter className="gap-2 shrink-0 px-6 pb-5 sm:gap-0">
          {" "}
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {" "}
            取消{" "}
          </Button>
          <Button type="button" disabled={!canConfirm} onClick={handleConfirm}>
            {" "}
            {saving ? "生成中..." : "确认"}{" "}
          </Button>{" "}
        </DialogFooter>
      </DialogContent>{" "}
    </Dialog>
  );
});
export default ImageAnnotateDialog;

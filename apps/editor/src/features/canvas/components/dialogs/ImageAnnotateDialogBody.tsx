import Image from "next/image";
import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { useOverlayLayer } from "@iart/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MediaStageFitBox } from "./MediaToolDialogShell";
import { measureTextBoxInImageSpace } from "./imageAnnotationRenderer";
import {
  clamp,
  type AnnotationSnapshot,
  type Stroke,
  type TextBox,
  type TextTransformType,
} from "./imageAnnotateDialogTypes";

type CommitEditing = (options: {
  reason: "shortcut" | "blur" | "confirm" | undefined;
  force: boolean | undefined;
} | undefined) => void;

export function ImageAnnotateDialogBody(props: {
  activeTool: "brush" | "text";
  brushColor: string;
  brushSize: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  commitEditing: CommitEditing;
  deleteSelectedText: () => void;
  editingTextId: string | null;
  editingValue: string;
  effectiveTextCount: number;
  exportError: string | null;
  handleCanvasPointerCancel: () => void;
  handleCanvasPointerDown: (event: PointerEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerMove: (event: PointerEvent<HTMLCanvasElement>) => void;
  handleCanvasPointerUp: (event: PointerEvent<HTMLCanvasElement>) => void;
  handleClear: () => void;
  handleUndo: () => void;
  historyCanUndo: boolean;
  imageRef: RefObject<HTMLImageElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  loadError: string | null;
  loading: boolean;
  localUrl: string | null;
  pushSnapshot: (snapshot: AnnotationSnapshot) => void;
  redraw: () => void;
  saving: boolean;
  selectedText: TextBox | null;
  selectedTextId: string | null;
  setActiveTool: Dispatch<SetStateAction<"brush" | "text">>;
  setBrushColor: Dispatch<SetStateAction<string>>;
  setBrushSize: Dispatch<SetStateAction<number>>;
  setEditingTextId: Dispatch<SetStateAction<string | null>>;
  setEditingValue: Dispatch<SetStateAction<string>>;
  setSelectedTextId: Dispatch<SetStateAction<string | null>>;
  setTextFontSize: Dispatch<SetStateAction<number>>;
  startEditingText: (id: string, options: { isNew: boolean | undefined } | undefined) => void;
  startTransform: (
    event: PointerEvent,
    id: string,
    type: TextTransformType,
  ) => void;
  strokeCount: number;
  strokesRef: MutableRefObject<Stroke[]>;
  syncCanvasSize: () => void;
  textFontSize: number;
  texts: TextBox[];
  textsRef: MutableRefObject<TextBox[]>;
  updateSelectedTextStyle: (
    patch: Partial<Pick<TextBox, "color" | "fontSizeRatio">>,
  ) => void;
  contentFrameInStage: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  cancelNewTextByUndoIfPossible: (id: string) => boolean;
  editSessionRef: MutableRefObject<{
    id: string;
    isNew: boolean;
    originalText: string;
  } | null>;
}) {
  const {
    activeTool,
    brushColor,
    brushSize,
    canvasRef,
    commitEditing,
    deleteSelectedText,
    editingTextId,
    editingValue,
    effectiveTextCount,
    exportError,
    handleCanvasPointerCancel,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
    handleClear,
    handleUndo,
    historyCanUndo,
    imageRef,
    stageRef,
    loadError,
    loading,
    localUrl,
    pushSnapshot,
    redraw,
    saving,
    selectedText,
    selectedTextId,
    setActiveTool,
    setBrushColor,
    setBrushSize,
    setEditingTextId,
    setEditingValue,
    setSelectedTextId,
    setTextFontSize,
    startEditingText,
    startTransform,
    strokeCount,
    strokesRef,
    syncCanvasSize,
    textFontSize,
    texts,
    textsRef,
    updateSelectedTextStyle,
    contentFrameInStage,
    cancelNewTextByUndoIfPossible,
    editSessionRef,
  } = props;
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  /**
   * Esc 退出文本编辑会话（spec docs/editor/浮层堆栈管理.md 核心规则 6）：编辑态是独立浮层，
   * 先退编辑态、再按才退宿主弹窗（Dialog 层）。动作与原先 textarea 的 Esc 分支逐字一致：
   * 新建会话（isNew）先尝试按撤销取消新建，无法撤销时直接丢弃该文本框；
   * 已有文本会话只退出编辑，不提交（提交走 Ctrl/Cmd+Enter 或失焦）。
   *
   * 入参用 `editingTextId`（prop）而非渲染项 id：编辑中的 textarea 只在
   * `editingTextId === textBox.id` 时渲染，二者恒等。
   */
  const cancelTextEditSession = useCallback(() => {
    const session = editSessionRef.current;
    const editingId = editingTextId;
    if (editingId === null) return;
    if (session !== null && session !== undefined ? session.isNew : undefined) {
      const undone = cancelNewTextByUndoIfPossible(editingId);
      if (!undone) {
        const nextTexts = textsRef.current.filter((item) => item.id !== editingId);
        setSelectedTextId(null);
        pushSnapshot({ strokes: strokesRef.current, texts: nextTexts });
      } else {
        setSelectedTextId(null);
      }
      setEditingTextId(null);
      setEditingValue("");
      editSessionRef.current = null;
      return;
    }
    setEditingTextId(null);
    setEditingValue("");
    editSessionRef.current = null;
  }, [
    cancelNewTextByUndoIfPossible,
    editingTextId,
    pushSnapshot,
    setEditingTextId,
    setEditingValue,
    setSelectedTextId,
    textsRef,
    strokesRef,
    editSessionRef,
  ]);

  useOverlayLayer({
    active: editingTextId !== null,
    id: "image-annotate-text-edit",
    onClose: cancelTextEditSession,
  });
  const basis = contentFrameInStage
    ? Math.min(contentFrameInStage.width, contentFrameInStage.height) || 1
    : 1;
  const displayedTextFontSize = selectedText
    ? Math.round(clamp(selectedText.fontSizeRatio * basis, 8, 256))
    : textFontSize;
  const textMetricsById = texts.reduce<
    Record<
      string,
      {
        widthPx: number;
        heightPx: number;
      }
    >
  >((acc, textBox) => {
    if (contentFrameInStage === null || typeof document === "undefined") {
      return acc;
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return acc;
    }
    const measured = measureTextBoxInImageSpace({
      ctx,
      targetWidth: contentFrameInStage.width,
      targetHeight: contentFrameInStage.height,
      textBox,
      editingTextId,
      editingValue,
    });
    acc[textBox.id] = {
      widthPx: measured.boxWidthPx,
      heightPx: measured.heightPx,
    };
    return acc;
  }, {});

  return (
    <>
      {/* 舞台工具条：颜色/粗细/字号 + 工具动作（spec stageToolbar 槽位） */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="annotate-color">颜色</Label>
          <Input
            id="annotate-color"
            type="color"
            value={brushColor}
            disabled={loading || saving}
            onChange={(event) => {
              const color = event.target.value;
              setBrushColor(color);
              if (selectedTextId) updateSelectedTextStyle({ color });
            }}
            className="h-9 w-12 p-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="annotate-size">粗细</Label>
          <Input
            id="annotate-size"
            type="number"
            min={1}
            max={48}
            value={brushSize}
            disabled={loading || saving}
            onChange={(event) => {
              const n = Number(event.target.value);
              if (!Number.isFinite(n)) return;
              setBrushSize(Math.max(1, Math.min(48, Math.round(n))));
            }}
            className="h-9 w-20"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="annotate-text-size">字号</Label>
          <Input
            id="annotate-text-size"
            type="number"
            min={8}
            max={256}
            value={displayedTextFontSize}
            disabled={loading || saving}
            onChange={(event) => {
              const n = Number(event.target.value);
              if (!Number.isFinite(n)) return;
              const next = clamp(Math.round(n), 8, 256);
              setTextFontSize(next);
              if (selectedTextId && contentFrameInStage) {
                updateSelectedTextStyle({ fontSizeRatio: next / basis });
              }
            }}
            className="h-9 w-20"
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant={activeTool === "text" ? "default" : "outline"}
            size="sm"
            disabled={saving}
            onClick={() =>
              setActiveTool(activeTool === "text" ? "brush" : "text")
            }
          >
            输入文本
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || !selectedTextId}
            onClick={deleteSelectedText}
          >
            删除文本
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || !historyCanUndo}
            onClick={handleUndo}
          >
            撤销
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving || (strokeCount === 0 && effectiveTextCount === 0)}
            onClick={handleClear}
          >
            清空
          </Button>
        </div>
      </div>
      {loadError ? (
        <div className="shrink-0 text-sm text-[var(--color-warning)]">{loadError}</div>
      ) : null}
      {exportError ? (
        <div className="shrink-0 text-sm text-destructive">{exportError}</div>
      ) : null}
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
        <div className="min-h-0 min-w-0 flex-1 rounded-md border bg-muted/20 p-2">
          {localUrl ? (
            <MediaStageFitBox
              naturalWidth={naturalSize?.width}
              naturalHeight={naturalSize?.height}
              boxRef={stageRef}
              className="select-none"
            >
              <Image
                ref={imageRef}
                src={localUrl}
                alt="图片标注"
                width={1}
                height={1}
                unoptimized
                crossOrigin="anonymous"
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                onLoad={() => {
                  const img = imageRef.current;
                  if (img) {
                    const w = img.naturalWidth;
                    const h = img.naturalHeight;
                    if (w && h) {
                      setNaturalSize((prev) =>
                        prev !== null && prev.width === w && prev.height === h
                          ? prev
                          : { width: w, height: h },
                      );
                    }
                  }
                  syncCanvasSize();
                  redraw();
                }}
                className="block h-full w-full object-contain"
              />
              <canvas
                ref={canvasRef}
                className="absolute touch-none"
                style={{
                  cursor:
                    loading || saving
                      ? "default"
                      : activeTool === "text"
                        ? "text"
                        : "crosshair",
                }}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerCancel}
              />
              {contentFrameInStage ? (
                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: `${contentFrameInStage.left}px`,
                    top: `${contentFrameInStage.top}px`,
                    width: `${contentFrameInStage.width}px`,
                    height: `${contentFrameInStage.height}px`,
                  }}
                >
                  {texts.map((textBox) => {
                    const fontSizePx = clamp(
                      textBox.fontSizeRatio * basis,
                      8,
                      256,
                    );
                    const metrics = textMetricsById[textBox.id];
                    const boxHeightPx =
                      metrics !== undefined ? metrics.heightPx : fontSizePx * 1.2;
                    const boxWidthPx =
                      metrics !== undefined
                        ? metrics.widthPx
                        : clamp(
                            textBox.widthRatio * contentFrameInStage.width,
                            1,
                            contentFrameInStage.width,
                          );
                  const isSelected = selectedTextId === textBox.id;
                  const isEditing = editingTextId === textBox.id;
                  const displayText = isEditing ? editingValue : textBox.text;
                    if (!displayText.trim() && !isEditing) return null;
                    return (
                      <div
                        key={textBox.id}
                        className="pointer-events-auto absolute"
                        style={{
                          left: `${textBox.x * 100}%`,
                          top: `${textBox.y * 100}%`,
                          width: `${boxWidthPx}px`,
                          minHeight: `${boxHeightPx}px`,
                          transform: `translate(-50%, -50%) rotate(${textBox.rotation}rad)`,
                          transformOrigin: "center",
                          color: textBox.color,
                          fontSize: `${fontSizePx}px`,
                          lineHeight: 1.2,
                          userSelect: "none",
                          cursor:
                            saving || isEditing ? "text" : "move",
                          outline:
                            isSelected && !isEditing
                              ? "1px solid rgba(59,130,246,0.9)"
                              : "none",
                          outlineOffset: "2px",
                        }}
                        onPointerDown={(event) =>
                          startTransform(event, textBox.id, "move")
                        }
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (saving) return;
                          setActiveTool("text");
                          setSelectedTextId(textBox.id);
                          startEditingText(textBox.id, { isNew: false });
                        }}
                      >
                        {isEditing ? (
                          <textarea
                            value={editingValue}
                            onChange={(event) =>
                              setEditingValue(event.target.value)
                            }
                            onBlur={() =>
                              commitEditing({
                                reason: "blur",
                                force: undefined,
                              })
                            }
                            onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              (event.ctrlKey || event.metaKey)
                            ) {
                              if (event.nativeEvent.isComposing) return;
                              event.preventDefault();
                              commitEditing({
                                reason: "shortcut",
                                force: undefined,
                              });
                            }
                            }}
                            className="w-full resize-none rounded-sm bg-transparent p-1 text-inherit outline-none"
                            style={{
                              border: "1px dashed rgba(59,130,246,0.9)",
                              font: "inherit",
                              lineHeight: "inherit",
                              color: "inherit",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              minHeight: `${boxHeightPx}px`,
                            }}
                          />
                        ) : null}
                        {isSelected && !isEditing && !saving ? (
                          <TextTransformHandles
                            textId={textBox.id}
                            startTransform={startTransform}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </MediaStageFitBox>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              {loading ? "加载图片中..." : "还没有可标注的图片"}
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        画笔：鼠标左键拖动绘制；文本：点击“输入文本”后在图片上放置，Enter
        换行，Ctrl+Enter 完成编辑。完成后点击“确认”，会生成一张新的图片节点。
      </div>
    </>
  );
}

function TextTransformHandles(props: {
  textId: string;
  startTransform: (
    event: PointerEvent,
    id: string,
    type: TextTransformType,
  ) => void;
}) {
  const { textId, startTransform } = props;
  return (
    <>
      <div
        className="absolute -top-8 left-1/2 h-4 w-4 -translate-x-1/2 rounded-full border bg-white shadow"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => startTransform(event, textId, "rotate")}
      />
      <div
        className="absolute -left-2 -top-2 h-3 w-3 rounded-sm border bg-white shadow"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => startTransform(event, textId, "scale")}
      />
      <div
        className="absolute -right-2 -top-2 h-3 w-3 rounded-sm border bg-white shadow"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => startTransform(event, textId, "scale")}
      />
      <div
        className="absolute -left-2 -bottom-2 h-3 w-3 rounded-sm border bg-white shadow"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => startTransform(event, textId, "scale")}
      />
      <div
        className="absolute -right-2 -bottom-2 h-3 w-3 rounded-sm border bg-white shadow"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => startTransform(event, textId, "scale")}
      />
      <div
        className="absolute -left-3 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border bg-white shadow"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => startTransform(event, textId, "resize-l")}
      />
      <div
        className="absolute -right-3 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border bg-white shadow"
        style={{ touchAction: "none" }}
        onPointerDown={(event) => startTransform(event, textId, "resize-r")}
      />
    </>
  );
}

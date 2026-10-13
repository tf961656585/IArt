import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ImagePlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TooltipButton } from "@/components/ui/tooltip-button";
import { FileImageProcessDialog } from "./file-upload/FileImageProcessDialog";
import {
  FilePreviewDialog,
  useFilePreview,
} from "./file-upload/FilePreviewDialog";
import { FileUploadPreviewList } from "./file-upload/FileUploadPreviewList";
import { applyCannyEdgeDetection, clamp } from "./file-upload/imageProcessing";
import type {
  FileUploadProps,
  UploadFileItem,
  ValidationMessage,
} from "./file-upload/fileUploadTypes";
import type { FileUploadTranslationOptions } from "./file-upload/fileUploadLogic";
import {
  appendWithinLimit,
  buildNotice,
  buildProcessedReplacement,
  buildUploadItems,
  buildValidationMessage,
  cloneItems,
  isImagePreviewItem,
  releaseAll,
  releaseObjectUrl,
  releaseRange,
  shallowEqualItems,
} from "./file-upload/fileUploadLogic";

export type {
  FileUploadProps,
  UploadFileItem,
} from "./file-upload/fileUploadTypes";
export {
  FilePreviewDialog,
  useFilePreview,
} from "./file-upload/FilePreviewDialog";

export const FileUpload: React.FC<FileUploadProps> = ({
  value,
  onFilesChange,
  accept,
  multiple,
  maxSizeMB,
  maxDimension,
  imageResizeMode = "none",
  imageConstraints,
  showHints = true,
  maxFiles,
  compactPreview,
  previewMode = "default",
  previewLayout = "card",
  onLimitExceeded,
}) => {
  const { t } = useTranslation("components");
  const translateUpload = useCallback(
    (key: string, options: FileUploadTranslationOptions) => t(key, options),
    [t],
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const controlled = Array.isArray(value);
  const [items, setItems] = useState<UploadFileItem[]>(() =>
    controlled ? cloneItems(value) : [],
  );
  const itemsRef = useRef<UploadFileItem[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [thresholds, setThresholds] = useState<[number, number]>([50, 150]);
  const [processedSrc, setProcessedSrc] = useState("");
  const [processingImage, setProcessingImage] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] =
    useState<ValidationMessage | null>(null);

  const editingItem =
    editingIndex !== null ? (items[editingIndex] ?? null) : null;
  const normalizedMaxSizeMB =
    typeof maxSizeMB === "number" && Number.isFinite(maxSizeMB) && maxSizeMB > 0
      ? maxSizeMB
      : undefined;
  const maxSizeBytes = normalizedMaxSizeMB
    ? normalizedMaxSizeMB * 1024 * 1024
    : undefined;
  const normalizedMaxFiles =
    Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : 1;
  const maxImageDimension =
    typeof maxDimension === "number" &&
    Number.isFinite(maxDimension) &&
    maxDimension > 0
      ? Math.floor(maxDimension)
      : undefined;
  const shouldAutoResize =
    imageResizeMode === "fit" &&
    typeof maxImageDimension === "number" &&
    maxImageDimension > 0;
  const allowMultiple =
    typeof multiple === "boolean" ? multiple : normalizedMaxFiles > 1;

  const normalizedCompactPreview = useMemo(() => {
    const defaults = {
      enabled: false,
      activateAtCount: 10,
      maxHeightPx: 420,
      cardWidthPx: 88,
      imageHeightPx: 64,
    };
    if (!compactPreview) return defaults;
    if (compactPreview === true) return { ...defaults, enabled: true };
    return {
      enabled: compactPreview.enabled !== false,
      activateAtCount: Number.isFinite(compactPreview.activateAtCount)
        ? Math.max(1, Math.round(compactPreview.activateAtCount as number))
        : defaults.activateAtCount,
      maxHeightPx: Number.isFinite(compactPreview.maxHeightPx)
        ? Math.max(120, Math.round(compactPreview.maxHeightPx as number))
        : defaults.maxHeightPx,
      cardWidthPx: Number.isFinite(compactPreview.cardWidthPx)
        ? Math.max(56, Math.round(compactPreview.cardWidthPx as number))
        : defaults.cardWidthPx,
      imageHeightPx: Number.isFinite(compactPreview.imageHeightPx)
        ? Math.max(40, Math.round(compactPreview.imageHeightPx as number))
        : defaults.imageHeightPx,
    };
  }, [compactPreview]);

  const compactPreviewActive =
    normalizedCompactPreview.enabled &&
    items.length >= normalizedCompactPreview.activateAtCount;
  const inspectorGridActive = previewLayout === "inspectorGrid";
  const previewContainerClassName = inspectorGridActive
    ? `mt-2 ${items.length >= 4 ? "max-h-60 overflow-y-auto overflow-x-hidden pr-1" : ""}`
    : compactPreviewActive
      ? "mt-2 overflow-y-auto overflow-x-hidden pr-1"
      : "mt-2";
  const previewContainerStyle: React.CSSProperties | undefined =
    !inspectorGridActive && compactPreviewActive
      ? { maxHeight: `${normalizedCompactPreview.maxHeightPx}px` }
      : undefined;
  const previewCardStyle: React.CSSProperties | undefined = compactPreviewActive
    ? { width: `${normalizedCompactPreview.cardWidthPx}px` }
    : undefined;
  const previewImageStyle: React.CSSProperties | undefined =
    compactPreviewActive
      ? { height: `${normalizedCompactPreview.imageHeightPx}px` }
      : undefined;
  const summaryText = showHints
    ? t("fileUpload.summary", {
        count: normalizedMaxFiles,
        reorderHint: allowMultiple ? t("fileUpload.reorderHint") : "",
        acceptHint: accept ? t("fileUpload.acceptHint", { accept }) : "",
      })
    : "";
  const dimensionHint =
    showHints &&
    shouldAutoResize &&
    (accept ?? "").toLowerCase().includes("image")
      ? t("fileUpload.dimensionHint", { max: maxImageDimension })
      : "";
  const getPreviewTitle = useCallback(
    (item: UploadFileItem) =>
      (item.file !== null && item.file !== undefined ? item.file.name : undefined) ?? item.id ?? t("fileUpload.preview", "预览"),
    [t],
  );
  const {
    previewItem,
    previewTitle,
    previewSrc,
    isVideoPreview,
    openPreview,
    closePreview,
  } = useFilePreview({ getTitle: getPreviewTitle });

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(
    () => () => {
      if (!controlled) releaseAll(itemsRef.current);
    },
    [controlled],
  );
  useEffect(() => {
    if (!controlled) return;
    const next = cloneItems(value);
    setItems((prev) => (shallowEqualItems(prev, next) ? prev : next));
  }, [controlled, value]);

  const applyItemsUpdate = useCallback(
    (updater: (prev: UploadFileItem[]) => UploadFileItem[]) => {
      let nextItems: UploadFileItem[] | null = null;
      let changed = false;
      setItems((prev) => {
        const resolved = updater(prev);
        nextItems = resolved;
        changed = resolved !== prev;
        return resolved;
      });
      if (changed && nextItems) onFilesChange(nextItems);
      return nextItems ?? itemsRef.current;
    },
    [onFilesChange],
  );

  useEffect(() => {
    if (items.length <= normalizedMaxFiles) return;
    applyItemsUpdate((prev) => {
      if (prev.length <= normalizedMaxFiles) return prev;
      releaseRange(prev, normalizedMaxFiles);
      return prev.slice(0, normalizedMaxFiles);
    });
    if (onLimitExceeded !== null && onLimitExceeded !== undefined) {
      onLimitExceeded(normalizedMaxFiles);
    }
  }, [applyItemsUpdate, items.length, normalizedMaxFiles, onLimitExceeded]);

  const handleFiles = async (list: FileList | File[] | null) => {
    const files = list ? (Array.isArray(list) ? list : Array.from(list)) : [];
    if (files.length === 0) return;
    const result = await buildUploadItems(files, {
      maxSizeBytes,
      maxImageDimension,
      shouldAutoResize,
      imageConstraints,
    });
    if (result.items.length === 0) {
      if (result.skippedBySize || result.skippedByError)
        setValidationMessage({
          type: "error",
          text: buildValidationMessage(
            result,
            normalizedMaxSizeMB,
            translateUpload,
          ),
        });
      return;
    }
    if (!allowMultiple) {
      releaseAll(items);
      if (result.items.length > normalizedMaxFiles) {
        releaseRange(result.items, normalizedMaxFiles);
        if (onLimitExceeded !== null && onLimitExceeded !== undefined) {
          onLimitExceeded(normalizedMaxFiles);
        }
      }
      applyItemsUpdate(() => result.items.slice(0, normalizedMaxFiles));
      return;
    }
    applyItemsUpdate((prev) =>
      appendWithinLimit(
        prev,
        result.items,
        normalizedMaxFiles,
        onLimitExceeded ?? (() => undefined),
      ),
    );
    setValidationMessage(
      buildNotice(
        result,
        normalizedMaxSizeMB,
        maxImageDimension,
        translateUpload,
      ),
    );
  };

  const removeAt = (index: number) => {
    applyItemsUpdate((prev) => {
      releaseObjectUrl(prev[index]);
      return prev.slice(0, index).concat(prev.slice(index + 1));
    });
  };

  const move = (fromIndex: number, toIndex: number) => {
    applyItemsUpdate((prev) => {
      if (
        fromIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex < 0 ||
        toIndex >= prev.length
      )
        return prev;
      const next = prev.slice();
      const [removed] = next.splice(fromIndex, 1);
      if (!removed) return prev;
      next.splice(toIndex, 0, removed);
      return next;
    });
  };

  useEffect(() => {
    const current = editingIndex !== null ? items[editingIndex] : null;
    if (editingIndex !== null && (!current || !isImagePreviewItem(current)))
      handleCloseEditor();
  });

  const handleOpenEditor = (index: number) => {
    const target = items[index];
    if (!target || !isImagePreviewItem(target)) return;
    setEditingIndex(index);
    setThresholds([50, 150]);
    setProcessedSrc("");
    setProcessError(null);
    setProcessingImage(false);
  };

  const handleCloseEditor = useCallback(() => {
    setEditingIndex(null);
    setProcessedSrc("");
    setProcessError(null);
    setProcessingImage(false);
  }, []);

  const handleRunProcessing = useCallback(async () => {
    if (editingIndex === null) return;
    const target = items[editingIndex];
    const src = ((target !== null && target !== undefined ? target.src : undefined) ?? "").trim();
    if (!target || !src) {
      setProcessError(t("fileUpload.processMissingSource"));
      return;
    }
    const normalizedLow = clamp(Math.min(thresholds[0], thresholds[1]), 0, 254);
    const normalizedHigh = clamp(
      Math.max(thresholds[0], thresholds[1]),
      normalizedLow + 1,
      255,
    );
    if (normalizedLow !== thresholds[0] || normalizedHigh !== thresholds[1])
      setThresholds([normalizedLow, normalizedHigh]);
    setProcessingImage(true);
    setProcessError(null);
    try {
      setProcessedSrc(
        await applyCannyEdgeDetection(src, normalizedLow, normalizedHigh),
      );
    } catch {
      setProcessError(t("fileUpload.processError"));
    } finally {
      setProcessingImage(false);
    }
  }, [editingIndex, items, thresholds, t]);

  const handleApplyProcessed = useCallback(async () => {
    if (editingIndex === null || !processedSrc) return;
    const target = items[editingIndex];
    if (!target) {
      setProcessError(t("fileUpload.processApplyError"));
      return;
    }
    try {
      const nextItem = await buildProcessedReplacement(
        target,
        processedSrc,
        shouldAutoResize,
        maxImageDimension,
        imageConstraints,
      );
      applyItemsUpdate((prev) => {
        if (!prev[editingIndex]) return prev;
        const next = prev.slice();
        releaseObjectUrl(next[editingIndex]);
        next[editingIndex] = nextItem;
        return next;
      });
      handleCloseEditor();
    } catch (error) {
      setProcessError(
        error instanceof Error
          ? error.message
          : t("fileUpload.processApplyError"),
      );
    }
  }, [
    applyItemsUpdate,
    editingIndex,
    handleCloseEditor,
    imageConstraints,
    items,
    maxImageDimension,
    processedSrc,
    shouldAutoResize,
    t,
  ]);

  useEffect(() => {
    if (!previewItem) return;
    const stillExists = items.some(
      (item) => item === previewItem || (item.id && item.id === previewItem.id),
    );
    if (!stillExists) closePreview();
  }, [closePreview, items, previewItem]);

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={allowMultiple}
        className="hidden"
        onChange={(event) => {
          void handleFiles(
            event.target.files ? Array.from(event.target.files) : [],
          );
          event.currentTarget.value = "";
        }}
      />
      <div className="flex items-center gap-2">
        <TooltipButton
          tooltip={t("fileUpload.select")}
          type="button"
          onClick={() => inputRef.current !== null && inputRef.current !== undefined ? inputRef.current.click() : undefined}
          variant={inspectorGridActive ? "outline" : "default"}
          size="icon-lg"
          aria-label={t("fileUpload.select")}
          className={
            inspectorGridActive
              ? "rounded-md border-dashed text-muted-foreground shadow-none hover:text-foreground"
              : "rounded-xl bg-gradient-to-tr from-indigo-500 to-violet-500 text-white shadow-[0_10px_24px_rgba(99,102,241,0.35)] transition-transform hover:from-indigo-600 hover:to-violet-600 hover:-translate-y-px"
          }
        >
          <ImagePlus className="size-5" />
        </TooltipButton>
        {showHints ? (
          <span className="text-xs text-muted-foreground">{summaryText}</span>
        ) : null}
      </div>
      {dimensionHint ? (
        <p className="text-[11px] text-muted-foreground">{dimensionHint}</p>
      ) : null}
      {validationMessage ? (
        <p
          className={`text-xs ${validationMessage.type === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {validationMessage.text}
        </p>
      ) : null}
      {items.length > 0 && previewMode !== "hidden" ? (
        <FileUploadPreviewList
          items={items}
          allowMultiple={allowMultiple}
          compactPreviewActive={compactPreviewActive}
          previewLayout={previewLayout}
          previewContainerClassName={previewContainerClassName}
          previewContainerStyle={previewContainerStyle}
          previewCardStyle={previewCardStyle}
          previewImageStyle={previewImageStyle}
          isImagePreview={isImagePreviewItem}
          fallbackName={t("fileUpload.fallbackName")}
          labels={{
            moveLeft: t("fileUpload.moveLeft"),
            moveRight: t("fileUpload.moveRight"),
            process: t("fileUpload.process"),
            preview: t("fileUpload.preview"),
            remove: t("fileUpload.remove"),
          }}
          onMove={move}
          onOpenEditor={handleOpenEditor}
          onPreview={openPreview}
          onRemove={removeAt}
        />
      ) : null}
      <FilePreviewDialog
        open={Boolean(previewItem)}
        onOpenChange={(open) => !open && closePreview()}
        title={previewTitle}
        src={previewSrc}
        isVideo={isVideoPreview}
        emptyText={t("fileUpload.previewUnavailable", "这个文件暂时无法预览")}
        closeText={t("fileUpload.closePreview", "关闭预览")}
      />
      <FileImageProcessDialog
        open={Boolean(editingItem && editingIndex !== null)}
        item={editingItem}
        thresholds={thresholds}
        processedSrc={processedSrc}
        processingImage={processingImage}
        processError={processError}
        labels={{
          title: t("fileUpload.processTitle"),
          original: t("fileUpload.processOriginal"),
          result: t("fileUpload.processResult"),
          missingSource: t("fileUpload.processMissingSource"),
          running: t("fileUpload.processRunning"),
          hint: t("fileUpload.processHint"),
          threshold: t("fileUpload.processThreshold"),
          thresholdValue: t("fileUpload.processThresholdValue", {
            low: thresholds[0],
            high: thresholds[1],
          }),
          cancel: t("fileUpload.processCancel"),
          run: t("fileUpload.processRun"),
          apply: t("fileUpload.processApply"),
        }}
        onOpenChange={(open) => !open && handleCloseEditor()}
        onThresholdsChange={setThresholds}
        onRun={() => {
          void handleRunProcessing();
        }}
        onApply={() => {
          void handleApplyProcessed();
        }}
      />
    </div>
  );
};

export default FileUpload;

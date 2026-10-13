"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent } from "react"; import { type NodeProps } from "@xyflow/react";
import { IconDownload, IconMaximize, IconPhoto, IconUpload, IconX, IconFolder } from "@tabler/icons-react"; import { toast } from "sonner";
import { Button } from "@/components/ui/button"; import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ZoomableImagePreview } from "@/components/ui/zoomable-image-preview";
import { getRuntimeProjectPath } from "@/client/store/runtimeStore";
import { ContentNodeCard } from "./ContentNodeCard"; import { DEFAULT_IMAGE_ASPECT_RATIO, ImageNodeSurface } from "./shared/ImageNodeSurface";
import { TaskStatusBadge } from "./shared/TaskStatusBadge";
import { downloadMedia } from "@/client/utils/download"; import { useCanvasStore } from "../../store/canvasStore";
import { useExecutionStore } from "../../store/executionStore";
import { ContentCacheManager } from "../../services/contentCacheManager"; import { importLocalFile } from "../../services/localMediaImport";
import { edgeDetectImage } from "@/client/api/imageEdgeDetect"; import { chromaKeyImage } from "@/client/api/imageChromaKey"; import { differenceKeyImage } from "@/client/api/imageDifferenceKey";
import { cropImage } from "@/client/api/imageCrop"; import { resizeImage } from "@/client/api/imageResize"; import { splitImage } from "@/client/api/imageSplit";
import { createDerivedImageInputNode, createDerivedImageInputNodesGrid } from "../../utils/imageDerivation";
import { ensureBackendConsumableImageSource } from "../../utils/mediaUtils"; import { normalizeLocalFileUrlWithQuery } from "../../utils/mediaUrl";
import { classifyMediaUrl } from "@/features/models/shared/mediaResolutionTypes";
import { formatBytesCompact, getMediaSizeBytes } from "../../utils/mediaSize";
import { resolveMediaPresentation } from "../../services/mediaPresentation";
import { ImageNodeToolbar } from "./ImageNodeToolbar"; import { ImageResizeDialog } from "../dialogs/ImageResizeDialog";
import { ImageCropDialog, type ImageCropRect } from "../dialogs/ImageCropDialog"; import { ImageSplitDialog, type ImageSplitDialogPayload } from "../dialogs/ImageSplitDialog";
import { ImageAnnotateDialog } from "../dialogs/ImageAnnotateDialog"; import { ImageEdgeDetectDialog } from "../dialogs/ImageEdgeDetectDialog";
import { ImageChromaKeyDialog } from "../dialogs/ImageChromaKeyDialog"; import { ImageDifferenceKeyDialog } from "../dialogs/ImageDifferenceKeyDialog"; import { ImageOutpaintDialog } from "../dialogs/ImageOutpaintDialog"; import { listRuntimeProjectedImageToImageModels } from "@/client/config/runtimeModelSelection";
import type {ImageInputNodeData,ImageMeta,
} from "../../types"; import { getTaskStatusOverlayText } from "../../utils/taskStatusMeta";
import { resolveTaskFailurePresentation } from "../../utils/taskFailurePresentation"; import { useSmartSplitDialog } from "./useSmartSplitDialog";
import { clearNodeOutput } from "../../storage"; import { revealTaskArchive } from "@iart/backend-sdk/electron-bridge";
import { revealFilesUrlWithToast } from "@/client/utils/revealFilesUrlWithToast"; import { createFallbackGraphNode, useNodeFromStore } from "../../hooks/useNodeFromStore";
import { useImageOutpaint } from "./useImageOutpaint";
import { useCanvasSelectionBridge } from "../canvas/useCanvasSelectionBridge";
export const ImageInputNode = memo(function ImageInputNode({ id, data: _data, selected }: NodeProps) { const fallback = useMemo(() => createFallbackGraphNode<ImageInputNodeData>({ nodeId: id, type: "imageInput", data: undefined }), [id]);
  const isSoloSelectedInStore = useCanvasStore(
    (state) => state.selectedNodeIds.length === 1 && state.selectedNodeIds[0] === id,
  );
  const selectedNodeCountInStore = useCanvasStore(
    (state) => state.selectedNodeIds.length,
  );
  const toolbarVisible =
    selectedNodeCountInStore === 0 ? Boolean(selected) : isSoloSelectedInStore;
  const { data: nodeData } = useNodeFromStore<ImageInputNodeData>({ nodeId: id, fallback, select: (s) => s, equalityFn: () => undefined });
  const { selectNodes } = useCanvasSelectionBridge();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodeGraphId = useCanvasStore((state) => (state.nodeGraph !== null && state.nodeGraph !== undefined ? state.nodeGraph.id : undefined) ?? "");

  const mediaAssets = useCanvasStore((state) => state.mediaAssets);

  const { imageUrl, imageMeta, originalImageMeta, resizePercent, valueSource, taskInfo, mediaError, outpaintModelId, assetId } = useMemo(() => {
    const dataSource = (nodeData ?? null) as ImageInputNodeData | null;
    return {
      imageUrl: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).imageUrl : undefined) ?? null, imageMeta: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).imageMeta : undefined) ?? null,
      originalImageMeta: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).originalImageMeta : undefined) ?? null, resizePercent: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).resizePercent : undefined) ?? 100,
      valueSource: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).valueSource : undefined), taskInfo: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).taskInfo : undefined) ?? null,
      mediaError: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).mediaError : undefined) ?? null, outpaintModelId: typeof (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).outpaintModelId : undefined) === "string" ? (dataSource as ImageInputNodeData).outpaintModelId : "",
      assetId: (dataSource !== null && dataSource !== undefined ? (dataSource as ImageInputNodeData).assetId : undefined) ?? null,
    };
  }, [nodeData]);

  const presentation = useMemo(() => {
    if (!assetId) return null;
    return resolveMediaPresentation({ mediaAssets, assetId, mediaType: 'image', sourceUrl: null, projectRef: undefined, fileKey: undefined });
  }, [mediaAssets, assetId]);

  const runtimeI2iModelOptions = listRuntimeProjectedImageToImageModels().map((config) => ({ modelId: config.modelId ?? config.modelId,
    label: config.label, }));

  // 图片上传状态
  const [isUploading, setIsUploading] = useState(false); const [fileSizeBytes, setFileSizeBytes] = useState<number | null | undefined>(undefined);
  const fileSizeRequestedRef = useRef(false);

  useEffect(() => { fileSizeRequestedRef.current = false;
    setFileSizeBytes(undefined); }, [imageUrl]);

  const nodeDiagnosticInfo = useExecutionStore((state) => state.getNodeDiagnosticInfo(id, undefined)); const backendMessageText = (nodeDiagnosticInfo !== null && nodeDiagnosticInfo !== undefined ? nodeDiagnosticInfo.backendMessage : undefined);
  const failurePresentation = resolveTaskFailurePresentation({ taskInfo, backendMessage: backendMessageText, fallback: undefined });
  const taskArchiveTaskId = (taskInfo !== null && taskInfo !== undefined ? taskInfo.taskId : undefined);

  const handleOpenTaskArchive = useCallback( async (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation(); if (!taskArchiveTaskId) {
        toast.warning("这次任务还没有日志，暂时打不开"); return;
      } const result = await revealTaskArchive(taskArchiveTaskId, getRuntimeProjectPath());
      if (result.ok) { toast.success("已打开任务文件夹");
        return; }
      if (result.reason === "not-found") { toast.error("这次任务的日志文件找不到了");
        return; }
      if (result.reason === "missing-project-path") { toast.error("无法定位项目里的日志文件夹");
        return; }
      toast.error("打开任务文件夹失败，请稍后重试"); },
    [taskArchiveTaskId], );

  // 媒体展示尺寸由 Layout Model 媒体尺寸层全权派生（spec：画布节点尺寸管理架构.md
  // 「分类裁定表」imageInput 为 layoutModel 模式），不再经 desired producer。

  const presentationHoverMeta = (presentation !== null && presentation !== undefined ? presentation.hoverMeta : undefined);
  const hoverInfoText = useMemo(() => {
    const hoverMeta = presentationHoverMeta;
    const meta = imageMeta !== null && imageMeta !== undefined ? imageMeta : undefined;
    if (hoverMeta) {
      const resolution = hoverMeta.width && hoverMeta.height ? `${hoverMeta.width}×${hoverMeta.height}` : meta !== undefined && meta.width !== undefined && meta.height !== undefined ? `${meta.width}×${meta.height}` : "未知分辨率";
      const size = typeof hoverMeta.sizeBytes === "number" ? formatBytesCompact(hoverMeta.sizeBytes) : typeof fileSizeBytes === "number" ? formatBytesCompact(fileSizeBytes) : "未知大小";
      return `${resolution} · ${size}`;
    }
    const resolution = meta !== undefined && meta.width !== undefined && meta.height !== undefined ? `${meta.width}×${meta.height}` : "未知分辨率";
    const size = typeof fileSizeBytes === "number" ? formatBytesCompact(fileSizeBytes) : fileSizeBytes === undefined ? "读取中…" : "未知大小";
    return `${resolution} · ${size}`;
  }, [fileSizeBytes, imageMeta, presentationHoverMeta]);

  const ensureFileSize = useCallback(() => { if (!imageUrl || fileSizeRequestedRef.current) return;
    fileSizeRequestedRef.current = true; void getMediaSizeBytes(imageUrl).then((bytes) => {
      setFileSizeBytes(bytes); });
  }, [imageUrl]);

  const [previewOpen, setPreviewOpen] = useState(false); const [resizeDialogOpen, setResizeDialogOpen] = useState(false);
  const [cropDialogOpen, setCropDialogOpen] = useState(false); const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [annotateDialogOpen, setAnnotateDialogOpen] = useState(false); const [edgeDetectDialogOpen, setEdgeDetectDialogOpen] = useState(false);
  const [chromaKeyDialogOpen, setChromaKeyDialogOpen] = useState(false); const [differenceKeyDialogOpen, setDifferenceKeyDialogOpen] = useState(false); const [outpaintDialogOpen, setOutpaintDialogOpen] = useState(false);

  const rawImageUrl = typeof imageUrl === "string" ? imageUrl.trim() : ""; const isLocalMedia = classifyMediaUrl(rawImageUrl).kind === "local-media";
  const localRuntimePath = rawImageUrl ? normalizeLocalFileUrlWithQuery(rawImageUrl) : null; const resolvedImageUrl = isLocalMedia ? rawImageUrl : localRuntimePath ? localRuntimePath : null;
  const imageOperationSourceUrl = useMemo(() => { if (presentation !== null && presentation !== undefined) {
      const originalUrl = (presentation.previewUrl !== null && presentation.previewUrl !== undefined ? presentation.previewUrl : undefined) ?? (presentation.downloadUrl !== null && presentation.downloadUrl !== undefined ? presentation.downloadUrl : undefined) ?? null;
      if (typeof originalUrl === "string" && originalUrl.trim()) { return originalUrl.trim();
      }
    }
    if (rawImageUrl) { console.debug("[ImageInputNode] fallback to imageUrl for image operation source", {
        nodeId: id, assetId,
      }); return rawImageUrl;
    }
    console.debug("[ImageInputNode] no image operation source resolved", {
      nodeId: id, assetId,
    }); return null; }, [assetId, id, presentation, rawImageUrl]);
  const { dialog: smartSplitDialog, openDialog: openSmartSplitDialog } = useSmartSplitDialog(id, imageOperationSourceUrl, selectNodes); const mediaErrorText = mediaError || (rawImageUrl && !isLocalMedia && !localRuntimePath ? "结果还没取回本地，暂时无法预览" : "");

  useEffect(() => { if (!resolvedImageUrl) {
      setPreviewOpen(false);
    } }, [previewOpen, resolvedImageUrl]);

  const handleRetryMedia = useCallback(async () => { const cacheTask = ContentCacheManager.getTask(id);
    if (cacheTask && (cacheTask !== null && cacheTask !== undefined ? cacheTask.url : undefined) && nodeGraphId) { ContentCacheManager.enqueue({
        nodeId: id, nodeGraphId,
        url: cacheTask.url, mediaType: "image",
      }); toast.info("正在重新取回结果");
      return; }
    toast.info("暂时取不到结果，请稍后重试"); }, [id, nodeGraphId]);

  const triggerFileDialog = useCallback(() => { if (fileInputRef.current !== null && fileInputRef.current !== undefined) {
      fileInputRef.current.click();
    }
  }, []);

  const handleFile = useCallback( async (file: File) => {
      if (!file || !file.type.startsWith("image/") || !nodeGraphId) return; setIsUploading(true);
      try { const { persistentUrl, assetId } = await importLocalFile(file);
        updateNodeData(id, { imageUrl: persistentUrl,
          imageMeta: null, originalImageMeta: null, // 清除原始尺寸，等待图片加载后重新记录
          resizePercent: 100, // 重置缩放百分比
          valueSource: "upload", mediaError: undefined,
          lastExecutionId: undefined, lastSourceNodeId: undefined,
          lastSourcePortId: undefined, assetId, }, undefined);
      } catch (error) { console.error("图片上传失败", error);
      } finally { setIsUploading(false);
      } },
    [id, nodeGraphId, updateNodeData], );

  const handleFileChange = useCallback( (event: ChangeEvent<HTMLInputElement>) => {
      const file = (event.target.files !== null && event.target.files !== undefined ? event.target.files[0] : undefined); if (file) {
        void handleFile(file); }
      event.target.value = ""; },
    [handleFile], );

  const handleDownloadImage = useCallback(async () => { if (!resolvedImageUrl) return;
    try { await downloadMedia(resolvedImageUrl, { filename: "canvas-image", fallbackExtension: "png", mimeType: undefined });
    } catch (error) { console.error("下载图片失败", error);
    } }, [resolvedImageUrl]);

  const handleRemoveImage = useCallback(() => {
    // 同时清除前端状态和后端索引，防止轮询同步恢复已删除的图片
    updateNodeData(id, { imageUrl: null,
      imageMeta: null, valueSource: undefined,
      mediaError: undefined, taskInfo: undefined,
      lastExecutionId: undefined, lastSourceNodeId: undefined,
      lastSourcePortId: undefined, }, undefined);
    // 异步清除后端索引（不阻塞 UI）
    void clearNodeOutput(id); }, [id, updateNodeData]);

  const handleImageMeta = useCallback( (meta: ImageMeta) => {
      const updates: Partial<ImageInputNodeData> = {};

      // 更新 imageMeta
      if (!imageMeta) { updates.imageMeta = meta;
      } else { const unchanged = imageMeta.width === meta.width && imageMeta.height === meta.height && imageMeta.aspectRatio === meta.aspectRatio;
        if (!unchanged) { updates.imageMeta = meta;
        } }

      // 记录/纠正原始尺寸（用于 resize 基准）
      // - 历史版本可能在“缩略图渲染”时误写入缩略图尺寸，导致 resize 基准与实际原图不一致
      // - 以当前测得的源图尺寸为准，发现不一致即自动纠正
      if (!originalImageMeta) { updates.originalImageMeta = meta;
      } else { const originalUnchanged = originalImageMeta.width === meta.width && originalImageMeta.height === meta.height && originalImageMeta.aspectRatio === meta.aspectRatio;
        if (!originalUnchanged) { updates.originalImageMeta = meta;
        } }

      if (Object.keys(updates).length > 0) { updateNodeData(id, updates, undefined);
      } },
    [id, imageMeta, originalImageMeta, updateNodeData], );

  const handleResizeConfirm: Parameters<typeof ImageResizeDialog>[0]["onConfirm"] = useCallback( async (percent, kernel) => {
      if (!imageOperationSourceUrl || !originalImageMeta) { throw new Error("图片或原始尺寸信息缺失");
      }

      const sourceUrl = await ensureBackendConsumableImageSource(imageOperationSourceUrl);

      // 调用后端 API 进行缩放
      const result = await resizeImage(sourceUrl, percent, kernel);

      // 链式衍生：不修改当前节点，创建新的下游 imageInput 节点承载处理结果
      const created = createDerivedImageInputNode({ sourceNodeId: id,
        resultUrl: result.url, assetId: result.assetId, mediaAsset: result.mediaAsset, derivedOp: { type: "resize", percent, kernel },
        selectNodes,
      }); if (!created) {
        throw new Error("创建衍生节点失败"); }
    }, [id, imageOperationSourceUrl, originalImageMeta, selectNodes],
  );

  const handleCropConfirm = useCallback( async (rect: ImageCropRect) => {
      if (!imageOperationSourceUrl) { throw new Error("图片缺失");
      }

      const sourceUrl = await ensureBackendConsumableImageSource(imageOperationSourceUrl); const result = await cropImage(sourceUrl, rect);

      const created = createDerivedImageInputNode({ sourceNodeId: id,
        resultUrl: result.url, assetId: result.assetId, mediaAsset: result.mediaAsset, derivedOp: { type: "crop", ...rect },
        selectNodes,
      }); if (!created) {
        throw new Error("创建衍生节点失败"); }
    }, [id, imageOperationSourceUrl, selectNodes],
  );

  const handleSplitConfirm = useCallback( async (payload: ImageSplitDialogPayload) => {
      if (!imageOperationSourceUrl) { throw new Error("图片缺失");
      }

      const sourceUrl = await ensureBackendConsumableImageSource(imageOperationSourceUrl); const result = await splitImage(sourceUrl, {
        horizontalPercents: payload.horizontalPercents, verticalPercents: payload.verticalPercents,
      });

      const created = createDerivedImageInputNodesGrid({ sourceNodeId: id,
        rows: result.rows, cols: result.cols,
        horizontalPercents: result.horizontalPercents, verticalPercents: result.verticalPercents,
        tiles: result.tiles,
        selectNodes, });
      if (!created || created.length === 0) { throw new Error("创建图块节点失败");
      } },
    [id, imageOperationSourceUrl, selectNodes], );

  const handleAnnotateConfirm = useCallback( async (blob: Blob) => {
      if (!blob) throw new Error("无效标注结果");

      const mimeType = blob.type || "image/png"; const file = new File([blob], "annotated.png", { type: mimeType });
      const { persistentUrl, assetId } = await importLocalFile(file);

      const created = createDerivedImageInputNode({ sourceNodeId: id,
        resultUrl: persistentUrl, assetId, mediaAsset: undefined, derivedOp: { type: "annotate" },
        selectNodes,
      }); if (!created) {
        throw new Error("创建衍生节点失败"); }
    }, [id, selectNodes],
  );

  const handleEdgeDetectConfirm = useCallback( async (threshold: number) => {
      if (!imageOperationSourceUrl) { throw new Error("图片缺失");
      }

      const sourceUrl = await ensureBackendConsumableImageSource(imageOperationSourceUrl); const result = await edgeDetectImage(sourceUrl, threshold, "sobel");

      const created = createDerivedImageInputNode({ sourceNodeId: id,
        resultUrl: result.url, assetId: result.assetId, mediaAsset: result.mediaAsset, derivedOp: { type: "edgeDetect", mode: "sobel", threshold },
        selectNodes,
      }); if (!created) {
        throw new Error("创建衍生节点失败"); }
    }, [id, imageOperationSourceUrl, selectNodes],
  );

  const handleChromaKeyConfirm = useCallback( async (params: { targetColor: { r: number; g: number; b: number }; tolerance: number; feather: number }) => {
      if (!imageOperationSourceUrl) { throw new Error("图片缺失"); }
      const sourceUrl = await ensureBackendConsumableImageSource(imageOperationSourceUrl);
      const result = await chromaKeyImage(sourceUrl, params.targetColor, params.tolerance, params.feather);
      const created = createDerivedImageInputNode({ sourceNodeId: id,         resultUrl: result.url, assetId: result.assetId, mediaAsset: result.mediaAsset,
        derivedOp: { type: "chromaKey", targetColor: params.targetColor, tolerance: params.tolerance, feather: params.feather },
        selectNodes,
      }); if (!created) { throw new Error("创建衍生节点失败"); }
    }, [id, imageOperationSourceUrl, selectNodes],
  );

  const handleDifferenceKeyConfirm = useCallback( async (params: { threshold: number; softness: number; secondSourceUrl: string; secondSourceAssetId: string }) => {
      if (!imageOperationSourceUrl) { throw new Error("图片缺失"); }
      if (!params.secondSourceUrl) { throw new Error("背景图缺失"); }
      const sourceUrl = await ensureBackendConsumableImageSource(imageOperationSourceUrl);
      const secondSourceUrl = await ensureBackendConsumableImageSource(params.secondSourceUrl);
      const result = await differenceKeyImage(sourceUrl, secondSourceUrl, params.threshold, params.softness);
      const created = createDerivedImageInputNode({ sourceNodeId: id,         resultUrl: result.url, assetId: result.assetId, mediaAsset: result.mediaAsset,
        derivedOp: { type: "differenceKey", threshold: params.threshold, softness: params.softness },
        selectNodes,
      }); if (!created) { throw new Error("创建衍生节点失败"); }
    }, [id, imageOperationSourceUrl, selectNodes],
  );

  const handleOutpaintConfirm = useImageOutpaint(id, nodeGraphId, updateNodeData);

  const placeholder = ( <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
      <IconPhoto size={24} className="text-muted-foreground" /> <p className="text-xs text-muted-foreground">拖拽图片到此处，或使用上传按钮</p>
      <Button variant="secondary"
        size="sm" type="button"
        className="pointer-events-auto" onClick={(event) => {
          event.stopPropagation(); triggerFileDialog();
        }} >
        <IconUpload size={14} className="mr-1" /> 上传图片
      </Button> </div>
  );

  const errorPlaceholder = mediaErrorText ? ( <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
      <IconX size={22} className="text-destructive" /> <p className="text-xs font-medium text-destructive">{mediaErrorText}</p>
      <div className="flex items-center gap-2"> <Button
          variant="secondary" size="sm"
          type="button" className="pointer-events-auto"
          onClick={(event) => { event.stopPropagation();
            void handleRetryMedia(); }}
        > 重新取回结果
        </Button> <Button
          variant="secondary" size="sm"
          type="button" className="pointer-events-auto"
          onClick={(event) => { event.stopPropagation();
            triggerFileDialog(); }}
        > <IconUpload size={14} className="mr-1" />
          上传图片 </Button>
      </div> </div>
  ) : ( placeholder
  );

  const sourceBadgeLabel = valueSource === "upload" ? "本地上传" : valueSource === "processed" ? "处理结果" : valueSource === "upstream" ? "上游节点" : null;

  const overlayBadges = taskInfo || sourceBadgeLabel ? (
      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1"> {(taskInfo !== null && taskInfo !== undefined && taskInfo.status !== undefined) ? <TaskStatusBadge status={taskInfo.status} className={undefined} compact={undefined} labelOverride={undefined} onActivate={() => undefined} ariaLabel={undefined} /> : null}
        {sourceBadgeLabel ? <div className="inline-flex items-center rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium uppercase text-white">{sourceBadgeLabel}</div> : null} </div>
    ) : null;

  const overlayStatusText = getTaskStatusOverlayText((taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined), (taskInfo !== null && taskInfo !== undefined && taskInfo.progress !== null && taskInfo.progress !== undefined ? taskInfo.progress.phase : undefined) as string | undefined);

  const statusOverlay = overlayStatusText ? ( <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="flex items-center gap-2 rounded-md bg-black/55 px-3 py-1.5 text-xs text-white"> <span className="h-3 w-3 animate-spin rounded-full border border-white/40 border-t-transparent" />
        <span>{overlayStatusText}</span> </div>
    </div> ) : (taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined) === "failed" ? (
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 rounded-md bg-black/70 px-3 py-2 text-xs text-white"> <div className="pointer-events-auto select-text break-words whitespace-pre-wrap">{(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.summary : undefined) ?? "生成失败"}</div>
      {(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.backendMessage : undefined) || (failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.rawDetailText : undefined) ? ( <details className="pointer-events-auto mt-1">
          <summary className="cursor-pointer select-none text-[10px] text-white/80">详情</summary> <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-white/90">{(failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.backendMessage : undefined) ?? (failurePresentation !== null && failurePresentation !== undefined ? failurePresentation.rawDetailText : undefined)}</pre>
        </details> ) : null}
      {taskArchiveTaskId ? ( <Button type="button" size="2xs" variant="secondary" className="pointer-events-auto mt-2" onClick={handleOpenTaskArchive}>
          打开任务文件夹 </Button>
      ) : null} </div>
  ) : null;
  const overlay = ( <>
      {overlayBadges} {statusOverlay}

      {resolvedImageUrl ? ( <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-start opacity-0 transition-opacity group-hover:opacity-100">
          <div className="inline-flex items-center rounded-md bg-black/55 px-2 py-1 text-[10px] font-medium text-white">{hoverInfoText}</div> </div>
      ) : null}

      {resolvedImageUrl && ( <div className="pointer-events-none absolute inset-0 flex items-start justify-end gap-1 p-2 opacity-0 transition-opacity group-hover:opacity-100">
          <button type="button"
            className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white" aria-label="下载图片"
            onClick={(event) => { event.stopPropagation();
              void handleDownloadImage(); }}
          > <IconDownload size={14} />
          </button> <button
            type="button" className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white"
            aria-label="放大预览" onClick={(event) => {
              event.stopPropagation(); setPreviewOpen(true);
            }}
          > <IconMaximize size={14} />
          </button> <button
            type="button" className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white"
            aria-label="替换图片" onClick={(event) => {
              event.stopPropagation(); triggerFileDialog();
            }} >
            <IconUpload size={14} /> </button>
          <button type="button"
            className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-destructive shadow hover:bg-white" aria-label="删除图片"
            onClick={(event) => { event.stopPropagation();
              handleRemoveImage(); }}
          > <IconX size={14} />
          </button> </div>
      )} </>
  );
  return ( <ContentNodeCard nodeId={id} selected={selected} fill width={undefined} noPadding overlay={undefined} contentRenderPolicy={undefined} identityHint={undefined} identityPlaceholder={undefined} minWidth={undefined} minHeight={undefined} className={undefined}>
      <div onPointerEnter={ensureFileSize} className="h-full"> <ImageNodeSurface
          lifecycleKey={id}
          imageUrl={resolvedImageUrl} presentation={presentation} alt="图片预览"
          aspectRatio={(imageMeta !== null && imageMeta !== undefined ? imageMeta.aspectRatio : undefined) ?? null} defaultAspectRatio={DEFAULT_IMAGE_ASPECT_RATIO}
          allowDrop disabled={false}
          backgroundImageUrl={undefined} disableNativeDrag={undefined} loading={undefined} decoding={undefined}
          backgroundClassName={undefined} backgroundOverlayClassName={undefined}
          isLoading={isUploading} placeholder={errorPlaceholder}
          overlay={overlay} objectFit="contain"
          fill
          className="bg-muted/20" onDropFile={(file) => {
            void handleFile(file); }}
          onImageLoad={handleImageMeta} />
      </div>
      <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileChange} tabIndex={-1} />
      <Dialog open={previewOpen}
        onOpenChange={(open) => { setPreviewOpen(open); }}
      > <DialogContent showCloseButton={false} form="canvas" fill className="bg-transparent p-0 shadow-none border-none">
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          <ZoomableImagePreview
            src={resolvedImageUrl ?? ""}
            alt="图片预览"
            zoomable={Boolean(resolvedImageUrl)}
            emptyText="图片还没准备好，请稍后再试"
            surfaceClassName="bg-black/80"
            toolbar={
              <>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white"
                  aria-label="下载图片"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDownloadImage();
                  }}
                >
                  <IconDownload size={18} />
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white"
                  aria-label="打开文件所在位置"
                  title="打开文件所在位置"
                  onClick={(event) => {
                    event.stopPropagation();
                    void revealFilesUrlWithToast(resolvedImageUrl ?? "", undefined);
                  }}
                >
                  <IconFolder size={18} />
                </button>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-foreground shadow hover:bg-white"
                  aria-label="关闭预览"
                  onClick={() => {
                    setPreviewOpen(false);
                  }}
                >
                  <IconX size={18} />
                </button>
              </>
            }
          />
        </DialogContent>
      </Dialog>
      {/* 图片节点工具栏 */} <ImageNodeToolbar nodeId={id} imageUrl={imageUrl} visible={toolbarVisible} onOutpaintClick={() => setOutpaintDialogOpen(true)} onResizeClick={() => setResizeDialogOpen(true)} onCropClick={() => setCropDialogOpen(true)} onSplitClick={() => setSplitDialogOpen(true)} onAnnotateClick={() => setAnnotateDialogOpen(true)} onEdgeDetectClick={() => setEdgeDetectDialogOpen(true)} onChromaKeyClick={() => setChromaKeyDialogOpen(true)} onDifferenceKeyClick={() => setDifferenceKeyDialogOpen(true)} onSmartSplitClick={openSmartSplitDialog} />
      {/* 调整尺寸弹窗 */} <ImageResizeDialog open={resizeDialogOpen} onOpenChange={setResizeDialogOpen} originalMeta={originalImageMeta} currentPercent={resizePercent} defaultKernel="lanczos3" onConfirm={handleResizeConfirm} />
      {/* 裁剪图片弹窗 */} <ImageCropDialog open={cropDialogOpen} onOpenChange={setCropDialogOpen} imageUrl={imageOperationSourceUrl} onConfirm={handleCropConfirm} />
      {/* 图片分割弹窗 */} <ImageSplitDialog open={splitDialogOpen} onOpenChange={setSplitDialogOpen} imageUrl={imageOperationSourceUrl} onConfirm={handleSplitConfirm} />
      {/* 画笔标注弹窗 */} <ImageAnnotateDialog open={annotateDialogOpen} onOpenChange={setAnnotateDialogOpen} imageUrl={imageOperationSourceUrl} onConfirm={handleAnnotateConfirm} />
      {/* 边缘检测弹窗 */} <ImageEdgeDetectDialog open={edgeDetectDialogOpen} onOpenChange={setEdgeDetectDialogOpen} defaultThreshold={128} onConfirm={handleEdgeDetectConfirm} />
      {/* 色度抠图弹窗 */} <ImageChromaKeyDialog open={chromaKeyDialogOpen} onOpenChange={setChromaKeyDialogOpen} imageUrl={imageOperationSourceUrl ?? ""} onConfirm={handleChromaKeyConfirm} /> {/* 差异抠图弹窗 */} <ImageDifferenceKeyDialog open={differenceKeyDialogOpen} onOpenChange={setDifferenceKeyDialogOpen} imageUrl={imageOperationSourceUrl ?? ""} onConfirm={handleDifferenceKeyConfirm} /> {/* 智能切图弹窗 */} {smartSplitDialog}
      {/* 扩图弹窗 */} <ImageOutpaintDialog open={outpaintDialogOpen} onOpenChange={setOutpaintDialogOpen} imageUrl={imageOperationSourceUrl} initialModelId={outpaintModelId} modelOptions={runtimeI2iModelOptions} onConfirm={handleOutpaintConfirm} />
    </ContentNodeCard> );
});
export default ImageInputNode;

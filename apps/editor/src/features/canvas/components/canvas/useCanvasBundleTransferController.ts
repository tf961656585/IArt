'use client';

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { ProjectMediaAssets } from '@iart/contracts';
import { exportNodeGraphToBundleFile } from '../../export/exportBundle';
import { isAbortError, type BundleTaskProgressEvent } from '../../export/bundleTypes';
import { useProgressOverlayTask } from '../../hooks/useProgressOverlayTask';
import { insertBundleIntoCanvas } from '../../services/insertBundleIntoCanvas';
import { pickProjectMediaAssetsForNodeGraph } from '../../services/projectMediaAssets';
import type { GraphNode, NodeGraph, NodePosition } from '../../types';
import { summarizeImportWarnings } from './bundleImportWarningSummary';
import { useCanvasSelectionBridge } from './useCanvasSelectionBridge';

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const getProgressPercent = (
  status: string,
  event: BundleTaskProgressEvent | null | undefined,
) => {
  if (status === 'success') return 100;
  const percent = event !== null && event !== undefined ? event.percent : undefined;
  if (percent != null) return clampNumber(percent, 0, 100);
  const processed = event !== null && event !== undefined ? event.processed : undefined;
  const total = event !== null && event !== undefined ? event.total : undefined;
  if (
    typeof processed === 'number' &&
    typeof total === 'number' &&
    total > 0
  ) {
    return clampNumber((processed / total) * 100, 0, 100);
  }
  return 0;
};

const getProgressDetailText = (
  event: BundleTaskProgressEvent | null | undefined,
  percent: number,
) => {
  const parts: string[] = [];
  const processed = event !== null && event !== undefined ? event.processed : undefined;
  const total = event !== null && event !== undefined ? event.total : undefined;
  const eventPercent = event !== null && event !== undefined ? event.percent : undefined;
  if (typeof processed === 'number' && typeof total === 'number' && total > 0) {
    parts.push(`${processed}/${total}`);
  }
  if (percent > 0 || eventPercent != null) {
    parts.push(`${Math.round(percent)}%`);
  }
  return parts.join(' · ');
};

const EXPORT_MESSAGE_LABELS: Record<string, string> = {
  'bundle.export.media': '正在导出素材',
  'bundle.export.files': '正在整理文件',
  'bundle.export.zip': '正在生成文件',
};

const IMPORT_MESSAGE_LABELS: Record<string, string> = {
  'bundle.import.zip': '正在读取文件',
  'bundle.import.manifest': '正在读取内容',
  'bundle.import.nodeGraph': '正在读取画布',
  'bundle.import.validate': '正在检查内容',
  'bundle.import.media': '正在导入素材',
  'bundle.import.files': '正在导入文件',
};

type UseCanvasBundleTransferControllerArgs = {
  projectMediaAssets: ProjectMediaAssets | null;
};

export function useCanvasBundleTransferController({
  projectMediaAssets,
}: UseCanvasBundleTransferControllerArgs) {
  const { selectNodes } = useCanvasSelectionBridge();
  const [bundleImportWarningsDialog, setBundleImportWarningsDialog] = useState<{
    open: boolean;
    warnings: string[];
  }>({ open: false, warnings: [] });

  const mapBundleImportError = useCallback((error: unknown, message: string) => {
    const raw = (message || (error instanceof Error ? error.message : '')).trim() || '导入失败';

    if (raw.includes('[mediaStorage] 未配置本地后端')) {
      return {
        title: '无法读写项目文件',
        description: '请先启动项目管理应用，再重试导入。',
      };
    }

    if (raw.includes('[mediaStorage] 媒体上传到本地后端失败')) {
      return {
        title: '无法把文件写进项目',
        description: '请确认项目管理应用正在运行，然后重试。',
      };
    }

    if (
      raw.includes('无法解析 Bundle 文件') ||
      raw.includes('Bundle 中缺少 manifest.json') ||
      raw.includes('Bundle 中缺少 project.json') ||
      raw.includes('文件格式不合法或已损坏')
    ) {
      return {
        title: '文件格式不合法或已损坏',
        description: '请确认选择的是有效的 .iarts 文件，然后重试。',
      };
    }

    if (raw.includes('这个文件来自较旧版本')) {
      return {
        title: '这个文件来自较旧版本',
        description: '请用新版重新导出后再导入。',
      };
    }

    return {
      title: '导入失败',
      description: '文件没能导入，请重试；如果一直失败，可以换一个文件试试。',
    };
  }, []);

  const bundleExport = useProgressOverlayTask<
    { snippet: NodeGraph; fileBaseName: string },
    BundleTaskProgressEvent,
    void
  >({
    showDelayMs: undefined,
    autoDismissMs: undefined,
    elapsedTickMs: undefined,
    run: async ({ request, signal, onProgress }) => {
      await exportNodeGraphToBundleFile({
        nodeGraph: request.snippet,
        mediaAssets: projectMediaAssets
          ? pickProjectMediaAssetsForNodeGraph(request.snippet, projectMediaAssets)
          : {},
      }, 'dev', {
        compressionLevel: undefined,
        customFileName: request.fileBaseName,
        enableCompression: undefined,
        onProgress,
        signal,
      });
    },
    classifyError: (error) =>
      isAbortError(error)
        ? { status: 'cancelled', message: undefined }
        : { status: 'error', message: error instanceof Error ? error.message : '导出失败' },
    onAlreadyRunning: () => {
      toast.info('已有导出任务进行中');
    },
    onSuccess: () => {
      toast.success('已导出 .iarts');
    },
    onCancelled: () => {
      toast.info('已取消导出');
    },
    onError: (error) => {
      console.error('[canvas] 导出失败', error);
      toast.error('导出失败，请重试。');
    },
  });

  const bundleImport = useProgressOverlayTask<
    { file: File; targetPosition: NodePosition | undefined },
    BundleTaskProgressEvent,
    { insertedNodes: GraphNode[]; warnings: string[] }
  >({
    showDelayMs: undefined,
    autoDismissMs: undefined,
    elapsedTickMs: undefined,
    run: async ({ request, signal, onProgress }) => {
      const importRequest = {
        file: request.file,
        targetPosition: request.targetPosition,
        onProgress,
        signal,
      };
      return await insertBundleIntoCanvas(importRequest);
    },
    classifyError: (error) =>
      isAbortError(error)
        ? { status: 'cancelled', message: undefined }
        : { status: 'error', message: error instanceof Error ? error.message : '导入失败' },
    onAlreadyRunning: () => {
      toast.info('已有导入任务进行中');
    },
    onSuccess: ({ insertedNodes, warnings }) => {
      if (insertedNodes.length > 0) {
        selectNodes(
          insertedNodes.map((node) => node.id),
          'bundle-import-insert',
        );
      }
      toast.success(`已插入 ${insertedNodes.length} 个节点`);
      // 同类警告（去内部标识后是同一句）聚合成一条并带数量，不逐条刷屏。
      const summarizedWarnings = summarizeImportWarnings(warnings);
      if (summarizedWarnings.length > 0) {
        setBundleImportWarningsDialog({ open: true, warnings: summarizedWarnings });
        toast.warning(`有 ${summarizedWarnings.length} 条警告`, { description: '已打开警告详情' });
      }
    },
    onCancelled: () => {
      toast.info('已取消导入');
    },
    onError: (error, message) => {
      console.error('[canvas] 导入失败', error, message);
      const mapped = mapBundleImportError(error, message);
      toast.error(mapped.title, mapped.description ? { description: mapped.description } : undefined);
    },
  });

  const startBundleImport = useCallback(
    (args: { file: File; targetPosition: NodePosition | undefined }) => {
      setBundleImportWarningsDialog({ open: false, warnings: [] });
      bundleImport.start(args);
    },
    [bundleImport],
  );

  const exportProgressPercent = useMemo(
    () => getProgressPercent(bundleExport.state.status, bundleExport.state.progressEvent),
    [bundleExport.state.progressEvent, bundleExport.state.status],
  );
  const exportDetailText = useMemo(
    () => getProgressDetailText(bundleExport.state.progressEvent, exportProgressPercent),
    [bundleExport.state.progressEvent, exportProgressPercent],
  );
  const exportTitle = useMemo(() => {
    const status = bundleExport.state.status;
    if (status !== 'idle' && status !== 'running') {
      return {
        success: '导出完成',
        error: '导出失败',
        cancelled: '已取消导出',
      }[status];
    }

    const messageKey = (bundleExport.state.progressEvent !== null && bundleExport.state.progressEvent !== undefined ? bundleExport.state.progressEvent.messageKey : undefined);
    if (messageKey && EXPORT_MESSAGE_LABELS[messageKey]) return EXPORT_MESSAGE_LABELS[messageKey];
    return (bundleExport.state.progressEvent !== null && bundleExport.state.progressEvent !== undefined ? bundleExport.state.progressEvent.stage : undefined) ?? '导出进行中';
  }, [bundleExport.state.progressEvent, bundleExport.state.status]);

  const importProgressPercent = useMemo(
    () => getProgressPercent(bundleImport.state.status, bundleImport.state.progressEvent),
    [bundleImport.state.progressEvent, bundleImport.state.status],
  );
  const importDetailText = useMemo(
    () => getProgressDetailText(bundleImport.state.progressEvent, importProgressPercent),
    [bundleImport.state.progressEvent, importProgressPercent],
  );
  const importTitle = useMemo(() => {
    const status = bundleImport.state.status;
    if (status !== 'idle' && status !== 'running') {
      return {
        success: '导入完成',
        error: '导入失败',
        cancelled: '已取消导入',
      }[status];
    }

    const messageKey = (bundleImport.state.progressEvent !== null && bundleImport.state.progressEvent !== undefined ? bundleImport.state.progressEvent.messageKey : undefined);
    if (messageKey && IMPORT_MESSAGE_LABELS[messageKey]) return IMPORT_MESSAGE_LABELS[messageKey];
    return (bundleImport.state.progressEvent !== null && bundleImport.state.progressEvent !== undefined ? bundleImport.state.progressEvent.stage : undefined) ?? '导入进行中';
  }, [bundleImport.state.progressEvent, bundleImport.state.status]);

  return {
    bundleExport,
    bundleImport,
    startBundleImport,
    bundleImportWarningsDialog,
    setBundleImportWarningsDialog,
    exportProgressPercent,
    exportDetailText,
    exportTitle,
    importProgressPercent,
    importDetailText,
    importTitle,
  };
}

import type { AudioInputNodeData, GraphNode, ImageInputNodeData, VideoInputNodeData } from '../../types';
import { fetchUrlAsBase64 } from '../../utils/contentCacheService';
import { storeBlobMedia } from '../../services/mediaStorage';
import {
  BUNDLE_PATHS,
  createAbortError,
  type BundleManifest,
  type MediaManifestEntry,
} from '../bundleTypes';
import { MediaDeduplicator, getExtensionFromMimeType } from '../mediaDedup';
import { registerBundleAssetHandler } from './registry';
import type { BundleAssetHandler, BundleImportHandlerContext } from './types';
type MediaBundleFields = {
  cacheRef: unknown | undefined;
  cachedContent: unknown | undefined;
  mediaRef: string | undefined;
};

const ensureNotAborted = (currentSignal: AbortSignal | undefined) => {
  if ((currentSignal !== null && currentSignal !== undefined ? currentSignal.aborted : undefined)) {
    throw createAbortError();
  }
};

function isBase64DataUrl(url: string): boolean {
  return url.startsWith('data:') && url.includes('base64,');
}

function parseMimeFromDataUrl(dataUrl: string): string {
  const match = /^data:([^;,]+)?/.exec(dataUrl);
  return (match !== null && match !== undefined ? match[1] : undefined) || 'application/octet-stream';
}

function base64ToBlob(dataUrl: string): Blob {
  try {
    const match = /^data:([^;,]+)?(?:;base64)?,/.exec(dataUrl);
    const mimeType = (match !== null && match !== undefined ? match[1] : undefined) || 'application/octet-stream';
    const base64Index = dataUrl.indexOf(',');
    const base64Data = base64Index >= 0 ? dataUrl.slice(base64Index + 1) : dataUrl;

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return new Blob([], { type: 'application/octet-stream' });
  }
}

function getNodeMediaUrl(node: GraphNode): string | null {
  if (node.type === 'imageInput') {
    return (node.data as ImageInputNodeData).imageUrl ?? null;
  }
  if (node.type === 'videoInput') {
    return (node.data as VideoInputNodeData).videoUrl ?? null;
  }
  if (node.type === 'audioInput') {
    return (node.data as AudioInputNodeData).audioUrl ?? null;
  }
  return null;
}

function isMediaCandidate(node: GraphNode): boolean {
  const currentUrl = getNodeMediaUrl(node);
  return typeof currentUrl === 'string' && currentUrl.length > 0;
}

const readMediaRef = (node: GraphNode): string | null => {
  const data = node.data as typeof node.data & MediaBundleFields;
  const mediaRef = data.mediaRef;
  return typeof mediaRef === 'string' && mediaRef.trim().length > 0 ? mediaRef : null;
};

async function getNodeMediaBlob(
  node: GraphNode,
  signal: AbortSignal | undefined
): Promise<{ blob: Blob; mimeType: string; originalUrl: string | undefined } | null> {
  if (node.type !== 'imageInput' && node.type !== 'videoInput' && node.type !== 'audioInput') {
    return null;
  }

  const currentUrl = getNodeMediaUrl(node);
  if (!currentUrl) {
    return null;
  }

  if (currentUrl && isBase64DataUrl(currentUrl)) {
    const mimeType = parseMimeFromDataUrl(currentUrl);
    const blob = base64ToBlob(currentUrl);
    return { blob, mimeType, originalUrl: undefined };
  }

  try {
    const fetched = await fetchUrlAsBase64(currentUrl, { maxSizeBytes: undefined, signal });
    if (fetched !== null && fetched !== undefined && fetched.data) {
      return {
        blob: base64ToBlob(fetched.data),
        mimeType: fetched.mimeType,
        originalUrl: fetched.originalUrl,
      };
    }
  } catch (error) {
    console.warn('[bundle.mediaHandler] 获取媒体失败，已跳过节点', node.id, error);
  }

  return null;
}

function sanitizeNodeForBundle(node: GraphNode, mediaRef: string | null): GraphNode {
  if (node.type !== 'imageInput' && node.type !== 'videoInput' && node.type !== 'audioInput') {
    return node;
  }

  const data = { ...node.data } as typeof node.data & MediaBundleFields;

  data.cacheRef = undefined;
  data.cachedContent = undefined;

  if (node.type === 'imageInput') {
    (data as ImageInputNodeData & MediaBundleFields).imageUrl = null;
  } else if (node.type === 'videoInput') {
    (data as VideoInputNodeData & MediaBundleFields).videoUrl = null;
  } else {
    (data as AudioInputNodeData & MediaBundleFields).audioUrl = null;
  }

  if (mediaRef) {
    data.mediaRef = mediaRef;
  }

  return { ...node, data };
}

function validateManifestHasMedia(manifest: BundleManifest): boolean {
  return Boolean(manifest.mediaManifest && typeof manifest.mediaManifest === 'object');
}

async function importNodeMedia(params: {
  node: GraphNode;
  nodeGraphId: BundleImportHandlerContext['nodeGraphId'];
  manifest: BundleImportHandlerContext['manifest'];
  zip: BundleImportHandlerContext['zip'];
  errors: BundleImportHandlerContext['errors'];
  warnings: BundleImportHandlerContext['warnings'];
  signal: AbortSignal | undefined;
}): Promise<GraphNode> {
  const { node, nodeGraphId, manifest, zip, errors, warnings, signal } = params;
  if (node.type !== 'imageInput' && node.type !== 'videoInput' && node.type !== 'audioInput') {
    return node;
  }

  const data = { ...node.data } as typeof node.data & MediaBundleFields;
  const mediaRef = data.mediaRef;

  if (!mediaRef) {
    return node;
  }

  if (!validateManifestHasMedia(manifest)) {
    errors.push('文件里的素材信息读不出来');
    data.mediaRef = undefined;
    return { ...node, data };
  }

  const mediaEntry = manifest.mediaManifest[mediaRef];
  if (!mediaEntry) {
    // 节点 id 只进日志：界面只说结果。
    console.warn(
      `[bundle.import] 节点用到的素材在文件里找不到 nodeId=${node.id} mediaRef=${mediaRef}`,
    );
    warnings.push('有节点用到的素材在文件里找不到。');
    data.mediaRef = undefined;
    return { ...node, data };
  }

  const mediaFile = zip.file(mediaEntry.path);
  if (!mediaFile) {
    // 文件内路径只进日志：界面只说结果。
    console.warn(
      `[bundle.import] 文件里缺少素材 nodeId=${node.id} path=${mediaEntry.path}`,
    );
    warnings.push('有素材没能从文件里带进来。');
    data.mediaRef = undefined;
    return { ...node, data };
  }

  try {
    ensureNotAborted(signal);
    const blob = await mediaFile.async('blob');
    ensureNotAborted(signal);
    const typedBlob = new Blob([blob], { type: mediaEntry.mimeType });

    ensureNotAborted(signal);
    const stored = await storeBlobMedia(typedBlob, {
      nodeGraphId,
      nodeId: node.id,
      source: 'bundle',
      originalUrl: mediaEntry.originalUrls[0] || '',
      filenamePrefix: 'bundle',
      mimeType: mediaEntry.mimeType,
    });
    ensureNotAborted(signal);

    data.mediaRef = undefined;
    if (node.type === 'imageInput') {
      (data as ImageInputNodeData & MediaBundleFields).imageUrl = stored.url;
    } else if (node.type === 'videoInput') {
      (data as VideoInputNodeData & MediaBundleFields).videoUrl = stored.url;
    } else {
      (data as AudioInputNodeData & MediaBundleFields).audioUrl = stored.url;
    }
    data.cacheRef = undefined;

    return { ...node, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    // 节点 id 与异常原文只进日志：界面只说明结果。
    console.error(`[bundle.import] 节点素材导入失败 nodeId=${node.id}`, message);
    errors.push('有素材没能导入。');
    data.mediaRef = undefined;
    return { ...node, data };
  }
}

const handler: BundleAssetHandler = {
  id: 'bundle.assets.media',
  export: async ({ projectDocument, zip, zipWriteOptions, manifest, onProgress, signal }) => {
    const { nodeGraph } = projectDocument;
    const deduplicator = new MediaDeduplicator();
    const mediaCandidates = nodeGraph.nodes.filter(isMediaCandidate);
    const total = mediaCandidates.length;
    let processed = 0;

    if (total > 0) {
      if (onProgress) {
        onProgress({ stage: 'media', messageKey: 'bundle.export.media', processed, total, percent: undefined });
      }
    }

    for (const node of mediaCandidates) {
      ensureNotAborted(signal);
      const media = await getNodeMediaBlob(node, signal);
      ensureNotAborted(signal);
      if (media) {
        await deduplicator.addMedia(node.id, media.blob, media.mimeType, media.originalUrl);
      }
      processed += 1;
      if (onProgress) {
        onProgress({ stage: 'media', messageKey: 'bundle.export.media', processed, total, percent: undefined });
      }
    }

    const mediaManifest: Record<string, MediaManifestEntry> = {};
    const mediaMap = deduplicator.getMediaMap();

    for (const [hash, media] of mediaMap) {
      ensureNotAborted(signal);
      const ext = getExtensionFromMimeType(media.mimeType);
      const path = `${BUNDLE_PATHS.MEDIA_DIR}/${hash}.${ext}`;

      const content = await media.blob.arrayBuffer();
      zip.file(path, content, {
        compression: zipWriteOptions.compression,
        compressionOptions: zipWriteOptions.compressionOptions ?? null,
      });

      mediaManifest[hash] = {
        path,
        mimeType: media.mimeType,
        sizeBytes: media.blob.size,
        originalUrls: media.originalUrls,
      };
    }

    const stats = deduplicator.getStats();
    manifest.mediaManifest = mediaManifest;
    manifest.mediaStats = {
      totalCount: stats.totalCount,
      totalSizeBytes: stats.totalSizeBytes,
      deduplicatedSizeBytes: stats.deduplicatedSizeBytes,
    };

    const exportNodes = nodeGraph.nodes.map((node) => {
      const mediaRef = deduplicator.getNodeMediaRef(node.id);
      return sanitizeNodeForBundle(node, mediaRef);
    });

    return {
      ...projectDocument,
      nodeGraph: {
        ...nodeGraph,
        nodes: exportNodes,
      },
    };
  },
  import: async ({ projectDocument, nodeGraphId, manifest, zip, errors, warnings, onProgress, signal }) => {
    const { nodeGraph } = projectDocument;
    const total = nodeGraph.nodes.reduce((acc, node) => {
      if (node.type !== 'imageInput' && node.type !== 'videoInput' && node.type !== 'audioInput') {
        return acc;
      }
      return readMediaRef(node) ? acc + 1 : acc;
    }, 0);

    let processed = 0;
    let lastEmit = 0;
    const emitProgress = (force = false) => {
      if (!onProgress || total <= 0) return;
      const now = Date.now();
      if (!force && now - lastEmit < 80) return;
      lastEmit = now;
      onProgress({ stage: 'media', messageKey: 'bundle.import.media', processed, total, percent: undefined });
    };

    emitProgress(true);

    const importedNodes: GraphNode[] = [];
    for (const node of nodeGraph.nodes) {
      ensureNotAborted(signal);
      const isCandidate =
        (node.type === 'imageInput' || node.type === 'videoInput' || node.type === 'audioInput') &&
        Boolean(readMediaRef(node));

      const next = await importNodeMedia({
        node,
        nodeGraphId,
        manifest,
        zip,
        errors,
        warnings,
        signal,
      });

      importedNodes.push(next);

      if (isCandidate) {
        processed += 1;
        emitProgress();
      }
    }

    emitProgress(true);

    return {
      ...projectDocument,
      nodeGraph: {
        ...nodeGraph,
        nodes: importedNodes,
      },
    };
  },
};

registerBundleAssetHandler(handler);

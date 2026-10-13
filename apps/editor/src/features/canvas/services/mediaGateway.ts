import { getRuntimeBackendBaseUrl } from '@/client/store/runtimeStore';
import { storeBase64Media, type StoredMediaResult } from './mediaStorage';
import {
  isBase64DataUrl,
  extractMimeType,
  estimateBase64Size,
} from '../utils/mediaUtils';
import type { UnknownRecord } from '@/client/utils/typeGuards';

interface InlineDataPayloadFields {
  data: unknown | undefined;
  mime_type: unknown | undefined;
  mimeType: unknown | undefined;
}

type InlineDataPayloadSource = UnknownRecord & InlineDataPayloadFields;

const readInlineDataPayloadFields = (
  value: UnknownRecord,
): InlineDataPayloadFields => {
  const source = value as InlineDataPayloadSource;
  return {
    data: source.data,
    mime_type: source.mime_type,
    mimeType: source.mimeType,
  };
};

/** Gateway 处理结果 */
export interface MediaGatewayResult {
  /** 清洗后的输出（大媒体已替换为本地磁盘 URL） */
  outputs: UnknownRecord;
  /** 已缓存的项目列表 */
  cachedItems: Array<{
    cacheId: string;
    fieldPath: string;
    originalSize: number;
    mimeType: string;
  }>;
  /** 处理统计 */
  stats: {
    totalMediaFound: number;
    totalCached: number;
    totalBytesOffloaded: number;
    processingTimeMs: number;
  };
}

/** Gateway 配置选项 */
export interface MediaGatewayOptions {
  /** 触发缓存的最小大小阈值（默认 50KB） */
  minSizeThreshold: number | undefined;
  /** 递归扫描的最大深度（默认 15） */
  maxDepth: number | undefined;
  /** 是否等待所有写入完成（默认 false，非阻塞） */
  awaitWrites: boolean | undefined;
}

/** MediaGateway 接口 */
export interface IMediaGateway {
  /**
   * 处理节点输出，检测并缓存大型媒体
   */
  sanitizeOutputs(
    outputs: UnknownRecord,
    context: { nodeGraphId: string; nodeId: string; executionId: string | undefined },
    options: MediaGatewayOptions | undefined
  ): Promise<MediaGatewayResult>;
}

const DEFAULT_MIN_SIZE = 50 * 1024;
const DEFAULT_MAX_DEPTH = 15;

const isPlainObject = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class MediaGatewayImpl implements IMediaGateway {
  async sanitizeOutputs(
    outputs: UnknownRecord,
    context: { nodeGraphId: string; nodeId: string; executionId: string | undefined },
    options: MediaGatewayOptions | undefined
  ): Promise<MediaGatewayResult> {
    const start = Date.now();
    const minSizeThreshold = (options !== null && options !== undefined ? options.minSizeThreshold : undefined) ?? DEFAULT_MIN_SIZE;
    const maxDepth = (options !== null && options !== undefined ? options.maxDepth : undefined) ?? DEFAULT_MAX_DEPTH;
    const awaitWrites = (options !== null && options !== undefined ? options.awaitWrites : undefined) ?? false;

    const cachedItems: MediaGatewayResult['cachedItems'] = [];
    const writesToAwait: Promise<boolean>[] = [];
    let totalMediaFound = 0;
    let totalCached = 0;
    let totalBytesOffloaded = 0;

    const buildPath = (base: string, token: string | number): string => {
      if (!base) return typeof token === 'number' ? `[${token}]` : String(token);
      return typeof token === 'number' ? `${base}[${token}]` : `${base}.${token}`;
    };

    const processInlineData = async (
      inlineData: UnknownRecord,
      fieldPath: string
    ): Promise<unknown> => {
      totalMediaFound += 1;

      const typedInlineData = readInlineDataPayloadFields(inlineData);
      const data = typeof typedInlineData.data === 'string' ? typedInlineData.data : '';
      const mimeType =
        typeof typedInlineData.mime_type === 'string'
          ? typedInlineData.mime_type
          : typeof typedInlineData.mimeType === 'string'
            ? typedInlineData.mimeType
            : 'application/octet-stream';

      if (!data) {
        return inlineData;
      }

      const normalizedBase64 = data.trim().replace(/\s+/g, '');
      const dataUrl = `data:${mimeType};base64,${normalizedBase64}`;
      const estimatedSize = estimateBase64Size(normalizedBase64);

      if (estimatedSize < minSizeThreshold) {
        return inlineData;
      }

      const stored = await this.cacheDataUrl({
        dataUrl,
        mimeType,
        sizeBytes: estimatedSize,
        fieldPath,
        context,
        awaitWrites,
        writesToAwait,
      });

      if (!stored) {
        return inlineData;
      }

      const sizeBytes = stored.sizeBytes ?? estimatedSize;
      totalCached += 1;
      totalBytesOffloaded += sizeBytes;
      cachedItems.push({
        cacheId: stored.url,
        fieldPath: fieldPath || '<root>',
        originalSize: sizeBytes,
        mimeType,
      });

      // 返回本地磁盘 URL
      return stored.url;
    };

    const processValue = async (
      value: unknown,
      fieldPath: string,
      depth: number
    ): Promise<unknown> => {
      if (depth > maxDepth) {
        return value;
      }

      if (typeof value === 'string') {
        if (isBase64DataUrl(value)) {
          totalMediaFound += 1;
          const mimeType = extractMimeType(value);
          const estimatedSize = estimateBase64Size(value);

          if (estimatedSize >= minSizeThreshold) {
            const stored = await this.cacheDataUrl({
              dataUrl: value,
              mimeType,
              sizeBytes: estimatedSize,
              fieldPath,
              context,
              awaitWrites,
              writesToAwait,
            });

            if (stored) {
              const sizeBytes = stored.sizeBytes ?? estimatedSize;
              totalCached += 1;
              totalBytesOffloaded += sizeBytes;
              cachedItems.push({
                cacheId: stored.url,
                fieldPath: fieldPath || '<root>',
                originalSize: sizeBytes,
                mimeType,
              });
              // 返回本地磁盘 URL
              return stored.url;
            }
          }
        }
        return value;
      }

      if (Array.isArray(value)) {
        const processed = await Promise.all(
          value.map((item, idx) => processValue(item, buildPath(fieldPath, idx), depth + 1))
        );
        const changed = processed.some((item, idx) => item !== value[idx]);
        return changed ? processed : value;
      }

      if (isPlainObject(value)) {
        if (this.isInlineDataObject(value)) {
          return processInlineData(value, fieldPath);
        }

        let changed = false;
        const next: UnknownRecord = {};

        for (const [key, item] of Object.entries(value)) {
          const childPath = buildPath(fieldPath, key);
          if ((key === 'inline_data' || key === 'inlineData') && this.isInlineDataObject(item)) {
            const processed = await processInlineData(item as UnknownRecord, childPath);
            next[key] = processed;
            if (processed !== item) {
              changed = true;
            }
            continue;
          }

          const processed = await processValue(item, childPath, depth + 1);
          next[key] = processed;
          if (processed !== item) {
            changed = true;
          }
        }

        return changed ? next : value;
      }

      return value;
    };

    const sanitizedOutputs = (await processValue(outputs, '', 0)) as UnknownRecord;

    if (awaitWrites && writesToAwait.length > 0) {
      await Promise.all(writesToAwait);
    }

    return {
      outputs: sanitizedOutputs,
      cachedItems,
      stats: {
        totalMediaFound,
        totalCached,
        totalBytesOffloaded,
        processingTimeMs: Date.now() - start,
      },
    };
  }

  private isInlineDataObject(value: unknown): value is UnknownRecord {
    if (!isPlainObject(value)) return false;

    const typed = readInlineDataPayloadFields(value);
    const data = typed.data;
    const mime =
      typed.mime_type ??
      typed.mimeType;

    return typeof data === 'string' && data.length > 0 && typeof mime === 'string' && mime.length > 0;
  }

  private async cacheDataUrl(params: {
    dataUrl: string;
    mimeType: string;
    sizeBytes: number;
    fieldPath: string;
    context: { nodeGraphId: string; nodeId: string; executionId: string | undefined };
    awaitWrites: boolean;
    writesToAwait: Promise<boolean>[];
  }): Promise<StoredMediaResult | null> {
    const { dataUrl, fieldPath, context } = params;

    if (!getRuntimeBackendBaseUrl()) {
      console.warn('[MediaGateway] 未配置本地后端，无法缓存媒体', fieldPath);
      return null;
    }

    try {
      // 总是使用本地后端存储，不再使用 IndexedDB
      const stored = await storeBase64Media(dataUrl, {
        nodeGraphId: context.nodeGraphId,
        nodeId: context.nodeId,
        source: 'gateway',
        originalUrl: '',
        filenamePrefix: 'canvas',
      });
      return stored;
    } catch (error) {
      console.warn('[MediaGateway] 缓存媒体失败', fieldPath, error);
      return null;
    }
  }
}

export const sharedMediaGateway = new MediaGatewayImpl();
export const createMediaGateway = (): IMediaGateway => new MediaGatewayImpl();

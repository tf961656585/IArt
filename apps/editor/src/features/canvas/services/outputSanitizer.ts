/**
 * 统一输出清洗服务
 *
 * 三层清洗策略：
 * - Tier 1 (≥50KB): 大媒体 → 本地磁盘（Hub）URL
 * - Tier 2 (5KB-50KB): 中等数据 → 截断为占位符
 * - Tier 3 (<5KB): 小数据 → 保留原值
 *
 * 设计目标：支持"无限节点"画布，彻底解决 base64 内存泄漏
 */

import { isBase64DataUrl, estimateBase64Size } from '../utils/mediaUtils';
import { sharedMediaGateway, type IMediaGateway } from './mediaGateway';
import type { UnknownRecord } from '@/client/utils/typeGuards';
import { cast } from '@/lib/utils';

interface InlineDataFields {
  data: unknown | undefined;
}

interface NodeDataCleanFields {
  cacheRef: unknown | undefined;
  cachedContent: unknown | undefined;
}

/** 大媒体阈值：超过此值写入本地磁盘 */
const LARGE_THRESHOLD = 50 * 1024; // 50KB

/** 中等数据阈值：超过此值截断 */
const MEDIUM_THRESHOLD = 5 * 1024; // 5KB

/** 最大递归深度 */
const MAX_DEPTH = 15;

/** 截断占位符 */
const TRUNCATE_PLACEHOLDER = '[truncated]';
const BASE64_TRUNCATE_PLACEHOLDER = '[base64-truncated]';

/** 清洗配置选项 */
export interface SanitizeOptions {
  /** Tier 1 阈值：大于此值的媒体写入本地磁盘（Hub） (默认 50KB) */
  largeThreshold: number | undefined;
  /** Tier 2 阈值：大于此值的数据截断 (默认 5KB) */
  mediumThreshold: number | undefined;
  /** 最大递归深度 (默认 15) */
  maxDepth: number | undefined;
  /** 是否等待写入完成 (默认 false) */
  awaitWrites: boolean | undefined;
  /** 上下文信息，用于生成 cacheId */
  context: { nodeGraphId: string; nodeId: string; executionId: string | undefined } | undefined;
}

/** 清洗结果 */
export interface SanitizeResult {
  /** 清洗后的输出 */
  outputs: UnknownRecord;
  /** 统计信息 */
  stats: {
    /** 写入本地磁盘（Hub）的项数 */
    cachedToIndexedDB: number;
    /** 截断的项数 */
    truncated: number;
    /** 卸载的字节数 */
    bytesOffloaded: number;
  };
}

/** 输出清洗服务接口 */
export interface IOutputSanitizer {
  /**
   * 异步清洗输出
   * - 大媒体 → 本地磁盘（Hub）URL
   * - 中等数据 → 截断
   * - 小数据 → 保留
   */
  sanitize(
    outputs: UnknownRecord,
    options: SanitizeOptions | undefined
  ): Promise<SanitizeResult>;

  /**
   * 同步清洗输出（仅截断，不写本地磁盘）
   * 用于 ExecutionStore 写入时拦截
   */
  sanitizeSync(outputs: UnknownRecord): UnknownRecord;
}

/**
 * 输出清洗服务实现
 */
class OutputSanitizerImpl implements IOutputSanitizer {
  private truncateCount = 0;

  constructor(private mediaGateway: IMediaGateway = sharedMediaGateway) {}

  async sanitize(
    outputs: UnknownRecord,
    options: SanitizeOptions | undefined
  ): Promise<SanitizeResult> {
    const largeThreshold = (options !== null && options !== undefined ? options.largeThreshold : undefined) ?? LARGE_THRESHOLD;
    const mediumThreshold = (options !== null && options !== undefined ? options.mediumThreshold : undefined) ?? MEDIUM_THRESHOLD;
    const maxDepth = (options !== null && options !== undefined ? options.maxDepth : undefined) ?? MAX_DEPTH;
    const awaitWrites = (options !== null && options !== undefined ? options.awaitWrites : undefined);

    // Tier 1: 如果有 context，使用 MediaGateway 处理大媒体
    const context = options !== undefined ? options.context : undefined;
    if (context !== undefined) {
      const gatewayResult = await this.mediaGateway.sanitizeOutputs(
        outputs,
        context,
        {
          minSizeThreshold: largeThreshold,
          maxDepth,
          awaitWrites: typeof awaitWrites === 'boolean' ? awaitWrites : undefined,
        }
      );

      // Tier 2: 对 MediaGateway 处理后的结果，再截断中等数据
      this.truncateCount = 0;
      const tier2Outputs = this.sanitizeSyncInternal(
        gatewayResult.outputs,
        mediumThreshold,
        maxDepth
      );

      return {
        outputs: tier2Outputs as UnknownRecord,
        stats: {
          cachedToIndexedDB: gatewayResult.stats.totalCached,
          truncated: this.truncateCount,
          bytesOffloaded: gatewayResult.stats.totalBytesOffloaded,
        },
      };
    }

    // 无 context: 仅应用 Tier 2/3
    this.truncateCount = 0;
    const sanitized = this.sanitizeSyncInternal(outputs, mediumThreshold, maxDepth);
    return {
      outputs: sanitized as UnknownRecord,
      stats: {
        cachedToIndexedDB: 0,
        truncated: this.truncateCount,
        bytesOffloaded: 0,
      },
    };
  }

  sanitizeSync(outputs: UnknownRecord): UnknownRecord {
    return this.sanitizeSyncInternal(outputs, MEDIUM_THRESHOLD, MAX_DEPTH) as UnknownRecord;
  }

  /**
   * 内部递归清洗实现
   */
  private sanitizeSyncInternal(value: unknown, threshold: number, depth: number): unknown {
    if (depth <= 0) return value;

    // 字符串：检测并截断 base64
    if (typeof value === 'string') {
      return this.sanitizeString(value, threshold);
    }

    // 数组：递归处理每个元素
    if (Array.isArray(value)) {
      let changed = false;
      const result = value.map((item) => {
        const sanitized = this.sanitizeSyncInternal(item, threshold, depth - 1);
        if (sanitized !== item) changed = true;
        return sanitized;
      });
      return changed ? result : value;
    }

    // 对象：递归处理每个属性
    if (value && typeof value === 'object') {
      return this.sanitizeObject(value as UnknownRecord, threshold, depth);
    }

    return value;
  }

  /**
   * 清洗字符串值
   */
  private sanitizeString(value: string, threshold: number): string {
    // 检测 base64 data URL
    if (isBase64DataUrl(value)) {
      const size = estimateBase64Size(value);
      if (size >= threshold) {
        this.truncateCount++;
        const colonIndex = value.indexOf('base64,');
        return colonIndex >= 0
          ? value.substring(0, colonIndex + 7) + TRUNCATE_PLACEHOLDER
          : BASE64_TRUNCATE_PLACEHOLDER;
      }
      return value;
    }

    // 检测裸 base64 字符串（超过阈值且为纯 base64 字符）
    if (value.length > threshold) {
      const cleanValue = value.replace(/\s/g, '');
      if (/^[A-Za-z0-9+/=]+$/.test(cleanValue) && cleanValue.length > threshold) {
        this.truncateCount++;
        return BASE64_TRUNCATE_PLACEHOLDER;
      }
    }

    return value;
  }

  /**
   * 清洗对象值
   */
  private sanitizeObject(
    obj: UnknownRecord,
    threshold: number,
    depth: number
  ): UnknownRecord {
    let changed = false;
    const result: UnknownRecord = {};

    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();

      // inline_data 特殊处理
      if (lowerKey === 'inline_data' || lowerKey === 'inlinedata') {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const inlineObj = val as InlineDataFields;
          if (typeof inlineObj.data === 'string' && inlineObj.data.length > 1000) {
            this.truncateCount++;
            result[key] = { ...inlineObj, data: TRUNCATE_PLACEHOLDER };
            changed = true;
            continue;
          }
        }
      }

      // 已知的大数据字段名，即使不是标准 base64 格式也截断
      if (
        (lowerKey === 'data' ||
          lowerKey === 'b64_json' ||
          lowerKey === 'b64json' ||
          lowerKey === 'image_base64' ||
          lowerKey === 'base64') &&
        typeof val === 'string' &&
        val.length > threshold
      ) {
        this.truncateCount++;
        result[key] = TRUNCATE_PLACEHOLDER;
        changed = true;
        continue;
      }

      const sanitized = this.sanitizeSyncInternal(val, threshold, depth - 1);
      result[key] = sanitized;
      if (sanitized !== val) changed = true;
    }

    return changed ? result : obj;
  }
}

/** 共享实例 */
export const sharedOutputSanitizer = new OutputSanitizerImpl();

/** 创建新实例（用于测试或自定义配置） */
export const createOutputSanitizer = (mediaGateway: IMediaGateway | undefined): IOutputSanitizer =>
  new OutputSanitizerImpl(mediaGateway);

// ============================================================================
// 节点数据净化 - 用于导入后清理冗余的 base64 数据
// ============================================================================

import type { GraphNode, GraphNodeData } from '../types';

/** 媒体 URL 字段列表 */
const NODE_MEDIA_URL_FIELDS = ['imageUrl', 'videoUrl', 'audioUrl'] as const;

/**
 * 净化单个节点的数据，移除已脱水的 base64 URL
 *
 * 使用场景：
 * - 导入后，确保进入 Zustand 状态树的数据不包含冗余 base64
 * - 确保历史或异常数据中的 base64 不泄漏到状态树
 *
 * @param node - 要净化的节点
 * @returns 净化后的节点（如果没有修改则返回原节点引用）
 */
export function sanitizeNodeForStore(node: GraphNode): GraphNode {
  if (!node.data) return node;

  const data = cast<UnknownRecord>(node.data);

  let modified = false;
  const cleanedData = { ...data } as NodeDataCleanFields & UnknownRecord;

  // 清理媒体 URL 字段中的 base64 数据
  for (const field of NODE_MEDIA_URL_FIELDS) {
    const value = cleanedData[field];
    if (typeof value === 'string' && isBase64DataUrl(value)) {
      cleanedData[field] = null;
      modified = true;
    }
  }

  // 清理遗留的 cacheRef 字段（旧数据）
  if ('cacheRef' in cleanedData) {
    delete (cleanedData as { cacheRef: unknown | undefined }).cacheRef;
    modified = true;
  }

  // 清理 cachedContent（旧版数据结构）
  if ('cachedContent' in cleanedData && cleanedData.cachedContent) {
    cleanedData.cachedContent = undefined;
    modified = true;
  }

  if (!modified) return node;

  return {
    ...node,
    data: cast<GraphNodeData>(cleanedData),
  };
}

/**
 * 批量净化节点列表
 *
 * @param nodes - 要净化的节点列表
 * @returns 净化后的节点列表
 */
export function sanitizeNodesForStore(nodes: GraphNode[]): GraphNode[] {
  return nodes.map(sanitizeNodeForStore);
}

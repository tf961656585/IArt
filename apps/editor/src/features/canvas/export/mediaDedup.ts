/**
 * 媒体去重模块
 * - 使用 SHA-256 哈希进行内容去重
 * - 支持批量处理和统计
 */

import type { DedupedMedia } from './bundleTypes';

/** MIME 类型到扩展名的映射 */
const MIME_TO_EXTENSION: Record<string, string> = {
  // 图片
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  // 视频
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'video/3gpp': '3gp',
  // 音频
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/opus': 'opus',
  'audio/webm': 'weba',
};

/**
 * 从 MIME 类型获取文件扩展名
 */
export function getExtensionFromMimeType(mimeType: string): string {
  const firstPart = mimeType.toLowerCase().split(';')[0];
  const normalized = firstPart !== undefined ? firstPart.trim() : '';
  return MIME_TO_EXTENSION[normalized] || 'bin';
}

/**
 * 计算媒体内容的 SHA-256 哈希（前 8 字节，16 字符 hex）
 * 使用 Web Crypto API，兼容性好且性能优秀
 */
export async function computeMediaHash(blob: Blob): Promise<string> {
  try {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = new Uint8Array(hashBuffer);
    // 取前 8 字节（16 字符 hex），足够避免碰撞
    return Array.from(hashArray.slice(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (error) {
    // 降级方案：使用简单哈希
    console.warn('[mediaDedup] crypto.subtle 不可用，使用降级哈希', error);
    return fallbackHash(blob);
  }
}

/**
 * 降级哈希方案（当 crypto.subtle 不可用时）
 * 基于文件大小和部分内容生成简单哈希
 */
async function fallbackHash(blob: Blob): Promise<string> {
  const size = blob.size;
  // 读取文件头部和尾部各 1KB
  const headSlice = blob.slice(0, 1024);
  const tailSlice = blob.slice(Math.max(0, size - 1024), size);

  const headBuffer = await headSlice.arrayBuffer();
  const tailBuffer = await tailSlice.arrayBuffer();

  const headArray = new Uint8Array(headBuffer);
  const tailArray = new Uint8Array(tailBuffer);

  // 简单的 DJB2 哈希
  let hash = 5381;
  for (const byte of headArray) {
    hash = ((hash << 5) + hash + byte) >>> 0;
  }
  for (const byte of tailArray) {
    hash = ((hash << 5) + hash + byte) >>> 0;
  }
  hash = ((hash << 5) + hash + size) >>> 0;

  return hash.toString(16).padStart(8, '0') + size.toString(16).padStart(8, '0');
}

/**
 * 媒体去重器
 * 收集媒体并按内容哈希去重
 */
export class MediaDeduplicator {
  /** 去重后的媒体映射（hash -> DedupedMedia） */
  private mediaMap = new Map<string, DedupedMedia>();

  /** 节点 ID 到媒体 hash 的映射 */
  private nodeMediaMap = new Map<string, string>();

  /** 去重节省的总大小 */
  private deduplicatedBytes = 0;

  /**
   * 添加媒体并返回其哈希
   * @param nodeId 节点 ID
   * @param blob 媒体 Blob
   * @param mimeType MIME 类型
   * @param originalUrl 原始 URL（可选）
   * @returns 媒体哈希
   */
  async addMedia(
    nodeId: string,
    blob: Blob,
    mimeType: string,
    originalUrl: string | undefined
  ): Promise<string> {
    const hash = await computeMediaHash(blob);

    const existing = this.mediaMap.get(hash);
    if (existing) {
      // 已存在相同内容，添加引用
      if (!existing.nodeIds.includes(nodeId)) {
        existing.nodeIds.push(nodeId);
      }
      if (originalUrl && !existing.originalUrls.includes(originalUrl)) {
        existing.originalUrls.push(originalUrl);
      }
      // 记录去重节省的大小
      this.deduplicatedBytes += blob.size;
    } else {
      // 新媒体
      this.mediaMap.set(hash, {
        hash,
        blob,
        mimeType,
        originalUrls: originalUrl ? [originalUrl] : [],
        nodeIds: [nodeId],
      });
    }

    // 记录节点到媒体的映射
    this.nodeMediaMap.set(nodeId, hash);

    return hash;
  }

  /**
   * 获取去重后的媒体映射
   */
  getMediaMap(): Map<string, DedupedMedia> {
    return this.mediaMap;
  }

  /**
   * 获取节点的媒体引用
   */
  getNodeMediaRef(nodeId: string): string | null {
    return this.nodeMediaMap.get(nodeId) ?? null;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalCount: number;
    totalSizeBytes: number;
    deduplicatedSizeBytes: number;
    uniqueCount: number;
  } {
    let totalSizeBytes = 0;
    for (const media of this.mediaMap.values()) {
      totalSizeBytes += media.blob.size;
    }

    return {
      totalCount: this.nodeMediaMap.size,
      uniqueCount: this.mediaMap.size,
      totalSizeBytes,
      deduplicatedSizeBytes: this.deduplicatedBytes,
    };
  }

  /**
   * 清空去重器
   */
  clear(): void {
    this.mediaMap.clear();
    this.nodeMediaMap.clear();
    this.deduplicatedBytes = 0;
  }
}

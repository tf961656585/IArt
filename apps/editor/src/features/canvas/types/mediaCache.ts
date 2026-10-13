/**
 * 媒体缓存类型定义
 * - 定义分层存储架构的核心类型
 */

/** 媒体缓存条目（桌面端为内存缓存/本地落盘优先） */
export interface MediaCacheEntry {
  /** 缓存唯一标识 */
  cacheId: string;
  /** 二进制数据 */
  data: Blob;
  /** MIME 类型 */
  mimeType: string;
  /** 原始 URL */
  originalUrl: string;
  /** 缓存时间戳 */
  cachedAt: number;
  /** 所属画板 ID */
  nodeGraphId: string;
  /** 所属节点 ID */
  nodeId: string;
  /** 文件大小（字节） */
  sizeBytes: number;
}

/** Object URL 池条目 */
export interface ObjectURLPoolEntry {
  /** Object URL */
  objectUrl: string;
  /** 缓存 ID */
  cacheId: string;
  /** 引用计数 */
  refCount: number;
  /** 最后访问时间 */
  lastAccess: number;
  /** 文件大小（字节） */
  sizeBytes: number;
}

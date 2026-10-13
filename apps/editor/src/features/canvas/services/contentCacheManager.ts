/**
 * 内容缓存管理器
 * - 管理后台缓存任务队列
 * - 控制并发数，避免同时下载过多大文件
 * - 提供缓存状态订阅
 */

import { fetchUrlAsBase64, isBase64DataUrl } from '../utils/contentCacheService';

import type { DynamicRecord } from '@/client/utils/typeGuards';
import { useCanvasStore } from '../store/canvasStore';
import { storeBlobMedia } from './mediaStorage';
import { registerAndCommitMediaAsset } from './localMediaImport';
import type { NodeContentCache } from '../types/node';

export type CacheTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export type CacheableMediaType = 'image' | 'video' | 'audio';

export interface CacheTask {
  id: string;
  nodeId: string;
  nodeGraphId: string;
  url: string;
  mediaType: CacheableMediaType;
  status: CacheTaskStatus;
  createdAt: number;
  error: string | undefined;
}

interface CacheManagerConfig {
  /** 最大并发数 */
  maxConcurrent: number;
  /** 最大文件大小 (字节) */
  maxFileSizeBytes: number;
}

const DEFAULT_CONFIG: CacheManagerConfig = {
  maxConcurrent: 2,
  maxFileSizeBytes: 100 * 1024 * 1024, // 100MB
};

type CacheListener = (tasks: CacheTask[]) => void;

const base64ToBlob = (dataUrl: string, mimeType: string): Blob => {
  const parts = dataUrl.split(',', 2);
  const base64 = parts.length === 2 ? (parts[1] ?? '') : dataUrl;
  const cleanMime = mimeType || 'application/octet-stream';

  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(base64, 'base64');
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return new Blob([bytes], { type: cleanMime });
  }

  if (typeof atob === 'function') {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: cleanMime });
  }

  throw new Error('当前环境不支持 base64 转换');
};

class ContentCacheManagerImpl {
  private queue: CacheTask[] = [];
  private running: Map<string, CacheTask> = new Map();
  private config: CacheManagerConfig;
  private listeners: Set<CacheListener> = new Set();

  constructor(config: Partial<CacheManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 提交缓存任务
   * @returns 任务 ID，如果已是 base64 则返回空字符串
   */
  enqueue(params: {
    nodeId: string;
    nodeGraphId: string;
    url: string;
    mediaType: CacheableMediaType;
  }): string {
    // 跳过已是 base64 的内容
    if (isBase64DataUrl(params.url)) {
      return '';
    }

    // 检查是否已有相同任务（相同节点和URL）
    const existingInQueue = this.queue.find(
      (t) => t.nodeId === params.nodeId && t.url === params.url && t.status !== 'failed'
    );
    if (existingInQueue) {
      return existingInQueue.id;
    }

    // 检查是否正在运行
    for (const task of this.running.values()) {
      if (task.nodeId === params.nodeId && task.url === params.url) {
        return task.id;
      }
    }

    const task: CacheTask = {
      id: `cache_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...params,
      status: 'pending',
      createdAt: Date.now(),
      error: undefined,
    };

    this.queue.push(task);
    this.notifyListeners();
    this.processQueue();
    return task.id;
  }

  /**
   * 处理队列
   */
  private processQueue(): void {
    while (
      this.running.size < this.config.maxConcurrent &&
      this.queue.some((t) => t.status === 'pending')
    ) {
      const task = this.queue.find((t) => t.status === 'pending');
      if (!task) break;

      task.status = 'running';
      this.running.set(task.id, task);
      this.notifyListeners();

      // 异步执行任务
      void this.executeTask(task);
    }
  }

  /**
   * 执行单个缓存任务
   */
  private async executeTask(task: CacheTask): Promise<void> {
    try {
      const cached = await fetchUrlAsBase64(task.url, {
        maxSizeBytes: this.config.maxFileSizeBytes,
        signal: undefined,
      });

      if (cached) {
        // 写入节点缓存
        await this.writeCacheToNode(task.nodeId, task.nodeGraphId, cached);
        task.status = 'completed';
        console.log(`[ContentCacheManager] 缓存成功: ${task.nodeId}`);
      } else {
        throw new Error('缓存返回空结果');
      }
    } catch (error) {
      task.error = error instanceof Error ? error.message : '未知错误';
      task.status = 'failed';
      console.warn(`[ContentCacheManager] 缓存失败: ${task.url}`, task.error);
    } finally {
      this.running.delete(task.id);
      this.notifyListeners();
      // 继续处理队列中的其他任务
      this.processQueue();
    }
  }

  /**
   * 写入节点缓存
   * 缓存完成后清除原始 URL，避免内存中同时存在多份数据
   */
  private async writeCacheToNode(
    nodeId: string,
    nodeGraphId: string,
    cached: NodeContentCache
  ): Promise<void> {
    const state = useCanvasStore.getState();
    if (!state.nodeGraph || state.nodeGraph.id !== nodeGraphId) {
      console.warn('[ContentCacheManager] 画板已切换，跳过缓存写入');
      return;
    }

    const node = state.nodeGraph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      console.warn('[ContentCacheManager] 节点不存在，跳过缓存写入');
      return;
    }

    let blob: Blob;
    try {
      blob = base64ToBlob(cached.data, cached.mimeType);
    } catch (error) {
      console.error('[ContentCacheManager] base64 转 Blob 失败', error);
      return;
    }

    const stored = await storeBlobMedia(blob, {
      nodeGraphId,
      nodeId,
      source: 'content-cache',
      originalUrl: cached.originalUrl,
      filenamePrefix: 'canvas',
      mimeType: cached.mimeType,
    });

    const mediaType = node.type === 'imageInput' ? 'image' as const
      : node.type === 'videoInput' ? 'video' as const
      : 'audio' as const;
    const registered = await registerAndCommitMediaAsset(stored.url, mediaType, {
      sizeBytes: stored.sizeBytes,
      mimeType: stored.mimeType,
      width: undefined,
      height: undefined,
      durationMs: undefined,
    });

    // 根据节点类型清除原始 URL，数据已写入本地磁盘
    // 这避免了内存中同时存在 URL 字符串和 Blob 数据
    const urlClearFields: DynamicRecord = {
      cachedContent: undefined,
      mediaError: undefined,
    };

    // 根据节点类型确定要更新的 URL 字段
    if (node.type === 'imageInput') {
      (urlClearFields as { imageUrl: string | undefined }).imageUrl = stored.url;
    } else if (node.type === 'videoInput') {
      (urlClearFields as { videoUrl: string | undefined }).videoUrl = stored.url;
    } else if (node.type === 'audioInput') {
      (urlClearFields as { audioUrl: string | undefined }).audioUrl = stored.url;
    }

    if (registered.assetId) {
      (urlClearFields as { assetId: string | undefined }).assetId = registered.assetId;
    }

    state.updateNodeData(nodeId, urlClearFields, undefined);
  }

  /**
   * 订阅状态变化
   * @returns 取消订阅函数
   */
  subscribe(listener: CacheListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const snapshot = [...this.queue];
    this.listeners.forEach((fn) => fn(snapshot));
  }

  /**
   * 获取节点的缓存状态
   */
  getTaskStatus(nodeId: string): CacheTaskStatus | null {
    // 先检查正在运行的
    for (const task of this.running.values()) {
      if (task.nodeId === nodeId) {
        return task.status;
      }
    }
    // 再检查队列中的
    const task = this.queue.find((t) => t.nodeId === nodeId);
    return (task !== null && task !== undefined ? task.status : undefined) ?? null;
  }

  /**
   * 获取节点的缓存任务
   */
  getTask(nodeId: string): CacheTask | null {
    for (const task of this.running.values()) {
      if (task.nodeId === nodeId) {
        return task;
      }
    }
    return this.queue.find((t) => t.nodeId === nodeId) ?? null;
  }

  /**
   * 获取所有任务快照
   */
  getAllTasks(): CacheTask[] {
    return [...this.queue];
  }

  /**
   * 获取统计信息
   */
  getStats(): { pending: number; running: number; completed: number; failed: number } {
    const stats = { pending: 0, running: 0, completed: 0, failed: 0 };
    for (const task of this.queue) {
      stats[task.status]++;
    }
    return stats;
  }

  /**
   * 清理已完成/失败的任务
   */
  cleanup(): void {
    this.queue = this.queue.filter(
      (t) => t.status === 'pending' || t.status === 'running'
    );
    this.notifyListeners();
  }

  /**
   * 取消指定节点的缓存任务
   */
  cancel(nodeId: string): boolean {
    const taskIndex = this.queue.findIndex(
      (t) => t.nodeId === nodeId && (t.status === 'pending' || t.status === 'running')
    );
    if (taskIndex === -1) return false;

    const task = this.queue[taskIndex];
    if (!task) return false;
    if (task.status === 'running') {
      // 正在运行的任务无法真正取消，但可以标记
      this.running.delete(task.id);
    }
    this.queue.splice(taskIndex, 1);
    this.notifyListeners();
    return true;
  }

  /**
   * 清空所有任务
   */
  clear(): void {
    this.queue = [];
    this.running.clear();
    this.notifyListeners();
  }
}

// 单例导出
export const ContentCacheManager = new ContentCacheManagerImpl();

// 导出类型以便测试
export type { CacheManagerConfig, CacheListener };

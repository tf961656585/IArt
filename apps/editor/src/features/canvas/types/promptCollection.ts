/**
 * 提示词收藏类型定义
 */

/**
 * 收藏的提示词条目
 */
export interface PromptCollectionItem {
  /** 唯一标识 (UUID) */
  id: string;
  /** 用户命名 */
  name: string;
  /** 提示词内容 */
  content: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/**
 * 提示词上传事件（用于开发者调优分析）
 */
export interface PromptUploadEvent {
  /** 操作类型 */
  type: 'create' | 'update' | 'delete';
  /** 条目 ID */
  itemId: string;
  /** 提示词内容（仅 create/update） */
  content: string | undefined;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 带匿名 ID 的上传事件（发送到服务端）
 */
export interface PromptUploadEventWithAnonymousId extends PromptUploadEvent {
  /** 匿名用户标识 */
  anonymousId: string;
}

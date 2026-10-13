/**
 * 提示词分析数据上传已下线。
 * 保留函数签名仅用于兼容调用点，不再收集或上传任何数据。
 */

import type { PromptUploadEvent } from '../types/promptCollection';

export function trackPromptEvent(_event: Omit<PromptUploadEvent, 'timestamp'>): void {
  // analytics upload retired
}

export function usePromptAnalytics(): void {
  // analytics upload retired
}

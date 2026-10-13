/**
 * System Prompt Contract
 *
 * 系统提示词库的 Zod schema + TypeScript 类型。
 * 用户级、跨项目的全局资源，独立于 PromptPresetItem。
 *
 * 设计依据: docs/chat/07-系统提示词库.md
 */

import * as z from 'zod';

// ────────────────────────────────────────────
// 1. SystemPromptItem — 系统提示词库条目
// ────────────────────────────────────────────

export const SystemPromptItemSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type SystemPromptItem = z.infer<typeof SystemPromptItemSchema>;

// ────────────────────────────────────────────
// 2. Storage IPC 参数/返回值 Schema（N 组）
// ────────────────────────────────────────────

// List

export const StorageListSystemPromptsParamsSchema = z.object({
  keyword: z.string().optional(),
});

export type StorageListSystemPromptsParams = z.infer<typeof StorageListSystemPromptsParamsSchema>;

export interface StorageListSystemPromptsResult {
  items: SystemPromptItem[];
}

// Get

export const StorageGetSystemPromptParamsSchema = z.object({
  id: z.string(),
});

export type StorageGetSystemPromptParams = z.infer<typeof StorageGetSystemPromptParamsSchema>;

export interface StorageGetSystemPromptResult {
  item: SystemPromptItem | null;
}

// Create

export const StorageCreateSystemPromptParamsSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
});

export type StorageCreateSystemPromptParams = z.infer<typeof StorageCreateSystemPromptParamsSchema>;

export interface StorageCreateSystemPromptResult {
  item: SystemPromptItem;
}

// Update

export const StorageUpdateSystemPromptParamsSchema = z.object({
  id: z.string(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
});

export type StorageUpdateSystemPromptParams = z.infer<typeof StorageUpdateSystemPromptParamsSchema>;

export interface StorageUpdateSystemPromptResult {
  item: SystemPromptItem | null;
}

// Delete

export const StorageDeleteSystemPromptParamsSchema = z.object({
  id: z.string(),
});

export type StorageDeleteSystemPromptParams = z.infer<typeof StorageDeleteSystemPromptParamsSchema>;

export interface StorageDeleteSystemPromptResult {
  success: boolean;
}

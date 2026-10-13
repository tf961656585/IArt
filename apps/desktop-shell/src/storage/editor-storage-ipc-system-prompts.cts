/**
 * System Prompts IPC Handler Registration (N 组)
 *
 * 独立于项目级存储，用户级全局资源。
 * IPC 边界使用 Zod parse 校验。
 */

import { ipcMain } from 'electron';
import {
  EDITOR_STORAGE_IPC_CHANNELS,
  StorageListSystemPromptsParamsSchema,
  StorageGetSystemPromptParamsSchema,
  StorageCreateSystemPromptParamsSchema,
  StorageUpdateSystemPromptParamsSchema,
  StorageDeleteSystemPromptParamsSchema,
} from '@iart/contracts';
import {
  listSystemPrompts,
  getSystemPrompt,
  createSystemPrompt,
  updateSystemPrompt,
  deleteSystemPrompt,
} from './editor-storage-system-prompts.cjs';

const CH = EDITOR_STORAGE_IPC_CHANNELS;

export function registerSystemPromptStorageIpcHandlers(): void {
  ipcMain.handle(CH.LIST_SYSTEM_PROMPTS, (_event, raw) => {
    const parsed = StorageListSystemPromptsParamsSchema.parse(raw);
    const items = listSystemPrompts(parsed.keyword);
    return { items };
  });

  ipcMain.handle(CH.GET_SYSTEM_PROMPT, (_event, raw) => {
    const parsed = StorageGetSystemPromptParamsSchema.parse(raw);
    const item = getSystemPrompt(parsed.id);
    return { item };
  });

  ipcMain.handle(CH.CREATE_SYSTEM_PROMPT, (_event, raw) => {
    const parsed = StorageCreateSystemPromptParamsSchema.parse(raw);
    const item = createSystemPrompt({
      name: parsed.name,
      description: parsed.description,
      systemPrompt: parsed.systemPrompt,
    });
    return { item };
  });

  ipcMain.handle(CH.UPDATE_SYSTEM_PROMPT, (_event, raw) => {
    const parsed = StorageUpdateSystemPromptParamsSchema.parse(raw);
    const item = updateSystemPrompt({
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      systemPrompt: parsed.systemPrompt,
    });
    return { item };
  });

  ipcMain.handle(CH.DELETE_SYSTEM_PROMPT, (_event, raw) => {
    const parsed = StorageDeleteSystemPromptParamsSchema.parse(raw);
    const success = deleteSystemPrompt(parsed.id);
    return { success };
  });
}

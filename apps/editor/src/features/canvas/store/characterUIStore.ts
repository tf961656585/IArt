/**
 * 角色预设 UI 状态管理
 * - 角色库弹窗状态
 * - 保存角色弹窗状态
 * - 当前项目已选角色
 * - 待放置角色节点状态
 */

import { create } from 'zustand';
import type { CharacterIndexItem } from '../types/character';
import { MAX_AVATAR_DISPLAY_COUNT } from '../types/character';
import { CharacterStore } from '../services/characterStore';
import {
  getCurrentProjectCharacterPins,
  setCurrentProjectCharacterPinnedIds,
} from '../storage/backend';

const PINS_RETRY_DELAY_MS = 1200;

const isErrorStatus = (error: unknown, targetStatus: number): boolean => {
  if (!error || typeof error !== 'object') return false;
  if (!('status' in error)) return false;
  return (error as { status: number | undefined }).status === targetStatus;
};

const extractErrorMessage = (error: unknown): string => {
  if (!error || typeof error !== 'object') return '角色固定列表加载失败';
  if ('message' in error && typeof (error as { message: unknown | undefined }).message === 'string') {
    const message = (error as { message: string }).message.trim();
    return message || '角色固定列表加载失败';
  }
  return '角色固定列表加载失败';
};

const normalizePinnedCharacterIds = (ids: unknown): string[] => {
  if (!Array.isArray(ids)) return [];
  return Array.from(
    new Set(
      ids
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    )
  ).slice(0, MAX_AVATAR_DISPLAY_COUNT);
};

let pinsRetryTimer: ReturnType<typeof setTimeout> | null = null;

const clearPinsRetryTimer = (): void => {
  if (!pinsRetryTimer) return;
  clearTimeout(pinsRetryTimer);
  pinsRetryTimer = null;
};

const schedulePinsRetry = (retry: () => void): void => {
  if (pinsRetryTimer) return;
  pinsRetryTimer = setTimeout(() => {
    pinsRetryTimer = null;
    retry();
  }, PINS_RETRY_DELAY_MS);
};

/** 待放置角色信息 */
interface PendingCharacterPlacement {
  /** 角色 ID */
  characterId: string;
  /** 角色名称 */
  characterName: string;
}

interface CharacterUIState {
  /** 角色库列表（轻量级索引） */
  characters: CharacterIndexItem[];
  /** 是否已至少加载过一次（用于避免在未加载前误判无效 ID） */
  hasLoaded: boolean;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 最近一次角色索引加载是否成功（用于判断索引快照是否稳定） */
  lastCharacterIndexLoadOk: boolean;
  /** 当前项目固定角色 IDs（新来源） */
  pinnedCharacterIds: string[];
  /** 项目 pins 是否正在读取/写入 */
  pinsLoading: boolean;
  /** 迁移未就绪（503） */
  migrationPending: boolean;
  /** 最近一次 pins 读取是否成功 */
  lastPinsLoadOk: boolean;
  /** pins 读取/保存错误 */
  pinsError: string | null;

  /** 角色库弹窗状态 */
  libraryOpen: boolean;

  /** 保存角色弹窗状态 */
  saveDialogOpen: boolean;
  /** 保存角色弹窗关联的节点 ID */
  saveDialogNodeId: string | null;

  /** 待放置角色（点击 avatar 后等待画布点击） */
  pendingPlacement: PendingCharacterPlacement | null;

  // Actions
  /** 加载角色列表 */
  loadCharacters: () => Promise<void>;
  /** 打开角色库弹窗 */
  openLibrary: () => void;
  /** 关闭角色库弹窗 */
  closeLibrary: () => void;
  /** 打开保存角色弹窗 */
  openSaveDialog: (nodeId: string) => void;
  /** 关闭保存角色弹窗 */
  closeSaveDialog: () => void;
  /** 添加角色后刷新列表 */
  refreshAfterAdd: () => Promise<void>;
  /** 删除角色后刷新列表 */
  refreshAfterDelete: (characterId: string) => Promise<void>;
  /** 读取当前项目固定角色 */
  loadPinnedCharacters: () => Promise<void>;
  /** 保存当前项目固定角色 */
  savePinnedCharacters: (ids: string[]) => Promise<void>;
  /** 追加固定角色 */
  appendPinnedCharacter: (id: string) => Promise<void>;
  /** 移除固定角色 */
  removePinnedCharacter: (id: string) => Promise<void>;
  /** 开始放置角色（点击 avatar 后调用） */
  startPlacement: (characterId: string, characterName: string) => void;
  /** 取消放置角色 */
  cancelPlacement: () => void;
  /** 完成放置角色（画布点击后调用） */
  completePlacement: () => void;
}

export const useCharacterUIStore = create<CharacterUIState>((set, get) => ({
  characters: [],
  hasLoaded: false,
  isLoading: false,
  lastCharacterIndexLoadOk: false,
  pinnedCharacterIds: [],
  pinsLoading: false,
  migrationPending: false,
  lastPinsLoadOk: false,
  pinsError: null,
  libraryOpen: false,
  saveDialogOpen: false,
  saveDialogNodeId: null,
  pendingPlacement: null,

  loadCharacters: async () => {
    set({ isLoading: true });
    try {
      const characters = await CharacterStore.getAllIndex();
      set({
        characters,
        isLoading: false,
        hasLoaded: true,
        lastCharacterIndexLoadOk: true,
      });
    } catch (error) {
      console.error('[characterUIStore] 加载角色列表失败', error);
      set({
        isLoading: false,
        hasLoaded: true,
        lastCharacterIndexLoadOk: false,
      });
    }
  },

  openLibrary: () => {
    set({ libraryOpen: true });
    // 打开时自动刷新全局角色与项目 pins
    void get().loadCharacters();
    void get().loadPinnedCharacters();
  },

  closeLibrary: () => set({ libraryOpen: false }),

  openSaveDialog: (nodeId) => set({ saveDialogOpen: true, saveDialogNodeId: nodeId }),

  closeSaveDialog: () => set({ saveDialogOpen: false, saveDialogNodeId: null }),

  refreshAfterAdd: async () => {
    await get().loadCharacters();
  },

  refreshAfterDelete: async (characterId) => {
    // 从列表中移除
    set((state) => ({
      characters: state.characters.filter((c) => c.id !== characterId),
      pinnedCharacterIds: state.pinnedCharacterIds.filter((id) => id !== characterId),
    }));
  },

  loadPinnedCharacters: async () => {
    set({ pinsLoading: true });
    try {
      const pins = await getCurrentProjectCharacterPins();
      const nextIds = normalizePinnedCharacterIds((pins !== null && pins !== undefined ? pins.pinnedCharacterIds : undefined));
      clearPinsRetryTimer();
      set({
        pinnedCharacterIds: nextIds,
        pinsLoading: false,
        migrationPending: false,
        lastPinsLoadOk: true,
        pinsError: null,
      });
    } catch (error) {
      if (isErrorStatus(error, 503)) {
        set({
          pinsLoading: false,
          migrationPending: true,
          lastPinsLoadOk: false,
          pinsError: null,
        });
        schedulePinsRetry(() => {
          void get().loadPinnedCharacters();
        });
        return;
      }
      console.error('[characterUIStore] 加载项目角色 pins 失败', error);
      set({
        pinsLoading: false,
        migrationPending: false,
        lastPinsLoadOk: false,
        pinsError: extractErrorMessage(error),
      });
    }
  },

  savePinnedCharacters: async (ids) => {
    const normalized = normalizePinnedCharacterIds(ids);
    set({ pinsLoading: true });
    try {
      const saved = await setCurrentProjectCharacterPinnedIds(normalized);
      const savedIds = normalizePinnedCharacterIds((saved !== null && saved !== undefined ? saved.pinnedCharacterIds : undefined) ?? normalized);
      clearPinsRetryTimer();
      set({
        pinnedCharacterIds: savedIds,
        pinsLoading: false,
        migrationPending: false,
        lastPinsLoadOk: true,
        pinsError: null,
      });
    } catch (error) {
      if (isErrorStatus(error, 503)) {
        set({
          pinsLoading: false,
          migrationPending: true,
          lastPinsLoadOk: false,
          pinsError: null,
        });
        schedulePinsRetry(() => {
          void get().loadPinnedCharacters();
        });
        return;
      }
      console.error('[characterUIStore] 保存项目角色 pins 失败', error);
      set({
        pinsLoading: false,
        migrationPending: false,
        pinsError: extractErrorMessage(error),
      });
    }
  },

  appendPinnedCharacter: async (id) => {
    const characterId = typeof id === 'string' ? id.trim() : '';
    if (!characterId) return;
    const current = get().pinnedCharacterIds;
    if (current.includes(characterId)) return;
    await get().savePinnedCharacters([...current, characterId]);
  },

  removePinnedCharacter: async (id) => {
    const characterId = typeof id === 'string' ? id.trim() : '';
    if (!characterId) return;
    const current = get().pinnedCharacterIds;
    if (!current.includes(characterId)) return;
    await get().savePinnedCharacters(current.filter((item) => item !== characterId));
  },

  startPlacement: (characterId, characterName) => {
    set({ pendingPlacement: { characterId, characterName } });
  },

  cancelPlacement: () => {
    set({ pendingPlacement: null });
  },

  completePlacement: () => {
    set({ pendingPlacement: null });
  },
}));

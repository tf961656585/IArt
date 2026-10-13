import { getCurrentProjectPath, ipcInvoke } from './backendCore';
import type { CharacterPins } from './types';
import type { StorageGetCharacterPinsParams, StorageGetCharacterPinsResult, StorageSaveCharacterPinsParams, StorageSaveCharacterPinsResult } from '@iart/contracts/editor-storage-contract';

// E 组：偏好/Pins
// ────────────────────────────────────────────

export const getProjectCharacterPins = async (
  projectPath: string,
): Promise<CharacterPins | null> => {
  if (!projectPath) return null;
  try {
    const params: StorageGetCharacterPinsParams = { projectPath };
    const result = await ipcInvoke<StorageGetCharacterPinsResult>("storage:get-character-pins", params);
    return (result !== null && result !== undefined ? result.pins : undefined) ?? null;
  } catch {
    return null;
  }
};

export const getCurrentProjectCharacterPins =
  async (): Promise<CharacterPins | null> => {
    const projectPath = await getCurrentProjectPath();
    if (!projectPath) return null;
    return getProjectCharacterPins(projectPath);
  };

export const setProjectCharacterPinnedIds = async (
  projectPath: string,
  ids: unknown,
): Promise<CharacterPins | null> => {
  if (!projectPath) return null;
  const normalized = Array.isArray(ids)
    ? Array.from(
        new Set(
          ids
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter(Boolean),
        ),
      )
    : [];
  try {
    const params: StorageSaveCharacterPinsParams = {
      projectPath,
      pinnedIds: normalized,
    };
    const result = await ipcInvoke<StorageSaveCharacterPinsResult>("storage:save-character-pins", params);
    return (result !== null && result !== undefined ? result.pins : undefined) ?? null;
  } catch {
    return null;
  }
};

export const setCurrentProjectCharacterPinnedIds = async (
  ids: unknown,
): Promise<CharacterPins | null> => {
  const projectPath = await getCurrentProjectPath();
  if (!projectPath) return null;
  return setProjectCharacterPinnedIds(projectPath, ids);
};

// ────────────────────────────────────────────

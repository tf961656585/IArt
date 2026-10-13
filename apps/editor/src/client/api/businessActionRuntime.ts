import { getRuntimeProjectPath } from '@/client/store/runtimeStore';

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

export const createBusinessActionId = (): string => {
  try {
    return (globalThis.crypto !== null && globalThis.crypto !== undefined && globalThis.crypto.randomUUID !== null && globalThis.crypto.randomUUID !== undefined ? globalThis.crypto.randomUUID() : undefined) ?? `action_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `action_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
};

export const getCurrentProjectPathForBusinessAction = async (): Promise<string | null> => {
  if (typeof window === 'undefined') return null;

  try {
    const projectPath = getRuntimeProjectPath();
    if (!projectPath) return null;
    return normalizeString(projectPath);
  } catch {
    return null;
  }
};

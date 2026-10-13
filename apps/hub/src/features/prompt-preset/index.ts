import type { HubApiClient } from '../../client/types';

export { PromptPresetTab } from './PromptPresetTab';

interface PromptPresetRecord {
  id: string | number | null | undefined;
  name: string | null | undefined;
  content: string | null | undefined;
  updatedAt: string | number | Date | null | undefined;
}

const normalizePromptPresetRecord = (value: unknown): PromptPresetRecord => {
  if (!value || typeof value !== 'object') {
    return {
      id: undefined,
      name: undefined,
      content: undefined,
      updatedAt: undefined,
    };
  }
  const source = value as Record<string, unknown>;
  const id = source['id'];
  const name = source['name'];
  const content = source['content'];
  const updatedAt = source['updatedAt'];

  return {
    id: typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined,
    name: typeof name === 'string' || name === null ? name : undefined,
    content: typeof content === 'string' || content === null ? content : undefined,
    updatedAt:
      typeof updatedAt === 'string' || typeof updatedAt === 'number' || updatedAt instanceof Date || updatedAt === null
        ? updatedAt
        : undefined,
  };
};

export const createPromptPresetFeature = (api: HubApiClient) => ({
  loadPresets: async () => {
    const data = await api.loadPromptPresets();
    const record = data as Record<string, unknown>;
    const message = typeof record['message'] === 'string' ? record['message'] : undefined;
    const presets = Array.isArray(record['presets'])
      ? record['presets'].map((item) => normalizePromptPresetRecord(item))
      : [];
    return {
      presets,
      message,
      error: undefined,
    };
  },
  savePreset: async ({ id, name, content }: { id: string | undefined; name: string; content: string }) => {
    const data = await api.savePromptPreset({ id, name, content });
    const message = (data as Record<string, unknown>)['message'];
    return {
      message: typeof message === 'string' ? message : undefined,
      error: undefined,
    };
  },
  deletePreset: async (id: string) => {
    const data = await api.deletePromptPreset(id);
    const message = (data as Record<string, unknown>)['message'];
    return {
      message: typeof message === 'string' ? message : undefined,
      error: undefined,
    };
  },
});

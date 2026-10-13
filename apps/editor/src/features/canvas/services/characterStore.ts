/**
 * 角色预设存储服务（全局）
 * - 角色实体统一写入全局角色库
 * - 当前项目固定角色通过 pins 独立维护（见 characterUIStore/backend）
 */

import { request } from '@/client/api/client';
import { serializeFormDataForBusinessAction } from '@/client/api/client';
import { createBusinessActionId } from '@/client/api/businessActionRuntime';
import { submitBusinessSyncAction } from '@/client/utils/businessActionSocket';
import { resolveLocalApiRequestTarget } from '@/client/utils/apiConfig';
import { isHubRuntime } from '@/client/utils/hubFetch';
import {
  EDITOR_BACKEND_ACTION_NAME,
  EDITOR_BACKEND_PROJECT_SCOPE,
} from '@iart/contracts/editor-backend-contract';
import type {
  Character,
  CharacterCreateInput,
  CharacterIndexItem,
  CharacterUpdateInput,
} from '../types/character';

type ListResponse = { success: boolean | undefined; characters: CharacterIndexItem[] | undefined };
type GetResponse = { success: boolean | undefined; character: Character | undefined };
type CreateResponse = {
  success: boolean | undefined;
  id: string | undefined;
  character: CharacterIndexItem | undefined;
  error: string | undefined;
};
type SimpleResponse = { success: boolean | undefined; error: string | undefined };

const guessFileExtension = (mimeType: string): string => {
  const normalized = (mimeType || '').toLowerCase().trim();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
  };
  return map[normalized] ?? 'png';
};

const resolveCharacterEndpoint = async (
  endpoint: string
): Promise<{ endpoint: string; resolveEndpoint: boolean | undefined }> => {
  return resolveLocalApiRequestTarget(endpoint, {
    allowRelativeFallback: false,
    allowStoredFallback: true,
  });
};

const readErrorCode = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  if ('code' in error && typeof (error as { code: unknown | undefined }).code === 'string') {
    return (error as { code: string }).code;
  }
  if ('body' in error) {
    const body = (error as { body: unknown | undefined }).body;
    if (body && typeof body === 'object' && 'code' in body && typeof (body as { code: unknown | undefined }).code === 'string') {
      return (body as { code: string }).code;
    }
  }
  return null;
};

const isBusinessSyncCompatFallbackError = (error: unknown): boolean =>
  readErrorCode(error) === 'business_action_socket_unavailable';

const withBusinessSyncCompat = async <TResult>(options: {
  submit: () => Promise<TResult>;
  compat: () => Promise<TResult>;
}): Promise<TResult> => {
  try {
    return await options.submit();
  } catch (error) {
    if (!isBusinessSyncCompatFallbackError(error)) {
      throw error;
    }
    return options.compat();
  }
};

const submitCharacterBusinessSyncAction = async <TResult>(
  actionName: string,
  payload: unknown
): Promise<TResult> => {
  const result = await submitBusinessSyncAction<TResult>({
    actionId: createBusinessActionId(),
    actionName,
    projectPath: EDITOR_BACKEND_PROJECT_SCOPE.WORKSPACE,
    payload,
  });
  return result.result;
};

class CharacterStoreImpl {
  async getAllIndex(): Promise<CharacterIndexItem[]> {
    try {
      const payload = isHubRuntime()
        ? await withBusinessSyncCompat<ListResponse>({
            submit: () =>
              submitCharacterBusinessSyncAction<ListResponse>(
                EDITOR_BACKEND_ACTION_NAME.CHARACTERS_LIST,
                {},
              ),
            compat: async () => {
              const target = await resolveCharacterEndpoint('/api/characters/list');
              return request<ListResponse>({
                method: 'POST',
                ...target,
                includeAuth: false,
                body: {},
              });
            },
          })
        : await (async () => {
            const target = await resolveCharacterEndpoint('/api/characters/list');
            return request<ListResponse>({
              method: 'POST',
              ...target,
              includeAuth: false,
              body: {},
            });
          })();
      return (payload !== null && payload !== undefined ? payload.characters : undefined) ?? [];
    } catch (error) {
      console.warn('[CharacterStore] 读取角色列表失败', error);
      return [];
    }
  }

  async get(id: string): Promise<Character | null> {
    const characterId = typeof id === 'string' ? id.trim() : '';
    if (!characterId) return null;
    try {
      const payload = isHubRuntime()
        ? await withBusinessSyncCompat<GetResponse>({
            submit: () =>
              submitCharacterBusinessSyncAction<GetResponse>(
                EDITOR_BACKEND_ACTION_NAME.CHARACTERS_GET,
                { id: characterId },
              ),
            compat: async () => {
              const target = await resolveCharacterEndpoint('/api/characters/get');
              return request<GetResponse>({
                method: 'POST',
                ...target,
                includeAuth: false,
                body: { id: characterId },
              });
            },
          })
        : await (async () => {
            const target = await resolveCharacterEndpoint('/api/characters/get');
            return request<GetResponse>({
              method: 'POST',
              ...target,
              includeAuth: false,
              body: { id: characterId },
            });
          })();
      return (payload !== null && payload !== undefined ? payload.character : undefined) ?? null;
    } catch (error) {
      console.warn('[CharacterStore] 读取角色失败', characterId, error);
      return null;
    }
  }

  async add(input: CharacterCreateInput): Promise<string | null> {
    const name = typeof (input !== null && input !== undefined ? input.name : undefined) === 'string' ? input.name.trim() : '';
    if (!name) return null;
    if (!(input !== null && input !== undefined ? input.imageData : undefined)) return null;

    const mimeType =
      (typeof (input !== null && input !== undefined ? input.mimeType : undefined) === 'string' && input.mimeType.trim()) ||
      input.imageData.type ||
      'image/png';

    const ext = guessFileExtension(mimeType);
    const filename = `character_${Date.now()}.${ext}`;

    const fd = new FormData();
    fd.append('name', name);
    fd.append('description', (input !== null && input !== undefined ? input.description : undefined) ?? '');
    fd.append('file', input.imageData, filename);

    try {
      const submitCreate = async () =>
        submitCharacterBusinessSyncAction<CreateResponse>(
          EDITOR_BACKEND_ACTION_NAME.CHARACTERS_CREATE,
          {
            formData: await serializeFormDataForBusinessAction(fd),
          },
        );
      const submitCompat = async () => {
        const target = await resolveCharacterEndpoint('/api/characters/create');
        const response = await fetch(target.endpoint, {
          method: 'POST',
          body: fd,
          credentials: 'include',
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          console.warn('[CharacterStore] 创建角色失败', response.status, text);
          return null;
        }
        return (await response.json()) as CreateResponse;
      };
      const payload =
        isHubRuntime()
          ? await withBusinessSyncCompat<CreateResponse | null>({
              submit: submitCreate,
              compat: submitCompat,
            })
          : await submitCompat();
      if (payload === null) {
        return null;
      }
      if (!(payload !== null && payload !== undefined ? payload.success : undefined) || !(payload !== null && payload !== undefined ? payload.id : undefined)) {
        console.warn('[CharacterStore] 创建角色失败', (payload !== null && payload !== undefined ? payload.error : undefined));
        return null;
      }
      const createdId = payload.id;
      return createdId ?? null;
    } catch (error) {
      console.warn('[CharacterStore] 创建角色失败', error);
      return null;
    }
  }

  async update(id: string, updates: CharacterUpdateInput): Promise<boolean> {
    const characterId = typeof id === 'string' ? id.trim() : '';
    if (!characterId) return false;
    try {
      const body = {
        id: characterId,
        ...((updates !== null && updates !== undefined ? updates.name : undefined) !== undefined ? { name: updates.name } : null),
        ...((updates !== null && updates !== undefined ? updates.description : undefined) !== undefined
          ? { description: updates.description }
          : null),
      };
      const payload = isHubRuntime()
        ? await withBusinessSyncCompat<SimpleResponse>({
            submit: () =>
              submitCharacterBusinessSyncAction<SimpleResponse>(
                EDITOR_BACKEND_ACTION_NAME.CHARACTERS_UPDATE,
                body,
              ),
            compat: async () => {
              const target = await resolveCharacterEndpoint('/api/characters/update');
              return request<SimpleResponse>({
                method: 'PUT',
                ...target,
                includeAuth: false,
                body,
              });
            },
          })
        : await (async () => {
            const target = await resolveCharacterEndpoint('/api/characters/update');
            return request<SimpleResponse>({
              method: 'PUT',
              ...target,
              includeAuth: false,
              body,
            });
          })();
      return (payload !== null && payload !== undefined ? payload.success : undefined) === true;
    } catch (error) {
      console.warn('[CharacterStore] 更新角色失败', characterId, error);
      return false;
    }
  }

  async delete(id: string): Promise<void> {
    const characterId = typeof id === 'string' ? id.trim() : '';
    if (!characterId) return;
    try {
      if (isHubRuntime()) {
        await withBusinessSyncCompat<SimpleResponse>({
          submit: () =>
            submitCharacterBusinessSyncAction<SimpleResponse>(
              EDITOR_BACKEND_ACTION_NAME.CHARACTERS_DELETE,
              { id: characterId },
            ),
          compat: async () => {
            const target = await resolveCharacterEndpoint('/api/characters/delete');
            return request<SimpleResponse>({
              method: 'DELETE',
              ...target,
              includeAuth: false,
              body: { id: characterId },
            });
          },
        });
        return;
      }
      const target = await resolveCharacterEndpoint('/api/characters/delete');
      await request<SimpleResponse>({
        method: 'DELETE',
        ...target,
        includeAuth: false,
        body: { id: characterId },
      });
    } catch (error) {
      console.warn('[CharacterStore] 删除角色失败', characterId, error);
    }
  }

  async getByIds(ids: string[]): Promise<Character[] | null> {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const results: Character[] = [];
    for (const id of ids) {
      const item = await this.get(id);
      if (item) results.push(item);
    }
    return results;
  }

  async exists(id: string): Promise<boolean> {
    const character = await this.get(id);
    return character !== null;
  }
}

export const CharacterStore = new CharacterStoreImpl();

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cast } from '@/lib/utils';

type BusinessActionCall = {
  actionName: string;
  projectPath: string;
  payload?: {
    formData?: {
      __formData?: unknown;
    };
  };
};

const requestMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const submitBusinessSyncActionMock = vi.fn<(input: BusinessActionCall) => Promise<unknown>>();
const serializeFormDataForBusinessActionMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('@/client/api/client', () => ({
  request: requestMock,
  serializeFormDataForBusinessAction: serializeFormDataForBusinessActionMock,
}));

vi.mock('@/client/utils/businessActionSocket', () => ({
  submitBusinessSyncAction: submitBusinessSyncActionMock,
}));

describe('characterStore Hub 主路径 owner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/canvas?hubBase=http://127.0.0.1:6001');
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
      getCurrentProjectPath: vi.fn(async () => '/tmp/demo.iartproj'),
      } as unknown,
    });
    requestMock.mockResolvedValue({ success: true, characters: [] });
    submitBusinessSyncActionMock.mockResolvedValue({ result: { success: true, characters: [] } });
    serializeFormDataForBusinessActionMock.mockResolvedValue({
      __formData: {
        fields: [{ name: 'name', value: 'Demo' }],
        files: [{ name: 'file', filename: 'demo.png', contentType: 'image/png', dataBase64: 'ZGVtbw==' }],
      },
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'electron');
  });

  it('角色列表在 Hub 主路径下优先走 ws business sync', async () => {
    const { CharacterStore } = await import('../characterStore');

    await CharacterStore.getAllIndex();

    expect(submitBusinessSyncActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionName: 'characters.list',
        projectPath: '__editor_workspace__',
        payload: {},
      }),
    );
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('本地上传创建角色在 Hub 主路径下优先走 ws business sync，不再直打旧 multipart HTTP', async () => {
    submitBusinessSyncActionMock.mockResolvedValueOnce({
      result: {
        success: true,
        id: 'char-1',
        character: { id: 'char-1', name: 'Demo', description: '', imageUrl: '/files/global-characters/char-1.png' },
      },
    });
    const { CharacterStore } = await import('../characterStore');

    const imageData = new File([new Uint8Array([1, 2, 3])], 'demo.png', { type: 'image/png' });
    const createdId = await CharacterStore.add({
      name: 'Demo',
      description: '',
      imageData,
      mimeType: 'image/png',
    });

    expect(createdId).toBe('char-1');
    expect(serializeFormDataForBusinessActionMock).toHaveBeenCalledTimes(1);
    const [createCall] = cast<Array<[BusinessActionCall]>>(submitBusinessSyncActionMock.mock.calls).at(0) ?? [];
    expect(createCall).toMatchObject({
      actionName: 'characters.create',
      projectPath: '__editor_workspace__',
    });
    expect(createCall?.payload?.formData?.__formData).toBeDefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

});

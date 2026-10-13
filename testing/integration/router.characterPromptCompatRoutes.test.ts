// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCjsMock, clearCjsCache, resolveCjsPath, cast } from './helpers/cjs-mock';
import { MemoryResponse, createMockRequest, parseMemoryResponseJson, type RouterModule } from './helpers/http-test-types';

describe('backend router characters + prompt compat routes', () => {
  const cjs = createCjsMock();

  beforeEach(() => {
    cjs.restore();
    cjs.replace('../../apps/backend/dist/local-server/global-character-store.cjs', {
      listGlobalCharacterIndex: () => [
        {
          id: 'char-1',
          name: 'Alice',
          description: 'hero',
          imageUrl: 'local-media://__global__/global-characters/char-1.png',
          createdAt: 1,
        },
      ],
      getGlobalCharacterById: () => null,
      createGlobalCharacter: async () => null,
      updateGlobalCharacter: () => null,
      deleteGlobalCharacter: () => null,
    });
    cjs.replace('../../apps/backend/dist/local-server/prompt-presets-store.cjs', {
      listPromptPresets: () => [{ id: 'preset-1', name: 'Preset 1', content: 'demo', createdAt: 1, updatedAt: 2 }],
      getPromptPreset: () => null,
      createPromptPreset: () => null,
      updatePromptPreset: () => null,
      deletePromptPreset: () => false,
    });
  });

  afterEach(() => {
    cjs.restore();
  });

  it('旧 /api/characters/* 与 /api/prompt-presets* 返回纯数据，不再携带 compat adapter 元信息', async () => {
    const routerPath = resolveCjsPath('../../apps/backend/dist/local-server/router.cjs');
    clearCjsCache(routerPath);
    const router = cast<RouterModule>(await import('../../apps/backend/dist/local-server/router.cjs'));
    const handler = router.createRequestHandler({ baseDir: process.cwd() });

    const charactersReq = createMockRequest({ method: 'POST', url: '/api/characters/list', body: Buffer.from('{}', 'utf-8'), headers: { 'content-type': 'application/json' } });
    const charactersRes = new MemoryResponse();
    await handler(charactersReq, charactersRes);
    await new Promise((resolve) => charactersRes.once('finish', resolve));

    expect(charactersRes.statusCode).toBe(200);
    const charactersPayload = parseMemoryResponseJson(charactersRes);
    expect(charactersPayload['success']).toBe(true);
    expect(charactersPayload['characters']).toEqual([
      {
        id: 'char-1',
        name: 'Alice',
        description: 'hero',
        imageUrl: 'local-media://__global__/global-characters/char-1.png',
        createdAt: 1,
      },
    ]);
    /* adapter 元信息口径已收缩为只挂 WS business sync 结果（{route, mode}），HTTP 路由不再携带 */
    expect(charactersPayload['adapter']).toBeUndefined();

    const promptReq = createMockRequest({ method: 'GET', url: '/api/prompt-presets', headers: {} });
    const promptRes = new MemoryResponse();
    await handler(promptReq, promptRes);
    await new Promise((resolve) => promptRes.once('finish', resolve));

    expect(promptRes.statusCode).toBe(200);
    const promptPayload = parseMemoryResponseJson(promptRes);
    expect(promptPayload['success']).toBe(true);
    expect(promptPayload['presets']).toEqual([
      { id: 'preset-1', name: 'Preset 1', content: 'demo', createdAt: 1, updatedAt: 2 },
    ]);
    expect(promptPayload['adapter']).toBeUndefined();
  });
});

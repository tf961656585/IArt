import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUB_LOCAL_WRITE_TOKEN_HEADER, type InterfaceRecipe } from '@iart/contracts';
import { createHubApiClient } from '../hub-api';
import { createHubHttpClient } from '../../adapters/http-client';

/**
 * 接口配方六个端点的请求构造 + 响应 schema parse（`docs/custom-providers/接口配方-design.md` §7）。
 *
 * 响应是裸对象（没有 data/message/success 包装），缺字段必须 parse 失败——不静默补默认值放行。
 */

const WRITE_TOKEN = 'a'.repeat(32);
const BASE = 'http://localhost:4877';

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = (handler: () => Promise<Response>): FetchMock => {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
};

const recipe: InterfaceRecipe = {
  recipe_id: 'recipe-1',
  name: 'OpenAI 完成判定',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
  requires_auth: false,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T01:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hub api 接口配方边界', () => {
  it('列表 GET 并 parse 裸 recipes 数组；写方法带写令牌', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({ recipes: [recipe] }));
    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));

    const listed = await api.listInterfaceRecipes(undefined);
    expect(listed.recipes).toEqual([recipe]);
    const [listUrl, listInit] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(listUrl).toBe(`${BASE}/api/interface-recipes`);
    expect(listInit?.method).toBeUndefined();
    expect((listInit?.headers as Record<string, string> | undefined)?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBeUndefined();

    fetchFn.mockImplementation(async () => jsonResponse({ recipe }));
    await api.createInterfaceRecipe({
      name: recipe.name,
      family_adapter_id: recipe.family_adapter_id,
      success_when: recipe.success_when,
      result: recipe.result,
      requires_auth: false,
    });
    const [createUrl, createInit] = fetchFn.mock.calls[1] as [string, RequestInit | undefined];
    expect(createUrl).toBe(`${BASE}/api/interface-recipes`);
    expect(createInit?.method).toBe('POST');
    expect(JSON.parse(String(createInit?.body))).toEqual({
      name: recipe.name,
      family_adapter_id: recipe.family_adapter_id,
      success_when: recipe.success_when,
      result: recipe.result,
      requires_auth: false,
    });
    expect((createInit?.headers as Record<string, string> | undefined)?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBe(WRITE_TOKEN);
  });

  it('修改 PUT：failure_when: null 原样透传（清除语义）', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({ recipe }));
    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));

    await api.updateInterfaceRecipe('recipe-1', {
      name: '改名',
      failure_when: null,
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/interface-recipes/recipe-1`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ name: '改名', failure_when: null });
  });

  it('删除 DELETE 并 parse removed_recipe_id', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({ removed_recipe_id: 'recipe-1' }));
    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));

    const removed = await api.deleteInterfaceRecipe('recipe-1');
    expect(removed.removed_recipe_id).toBe('recipe-1');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/interface-recipes/recipe-1`);
    expect(init?.method).toBe('DELETE');
  });

  it('试跑 POST：样本与草稿原样透传，响应 parse', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({
      verdict: 'success',
      matched: [{ path: 'status', value: 'succeeded' }],
      outputs: [{ media_type: 'image', url: 'https://cdn.example.com/a.png', source_path: 'data.url' }],
      unseen_paths: [],
    }));
    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));

    const response = await api.dryRunInterfaceRecipe({
      sample: { status: 'succeeded' },
      draft: {
        family_adapter_id: 'openai-image-v1',
        success_when: recipe.success_when,
        result: recipe.result,
      },
    });
    expect(response.verdict).toBe('success');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/interface-recipes/dry-run`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      sample: { status: 'succeeded' },
      draft: {
        family_adapter_id: 'openai-image-v1',
        success_when: recipe.success_when,
        result: recipe.result,
      },
    });
  });

  it('路径发现 POST 只带 sample，响应 parse', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({
      paths: [{ path: 'data.task_id', value: 'task-1', value_kind: 'string' }],
    }));
    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));

    const response = await api.discoverInterfaceRecipePaths({ data: { task_id: 'task-1' } });
    expect(response.paths[0]?.path).toBe('data.task_id');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/interface-recipes/path-discovery`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ sample: { data: { task_id: 'task-1' } } });
  });

  it('响应形状不对：parse 失败，不放行到下游', async () => {
    fetchMock(async () => jsonResponse({ recipes: [{ recipe_id: 'recipe-1' }] }));
    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    await expect(api.listInterfaceRecipes(undefined)).rejects.toThrow();
  });
});

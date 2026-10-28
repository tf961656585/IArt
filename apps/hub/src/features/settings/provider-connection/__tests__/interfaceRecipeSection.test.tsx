import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InterfaceRecipe } from '@iart/contracts';

import { InterfaceRecipeSection } from '../InterfaceRecipeSection';
import { createHubApiClient } from '../../../../client/api/hub-api';
import { createHubHttpClient } from '../../../../client/adapters/http-client';
import { PRESET_FORMAT_SUMMARIES } from './formatOptionsFixture';

/**
 * 接口配方列表（`docs/custom-providers/接口配方-design.md` §8.1）。
 *
 * 保护：空态给出下一步、列表显示名称/接口格式/最后修改、修改与删除入口，
 * 删除确认说明真实影响面并真的发出 DELETE（用真 api 客户端，只挡网络）。
 */

const WRITE_TOKEN = 'a'.repeat(32);
const BASE = 'http://localhost:4877';

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const renderSection = (
  recipes: InterfaceRecipe[],
  options: { unavailable?: boolean; fetchImpl?: typeof fetch } = {},
) => {
  const reload = vi.fn(async () => undefined);
  const setNotice = vi.fn();
  // 配方页也会读接口格式列表（配方绑定的展示名来源）：默认给预设清单，
  // 需要自定义请求行为的用例传 fetchImpl。
  vi.stubGlobal(
    'fetch',
    options.fetchImpl
      ?? (async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('/api/interface-formats')) return jsonResponse({ formats: PRESET_FORMAT_SUMMARIES });
        return jsonResponse({ recipes });
      }),
  );
  render(
    <InterfaceRecipeSection
      recipes={recipes}
      unavailable={options.unavailable ?? false}
      api={createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN))}
      reload={reload}
      setNotice={setNotice}
    />,
  );
  return { reload, setNotice };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InterfaceRecipeSection', () => {
  it('空态：说清还没有配方，并给出「新建配方」入口', () => {
    renderSection([]);
    expect(
      screen.getByText('还没有接口配方。新建一个，用来决定任务什么时候算完成、产物从哪里取。'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新建配方' }));
    expect(screen.getByRole('heading', { name: '新建接口配方' })).toBeInTheDocument();
  });

  it('列表：显示名称、接口格式与最后修改；修改入口打开对应配方', async () => {
    renderSection([recipe]);
    expect(screen.getByText('OpenAI 完成判定')).toBeInTheDocument();
    // 接口格式展示名来自列表接口（异步装载）
    expect(await screen.findByText('OpenAI Image')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '修改配方「OpenAI 完成判定」' }));
    expect(screen.getByRole('heading', { name: '修改「OpenAI 完成判定」' })).toBeInTheDocument();
  });

  it('删除：确认文案说明影响面，确认后发出 DELETE 并重新装载', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).includes('/api/interface-formats')) {
          return jsonResponse({ formats: PRESET_FORMAT_SUMMARIES });
        }
        if (init?.method === 'DELETE') return jsonResponse({ removed_recipe_id: 'recipe-1' });
        return jsonResponse({ recipes: [recipe] });
      },
    );
    const { reload, setNotice } = renderSection([recipe], { fetchImpl: fetchMock });

    fireEvent.click(screen.getByRole('button', { name: '删除配方「OpenAI 完成判定」' }));
    expect(
      screen.getByText('删除后，正在引用它的模型会改用内置默认判定；已经提交的任务不受影响。'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除配方' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(deleteCall?.[0]).toBe(`${BASE}/api/interface-recipes/recipe-1`);
    await waitFor(() => {
      expect(reload).toHaveBeenCalled();
      expect(setNotice).toHaveBeenCalledWith({ tone: 'success', text: '已删除配方「OpenAI 完成判定」' });
    });
  });

  it('列表读不到：说明可以刷新再试，不冒充「还没有配方」', () => {
    renderSection([], { unavailable: true });
    expect(screen.getByText('暂时读不到配方列表，点「刷新」再试。')).toBeInTheDocument();
    expect(
      screen.queryByText('还没有接口配方。新建一个，用来决定任务什么时候算完成、产物从哪里取。'),
    ).not.toBeInTheDocument();
  });
});

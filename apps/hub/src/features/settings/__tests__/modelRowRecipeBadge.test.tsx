import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

import type {
  CustomGenerationModel,
  InterfaceRecipe,
  ProviderConnection,
} from '@iart/contracts';
import { ProviderSection } from '../ProviderSection';
import { createHubApiClient } from '../../../client/api/hub-api';
import { createHubHttpClient } from '../../../client/adapters/http-client';
import { countModelsByConnection } from '../provider-connection/invalidity';
import type {
  ProviderConnectionData,
  ProviderNotice,
} from '../provider-connection/useProviderConnectionData';

/**
 * 模型列表里的「配方已失效」标记（`docs/custom-providers/接口配方-design.md` §8.4
 * 「删除配方后的可见性」）。
 *
 * 保护的是静默降级：配方被删后运行时回落到该族内置默认，若列表不标记，用户会以为
 * 模型仍按自己的配方运行。三种状态各有独立用例，其中「配方库读不到」**不得**被当成
 * 「配方不存在」（未知 ≠ 缺失）。
 */

const WRITE_TOKEN = 'a'.repeat(32);
const BASE = 'http://localhost:4877';

const generationConnection: ProviderConnection = {
  connection_id: 'up_conn_gen1',
  display_name: '我的绘图服务',
  protocol_adapter_id: 'openai-image-v1',
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T00:00:00.000Z',
};

const recipe: InterfaceRecipe = {
  recipe_id: 'recipe-openai',
  name: 'OpenAI 完成判定',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
  requires_auth: false,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T00:00:00.000Z',
};

const recordReferencing = (recipeId: string | undefined): CustomGenerationModel => ({
  model_id: 'my-image-model',
  record_id: 'up_dep_rec1',
  connection_id: generationConnection.connection_id,
  remote_model_id: 'my-image-model',
  family_adapter_id: 'openai-image-v1',
  accepted_media_slots: [],
  parameter_overrides: { official: [], custom: [] },
  ...(recipeId === undefined ? {} : { recipe_id: recipeId }),
  created_at: '2026-10-24T00:00:00.000Z',
});

/** 被 mock 的数据源；用例的 Harness 每次渲染把它刷成当前值。 */
const stateRef = vi.hoisted(() => ({ current: null as ProviderConnectionData | null }));

vi.mock('../provider-connection/ProviderDataContext', () => ({
  useProviderData: (): ProviderConnectionData => {
    if (stateRef.current === null) throw new Error('用例没有装载数据源');
    return stateRef.current;
  },
}));

function Harness({
  customGenerationModels,
  interfaceRecipes,
  interfaceRecipesUnavailable,
}: {
  customGenerationModels: CustomGenerationModel[];
  interfaceRecipes: InterfaceRecipe[];
  interfaceRecipesUnavailable: boolean;
}) {
  const [notice, setNotice] = useState<ProviderNotice | null>(null);
  stateRef.current = {
    api: createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN)),
    connections: [generationConnection],
    activeRoutes: {},
    activeRecordIds: new Set(),
    connectionById: new Map([[generationConnection.connection_id, generationConnection]]),
    modelCountByConnection: countModelsByConnection(customGenerationModels),
    catalog: [],
    chatCatalog: [],
    catalogUnavailable: false,
    chatCatalogUnavailable: false,
    thinkingTierPool: { builtin: [], custom: [] },
    thinkingTierPoolUnavailable: false,
    customChatModels: [],
    customChatModelsUnavailable: false,
    customGenerationModels,
    customGenerationModelsUnavailable: false,
    interfaceRecipes,
    interfaceRecipesUnavailable,
    agentDefaultModelId: null,
    saveAgentDefaultModel: async () => undefined,
    generationDefaultModelId: null,
    saveGenerationDefaultModel: async () => undefined,
    loadState: 'ready',
    loadError: null,
    notice,
    setNotice,
    reload: async () => undefined,
  };
  return <ProviderSection />;
}

const openDetail = (props: {
  customGenerationModels: CustomGenerationModel[];
  interfaceRecipes: InterfaceRecipe[];
  interfaceRecipesUnavailable?: boolean;
}): void => {
  render(
    <Harness
      customGenerationModels={props.customGenerationModels}
      interfaceRecipes={props.interfaceRecipes}
      interfaceRecipesUnavailable={props.interfaceRecipesUnavailable ?? false}
    />,
  );
  const rail = screen.getByRole('group', { name: '服务商列表' });
  const card = within(rail)
    .queryAllByRole('button')
    .find((element) => (element.textContent ?? '').includes(generationConnection.display_name));
  if (card === undefined) throw new Error('服务商栏里没有这条连接');
  fireEvent.click(card);
};

/** 用例里只有一个服务商、一条生成模型记录：按行类型取那一行（模型 ID 在行内出现两次，按文本取不准）。 */
const rowOf = (modelId: string): HTMLElement => {
  const row = document.querySelector('tr[data-model-row="custom-generation"]');
  if (!(row instanceof HTMLElement)) throw new Error(`找不到「${modelId}」所在的模型行`);
  if (!(row.textContent ?? '').includes(modelId)) throw new Error(`这一行不是「${modelId}」`);
  return row;
};

describe('模型列表：配方引用失效的可见标记', () => {
  it('引用的配方已不在库里：行内出现「配方已失效」，说明当前用内置默认并指到修改入口', async () => {
    openDetail({
      customGenerationModels: [recordReferencing('recipe-deleted')],
      interfaceRecipes: [recipe],
    });

    const row = rowOf('my-image-model');
    expect(within(row).getByText('配方已失效')).toBeInTheDocument();

    // 说明挂在这一行的「?」上：默认不印解释文字，悬停/聚焦才展开
    const hintTrigger = within(row).getByRole('button', { name: '「my-image-model」的接口配方说明' });
    fireEvent.focus(hintTrigger);
    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveTextContent('这个模型现在用内置默认判定');
      expect(tooltip).toHaveTextContent('「修改配置」');
      expect(tooltip).toHaveTextContent('「使用内置默认」');
    });
  });

  it('记录没有引用配方：不显示任何标记（按内置默认运行本来就是正常状态）', () => {
    openDetail({
      customGenerationModels: [recordReferencing(undefined)],
      interfaceRecipes: [recipe],
    });

    const row = rowOf('my-image-model');
    expect(within(row).queryByText('配方已失效')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /接口配方说明/ })).not.toBeInTheDocument();
  });

  it('引用命中同族配方：不显示标记', () => {
    openDetail({
      customGenerationModels: [recordReferencing(recipe.recipe_id)],
      interfaceRecipes: [recipe],
    });

    expect(within(rowOf('my-image-model')).queryByText('配方已失效')).not.toBeInTheDocument();
  });

  it('引用的配方属于另一个接口格式：按失效处理（运行时同样回落内置默认）', () => {
    openDetail({
      customGenerationModels: [recordReferencing('recipe-seedance')],
      interfaceRecipes: [{ ...recipe, recipe_id: 'recipe-seedance', family_adapter_id: 'seedance-2-0-v1' }],
    });

    expect(within(rowOf('my-image-model')).getByText('配方已失效')).toBeInTheDocument();
  });

  it('配方库读不到：未知不等于缺失，不把记录误标为失效', () => {
    openDetail({
      customGenerationModels: [recordReferencing('recipe-deleted')],
      interfaceRecipes: [],
      interfaceRecipesUnavailable: true,
    });

    const row = rowOf('my-image-model');
    expect(within(row).queryByText('配方已失效')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /接口配方说明/ })).not.toBeInTheDocument();
    // 配方区块 2026-10-26 已迁到「接口格式」页的第二标签：服务商页不再同屏呈现配方列表，
    // 「读不到」的说明由那一页承载，这里只保护行内不误标失效。
  });
});

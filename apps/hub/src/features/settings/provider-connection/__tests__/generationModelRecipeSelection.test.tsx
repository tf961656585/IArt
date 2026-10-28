import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  CustomGenerationModel,
  FamilyTemplateParameterDescriptor,
  InterfaceRecipe,
} from '@iart/contracts';

import {
  GenerationModelFields,
  useGenerationModelForm,
  type GenerationModelFormPayload,
} from '../GenerationModelForm';
import {
  GenerationModelEditDialog,
  type GenerationModelEditPayload,
} from '../GenerationModelEditDialog';
import { PRESET_FORMAT_OPTIONS } from './formatOptionsFixture';

/**
 * 模型记录侧选择接口配方（`docs/custom-providers/接口配方-design.md` §8.4）。
 *
 * 保护：可选配方按当前接口格式过滤；换接口格式清掉不再适用的引用并给可见反馈；
 * 修改模型时选「使用内置默认」提交 `recipe_id: null`（清除三态，不是漏字段）。
 */

const openaiRecipe: InterfaceRecipe = {
  recipe_id: 'recipe-openai',
  name: 'OpenAI 完成判定',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
  requires_auth: false,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T00:00:00.000Z',
};

const seedanceRecipe: InterfaceRecipe = {
  ...openaiRecipe,
  recipe_id: 'recipe-seedance',
  name: 'Seedance 完成判定',
  family_adapter_id: 'seedance-2-0-v1',
};

const descriptorFor = (familyAdapterId: string): FamilyTemplateParameterDescriptor => ({
  family_adapter_id: familyAdapterId,
  official_fields: [],
  reserved_wire_names: { body: [], query: [], header: [] },
  supports_media_slots: ['reference_image'],
  required_media_slots: [],
});

const chooseOption = (label: string, optionName: string): void => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: optionName }));
};

function CreateHarness({
  recipes,
  onSubmit,
}: {
  recipes: InterfaceRecipe[];
  onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
}) {
  const form = useGenerationModelForm({
    loadParameterTemplate: (familyAdapterId) => Promise.resolve(descriptorFor(familyAdapterId)),
    recipes,
    formatOptions: PRESET_FORMAT_OPTIONS,
    onSubmit,
    onClose: () => undefined,
  });
  return (
    <>
      <GenerationModelFields form={form} />
      <button type="button" disabled={form.busy || !form.canSubmit} onClick={form.submit}>
        添加
      </button>
    </>
  );
}

describe('添加模型时选择接口配方', () => {
  it('只列当前接口格式的配方；选中后随提交体交回', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<CreateHarness recipes={[openaiRecipe, seedanceRecipe]} onSubmit={onSubmit} />);

    chooseOption('接口格式', 'OpenAI Image');
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseOption('接口配方', 'OpenAI 完成判定');
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          familyAdapterId: 'openai-image-v1',
          modelId: 'my-image-model',
          recipeId: 'recipe-openai',
        }),
      );
    });
  });

  it('换接口格式：不再适用的配方被清掉，提交为内置默认', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<CreateHarness recipes={[openaiRecipe, seedanceRecipe]} onSubmit={onSubmit} />);

    chooseOption('接口格式', 'OpenAI Image');
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-model' } });
    chooseOption('接口配方', 'OpenAI 完成判定');

    chooseOption('接口格式', 'Seedance 2.0');
    expect(
      screen.getByText('接口格式变了，之前选的配方不再适用，已改用内置默认。'),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ familyAdapterId: 'seedance-2-0-v1', recipeId: null }),
      );
    });
  });

  it('当前接口格式没有配方：说明会使用内置默认，提交不带 recipe_id', async () => {
    const onSubmit = vi.fn(async () => true);
    render(<CreateHarness recipes={[seedanceRecipe]} onSubmit={onSubmit} />);

    chooseOption('接口格式', 'OpenAI Image');
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });
    expect(screen.getByText('这个接口格式还没有配方，会使用内置默认。')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-model' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ recipeId: null }));
    });
  });
});

const generationEntry: CustomGenerationModel = {
  model_id: 'my-video-model',
  record_id: 'up_dep_recipe1',
  connection_id: 'up_conn_gen1',
  remote_model_id: 'my-video-model',
  family_adapter_id: 'openai-image-v1',
  accepted_media_slots: ['reference_image'],
  parameter_overrides: { official: [], custom: [] },
  recipe_id: 'recipe-openai',
  created_at: '2026-10-24T00:00:00.000Z',
};

describe('修改模型时清除配方引用', () => {
  it('选「使用内置默认」保存：提交 recipe_id: null', async () => {
    const onSubmit = vi.fn(async (_payload: GenerationModelEditPayload) => true);
    render(
      <GenerationModelEditDialog
        entry={generationEntry}
        loadParameterTemplate={() => Promise.resolve(descriptorFor('openai-image-v1'))}
        recipes={[openaiRecipe]}
        onSubmit={onSubmit}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });

    chooseOption('接口配方', '使用内置默认');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        acceptedMediaSlots: ['reference_image'],
        parameterOverrides: { official: [], custom: [] },
        recipeId: null,
      });
    });
  });

  it('配方列表读不到：保存时不改引用（recipeId 为 undefined）', async () => {
    const onSubmit = vi.fn(async (_payload: GenerationModelEditPayload) => true);
    render(
      <GenerationModelEditDialog
        entry={generationEntry}
        loadParameterTemplate={() => Promise.resolve(descriptorFor('openai-image-v1'))}
        recipes={[]}
        recipesUnavailable
        onSubmit={onSubmit}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });
    expect(screen.getByText('暂时读不到配方列表，这次不改配方。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ recipeId: undefined }));
    });
  });
});

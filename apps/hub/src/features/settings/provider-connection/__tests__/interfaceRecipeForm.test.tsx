import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  InterfaceRecipe,
  InterfaceRecipeDryRunResponse,
  InterfaceRecipePathDiscoveryResponse,
} from '@iart/contracts';

import { InterfaceRecipeFields } from '../InterfaceRecipeFields';
import {
  useInterfaceRecipeForm,
  type InterfaceRecipeFormApiBinding,
  type InterfaceRecipeFormPayload,
} from '../InterfaceRecipeForm';
import { PRESET_FORMAT_OPTIONS } from './formatOptionsFixture';

/**
 * 接口配方表单（`docs/custom-providers/接口配方-design.md` §5/§8）。
 *
 * 保护：简单模式编译成条件树、三种结果形态的提交体、编辑时清空失败判定提交 `null`、
 * 路径发现与试跑真正发出的参数，以及客户端可判定的必然失败在提交前拦下。
 */

const initialRecipe: InterfaceRecipe = {
  recipe_id: 'recipe-1',
  name: '现有配方',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  failure_when: { op: 'eq', path: 'status', value: 'failed' },
  result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'video' },
  requires_auth: false,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T00:00:00.000Z',
};

const discoveryResponse: InterfaceRecipePathDiscoveryResponse = {
  paths: [
    { path: 'data.task_id', value: 'task-123', value_kind: 'string' },
    { path: 'data.status', value: 'succeeded', value_kind: 'string' },
  ],
};

const dryRunResponse: InterfaceRecipeDryRunResponse = {
  verdict: 'success',
  matched: [{ path: 'status', value: 'succeeded' }],
  outputs: [{ media_type: 'video', url: 'https://cdn.example.com/out.mp4', source_path: 'data.url' }],
  unseen_paths: [],
};

const apiBinding = (
  overrides: Partial<InterfaceRecipeFormApiBinding> = {},
): InterfaceRecipeFormApiBinding => ({
  discoverPaths: overrides.discoverPaths ?? vi.fn(async () => discoveryResponse),
  dryRun: overrides.dryRun ?? vi.fn(async () => dryRunResponse),
});

function Harness({
  initial = null,
  api,
  onSubmit,
  onClose = () => undefined,
}: {
  initial?: InterfaceRecipe | null;
  api: InterfaceRecipeFormApiBinding;
  onSubmit: (payload: InterfaceRecipeFormPayload) => Promise<boolean>;
  onClose?: () => void;
}) {
  const form = useInterfaceRecipeForm({ initial, api, familyOptions: PRESET_FORMAT_OPTIONS, onSubmit, onClose });
  return (
    <>
      <InterfaceRecipeFields form={form} />
      <button type="button" disabled={form.busy || !form.canSubmit} onClick={form.submit}>
        保存
      </button>
    </>
  );
}

const renderForm = (
  overrides: {
    initial?: InterfaceRecipe | null;
    api?: InterfaceRecipeFormApiBinding;
    onSubmit?: (payload: InterfaceRecipeFormPayload) => Promise<boolean>;
  } = {},
) => {
  const onSubmit = overrides.onSubmit ?? vi.fn(async () => true);
  render(
    <Harness
      initial={overrides.initial ?? null}
      api={overrides.api ?? apiBinding()}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit };
};

/** Radix Select：键盘打开，再点选项（jsdom 没有 PointerEvent）。 */
const chooseOption = (label: string, optionName: string): void => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: optionName }));
};

const fillBasics = (): void => {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '完成判定' } });
  chooseOption('接口格式', 'OpenAI Image');
  fireEvent.change(screen.getByLabelText('成功判定第 1 行的字段路径'), {
    target: { value: 'status' },
  });
  fireEvent.change(screen.getByLabelText('成功判定第 1 行的允许值'), {
    target: { value: 'succeeded, completed' },
  });
};

describe('InterfaceRecipeForm 提交体', () => {
  it('直接返回链接：简单模式编译成 in 条件，结果形态带字段路径与媒体类型', async () => {
    const { onSubmit } = renderForm();
    fillBasics();
    fireEvent.change(screen.getByLabelText('产物地址第 1 行的字段路径'), {
      target: { value: 'data.url' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'create',
        create: {
          name: '完成判定',
          family_adapter_id: 'openai-image-v1',
          success_when: {
            op: 'in',
            path: 'status',
            value: ['succeeded', 'completed'],
          },
          result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
          requires_auth: false,
        },
      });
    });
  });

  it('直接返回内容：带内容格式（json_inline）', async () => {
    const { onSubmit } = renderForm();
    fillBasics();
    chooseOption('结果形态', '直接返回内容');
    chooseOption('内容格式', 'JSON 里的 data 字段');
    fireEvent.change(screen.getByLabelText('产物内容第 1 行的字段路径'), {
      target: { value: 'data.b64_json' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'create',
        create: {
          name: '完成判定',
          family_adapter_id: 'openai-image-v1',
          success_when: {
            op: 'in',
            path: 'status',
            value: ['succeeded', 'completed'],
          },
          result: {
            kind: 'inline_media',
            media_field_paths: ['data.b64_json'],
            media_type: 'image',
            encoding: 'json_inline',
          },
          requires_auth: false,
        },
      });
    });
  });

  it('需要再取一次：地址模板与标识路径进结果形态', async () => {
    const { onSubmit } = renderForm();
    fillBasics();
    chooseOption('结果形态', '需要再取一次');
    fireEvent.change(screen.getByLabelText('任务标识的字段路径'), {
      target: { value: 'data.task_id' },
    });
    fireEvent.change(screen.getByLabelText('结果地址模板'), {
      target: { value: '/v1/videos/{id}/content' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'create',
        create: {
          name: '完成判定',
          family_adapter_id: 'openai-image-v1',
          success_when: {
            op: 'in',
            path: 'status',
            value: ['succeeded', 'completed'],
          },
          result: {
            kind: 'needs_fetch',
            identity_field_path: 'data.task_id',
            content_url_template: '/v1/videos/{id}/content',
            accept: 'binary',
            media_type: 'image',
          },
          requires_auth: false,
        },
      });
    });
  });

  it('地址模板缺 {id}：提交前拦下并说清怎么改', async () => {
    const { onSubmit } = renderForm();
    fillBasics();
    chooseOption('结果形态', '需要再取一次');
    fireEvent.change(screen.getByLabelText('任务标识的字段路径'), {
      target: { value: 'data.task_id' },
    });
    fireEvent.change(screen.getByLabelText('结果地址模板'), {
      target: { value: '/v1/videos/content' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(
      screen.getByText('结果地址模板里要有 {id}，比如 /v1/videos/{id}/content。'),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('多行判定：第二行进 any 组合', async () => {
    const { onSubmit } = renderForm();
    fillBasics();
    fireEvent.change(screen.getByLabelText('产物地址第 1 行的字段路径'), {
      target: { value: 'data.url' },
    });
    // 成功判定、产物地址各有「添加一行」：这里要的是成功判定的那一个（先出现）
    const addRowButtons = screen.getAllByRole('button', { name: '添加一行' });
    fireEvent.click(addRowButtons[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText('成功判定第 2 行的字段路径'), {
      target: { value: 'progress' },
    });
    fireEvent.change(screen.getByLabelText('成功判定第 2 行的允许值'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'create',
        create: {
          name: '完成判定',
          family_adapter_id: 'openai-image-v1',
          success_when: {
            op: 'any',
            children: [
              { op: 'in', path: 'status', value: ['succeeded', 'completed'] },
              { op: 'eq', path: 'progress', value: 100 },
            ],
          },
          result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
          requires_auth: false,
        },
      });
    });
  });

  it('编辑时关掉失败判定：提交 failure_when: null（清除语义）', async () => {
    const { onSubmit } = renderForm({ initial: initialRecipe });
    fireEvent.click(screen.getByRole('switch', { name: '同时判断失败' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'edit',
        recipeId: 'recipe-1',
        update: {
          name: '现有配方',
          success_when: { op: 'eq', path: 'status', value: 'succeeded' },
          failure_when: null,
          failure_reason: null,
          result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'video' },
          requires_auth: false,
        },
      });
    });
  });

  it('失败原因：随失败判定一起提交', async () => {
    const { onSubmit } = renderForm();
    fillBasics();
    fireEvent.click(screen.getByRole('switch', { name: '同时判断失败' }));
    fireEvent.change(screen.getByLabelText('失败判定第 1 行的字段路径'), {
      target: { value: 'status' },
    });
    fireEvent.change(screen.getByLabelText('失败判定第 1 行的允许值'), {
      target: { value: 'failed' },
    });
    fireEvent.change(screen.getByLabelText('失败原因'), {
      target: { value: '这段内容被服务商拒绝了，改一下提示词再试。' },
    });
    fireEvent.change(screen.getByLabelText('产物地址第 1 行的字段路径'), {
      target: { value: 'data.url' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'create',
        create: {
          name: '完成判定',
          family_adapter_id: 'openai-image-v1',
          success_when: {
            op: 'in',
            path: 'status',
            value: ['succeeded', 'completed'],
          },
          failure_when: { op: 'eq', path: 'status', value: 'failed' },
          failure_reason: '这段内容被服务商拒绝了，改一下提示词再试。',
          result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
          requires_auth: false,
        },
      });
    });
  });

  it('编辑时清空失败原因：提交 failure_reason: null（清除语义）', async () => {
    const withReason: InterfaceRecipe = {
      ...initialRecipe,
      failure_reason: '旧的失败原因',
    };
    const { onSubmit } = renderForm({ initial: withReason });
    expect((screen.getByLabelText('失败原因') as HTMLInputElement).value).toBe('旧的失败原因');
    fireEvent.change(screen.getByLabelText('失败原因'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        mode: 'edit',
        recipeId: 'recipe-1',
        update: {
          name: '现有配方',
          success_when: { op: 'eq', path: 'status', value: 'succeeded' },
          failure_when: { op: 'eq', path: 'status', value: 'failed' },
          failure_reason: null,
          result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'video' },
          requires_auth: false,
        },
      });
    });
  });
});

describe('InterfaceRecipeForm 样本工具', () => {
  it('路径发现：发出解析后的样本；点路径填进当前聚焦的路径框', async () => {
    const discoverPaths = vi.fn(async () => discoveryResponse);
    renderForm({ api: apiBinding({ discoverPaths }) });

    fireEvent.change(screen.getByLabelText('响应样本'), {
      target: { value: '{"status":"succeeded","data":{"task_id":"task-123"}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '找出字段路径' }));

    await waitFor(() => {
      expect(discoverPaths).toHaveBeenCalledWith({
        status: 'succeeded',
        data: { task_id: 'task-123' },
      });
    });

    const successPath = screen.getByLabelText('成功判定第 1 行的字段路径');
    fireEvent.focus(successPath);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /data\.task_id/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /data\.task_id/ }));

    expect((successPath as HTMLInputElement).value).toBe('data.task_id');
  });

  it('没聚焦路径框就点发现结果：给一句可操作提示，不写到别处', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('响应样本'), {
      target: { value: '{"status":"succeeded"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '找出字段路径' }));

    return waitFor(() => {
      expect(screen.getByRole('button', { name: /data\.status/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /data\.status/ }));
      expect(screen.getByText('先点一下要填的路径框，再点这里的路径。')).toBeInTheDocument();
    });
  });

  it('试跑：带当前草稿调用并展示判定、命中字段与产物', async () => {
    const dryRun = vi.fn(async () => dryRunResponse);
    renderForm({ api: apiBinding({ dryRun }) });
    fillBasics();
    fireEvent.change(screen.getByLabelText('产物地址第 1 行的字段路径'), {
      target: { value: 'data.url' },
    });
    fireEvent.change(screen.getByLabelText('响应样本'), {
      target: { value: '{"status":"succeeded","data":{"url":"https://cdn.example.com/out.mp4"}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '试跑' }));

    await waitFor(() => {
      expect(dryRun).toHaveBeenCalledWith({
        sample: {
          status: 'succeeded',
          data: { url: 'https://cdn.example.com/out.mp4' },
        },
        draft: {
          name: '完成判定',
          family_adapter_id: 'openai-image-v1',
          success_when: {
            op: 'in',
            path: 'status',
            value: ['succeeded', 'completed'],
          },
          result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
          requires_auth: false,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText('按现在的配方，这段样本会被判为成功。')).toBeInTheDocument();
    });
    expect(screen.getByText('status = succeeded')).toBeInTheDocument();
    expect(
      screen.getByText('视频 · data.url → https://cdn.example.com/out.mp4'),
    ).toBeInTheDocument();
  });

  it('样本不是完整 JSON：本地拦下，不调用接口', async () => {
    const discoverPaths = vi.fn(async () => discoveryResponse);
    renderForm({ api: apiBinding({ discoverPaths }) });
    fireEvent.change(screen.getByLabelText('响应样本'), { target: { value: '{"status":' } });
    fireEvent.click(screen.getByRole('button', { name: '找出字段路径' }));

    expect(screen.getByText('这段样本不是完整的 JSON，检查一下括号和引号。')).toBeInTheDocument();
    expect(discoverPaths).not.toHaveBeenCalled();
  });
});

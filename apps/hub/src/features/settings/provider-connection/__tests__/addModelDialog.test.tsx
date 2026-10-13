import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExecutableModelDirectoryEntry } from '@iart/contracts';

import { AddModelDialog, type CustomModelFormBinding, type ModelMappingDraft } from '../AddModelDialog';

/**
 * 生成侧「添加模型」合并弹窗（2026-09-26 界面收敛）：原「接入模型」多选弹层与生成族自建
 * 表单弹层合并为一个弹窗、两个区块（分段切换）。
 *
 * 这里保护的合并结构口径：
 * - 默认落在「有东西可做」的区块：有可勾的自带模型落勾选，否则落表单；
 * - 目录读到了且为空、而表单区块存在时，自带区块连同切换项整体不渲染（过渡期不留死壳，
 *   自带包退役后弹窗自然退化成纯表单）；
 * - 目录读不到与「都添加过了」保留区块：前者给「刷新」的出路，后者说明缺口在哪；
 * - 两个区块都挂载保活（`hidden` 收起）：切走再切回，勾选与填了一半的表单都还在；
 * - 自建表单的接口类型空态起步、必选（2026-09-29 起连接级预选摘除），随提交体交回；
 * - 失败原因显示在 footer 上方（分区顶部的提示条在弹窗期间被遮罩挡住）。
 */

const entry = (modelId: string): ExecutableModelDirectoryEntry => ({
  model_id: modelId,
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [] },
  deployment: {
    has_active_deployment: false,
    active_deployment_id: null,
    deployable: false,
    failure_code: 'no_active_deployment',
  },
});

const customFormBinding = (overrides: Partial<CustomModelFormBinding> = {}): CustomModelFormBinding => ({
  loadParameterTemplate:
    overrides.loadParameterTemplate ?? (() => Promise.reject(new Error('用例没有预期会拉取参数描述'))),
  onSubmit: overrides.onSubmit ?? vi.fn(async () => true),
});

const renderDialog = (params: {
  catalog?: ExecutableModelDirectoryEntry[];
  catalogUnavailable?: boolean;
  boundModelIds?: string[];
  customForm?: CustomModelFormBinding | null;
  failureText?: string | null;
  onClose?: () => void;
  onSubmitBuiltIn?: (items: ModelMappingDraft[]) => Promise<void>;
}) => {
  const onSubmitBuiltIn = params.onSubmitBuiltIn ?? vi.fn(async () => undefined);
  const onClose = params.onClose ?? vi.fn();
  const view = render(
    <AddModelDialog
      providerName="我的绘图服务"
      catalog={params.catalog ?? [entry('gpt-image-2')]}
      catalogUnavailable={params.catalogUnavailable ?? false}
      boundModelIds={new Set(params.boundModelIds ?? [])}
      customForm={params.customForm === undefined ? customFormBinding() : params.customForm}
      failureText={params.failureText ?? null}
      onClose={onClose}
      onSubmitBuiltIn={onSubmitBuiltIn}
    />,
  );
  return { onSubmitBuiltIn, onClose, unmount: view.unmount };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AddModelDialog 区块切换', () => {
  it('默认落在「软件自带的模型」；切到表单区块，字段树完整；再切回来勾选列表还在', () => {
    renderDialog({});

    // 正向查询两块字段名不重叠、各自唯一；非活动块在 jsdom 里测不出不可见性
    // （Tailwind 类不进 jsdom 样式表），由下方类名断言用例作前置条件断言
    expect(screen.getByRole('checkbox', { name: '添加 gpt-image-2' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '自定义接口的模型' }));
    expect(screen.getByRole('textbox', { name: '模型 ID' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '服务商那边的模型 ID' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '支持参考图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '高级参数自定义' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '软件自带的模型' }));
    expect(screen.getByRole('checkbox', { name: '添加 gpt-image-2' })).toBeInTheDocument();
  });

  it('切走再切回：表单里填了一半的内容还在（两块都挂载保活，不静默清空输入）', () => {
    renderDialog({});

    fireEvent.click(screen.getByRole('button', { name: '自定义接口的模型' }));
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    fireEvent.click(screen.getByRole('button', { name: '软件自带的模型' }));
    fireEvent.click(screen.getByRole('button', { name: '自定义接口的模型' }));

    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).value).toBe('my-image-model');
  });

  it('非活动块收起走条件 hidden 类：收起块的类名只有 hidden，不与任何布局 display 类共挂（2026-09-21 先例；jsdom 只作前置断言，真机可见性由真实验证兜底）', () => {
    renderDialog({});

    // 两个区块包装是唯一 gap-4 纵向容器的直接子 div，DOM 顺序固定 [自带, 自定义]
    const paneClassNames = (): string[] => {
      const host = screen.getByRole('dialog').querySelector('.flex.flex-col.gap-4');
      expect(host).not.toBeNull();
      return Array.from(host?.children ?? [])
        .filter((child) => child.tagName === 'DIV')
        .map((child) => child.className);
    };

    // 默认自带区块活动：自定义块收起。收起块类名严格等于 'hidden'——display:none 的生效路径
    // 唯一来自 hidden 类，没有 flex 等布局类与它竞争（布局类压过 hidden 属性的实锤先例）
    expect(paneClassNames()).toEqual(['flex flex-col gap-3', 'hidden']);

    fireEvent.click(screen.getByRole('button', { name: '自定义接口的模型' }));
    expect(paneClassNames()).toEqual(['hidden', 'flex flex-col gap-3']);
  });

  it('弹窗标题点明对象：添加到哪个服务商写在标题里', () => {
    renderDialog({});
    expect(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' })).toBeInTheDocument();
  });
});

describe('AddModelDialog 自带区块显隐（过渡期不留死壳）', () => {
  it('目录为空且有表单区块：自带区块连同切换项不渲染，弹窗直接是表单', () => {
    renderDialog({ catalog: [] });

    expect(screen.queryByRole('button', { name: '软件自带的模型' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '模型 ID' })).toBeInTheDocument();
    // footer 的主按钮随当前区块走：落表单就是「添加」
    expect(screen.getByRole('button', { name: '添加' })).toBeInTheDocument();
  });

  it('都添加过了：区块保留并说明缺口，默认落在表单（落在没有东西可勾的区块上等于让用户多点一次）', () => {
    renderDialog({ boundModelIds: ['gpt-image-2'] });

    expect(screen.getByRole('button', { name: '软件自带的模型' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '模型 ID' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '软件自带的模型' }));
    expect(screen.getByText('软件自带的模型都已经添加到这个服务商了。')).toBeInTheDocument();
  });

  it('目录读不到与「目录为空」分开说：区块保留、给「刷新」的出路，不引他去添加', () => {
    renderDialog({ catalog: [], catalogUnavailable: true });

    fireEvent.click(screen.getByRole('button', { name: '软件自带的模型' }));
    expect(screen.getByText('暂时读不到模型清单，关掉这个窗口后点「刷新」再试。')).toBeInTheDocument();
  });

  it('没装配自定义表单区块的调用方：不出切换项，目录为空时只说明情况', () => {
    renderDialog({ catalog: [], customForm: null });

    expect(screen.queryByRole('button', { name: '自定义接口的模型' })).not.toBeInTheDocument();
    expect(screen.getByText('软件里还没有可用的模型。')).toBeInTheDocument();
    // 没有可勾的模型：提交按钮禁用、标「添加模型」
    expect(screen.getByRole('button', { name: '添加模型' })).toBeDisabled();
  });
});

describe('AddModelDialog 提交', () => {
  it('勾选后提交：按草稿交回勾上的模型，没填远端 ID 就按模型 ID 请求', async () => {
    const onSubmitBuiltIn = vi.fn(async () => undefined);
    renderDialog({ onSubmitBuiltIn });

    fireEvent.click(screen.getByRole('checkbox', { name: '添加 gpt-image-2' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个模型' }));

    await waitFor(() => {
      expect(onSubmitBuiltIn).toHaveBeenCalledWith([
        { model_id: 'gpt-image-2', remote_model_id: 'gpt-image-2' },
      ]);
    });
  });

  it('没有勾选时主按钮禁用、标「添加模型」，不发起提交', () => {
    const onSubmitBuiltIn = vi.fn(async () => undefined);
    renderDialog({ onSubmitBuiltIn });

    expect(screen.getByRole('button', { name: '添加模型' })).toBeDisabled();
    expect(onSubmitBuiltIn).not.toHaveBeenCalled();
  });

  it('表单区块提交：接口类型空态起步、选了才可提交，随提交体交回；成功后关掉整个弹窗（footer 的主按钮随当前区块切换）', async () => {
    const onSubmit = vi.fn(async () => true);
    const onClose = vi.fn();
    renderDialog({
      catalog: [],
      customForm: customFormBinding({ onSubmit }),
      onClose,
    });

    // 接口类型未选：填了模型 ID 也不能提交
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();

    // 打开「接口类型」下拉选中一个选项（jsdom 无 PointerEvent：键盘开下拉，click 选中）
    fireEvent.keyDown(screen.getByLabelText('接口类型'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI Image' }));
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        familyAdapterId: 'openai-image-v1',
        modelId: 'my-image-model',
        remoteModelId: null,
        supportsReferenceImage: false,
        parameterOverrides: null,
      });
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe('AddModelDialog 失败提示', () => {
  it('失败原因显示在 footer 上方（顶部提示条被遮罩挡住），没有失败就不占位', () => {
    const { unmount } = renderDialog({});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    renderDialog({ failureText: '没能添加这个模型，请重试' });
    expect(screen.getByRole('alert')).toHaveTextContent('没能添加这个模型，请重试');
  });
});

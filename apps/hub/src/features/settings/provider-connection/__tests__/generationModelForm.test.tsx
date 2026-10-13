import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FamilyTemplateParameterDescriptor } from '@iart/contracts';

import {
  GenerationModelFields,
  useGenerationModelForm,
  type GenerationModelFormPayload,
} from '../GenerationModelForm';

/**
 * 自建生成模型的表单体（docs/custom-providers/生成模型自建声明试点-design.md §3.7）。
 *
 * 2026-09-26 界面收敛后它是合并弹窗（AddModelDialog）的「自定义接口的模型」区块：
 * 状态与提交逻辑在 `useGenerationModelForm`（挂在弹窗壳层，footer 按钮才拿得到可提交性），
 * 字段树在 `GenerationModelFields`。这里的 Harness 按合并弹窗的真实接线组装两者，
 * 底部按钮与弹窗 footer 同构（disabled = busy 或不可提交）。
 *
 * 保护的口径：接口类型是表单字段（协议归属模型级），空态起步、必选
 * （2026-09-29 起连接级预选摘除），随提交体交回；模型 ID 必填，没填不能提交；填了但格式非法
 * （按 contracts 的 model_id schema）拦截并显示格式文案，失焦即提示、提交不发请求；
 * 远端模型名留空提交 null（由调用方按「与模型 ID 相同」落成具体值，与对话侧先例同义），
 * 填了就原样交回；「支持参考图」默认不勾、勾选随提交体交回；没动「高级参数自定义」时
 * 提交 parameterOverrides 为 null（请求体不带 parameter_overrides，行为与现状一致）；
 * 尚未选择接口类型时展开高级区不拉参数描述，选好后再展开按所选接口类型拉取；
 * 失败原因显示在表单底部（顶部提示条被遮罩挡住），失败不关弹层、输入不丢。
 */

const Harness = ({
  onSubmit,
  onClose,
  loadParameterTemplate,
  failureText = null,
}: {
  onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
  onClose: () => void;
  loadParameterTemplate: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  failureText?: string | null;
}) => {
  const form = useGenerationModelForm({ loadParameterTemplate, onSubmit, onClose });
  return (
    <>
      <GenerationModelFields form={form} />
      {failureText === null ? null : <p role="alert" className="text-2xs text-destructive">{failureText}</p>}
      <button type="button" disabled={form.busy || !form.canSubmit} onClick={form.submit}>
        添加
      </button>
    </>
  );
};

const renderForm = (
  overrides: {
    failureText?: string | null;
    onClose?: () => void;
    onSubmit?: (payload: GenerationModelFormPayload) => Promise<boolean>;
    loadParameterTemplate?: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  } = {},
) => {
  const onSubmit = overrides.onSubmit ?? vi.fn(async () => true);
  const loadParameterTemplate =
    overrides.loadParameterTemplate ?? (() => Promise.reject(new Error('用例没有预期会拉取参数描述')));
  const view = render(
    <Harness
      loadParameterTemplate={loadParameterTemplate}
      failureText={overrides.failureText ?? null}
      onClose={overrides.onClose ?? (() => undefined)}
      onSubmit={onSubmit}
    />,
  );
  return { onSubmit, loadParameterTemplate, unmount: view.unmount };
};

/** 打开「接口类型」下拉并选中一个选项（jsdom 无 PointerEvent：键盘开下拉，click 选中）。 */
const chooseAdapter = (): void => {
  fireEvent.keyDown(screen.getByLabelText('接口类型'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: 'OpenAI Image' }));
};

describe('GenerationModelForm（添加）', () => {
  it('接口类型空态起步且必填：填了模型 ID 没选接口类型仍不能提交', () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
    expect(screen.getByLabelText('接口类型')).toHaveTextContent('请选择接口类型');
  });

  it('选了接口类型才可提交，随提交体交回；勾选的能力随提交体交回', async () => {
    const { onSubmit } = renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    fireEvent.change(screen.getByLabelText('服务商那边的模型 ID'), { target: { value: 'remote-name' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '支持参考图' }));
    chooseAdapter();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        familyAdapterId: 'openai-image-v1',
        modelId: 'my-image-model',
        remoteModelId: 'remote-name',
        supportsReferenceImage: true,
        parameterOverrides: null,
      });
    });
  });

  it('远端模型名留空提交 null（由调用方按「与模型 ID 相同」落成具体值），支持参考图默认不勾', async () => {
    const { onSubmit } = renderForm();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseAdapter();
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
  });

  it('模型 ID 格式非法时拦下：失焦即显示格式文案，提交不发请求；改一个字符即撤掉提示', () => {
    const { onSubmit } = renderForm();

    const input = screen.getByLabelText('模型 ID');
    fireEvent.change(input, { target: { value: 'my image!' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent(
      '模型 ID 只能用字母、数字、.、_、-，且以字母或数字开头',
    );

    chooseAdapter();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'my-image' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('提交失败时返回 false 不关弹层，输入不丢', async () => {
    const onClose = vi.fn();
    const { onSubmit } = renderForm({ onClose, onSubmit: vi.fn(async () => false) });

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseAdapter();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).value).toBe('my-image-model');
  });

  it('失败原因显示在表单底部（顶部提示条被遮罩挡住），没有失败就不占位', () => {
    const { unmount } = renderForm();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    // 后端确定性拒绝的可操作原因由调用方原样透传进来，弹层只负责显示
    renderForm({ failureText: '「my-image-model」已经添加到这个服务商了。' });
    expect(screen.getByRole('alert')).toHaveTextContent('「my-image-model」已经添加到这个服务商了。');
  });

  it('尚未选择接口类型时展开高级区不拉参数描述；选好后再展开按所选接口类型拉取', async () => {
    const loadParameterTemplate = vi.fn<(familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>>(
      () => Promise.reject(new Error('用例没有预期会真的装载')),
    );
    renderForm({ loadParameterTemplate });

    // 接口类型未选：展开高级区不发起装载，折叠区按「先选接口类型」指引呈现
    fireEvent.click(screen.getByRole('button', { name: '高级参数自定义' }));
    await waitFor(() => {
      expect(screen.getByText('先选好接口类型，再看能调哪些参数。')).toBeInTheDocument();
    });
    expect(loadParameterTemplate).not.toHaveBeenCalled();

    // 选好接口类型：收起再展开，按所选接口类型拉取
    fireEvent.click(screen.getByRole('button', { name: '高级参数自定义' }));
    chooseAdapter();
    fireEvent.click(screen.getByRole('button', { name: '高级参数自定义' }));
    await waitFor(() => {
      expect(loadParameterTemplate).toHaveBeenCalledWith('openai-image-v1');
    });
  });
});

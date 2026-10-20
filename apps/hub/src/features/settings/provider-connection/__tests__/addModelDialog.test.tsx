import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FamilyTemplateParameterDescriptor } from '@iart/contracts';

import { AddModelDialog, type CustomModelFormBinding } from '../AddModelDialog';

/** 族模板描述符：素材位能力是 2026-10-19 起表单的一部分（这里只给最小合法形状）。 */
const descriptorFor = (familyAdapterId: string): FamilyTemplateParameterDescriptor => ({
  family_adapter_id: familyAdapterId,
  official_fields: [],
  reserved_wire_names: [],
  supports_media_slots: familyAdapterId === 'openai-image-v1' ? ['reference_image'] : [],
  required_media_slots: [],
});

/**
 * 生成侧「添加模型」弹窗（2026-10-19：单一表单）。
 *
 * 这里保护的口径：
 * - 弹窗里只有**一个表单**：没有「软件自带的模型」区块、没有来源分段切换——软件不内置任何
 *   具体模型，界面上只有一种对象「模型」（spec 03 §6.1 单一载体 / `docs/ui-copy-standard.md`
 *   禁用「自带 / 自建」来源区分）。原「两区块切换 + 各自保活」的一整组用例因此随之退场。
 * - 自建表单的接口类型空态起步、必选（2026-09-29 起连接级预选摘除），随提交体交回。
 * - 表单区块未装配时不渲染提交必然失败的表单，只留一句可读说明、主按钮禁用。
 * - 失败原因显示在 footer 上方（分区顶部的提示条在弹窗期间被遮罩挡住）。
 */

const customFormBinding = (overrides: Partial<CustomModelFormBinding> = {}): CustomModelFormBinding => ({
  loadParameterTemplate:
    overrides.loadParameterTemplate ??
    ((familyAdapterId: string) => Promise.resolve(descriptorFor(familyAdapterId))),
  onSubmit: overrides.onSubmit ?? vi.fn(async () => true),
});

const renderDialog = (params: {
  customForm?: CustomModelFormBinding | null;
  failureText?: string | null;
  onClose?: () => void;
}) => {
  const onClose = params.onClose ?? vi.fn();
  const view = render(
    <AddModelDialog
      providerName="我的绘图服务"
      customForm={params.customForm === undefined ? customFormBinding() : params.customForm}
      failureText={params.failureText ?? null}
      onClose={onClose}
    />,
  );
  return { onClose, unmount: view.unmount };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AddModelDialog 单一表单', () => {
  it('打开即是表单：字段树完整，没有来源区块与分段切换', () => {
    renderDialog({});

    expect(screen.getByRole('textbox', { name: '模型 ID' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '服务商那边的模型 ID' })).toBeInTheDocument();
    // 素材位不预渲染成固定勾选框：没选接口类型时区块不出现（能力按所选族才可知）
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '高级参数自定义' })).toBeInTheDocument();
    // 来源区块与切换项整体不存在（不是被 hidden 收起）
    expect(screen.queryByRole('button', { name: '软件自带的模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '自定义接口的模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '模型来源' })).not.toBeInTheDocument();
  });

  it('弹窗标题点明对象：添加到哪个服务商写在标题里', () => {
    renderDialog({});
    expect(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' })).toBeInTheDocument();
  });

  it('没装配表单的调用方：不渲染提交必然失败的表单，只留可读说明且主按钮禁用', () => {
    renderDialog({ customForm: null });

    expect(screen.queryByRole('textbox', { name: '模型 ID' })).not.toBeInTheDocument();
    expect(screen.getByText('暂时没法添加模型，关掉这个窗口后点「刷新」再试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
  });
});

describe('AddModelDialog 提交', () => {
  it('接口类型空态起步、选了才可提交，随提交体交回；成功后关掉整个弹窗', async () => {
    const onSubmit = vi.fn(async () => true);
    const onClose = vi.fn();
    renderDialog({ customForm: customFormBinding({ onSubmit }), onClose });

    // 接口类型未选：填了模型 ID 也不能提交
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();

    // 打开「接口类型」下拉选中一个选项（jsdom 无 PointerEvent：键盘开下拉，click 选中）
    fireEvent.keyDown(screen.getByLabelText('接口类型'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI Image' }));
    // 素材位按所选族能力渲染，读到之后才放行提交
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        familyAdapterId: 'openai-image-v1',
        modelId: 'my-image-model',
        remoteModelId: null,
        acceptedMediaSlots: [],
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

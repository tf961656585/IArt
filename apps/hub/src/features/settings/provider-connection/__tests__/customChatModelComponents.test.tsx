import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { type ThinkingTierPool } from '@iart/contracts';
import { THINKING_TIER_NAME_INVALID_TEXT } from '../ThinkingTierFields';
import { CustomModelDialog, type CustomModelThinkingContext } from '../CustomModelDialog';
import {
  CONTEXT_WINDOW_INVALID_TEXT,
  MAX_OUTPUT_TOKENS_INVALID_TEXT,
} from '../CustomModelCapabilityFields';
import type { CustomChatModel } from '@iart/contracts';

/**
 * 自建对话模型的表单（spec 03 §6.1「记录即接入」、
 * spec hub-information-architecture §7.4「添加模型」「修改」）。
 *
 * 保护的口径：添加与修改走同一套能力字段（默认值来自共享常量，校验文案来自契约范围）；
 * 最大输出 token 留空即「不声明」，提交成 null 而不是某个我们挑的默认数字；
 * 添加时接口格式必选（2026-09-26 起协议归属模型级，记录自带 protocol_adapter_id；
 * 2026-09-29 起连接级预选摘除，空态起步、不落任何默认值），修改态接口格式随记录不可改；
 * 删除模型只在「改模型配置」时出现、且交回调用方（组件不自行删除）；
 * 思考档位只在有连接上下文的入口出现，「添加档位」按下的档位会被勾上，
 * 自定义档位能就地删出池子（内置常用档没有这个入口）。
 */

/** 打开「接口格式」下拉并选中一个选项（jsdom 无 PointerEvent：键盘开下拉，click 选中）。 */
const chooseAdapter = (): void => {
  fireEvent.keyDown(screen.getByLabelText('接口格式'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: 'OpenAI Chat Completions' }));
};

const existingModel: CustomChatModel = {
  model_id: 'my-llm',
  record_id: 'up_dep_rec1',
  connection_id: 'up_conn_chat1',
  remote_model_id: 'my-llm',
  protocol_adapter_id: 'openai-chat-completions-v1',
  context_window_tokens: 300000,
  max_output_tokens: 8192,
  enabled_thinking_tiers: ['low'],
  default_thinking_tier: null,
  created_at: '2026-09-17T00:00:00.000Z',
};

describe('CustomModelDialog（添加）', () => {
  it('未填模型 ID 时不能提交，填了才交回模型 ID 与两个能力值', async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <CustomModelDialog
        mode={{ kind: 'create', providerName: '我的网关' }}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    const submit = screen.getByRole('button', { name: '添加' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-llm' } });
    fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '300000' } });
    fireEvent.change(screen.getByLabelText('最大输出 token'), { target: { value: '8192' } });
    chooseAdapter();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        modelId: 'my-llm',
        protocolAdapterId: 'openai-chat-completions-v1',
        contextWindowTokens: 300000,
        maxOutputTokens: 8192,
        enabledThinkingTiers: null,
        defaultThinkingTier: null,
      });
    });
  });

  it('接口格式空态起步、必选：不落任何默认值，选了才能提交', () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <CustomModelDialog
        mode={{ kind: 'create', providerName: '我的网关' }}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    // 空态起步：不预选第一个对话接口，占位明示必选
    expect(screen.getByLabelText('接口格式')).toHaveTextContent('请选择接口格式');
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-llm' } });
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();

    chooseAdapter();
    expect(screen.getByRole('button', { name: '添加' })).toBeEnabled();
  });

  it('最大输出 token 留空表示不声明，提交 null（而不是补一个默认数字）', async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <CustomModelDialog
        mode={{ kind: 'create', providerName: '我的网关' }}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-llm' } });
    chooseAdapter();
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        modelId: 'my-llm',
        protocolAdapterId: 'openai-chat-completions-v1',
        contextWindowTokens: 128000,
        maxOutputTokens: null,
        enabledThinkingTiers: null,
        defaultThinkingTier: null,
      });
    });
  });

  it('上下文窗口预填共享缺省值；两个字段越界都被拦下且提示写清范围', () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <CustomModelDialog
        mode={{ kind: 'create', providerName: '我的网关' }}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    expect((screen.getByLabelText('上下文窗口') as HTMLInputElement).value).toBe('128000');

    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'my-llm' } });
    fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '12.5' } });
    expect(screen.getByText(CONTEXT_WINDOW_INVALID_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('上下文窗口'), { target: { value: '300000' } });
    fireEvent.change(screen.getByLabelText('最大输出 token'), { target: { value: '0' } });
    expect(screen.getByText(MAX_OUTPUT_TOKENS_INVALID_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('CustomModelDialog（修改）', () => {
  it('回填当前声明的能力，模型 ID 只读不可改', async () => {
    const onSubmit = vi.fn(async () => true);
    render(
      <CustomModelDialog mode={{ kind: 'edit', model: existingModel }} onClose={() => undefined} onSubmit={onSubmit} />,
    );

    expect((screen.getByLabelText('上下文窗口') as HTMLInputElement).value).toBe('300000');
    expect((screen.getByLabelText('最大输出 token') as HTMLInputElement).value).toBe('8192');
    // 模型 ID 是身份，不提供改名：这里是只读文本，不是输入框。
    expect(screen.getByText('my-llm')).toBeInTheDocument();
    expect(screen.queryByLabelText('模型 ID')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('最大输出 token'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        modelId: 'my-llm',
        protocolAdapterId: null,
        contextWindowTokens: 300000,
        maxOutputTokens: null,
        enabledThinkingTiers: null,
        defaultThinkingTier: null,
      });
    });
  });

  it('保存失败时返回 false 不关弹层', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn(async () => false);
    render(
      <CustomModelDialog mode={{ kind: 'edit', model: existingModel }} onClose={onClose} onSubmit={onSubmit} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('带删除动作时给出「删除模型」，交回调用方（组件不自行删除）', () => {
    const onDelete = vi.fn();
    render(
      <CustomModelDialog
        mode={{ kind: 'edit', model: existingModel }}
        onDelete={onDelete}
        onClose={() => undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除模型' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('没带删除动作时不给「删除模型」：声明级的删除只从接入的配置弹层进', () => {
    render(
      <CustomModelDialog
        mode={{ kind: 'edit', model: existingModel }}
        onClose={() => undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(screen.queryByRole('button', { name: '删除模型' })).not.toBeInTheDocument();
  });

  it('失败原因显示在表单底部（顶部提示条被遮罩挡住），没有失败就不占位', () => {
    const { unmount } = render(
      <CustomModelDialog
        mode={{ kind: 'edit', model: existingModel }}
        onClose={() => undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    render(
      <CustomModelDialog
        mode={{ kind: 'edit', model: existingModel }}
        failureText="没能保存模型配置，请重试"
        onClose={() => undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('没能保存模型配置，请重试');
  });
});

describe('CustomModelDialog（思考档位）', () => {
  const pool: ThinkingTierPool = {
    builtin: ['minimal', 'low', 'medium', 'high'],
    custom: [{ name: 'ultra', used_by_models: 1 }],
  };

  const thinkingContext = (
    overrides: Partial<CustomModelThinkingContext> = {},
  ): CustomModelThinkingContext => ({
    pool,
    unavailable: false,
    initialTiers: [],
    initialDefaultTier: null,
    onAddCustom: async () => true,
    onDeleteCustom: () => undefined,
    ...overrides,
  });

  /** 已启用列表里按 DOM 顺序读出的档位名（顺序即创作面展示顺序） */
  const enabledTierNames = (): string[] =>
    screen
      .queryAllByRole('button', { name: /^拖动排序「/ })
      .map((handle) => (handle.getAttribute('aria-label') ?? '').replace(/^拖动排序「|」$/g, ''));

  const renderEdit = (
    thinking: CustomModelThinkingContext,
    onSubmit = vi.fn(async () => true),
    model: CustomChatModel = existingModel,
  ): { onSubmit: typeof onSubmit } => {
    render(
      <CustomModelDialog
        mode={{ kind: 'edit', model }}
        thinking={thinking}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    return { onSubmit };
  };

  it('回填该接入已启用的档位与它们的顺序，保存时按该顺序交回', async () => {
    const { onSubmit } = renderEdit(thinkingContext({ initialTiers: ['high', 'low'] }));

    // 已启用列表的顺序就是创作面的展示顺序：DOM 顺序必须与回填顺序一致
    expect(enabledTierNames()).toEqual(['high', 'low']);

    fireEvent.click(screen.getByRole('button', { name: '启用档位「medium」' }));
    fireEvent.click(screen.getByRole('button', { name: '移除档位「low」' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        modelId: 'my-llm',
        protocolAdapterId: null,
        contextWindowTokens: 300000,
        maxOutputTokens: 8192,
        enabledThinkingTiers: ['high', 'medium'],
        defaultThinkingTier: null,
      });
    });
  });

  it('默认档位从已启用档位里指定，取消后交回 null', async () => {
    const { onSubmit } = renderEdit(thinkingContext({ initialTiers: ['low', 'medium'], initialDefaultTier: 'low' }));

    expect(screen.getByText('默认档位')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消默认档位' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ defaultThinkingTier: null }));
    });
  });

  it('没有启用档位就是「不思考」，提交空数组与空默认（不是不提交）', async () => {
    const { onSubmit } = renderEdit(thinkingContext());
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ enabledThinkingTiers: [], defaultThinkingTier: null }),
      );
    });
  });

  it('移除默认档位那一行时默认跟着清掉（默认必须还在已启用列表里）', async () => {
    const { onSubmit } = renderEdit(thinkingContext({ initialTiers: ['low'], initialDefaultTier: 'low' }));

    fireEvent.click(screen.getByRole('button', { name: '移除档位「low」' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ enabledThinkingTiers: [], defaultThinkingTier: null }),
      );
    });
  });

  it('拖动排序手柄带可读名（排序入口对键盘与读屏可见）', () => {
    renderEdit(thinkingContext({ initialTiers: ['low', 'high'] }));

    expect(screen.getByRole('button', { name: '拖动排序「low」' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拖动排序「high」' })).toBeInTheDocument();
  });

  it('「添加档位」成功后进池并被启用（用户按下它就是要在本模型上用），默认不动', async () => {
    const onAddCustom = vi.fn(async () => true);
    const { onSubmit } = renderEdit(thinkingContext({ onAddCustom, initialTiers: ['low'] }));

    fireEvent.change(screen.getByLabelText('自定义档位名'), { target: { value: 'ultra-2' } });
    fireEvent.click(screen.getByRole('button', { name: '添加档位' }));

    await waitFor(() => {
      expect(onAddCustom).toHaveBeenCalledWith('ultra-2');
    });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ enabledThinkingTiers: ['low', 'ultra-2'], defaultThinkingTier: null }),
      );
    });
  });

  it('加档位失败时保留输入内容，不勾选、不静默清空', async () => {
    const onAddCustom = vi.fn(async () => false);
    renderEdit(thinkingContext({ onAddCustom }));

    const input = screen.getByLabelText('自定义档位名') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ultra-2' } });
    fireEvent.click(screen.getByRole('button', { name: '添加档位' }));

    await waitFor(() => {
      expect(onAddCustom).toHaveBeenCalledWith('ultra-2');
    });
    expect(input.value).toBe('ultra-2');
    expect(enabledTierNames()).not.toContain('ultra-2');
  });

  it('自定义档位能在「可添加」里就地删出池子，交回调用方（组件不自行删除）', () => {
    const onDeleteCustom = vi.fn();
    renderEdit(thinkingContext({ onDeleteCustom }));

    fireEvent.click(screen.getByRole('button', { name: '删除档位「ultra」' }));
    expect(onDeleteCustom).toHaveBeenCalledWith('ultra');
    // 内置常用档随软件固定、只读：不给删除入口
    expect(screen.queryByRole('button', { name: '删除档位「low」' })).not.toBeInTheDocument();
  });

  it('已启用的自定义档位不在「可添加」里，先把它从本模型移除才删除它', () => {
    const onDeleteCustom = vi.fn();
    renderEdit(thinkingContext({ onDeleteCustom, initialTiers: ['ultra'] }));

    // 一次表单里不混两处状态：它在已启用列表里时不给池子删除入口
    expect(screen.queryByRole('button', { name: '删除档位「ultra」' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移除档位「ultra」' }));
    fireEvent.click(screen.getByRole('button', { name: '删除档位「ultra」' }));
    expect(onDeleteCustom).toHaveBeenCalledWith('ultra');
  });

  it('档位名不合规时当场说清规则并挡住提交，不等一次失败往返', () => {
    const onAddCustom = vi.fn(async () => true);
    renderEdit(thinkingContext({ onAddCustom }));

    const input = screen.getByLabelText('自定义档位名');
    fireEvent.change(input, { target: { value: '超高' } });

    expect(screen.getByText(THINKING_TIER_NAME_INVALID_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加档位' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'ultra-2' } });
    expect(screen.queryByText(THINKING_TIER_NAME_INVALID_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加档位' })).toBeEnabled();
    expect(onAddCustom).not.toHaveBeenCalled();
  });

  it('接口格式表达不了自定义档位时：自定义档位加不上、说明原因，且不给添加入口', () => {
    // 可表达性按记录自带的接口格式判定（协议归属模型级），不按连接的默认接口格式
    const anthropicModel: CustomChatModel = { ...existingModel, protocol_adapter_id: 'anthropic-messages-v1' };
    renderEdit(thinkingContext(), vi.fn(async () => true), anthropicModel);

    expect(screen.getByRole('button', { name: '启用档位「ultra」' })).toBeDisabled();
    expect(screen.getByText('当前接口格式不支持自定义档位。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加档位' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启用档位「low」' })).toBeEnabled();
  });

  it('接口格式还没选时：自定义档位先说明要先选接口格式，不给添加入口', () => {
    render(
      <CustomModelDialog
        mode={{ kind: 'create', providerName: '我的网关' }}
        thinking={thinkingContext()}
        onClose={() => undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText('先选好接口格式，再看能不能加自定义档位。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加档位' })).not.toBeInTheDocument();
  });

  it('档位读不到时说明「暂时读不到」，不给空候选', () => {
    renderEdit(thinkingContext({ unavailable: true, pool: { builtin: [], custom: [] } }));

    expect(screen.getByText('思考档位暂时读不到，关掉这个窗口后点「刷新」再试。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '＋ low' })).not.toBeInTheDocument();
  });

  it('没有接入上下文时不出现思考档位：档位属于接入，写进去也没有连接承载它', () => {
    render(
      <CustomModelDialog
        mode={{ kind: 'edit', model: existingModel }}
        onClose={() => undefined}
        onSubmit={vi.fn(async () => true)}
      />,
    );

    expect(screen.queryByText('思考档位')).not.toBeInTheDocument();
  });
});

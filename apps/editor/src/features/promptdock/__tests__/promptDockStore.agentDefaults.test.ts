import { describe, expect, it, beforeEach } from 'vitest';

import type { PromptDockChatCatalogEntry } from '@/client/api/promptDockApi';
import { usePromptDockStore } from '../promptDockStore';

/**
 * agent 形态的默认模型与默认档位（spec docs/agent/06「agent 形态的输入面」、
 * spec 37「思考档位」）。
 *
 * 两条规则：
 * - 默认模型：主窗口设置的偏好（`config.agentDefaultModelId`）在创作面还没选过模型时预选；
 *   配置里的模型不在目录里就不预选——目录是「现在能用什么」的事实源。
 * - 默认档位：换模型时，用户没改过思考就套用新模型的默认档位；改过就保留（不可用才换）。
 *   存在的意义是「不为用户挑一个他没表达过的档位」，同时让默认档位真的生效。
 */

const chatEntry = (
  modelId: string,
  thinkingTiers: string[],
  defaultThinkingTier: string | null = null,
): PromptDockChatCatalogEntry => ({
  model_id: modelId,
  model_version: '1.0.0',
  default_task_type: 'text',
  capability: { input_modalities: ['text'], output_modalities: ['text'] },
  parameter_schema: { fields: [], required_fields: [] },
  thinking_tiers: thinkingTiers,
  default_thinking_tier: defaultThinkingTier,
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'up_dep_chat',
    deployable: true,
    failure_code: 'none',
  },
});

const resetStore = () => {
  usePromptDockStore.setState({
    agentSelection: { modelId: null, thinkingTier: 'off', approval: 'confirm' },
    chatCatalog: [],
    chatCatalogLoaded: false,
    agentDefaultModelId: null,
    agentThinkingTierChosen: false,
  });
};

const selection = () => usePromptDockStore.getState().agentSelection;

beforeEach(() => {
  resetStore();
});

describe('Agent 默认模型的预选', () => {
  it('目录与配置都到齐后预选默认模型，并套用该模型的默认档位', () => {
    usePromptDockStore.getState().setChatCatalog([chatEntry('my-llm', ['low', 'high'], 'high')]);
    usePromptDockStore.getState().setAgentDefaultModelId('my-llm');

    expect(selection().modelId).toBe('my-llm');
    expect(selection().thinkingTier).toBe('high');
  });

  it('两边到达顺序相反时同样预选（配置先到、目录后到）', () => {
    usePromptDockStore.getState().setAgentDefaultModelId('my-llm');
    expect(selection().modelId).toBeNull();

    usePromptDockStore.getState().setChatCatalog([chatEntry('my-llm', ['low'], 'low')]);
    expect(selection().modelId).toBe('my-llm');
    expect(selection().thinkingTier).toBe('low');
  });

  it('用户已经选过模型时不覆盖他的选择', () => {
    usePromptDockStore.getState().setChatCatalog([chatEntry('other-llm', ['low']), chatEntry('my-llm', ['high'], 'high')]);
    usePromptDockStore.getState().selectAgentModel('other-llm');
    usePromptDockStore.getState().setAgentDefaultModelId('my-llm');

    expect(selection().modelId).toBe('other-llm');
  });

  it('默认模型不在目录里（已被移除或接入不可用）时不预选', () => {
    usePromptDockStore.getState().setAgentDefaultModelId('gone-llm');
    usePromptDockStore.getState().setChatCatalog([chatEntry('my-llm', ['low'], 'low')]);

    expect(selection().modelId).toBeNull();
    expect(selection().thinkingTier).toBe('off');
  });

  it('没设默认（null）时保持未选择，由用户自己挑', () => {
    usePromptDockStore.getState().setAgentDefaultModelId(null);
    usePromptDockStore.getState().setChatCatalog([chatEntry('my-llm', ['low'], 'low')]);

    expect(selection().modelId).toBeNull();
  });
});

describe('换模型时的思考档位', () => {
  beforeEach(() => {
    usePromptDockStore.getState().setChatCatalog([
      chatEntry('llm-default-low', ['low', 'high'], 'low'),
      chatEntry('llm-default-high', ['low', 'high'], 'high'),
      chatEntry('llm-no-default', ['low', 'high']),
      chatEntry('llm-no-tiers', []),
    ]);
  });

  it('用户没改过思考：换模型套用新模型的默认档位', () => {
    usePromptDockStore.getState().selectAgentModel('llm-default-low');
    expect(selection().thinkingTier).toBe('low');

    usePromptDockStore.getState().selectAgentModel('llm-default-high');
    expect(selection().thinkingTier).toBe('high');
  });

  it('没有默认档位的模型按「不思考」处理', () => {
    usePromptDockStore.getState().selectAgentModel('llm-no-default');
    expect(selection().thinkingTier).toBe('off');
  });

  it('用户改过、且该档位对新模型仍可用时保留他的选择', () => {
    usePromptDockStore.getState().selectAgentModel('llm-default-low');
    usePromptDockStore.getState().setAgentThinkingTier('high');

    usePromptDockStore.getState().selectAgentModel('llm-default-high');
    expect(selection().thinkingTier).toBe('high');
  });

  it('用户改过但新模型用不了该档位时，改用新模型的默认档位', () => {
    usePromptDockStore.getState().selectAgentModel('llm-default-low');
    usePromptDockStore.getState().setAgentThinkingTier('high');

    usePromptDockStore.getState().selectAgentModel('llm-no-tiers');
    expect(selection().thinkingTier).toBe('off');

    usePromptDockStore.getState().selectAgentModel('llm-default-high');
    expect(selection().thinkingTier).toBe('high');
  });

  it('用户明确选了「不思考」后换模型不被默认档位顶掉', () => {
    usePromptDockStore.getState().selectAgentModel('llm-default-low');
    usePromptDockStore.getState().setAgentThinkingTier('off');

    usePromptDockStore.getState().selectAgentModel('llm-default-high');
    expect(selection().thinkingTier).toBe('off');
  });
});

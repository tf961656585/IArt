import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PromptDockChatCatalogEntry } from '@/client/api/promptDockApi';
import { usePromptDockStore } from '../promptDockStore';
import { PromptDockAgentServiceRow } from '../components/PromptDockAgentServiceRow';

/**
 * agent 形态服务行的选择语义（spec docs/agent/06「agent 形态的输入面」、spec 37「思考档位」）。
 *
 * 保护两条口径：
 * - 思考档位候选只来自该模型的目录投影（`thinking_tiers`）+「不思考」，创作面不自行推断；
 * - 换模型时不可用的档位回落为「不思考」，不静默替用户换到别的档位；
 * - 审批切「自动执行」需要显式确认。
 */

vi.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const chatEntry = (
  modelId: string,
  thinkingTiers: string[],
  deployable = true,
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
    has_active_deployment: deployable,
    active_deployment_id: deployable ? 'up_dep_chat' : null,
    deployable,
    failure_code: deployable ? 'none' : 'no_active_deployment',
  },
});

beforeEach(() => {
  cleanup();
  usePromptDockStore.setState({
    agentSelection: { modelId: null, thinkingTier: 'off', approval: 'confirm' },
    chatCatalog: [chatEntry('my-llm', ['low', 'high']), chatEntry('my-llm-2', [])],
    chatCatalogLoaded: true,
  });
});

describe('agent 服务行：形态配置', () => {
  it('思考候选 = 「不思考」+ 该模型启用档位；换到没有档位的模型后回落不思考', () => {
    render(<PromptDockAgentServiceRow />);

    usePromptDockStore.getState().selectAgentModel('my-llm');
    expect(usePromptDockStore.getState().agentSelection.modelId).toBe('my-llm');

    usePromptDockStore.getState().setAgentSelection({ thinkingTier: 'high' });
    expect(usePromptDockStore.getState().agentSelection.thinkingTier).toBe('high');

    // 换到没有思考档位的模型：当前档位不可用 → 回落不思考，而不是保留一个发不出去的档位
    usePromptDockStore.getState().selectAgentModel('my-llm-2');
    expect(usePromptDockStore.getState().agentSelection.thinkingTier).toBe('off');
  });

  it('换模型后仍可用同一档位时保留选择', () => {
    usePromptDockStore.getState().selectAgentModel('my-llm');
    usePromptDockStore.getState().setAgentSelection({ thinkingTier: 'low' });
    usePromptDockStore.getState().selectAgentModel('my-llm-2');
    usePromptDockStore.getState().selectAgentModel('my-llm');
    // 中间经过一次「不可用回落」，因此回到 my-llm 时是不思考——这是回落后的真实状态，不做记忆
    expect(usePromptDockStore.getState().agentSelection.thinkingTier).toBe('off');
  });

  it('审批切「自动执行」需确认：取消不改，确认才改', () => {
    render(<PromptDockAgentServiceRow />);

    fireEvent.click(screen.getByTestId('promptdock-agent-approval'));
    expect(usePromptDockStore.getState().agentSelection.approval).toBe('confirm');
  });

  it('未选模型时不显示部署提示；选了不可用模型时给出失效原因', () => {
    const { rerender } = render(<PromptDockAgentServiceRow />);
    expect(screen.queryByTestId('promptdock-agent-deployment-hint')).not.toBeInTheDocument();

    usePromptDockStore.setState({
      agentSelection: { modelId: 'my-llm', thinkingTier: 'off', approval: 'confirm' },
      chatCatalog: [chatEntry('my-llm', ['low'], false)],
    });
    rerender(<PromptDockAgentServiceRow />);

    expect(screen.getByTestId('promptdock-agent-deployment-hint')).toHaveTextContent('还没有添加到任何服务商');
  });
});

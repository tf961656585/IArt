import { describe, expect, it } from 'vitest';

import type { PromptDockCatalogEntry, PromptDockChatCatalogEntry } from '@/client/api/promptDockApi';
import {
  createMediaAssetFixture,
  createMediaAssetMapFixture,
} from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import type { PromptDockAgentSelection, PromptDockDraft } from '../PromptDock.types';
import { runPromptDockPreflight } from '../promptDockPreflight';

/**
 * PromptDock 提交前置校验（spec docs/editor/节点执行前置校验.md）。
 *
 * 本组保护 prompt 与参数空间的双口径边界：
 * - prompt 已从模型能力包 parameter_schema 剥离（方案 B），目录投影的 fields / required_fields
 *   不再出现 prompt，草稿顶层 prompt 非空即满足「必需输入」；
 * - 其余参数必填项仍照常校验。
 */

const buildEntry = (requiredFields: string[]): PromptDockCatalogEntry => ({
  model_id: 'gpt-image-2',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: {
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
    supports_reference_media: true,
  },
  parameter_schema: {
    fields: [
      {
        fieldKey: 'size',
        label: 'Size',
        component: 'select',
        required: false,
        enumOptions: [{ value: 'auto', label: 'Auto' }],
      },
    ],
    required_fields: requiredFields,
    default_values: { size: 'auto' },
  },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'up_dep_openai_image',
    deployable: true,
    failure_code: 'none',
  },
});

const buildDraft = (prompt: string, args: Record<string, unknown>): PromptDockDraft => ({
  modelId: 'gpt-image-2',
  modelVersion: '1.0.0',
  prompt,
  arguments: args,
  references: [],
  promptPresetSnapshots: undefined,
  taskCount: 1,
});

describe('runPromptDockPreflight：prompt 与模型参数空间分离', () => {
  it('输入 prompt 后，无模型必需参数缺失，直接通过', () => {
    const result = runPromptDockPreflight(
      buildDraft('一只在草地上的猫', { size: 'auto' }),
      buildEntry([]),
      {},
    );
    expect(result.ok).toBe(true);
  });

  it('prompt 为空且无引用素材时，仍按必需输入未提供拦截', () => {
    const result = runPromptDockPreflight(
      buildDraft('', { size: 'auto' }),
      buildEntry([]),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'required-input-missing')).toBe(true);
    }
  });

  it('prompt 字段以外的模型必需参数缺失仍被拦截', () => {
    const result = runPromptDockPreflight(
      buildDraft('一只在草地上的猫', {}),
      buildEntry(['size']),
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((item) => item.code === 'required-param-missing');
      expect(issue?.field).toBe('size');
    }
  });
});

describe('runPromptDockPreflight：prompt 内联预设 token 失效', () => {
  const snapshot = (id: string, content: string) => ({
    id,
    name: `预设-${id}`,
    content,
    createdAt: 0,
    updatedAt: 0,
  });

  it('token 无快照时按失效拦截，并定位到该预设', () => {
    const draft: PromptDockDraft = {
      ...buildDraft('[[pp:gone]] 一只猫', { size: 'auto' }),
      promptPresetSnapshots: undefined,
    };
    const result = runPromptDockPreflight(draft, buildEntry([]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((item) => item.code === 'preset-token-invalid');
      expect(issue?.field).toBe('gone');
    }
  });

  it('快照存在且正文非空时通过', () => {
    const draft: PromptDockDraft = {
      ...buildDraft('[[pp:p1]] 一只猫', { size: 'auto' }),
      promptPresetSnapshots: { p1: snapshot('p1', 'portrait prompt') },
    };
    expect(runPromptDockPreflight(draft, buildEntry([]), {}).ok).toBe(true);
  });

  it('快照正文为空同样按失效拦截，同一预设出现多次只报一次', () => {
    const draft: PromptDockDraft = {
      ...buildDraft('[[pp:p1]] 前面 [[pp:p1]] 后面', { size: 'auto' }),
      promptPresetSnapshots: { p1: snapshot('p1', '') },
    };
    const result = runPromptDockPreflight(draft, buildEntry([]), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.filter((item) => item.code === 'preset-token-invalid')).toHaveLength(1);
      expect(result.issues[0]?.message).toContain('预设-p1');
    }
  });
});

/**
 * agent 形态的模型可用性判定（spec docs/agent/06「空态与无会话状态」、spec 04 发送前置校验）。
 *
 * 与生成式同源：可用性与失效原因都由目录投影的 deployment.deployable / failure_code 给出，
 * Editor 不解析连接、凭证与适配器。
 */
describe('runPromptDockPreflight：agent 形态的模型可用性', () => {
  const buildAgentEntry = (
    deployable: boolean,
    failureCode: PromptDockCatalogEntry['deployment']['failure_code'],
  ): PromptDockChatCatalogEntry => ({
    model_id: 'my-llm',
    model_version: '1.0.0',
    default_task_type: 'text',
    capability: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    parameter_schema: { fields: [], required_fields: [] },
    thinking_tiers: ['low', 'high'],
    default_thinking_tier: null,
    deployment: {
      has_active_deployment: true,
      active_deployment_id: deployable ? 'up_dep_chat' : null,
      deployable,
      failure_code: failureCode,
    },
  });
  const agentSelection = (modelId: string | null): PromptDockAgentSelection => ({
    modelId,
    thinkingTier: 'off',
    approval: 'confirm',
  });

  it('未选模型：给出到主窗口配置的引导', () => {
    const result = runPromptDockPreflight(
      buildDraft('帮我做三张图', {}),
      null,
      {},
      'agent',
      agentSelection(null),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe('deployment-not-executable');
      expect(result.issues[0]?.message).toContain('还没有可用的模型');
    }
  });

  it('选了模型但服务商那边不可用：反馈是失效原因，不是「没有模型」', () => {
    const result = runPromptDockPreflight(
      buildDraft('帮我做三张图', {}),
      buildAgentEntry(false, 'credential_missing'),
      {},
      'agent',
      agentSelection('my-llm'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.message).toContain('还没填密钥');
    }
  });

  it('模型可用：通过（agent 不校验参数与任务数）', () => {
    const result = runPromptDockPreflight(
      buildDraft('帮我做三张图', {}),
      buildAgentEntry(true, 'none'),
      {},
      'agent',
      agentSelection('my-llm'),
    );
    expect(result.ok).toBe(true);
  });

  it('参考素材是语言模型用不了的媒体类型：阻断', () => {
    const draft: PromptDockDraft = {
      ...buildDraft('帮我做三张图', {}),
      references: [{ refId: 'r1', assetId: 'asset_video', mediaType: 'video', label: '片段' }],
    };
    const result = runPromptDockPreflight(
      draft,
      buildAgentEntry(true, 'none'),
      createMediaAssetMapFixture([createMediaAssetFixture({ id: 'asset_video' })]),
      'agent',
      agentSelection('my-llm'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe('incompatible-reference');
      expect(result.issues[0]?.message).toContain('视频');
    }
  });
});

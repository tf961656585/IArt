// @spec: OF-16
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { ExecutableModelDirectoryEntry } from '@iart/contracts';
import { PromptDockHeader } from '../components/PromptDockHeader';
import {
  CAPABILITY_UNLABELED_LABEL,
  capabilityLabelsOf,
  hasUnlabeledCapability,
} from '../promptDockCapabilityLabels';

/**
 * 能力标签的创作面呈现（spec 48 §6.2 / OF-16）。
 *
 * 接缝：可执行目录条目（记录上的 capability_labels）→ PromptDock 顶带。
 * 钉三件事：① 有标签原样显示、不翻译；② 没标签给中性提示「能力未标注」；
 * ③ 标注不阻断——它不是错误，也不进前置校验。
 */

vi.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    // 组件里两种调用形态都有：t(key, '默认文案') 与 t(key, { defaultValue })，mock 都要兜住。
    t: (key: string, options?: string | { defaultValue?: string }) =>
      typeof options === 'string' ? options : options?.defaultValue ?? key,
  }),
}));

const entry = (overrides: Partial<ExecutableModelDirectoryEntry> = {}): ExecutableModelDirectoryEntry => ({
  model_id: 'model-a',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [], default_values: {} },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
  ...overrides,
});

const renderHeader = (target: ExecutableModelDirectoryEntry): void => {
  render(<PromptDockHeader catalog={[target]} selectedModelId={target.model_id} selectedEntry={target} />);
};

afterEach(cleanup);

describe('PromptDock 模型选择器：能力标签', () => {
  it('有标签时原样显示，不翻译不排序', () => {
    renderHeader(entry({ capability_labels: ['动图', '4K 图'] }));
    expect(screen.getByTestId('promptdock-capability-labels')).toHaveTextContent('动图、4K 图');
  });

  it('没标签时给中性提示「能力未标注」，不冒充「什么都产不出」', () => {
    renderHeader(entry({ capability_labels: [] }));
    expect(screen.getByTestId('promptdock-capability-unlabeled')).toHaveTextContent(
      CAPABILITY_UNLABELED_LABEL,
    );
    expect(screen.queryByTestId('promptdock-capability-labels')).not.toBeInTheDocument();
  });

  it('目录没给该字段（旧后端）按未标注呈现', () => {
    renderHeader(entry());
    expect(screen.getByTestId('promptdock-capability-unlabeled')).toBeInTheDocument();
  });

  it('标注不阻断：可提交状态不因未标注改变', () => {
    renderHeader(entry());
    expect(screen.getByTestId('promptdock-deployment-status')).toHaveAttribute('aria-label', '可以生成');
  });

  it('选择器 trigger 只显示模型名，能力标签不跟着再重复一遍', () => {
    // Radix 默认把选中条目的整块内容投影进 trigger（模型名 + 标签），
    // 右侧常驻标签会变成第二份；trigger 必须只留模型名。
    renderHeader(entry({ capability_labels: ['动图', '4K 图'] }));
    expect(screen.getByTestId('promptdock-model-select')).toHaveTextContent(/^model-a$/);
  });

  it('未标注时 trigger 也不重复「能力未标注」', () => {
    renderHeader(entry());
    expect(screen.getByTestId('promptdock-model-select')).toHaveTextContent(/^model-a$/);
  });


});

describe('能力标签判据', () => {
  it('缺字段与空数组都算未标注；有值即已标注', () => {
    expect(capabilityLabelsOf(null)).toEqual([]);
    expect(capabilityLabelsOf(undefined)).toEqual([]);
    expect(capabilityLabelsOf(entry())).toEqual([]);
    expect(hasUnlabeledCapability(entry())).toBe(true);
    expect(hasUnlabeledCapability(entry({ capability_labels: ['静态图'] }))).toBe(false);
  });
});

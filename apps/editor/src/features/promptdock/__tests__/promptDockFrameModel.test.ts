import { describe, expect, it } from 'vitest';

import type { ExecutableCatalogParameterField } from '@iart/contracts';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import type { FrameConstrainedProps } from '../promptDockFrameModel';
import {
  checkConstrainedDims,
  compareFrameGridOptions,
  composeConstrainedSize,
  deriveFrameSpec,
  formatConstraintSummary,
  frameChipText,
  frameConsumedKeys,
  parseDimsValue,
  parseFrameConstrainedProps,
  parseRatioValue,
  ratioFraction,
  resolveConstrainedState,
} from '../promptDockFrameModel';

/**
 * PromptDock 画幅域呈现模型（原型 prototypes/shared/promptdock-frame.js 的 Editor 落地）。
 * 保护不变量：
 * - 形态派生只依据运行时 schema（constrained 单字段 / combo 双字段），不按 model_id 硬编码；
 * - 总像素档合成（K 档重锚口径）与官方四约束校验一致；
 * - 提交值保持扁平 'auto' | 'WxH'（后端 payload_rules 直接映射 body.size）；
 * - 不构成画幅两轴的字段保持通用控件（不派生）。
 */

const field = (
  overrides: Partial<ExecutableCatalogParameterField> & { fieldKey: string; component: string },
): ExecutableCatalogParameterField => ({
  label: overrides.fieldKey,
  required: false,
  ...overrides,
});

const entry = (fields: ExecutableCatalogParameterField[]): PromptDockCatalogEntry => ({
  model_id: 'test-model',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields, required_fields: [], default_values: {} },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
});

/** gpt-image-2 官方约束（03 §6.1）测试夹具 */
const gpt2Constraints = {
  dimensionMultiple: 16,
  maxLongEdge: 3840,
  minPixels: 655360,
  maxPixels: 8294400,
  maxAspectRatio: 3,
};

const constrainedSizeField = (): ExecutableCatalogParameterField =>
  field({
    fieldKey: 'size',
    component: 'imageSize',
    componentProps: {
      mode: 'constrainedResolution',
      allowAuto: true,
      sizeLevels: [
        { id: '1k', pixelBudget: 1048576 },
        { id: '2k', pixelBudget: 4194304 },
        { id: '4k', pixelBudget: 8294400 },
      ],
      aspectPresets: [
        { id: '1:1', ratio: 1 },
        { id: '3:2', ratio: 1.5 },
        { id: '16:9', ratio: 16 / 9 },
        { id: '9:16', ratio: 0.5625 },
      ],
      presetOptions: [{ value: 'auto' }],
      customPresets: [{ value: '1024x1024' }, { value: '3840x2160' }],
      constraints: gpt2Constraints,
    },
  });

const comboEntry = (ratioKey: string, sizeKey: string): PromptDockCatalogEntry =>
  entry([
    field({
      fieldKey: ratioKey,
      component: 'select',
      enumOptions: [
        { value: '16:9' },
        { value: '1:1' },
        { value: 'adaptive' },
      ],
    }),
    field({
      fieldKey: sizeKey,
      component: 'select',
      enumOptions: [{ value: '720p' }, { value: '1080p' }],
    }),
  ]);

describe('deriveFrameSpec 形态派生', () => {
  it('单 imageSize constrainedResolution 字段 → constrained（gpt-image-2 形态）', () => {
    const spec = deriveFrameSpec(entry([constrainedSizeField()]));
    expect(spec?.kind).toBe('constrained');
  });

  it('ratio 族 + size 族双 select → combo（gemini/seedance 形态）', () => {
    const combos: [string, string][] = [
      ['aspectRatio', 'imageSize'],
      ['ratio', 'resolution'],
      ['aspect_ratio', 'size'],
    ];
    for (const [ratioKey, sizeKey] of combos) {
      const spec = deriveFrameSpec(comboEntry(ratioKey, sizeKey));
      expect(spec?.kind).toBe('combo');
      if (spec?.kind === 'combo') {
        expect(spec.ratioField.fieldKey).toBe(ratioKey);
        expect(spec.sizeField.fieldKey).toBe(sizeKey);
      }
    }
  });

  it('缺 size 轴（单 ratio select）不派生', () => {
    const e = entry([
      field({ fieldKey: 'aspectRatio', component: 'select', enumOptions: [{ value: '1:1' }] }),
    ]);
    expect(deriveFrameSpec(e)).toBeNull();
  });

  it('缺 ratio 轴（单 size select）不派生', () => {
    const e = entry([
      field({ fieldKey: 'resolution', component: 'select', enumOptions: [{ value: '720p' }] }),
    ]);
    expect(deriveFrameSpec(e)).toBeNull();
  });

  it('imageSize 非 constrainedResolution 形态（seedream sizeOptions）不派生', () => {
    const e = entry([
      field({
        fieldKey: 'size',
        component: 'imageSize',
        componentProps: {
          sizeOptions: [{ value: 2048 }],
          aspectField: 'aspectRatio',
          aspectOptions: [{ id: 'square', value: '1:1', ratio: 1 }],
        },
      }),
    ]);
    expect(deriveFrameSpec(e)).toBeNull();
  });

  it('text 组件的 ratio/resolution 不派生', () => {
    const e = entry([
      field({ fieldKey: 'ratio', component: 'text' }),
      field({ fieldKey: 'resolution', component: 'text' }),
    ]);
    expect(deriveFrameSpec(e)).toBeNull();
  });

  it('constrained 缺约束/档位时不派生（保持通用控件）', () => {
    const e = entry([
      field({
        fieldKey: 'size',
        component: 'imageSize',
        componentProps: {
          mode: 'constrainedResolution',
          sizeLevels: [{ id: '1k', pixelBudget: 1048576 }],
          aspectPresets: [{ id: '1:1', ratio: 1 }],
          constraints: { ...gpt2Constraints, minPixels: 100, maxPixels: 50 },
        },
      }),
    ]);
    expect(deriveFrameSpec(e)).toBeNull();
  });

  it('null entry 返回 null', () => {
    expect(deriveFrameSpec(null)).toBeNull();
  });

  it('frameConsumedKeys 覆盖被接管的参数 key', () => {
    const constrained = deriveFrameSpec(entry([constrainedSizeField()]));
    expect(constrained && frameConsumedKeys(constrained)).toEqual(['size']);

    const combo = deriveFrameSpec(comboEntry('ratio', 'resolution'));
    expect(combo && frameConsumedKeys(combo)).toEqual(['ratio', 'resolution']);
  });
});

describe('parseFrameConstrainedProps customPresets 解析', () => {
  const parse = (componentProps: Record<string, unknown>) =>
    parseFrameConstrainedProps(field({ fieldKey: 'size', component: 'imageSize', componentProps }));

  const baseProps = {
    mode: 'constrainedResolution',
    sizeLevels: [{ id: '1k', pixelBudget: 1048576 }],
    aspectPresets: [{ id: '1:1', ratio: 1 }],
    presetOptions: [{ value: 'auto' }],
    constraints: gpt2Constraints,
  };

  it('合法 WxH 预设全量保留（value 即提交值，label 可选）', () => {
    const props = parse({
      ...baseProps,
      customPresets: [{ value: '1024x1024' }, { value: '1536x1024', label: '横版' }],
    });
    expect(props?.customPresets).toEqual([{ value: '1024x1024' }, { value: '1536x1024', label: '横版' }]);
  });

  it('auto/非 WxH/非对象条目逐条丢弃，不阻断其余预设', () => {
    const props = parse({
      ...baseProps,
      customPresets: [
        { value: 'auto' },
        { value: '1024×1024' },
        { value: '1360x768' },
        'garbage',
        { value: 42 },
      ],
    });
    expect(props?.customPresets).toEqual([{ value: '1360x768' }]);
  });

  it('缺省 customPresets 解析为空数组（UI 不渲染预设入口）', () => {
    const props = parse({ ...baseProps });
    expect(props?.customPresets).toEqual([]);
  });
});

describe('比例工具', () => {
  it('parseRatioValue / parseDimsValue', () => {
    expect(parseRatioValue('16:9')).toEqual([16, 9]);
    expect(parseRatioValue('adaptive')).toBeNull();
    expect(parseRatioValue('auto')).toBeNull();
    expect(parseDimsValue('1360x768')).toEqual([1360, 768]);
    expect(parseDimsValue('16:9')).toBeNull();
  });

  it('ratioFraction 约分，非法输入 null', () => {
    expect(ratioFraction(1360, 768)).toBe('85:48');
    expect(ratioFraction(1024, 1024)).toBe('1:1');
    expect(ratioFraction(0, 100)).toBeNull();
    expect(ratioFraction(1.5, 2)).toBeNull();
  });

  it('网格序：auto/adaptive 最前 → 极值升序 → 同极值横版在前', () => {
    const options = [
      { dims: [9, 16] as [number, number] | null },
      { dims: null },
      { dims: [16, 9] as [number, number] | null },
      { dims: [1, 1] as [number, number] | null },
      { dims: [3, 2] as [number, number] | null },
    ];
    const sorted = [...options].sort(compareFrameGridOptions);
    expect(sorted.map((o) => (o.dims ? `${o.dims[0]}:${o.dims[1]}` : 'auto'))).toEqual([
      'auto',
      '1:1',
      '3:2',
      '16:9',
      '9:16',
    ]);
  });
});

describe('constrained 合成与官方约束校验', () => {
  const props: FrameConstrainedProps = {
    presetOptions: [{ value: 'auto' }],
    customPresets: [],
    sizeLevels: [
      { id: '1k', pixelBudget: 1048576 },
      { id: '2k', pixelBudget: 4194304 },
    ],
    aspectPresets: [
      { id: '1:1', ratio: 1 },
      { id: '16:9', ratio: 16 / 9 },
    ],
    constraints: gpt2Constraints,
  };

  it('1:1 × 1K 合成 1024×1024', () => {
    expect(composeConstrainedSize(props, '1:1', '1k')).toEqual({ width: 1024, height: 1024 });
  });

  it('16:9 × 1K 合成 1360×768（档位=总像素预算，对齐 16 倍数）', () => {
    expect(composeConstrainedSize(props, '16:9', '1k')).toEqual({ width: 1360, height: 768 });
  });

  it('未知比例/档位返回 null', () => {
    expect(composeConstrainedSize(props, '21:9', '1k')).toBeNull();
    expect(composeConstrainedSize(props, '1:1', '8k')).toBeNull();
  });

  it('校验：合法组合零违例', () => {
    expect(checkConstrainedDims(1024, 1024, gpt2Constraints)).toEqual([]);
    expect(checkConstrainedDims(1360, 768, gpt2Constraints)).toEqual([]);
  });

  it('校验：16 整除 / 比例上界 / 最长边 / 像素区间逐项给违例', () => {
    expect(checkConstrainedDims(1000, 1000, gpt2Constraints)).toHaveLength(1);
    expect(checkConstrainedDims(4000, 1000, gpt2Constraints).join('')).toContain('比例');
    expect(checkConstrainedDims(4000, 1000, gpt2Constraints).join('')).toContain('最长边');
    expect(checkConstrainedDims(64, 64, gpt2Constraints).join('')).toContain('总像素要在');
    expect(checkConstrainedDims(16, 16, gpt2Constraints)).toEqual([
      expect.stringContaining('总像素要在'),
    ]);
  });

  it('约束摘要含整除/比例/最长边/像素区间', () => {
    const summary = formatConstraintSummary(gpt2Constraints);
    expect(summary).toContain('能被 16 整除');
    expect(summary).toContain('比例不超过 3:1');
    expect(summary).toContain('最长边不超过 3840');
    expect(summary).toContain('655,360');
  });
});

describe('resolveConstrainedState 提交值反推', () => {
  const props: FrameConstrainedProps = {
    presetOptions: [{ value: 'auto' }],
    customPresets: [],
    sizeLevels: [{ id: '1k', pixelBudget: 1048576 }],
    aspectPresets: [
      { id: '1:1', ratio: 1 },
      { id: '16:9', ratio: 16 / 9 },
    ],
    constraints: gpt2Constraints,
  };

  it("'auto' → preset 模式", () => {
    const state = resolveConstrainedState('auto', props);
    expect(state.mode).toBe('preset');
    expect(state.presetValue).toBe('auto');
  });

  it("'1360x768' 精确反解为 ratio 模式（16:9 × 1K）", () => {
    const state = resolveConstrainedState('1360x768', props);
    expect(state.mode).toBe('ratio');
    expect(state.ratioId).toBe('16:9');
    expect(state.levelId).toBe('1k');
  });

  it('不可反解的合法比例 → custom 模式并保留宽高', () => {
    const state = resolveConstrainedState('640x640', props);
    expect(state.mode).toBe('custom');
    expect(state.customWidth).toBe(640);
    expect(state.customHeight).toBe(640);
  });

  it('非字符串/垃圾值回退首预设', () => {
    expect(resolveConstrainedState(undefined, props).mode).toBe('preset');
    expect(resolveConstrainedState('garbage', props).mode).toBe('preset');
  });
});

describe('frameChipText chip 文案', () => {
  it("constrained：auto 直显；ratio 命中显示选中比例；custom 显示约分比例", () => {
    const spec = deriveFrameSpec(entry([constrainedSizeField()]));
    if (spec === null || spec.kind !== 'constrained') {
      throw new Error('fixture must derive constrained spec');
    }
    expect(frameChipText(spec, { size: 'auto' }, (_f, v) => v)).toBe('auto');
    expect(frameChipText(spec, { size: '1360x768' }, (_f, v) => v)).toBe('16:9 · 1360×768');
    expect(frameChipText(spec, { size: '640x640' }, (_f, v) => v)).toBe('1:1 · 640×640');
    // 参数缺省时按 schema 默认口径回退首预设（draft.arguments 由 default_values 播种）
    expect(frameChipText(spec, {}, (_f, v) => v)).toBe('auto');
  });

  it('combo：比例值 · 尺寸档位文案', () => {
    const spec = deriveFrameSpec(
      entry([
        field({
          fieldKey: 'ratio',
          component: 'select',
          enumOptions: [{ value: '16:9' }, { value: 'adaptive' }],
        }),
        field({
          fieldKey: 'resolution',
          component: 'select',
          enumOptions: [{ value: '720p' }, { value: '1080p' }],
        }),
      ]),
    );
    if (spec === null || spec.kind !== 'combo') {
      throw new Error('fixture must derive combo spec');
    }
    expect(
      frameChipText(spec, { ratio: '16:9', resolution: '1080p' }, (_f, v) => v),
    ).toBe('16:9 · 1080p');
    expect(
      frameChipText(spec, { ratio: 'adaptive', resolution: '720p' }, (_f, v) => v),
    ).toBe('adaptive · 720p');
    expect(frameChipText(spec, {}, (_f, v) => v)).toBe(' · ');
  });
});

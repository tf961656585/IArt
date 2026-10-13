import { describe, expect, it } from 'vitest';

import type { ExecutableCatalogParameterField } from '@iart/contracts';
import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';
import {
  buildImageSizeChoices,
  buildSelectOptions,
  computeImageSize,
  inlineFields,
  localizationKeyTail,
  paramFormFields,
  resolveParamLabel,
} from '../promptDockParamModel';

/**
 * PromptDock 参数呈现模型（spec docs/editor/节点参数呈现分层.md）。
 * 保护两层派生不变量：
 * - inline 层是完整集合的真子集且硬上限 4；
 * - 媒体上传字段不进参数层（参考区唯一承载）；
 * - imageSize constrainedResolution 档位派生与后端 body.size 直传格式一致（WxH / auto）。
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

const translate = (key: string | undefined, fallback: string): string =>
  key && key.includes(':') ? localizationKeyTail(key) : (key ?? fallback);

/** 'WxH' 解析为 { w, h }；auto 等非尺寸值返回 null。 */
const parseWxH = (value: string): { w: number; h: number } | null => {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return { w, h };
};

describe('inlineFields 派生', () => {
  it('空目录返回空', () => {
    expect(inlineFields(null)).toEqual([]);
    expect(inlineFields(entry([]))).toEqual([]);
  });

  it('imageUpload/file 字段被排除（参考区唯一承载）', () => {
    const e = entry([
      field({ fieldKey: 'image', component: 'imageUpload' }),
      field({ fieldKey: 'size', component: 'select' }),
      field({ fieldKey: 'quality', component: 'select' }),
    ]);
    expect(inlineFields(e).map((f) => f.fieldKey)).toEqual(['size']);
  });

  it('≤4 个字段时 inline 是真子集（最后一个只进完整面板）', () => {
    const e = entry([
      field({ fieldKey: 'a', component: 'select' }),
      field({ fieldKey: 'b', component: 'select' }),
      field({ fieldKey: 'c', component: 'select' }),
    ]);
    expect(inlineFields(e).map((f) => f.fieldKey)).toEqual(['a', 'b']);
  });

  it('>4 个字段时硬上限 4，完整集合保持全量', () => {
    const e = entry(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => field({ fieldKey: k, component: 'select' })),
    );
    expect(inlineFields(e).map((f) => f.fieldKey)).toEqual(['a', 'b', 'c', 'd']);
    expect(paramFormFields(e).map((f) => f.fieldKey)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('单字段模型无 inline 层（唯一承载 = Sheet）', () => {
    const e = entry([field({ fieldKey: 'a', component: 'select' })]);
    expect(inlineFields(e)).toEqual([]);
    expect(paramFormFields(e)).toHaveLength(1);
  });
});

describe('文案解析', () => {
  it('model-asset i18n 键回退到末段可读片段', () => {
    expect(
      resolveParamLabel(
        translate,
        'model-asset/gpt-image-2:fields.quality.label',
        'quality',
      ),
    ).toBe('quality');
  });

  it('裸文本原样返回', () => {
    expect(resolveParamLabel(translate, '质量', 'fallback')).toBe('质量');
  });
});

describe('buildImageSizeChoices（constrainedResolution → 档位枚举）', () => {
  const sizeField = field({
    fieldKey: 'size',
    component: 'imageSize',
    defaultValue: 'auto',
    componentProps: {
      mode: 'constrainedResolution',
      allowAuto: true,
      sizeLevels: [
        { id: '1k', label: 'model-asset/gpt-image-2:fields.size.sizeLevels.1k.label', pixelBudget: 1048576 },
        { id: '2k', label: 'model-asset/gpt-image-2:fields.size.sizeLevels.2k.label', pixelBudget: 4194304 },
      ],
      aspectPresets: [
        { id: '1:1', label: 'model-asset/gpt-image-2:fields.size.aspectPresets.1_1.label', ratio: 1 },
        { id: '16:9', label: 'model-asset/gpt-image-2:fields.size.aspectPresets.16_9.label', ratio: 1.7777777778 },
      ],
      presetOptions: [
        { value: 'auto', label: 'model-asset/gpt-image-2:fields.size.presetOptions.auto.label' },
      ],
      constraints: {
        dimensionMultiple: 16,
        maxLongEdge: 3840,
        minPixels: 655360,
        maxPixels: 8294400,
        maxAspectRatio: 3,
      },
    },
  });

  it('非 constrainedResolution 形态返回 null（不呈现）', () => {
    expect(buildImageSizeChoices(field({ fieldKey: 'size', component: 'imageSize' }), translate)).toBeNull();
  });

  it('auto + 比例×分辨率组合，值格式为 WxH（后端 body.size 直传）', () => {
    const choices = buildImageSizeChoices(sizeField, translate) ?? [];
    expect(choices[0]).toEqual({ value: 'auto', label: 'auto' });
    // 1:1（ratio=1）× 1K 档 → 1024x1024；再取一个横向组合（宽>高）验证比例枚举存在。
    expect(choices.some((c) => c.value === '1024x1024')).toBe(true);
    const landscape = choices
      .map((c) => parseWxH(c.value))
      .find((size) => size !== null && size.w > size.h);
    expect(landscape).toBeDefined();
    expect(landscape && landscape.w % 16).toBe(0);
    expect(landscape && landscape.h % 16).toBe(0);
  });

  it('派生值满足包 constraints：16 倍数、比例、像素区间', () => {
    const choices = buildImageSizeChoices(sizeField, translate) ?? [];
    expect(choices.length).toBeGreaterThan(1);
    for (const choice of choices) {
      const size = parseWxH(choice.value);
      if (size === null) continue;
      expect(size.w % 16).toBe(0);
      expect(size.h % 16).toBe(0);
      const ratio = Math.max(size.w, size.h) / Math.min(size.w, size.h);
      expect(ratio).toBeLessThanOrEqual(3);
      expect(size.w * size.h).toBeGreaterThanOrEqual(655360);
      expect(size.w * size.h).toBeLessThanOrEqual(8294400);
    }
  });

  it('computeImageSize 按倍数对齐', () => {
    const { width, height } = computeImageSize(1.7777777778, 1048576, 16);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
    expect(width).toBeGreaterThan(height);
  });
});

describe('buildSelectOptions', () => {
  it('枚举选项值字符串化 + label 键解析', () => {
    const f = field({
      fieldKey: 'format',
      component: 'select',
      enumOptions: [
        { value: 'png', label: 'model-asset/gpt-image-2:fields.format.options.png.label' },
        { value: 'jpeg' },
      ],
    });
    expect(buildSelectOptions(f, translate)).toEqual([
      { value: 'png', label: 'png' },
      { value: 'jpeg', label: 'jpeg' },
    ]);
  });
});

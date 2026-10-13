import { describe, it, expect } from 'vitest';
import {
  createPromptField,
  createModelSelectField,
  createDurationField,
  createImageUploadField,
  createTrimmedPromptCompute,
  createNormalizer,
  createStaticSelectField,
} from '@/features/models/shared/schemaFieldBuilders';
import type { SchemaBuildContext, SchemaConditionContext } from '@/features/workspace/schema/types';
import type { StaticSelectOption } from '@/features/models/shared/schemaFieldBuilders';

const imageUploadOptions = {
  labelKey: undefined,
  compact: undefined,
  maxFiles: undefined,
  accept: undefined,
  maxSizeMB: undefined,
  maxDimension: undefined,
  imageResizeMode: undefined,
  imageConstraints: undefined,
};

const absentNormalize = undefined as never;

const staticSelectOptions = {
  labelKey: undefined,
  helperTextKey: undefined,
  defaultValue: undefined,
  visibleWhen: undefined,
  normalize: absentNormalize,
};

describe('createPromptField', () => {
  it('使用默认配置创建 Prompt 文本域字段', () => {
    const field = createPromptField('prompt', undefined);

    expect(field).toMatchObject({
      key: 'prompt',
      type: 'textarea',
      minRows: 2,
      maxRows: 3,
      required: true,
    });
  });

  it('支持通过 opts 覆盖默认配置', () => {
    const field = createPromptField('prompt', {
      labelKey: 'prompt.label',
      placeholderKey: 'prompt.placeholder',
      required: false,
      minRows: 5,
    });

    expect(field).toMatchObject({
      key: 'prompt',
      type: 'textarea',
      labelKey: 'prompt.label',
      placeholderKey: 'prompt.placeholder',
      minRows: 5,
      maxRows: 3,
      required: false,
    });
  });
});

describe('createModelSelectField', () => {
  const models = [
    { value: 'model-1', labelKey: 'models.1', descriptionKey: 'models.1.desc', visible: undefined },
    { value: 'model-2', labelKey: 'models.2', descriptionKey: undefined, visible: undefined },
  ];

  it('根据传入的 models 生成静态 options 列表', () => {
    const field = createModelSelectField('model', models, undefined);

    expect(field.type).toBe('select');
    expect(field.layout).toMatchObject({ colSpan: 1 });
    const options = field.options;
    expect(options.kind).toBe('static');
    if (options.kind !== 'static') {
      throw new Error('options.kind 应为 static');
    }
    expect(options.options).toEqual([
      {
        value: 'model-1',
        labelKey: 'models.1',
        descriptionKey: 'models.1.desc',
        labelParams: undefined,
        helperKey: undefined,
        disabledWhen: undefined,
        icon: undefined,
        groupKey: undefined,
      },
      {
        value: 'model-2',
        labelKey: 'models.2',
        descriptionKey: undefined,
        labelParams: undefined,
        helperKey: undefined,
        disabledWhen: undefined,
        icon: undefined,
        groupKey: undefined,
      },
    ]);
  });

  it('注入 onChange 事件处理器', () => {
    const onChange = () => ({ model: 'next-model' });
    const field = createModelSelectField('model', models, {
      defaultValue: 'model-2',
      onChange,
    });

    expect(field.defaultValue).toBe('model-2');
    expect(field.events).toBeDefined();
    expect(field.events?.[0]?.kind).toBe('change');
    expect(field.events?.[0]?.handler).toBe(onChange);
  });
});

describe('createDurationField', () => {
  it('根据 durations 生成静态 options 列表并设置默认值', () => {
    const durations = [30, 60, 90];
    const field = createDurationField('duration', durations, undefined);

    expect(field.type).toBe('select');
    expect(field.layout).toMatchObject({ colSpan: 1 });
    const options = field.options;
    expect(options.kind).toBe('static');
    if (options.kind !== 'static') {
      throw new Error('options.kind 应为 static');
    }
    expect(options.options).toEqual([
      { value: 30, labelKey: 'duration.30', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined },
      { value: 60, labelKey: 'duration.60', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined },
      { value: 90, labelKey: 'duration.90', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined },
    ]);
    expect(field.defaultValue).toBe(30);
  });

  it('支持 labelKeyTemplate 并注入 labelParams', () => {
    const durations = [15, 30];
    const field = createDurationField('duration', durations, {
      labelKeyTemplate: 'duration.custom.{seconds}s',
      defaultValue: undefined,
    });

    const options = field.options;
    expect(options.kind).toBe('static');
    if (options.kind !== 'static') {
      throw new Error('options.kind 应为 static');
    }
    expect(options.options).toEqual([
      { value: 15, labelKey: 'duration.custom.15s', labelParams: { seconds: 15 }, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined },
      { value: 30, labelKey: 'duration.custom.30s', labelParams: { seconds: 30 }, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined },
    ]);
  });

  it('ensureDuration 在事件中对输入值进行归一化', () => {
    const durations = [30, 60];
    const field = createDurationField('duration', durations, {
      labelKeyTemplate: undefined,
      defaultValue: 60,
    });

    const handler = field.events?.[0]?.handler as
      | ((value: unknown) => Partial<Record<'duration', number>>)
      | undefined;

    expect(handler).toBeDefined();

    const resultAllowedNumber = handler?.(60);
    const resultAllowedString = handler?.('60');
    const resultUnknownNumber = handler?.(45);
    const resultNaNInput = handler?.('not-a-number');

    expect(resultAllowedNumber).toEqual({ duration: 60 });
    expect(resultAllowedString).toEqual({ duration: 60 });
    expect(resultUnknownNumber).toEqual({ duration: 60 });
    expect(resultNaNInput).toEqual({ duration: 60 });
  });
});

describe('createImageUploadField', () => {
  it('compact=true 时增加 metadata.compactUpload', () => {
    const field = createImageUploadField('image', {
      ...imageUploadOptions,
      compact: true,
    });

    expect(field.type).toBe('imageUpload');
    expect(field.metadata).toEqual({ compactUpload: true });
  });

  it('正确传递 maxFiles 与 accept 配置', () => {
    const field = createImageUploadField('image', {
      ...imageUploadOptions,
      compact: true,
      maxFiles: 5,
      accept: 'image/*',
    });

    expect(field.maxFiles).toBe(5);
    expect(field.accept).toBe('image/*');
    expect(field.defaultValue).toEqual([]);
  });

  it('未开启 compact 时不包含 metadata', () => {
    const field = createImageUploadField('image', {
      ...imageUploadOptions,
      compact: false,
    });

    expect(field.metadata).toBeUndefined();
    expect(field.defaultValue).toEqual([]);
  });
});

describe('createTrimmedPromptCompute', () => {
  it('返回正确的 SchemaComputedValue 结构', () => {
    const computeValue = createTrimmedPromptCompute('prompt');

    expect(computeValue.kind).toBe('compute');
    expect(computeValue.dependsOn).toEqual(['prompt']);
    expect(computeValue.cacheKey).toBe('trim.prompt');
    expect(typeof computeValue.run).toBe('function');
  });

  it('compute 函数会对字符串进行 trim 处理', () => {
    const computeValue = createTrimmedPromptCompute('prompt');

    const run = computeValue.run;
    const trimmed = run({
      // 仅需提供 run 实际使用到的字段
      values: { prompt: '  hello world  ' },
    } as SchemaBuildContext<'prompt'>);

    const nonString = run({
      values: { prompt: 123 },
    } as SchemaBuildContext<'prompt'>);

    expect(trimmed).toBe('hello world');
    expect(nonString).toBe('');
  });
});

describe('createNormalizer', () => {
  it('允许列表中的值会被原样返回', () => {
    const normalize = createNormalizer(['a', 'b'], 'a');

    expect(normalize('a')).toBe('a');
    expect(normalize('b')).toBe('b');
  });

  it('不在允许列表中的值会返回 fallback', () => {
    const normalize = createNormalizer(['a', 'b'], 'a');

    expect(normalize('c')).toBe('a');
    expect(normalize(null)).toBe('a');
  });
});

describe('createStaticSelectField', () => {
  const staticOptions: StaticSelectOption[] = [
    { value: '1_1', labelKey: 'aspect.1_1', descriptionKey: undefined, labelParams: undefined },
    { value: '16_9', labelKey: 'aspect.16_9', descriptionKey: 'aspect.16_9.desc', labelParams: undefined },
    { value: '4_3', labelKey: 'aspect.4_3', descriptionKey: undefined, labelParams: undefined },
  ];

  it('创建带静态选项的下拉字段', () => {
    const field = createStaticSelectField('aspectRatio', staticOptions, undefined);

    expect(field.type).toBe('select');
    expect(field.key).toBe('aspectRatio');
    expect(field.layout).toMatchObject({ colSpan: 1 });

    const options = field.options;
    expect(options.kind).toBe('static');
    if (options.kind !== 'static') {
      throw new Error('options.kind 应为 static');
    }
    expect(options.options).toEqual(staticOptions);
  });

  it('默认值为 opts.defaultValue 或首个选项的 value', () => {
    const field1 = createStaticSelectField('aspectRatio', staticOptions, undefined);
    expect(field1.defaultValue).toBe('1_1');

    const field2 = createStaticSelectField('aspectRatio', staticOptions, {
      ...staticSelectOptions,
      defaultValue: '16_9',
    });
    expect(field2.defaultValue).toBe('16_9');
  });

  it('支持 labelKey 和 helperTextKey', () => {
    const field = createStaticSelectField('aspectRatio', staticOptions, {
      ...staticSelectOptions,
      labelKey: 'pages:aspect.label',
      helperTextKey: 'pages:aspect.helper',
    });

    expect(field.labelKey).toBe('pages:aspect.label');
    expect(field.helperTextKey).toBe('pages:aspect.helper');
  });

  it('支持 visibleWhen 条件', () => {
    const condition = ({ values }: SchemaConditionContext<string>) => values['model'] === 'pro';
    const field = createStaticSelectField<string>('imageSize', staticOptions, {
      ...staticSelectOptions,
      visibleWhen: condition,
    });

    expect(field.visibleWhen).toBe(condition);
  });

  it('默认的 normalize 会校验值是否在 options 中', () => {
    const field = createStaticSelectField('aspectRatio', staticOptions, {
      ...staticSelectOptions,
      defaultValue: '16_9',
    });

    const handler = field.events?.[0]?.handler as
      | ((value: unknown) => Partial<Record<'aspectRatio', string>> | undefined)
      | undefined;

    expect(handler).toBeDefined();

    // 合法值原样返回 (返回 undefined 表示不需要更新)
    expect(handler?.('1_1')).toBeUndefined();
    expect(handler?.('16_9')).toBeUndefined();

    // 非法值回退到 defaultValue
    expect(handler?.('invalid')).toEqual({ aspectRatio: '16_9' });
    expect(handler?.(null)).toEqual({ aspectRatio: '16_9' });
    expect(handler?.(undefined)).toEqual({ aspectRatio: '16_9' });
  });

  it('支持自定义 normalize 函数', () => {
    // 模拟容错旧格式: 1:1 -> 1_1
    const customNormalize = (value: unknown): string => {
      if (typeof value === 'string') {
        if (value === '1:1') return '1_1';
        if (value === '16:9') return '16_9';
        return value;
      }
      return '1_1';
    };

    const field = createStaticSelectField('aspectRatio', staticOptions, {
      ...staticSelectOptions,
      normalize: customNormalize,
    });

    const handler = field.events?.[0]?.handler as
      | ((value: unknown) => Partial<Record<'aspectRatio', string>> | undefined)
      | undefined;

    // 旧格式会被转换
    expect(handler?.('1:1')).toEqual({ aspectRatio: '1_1' });
    expect(handler?.('16:9')).toEqual({ aspectRatio: '16_9' });

    // 新格式原样返回
    expect(handler?.('1_1')).toBeUndefined();
  });

  it('change 事件只在值发生变化时返回更新', () => {
    const field = createStaticSelectField('aspectRatio', staticOptions, undefined);

    const handler = field.events?.[0]?.handler as
      | ((value: unknown) => Partial<Record<'aspectRatio', string>> | undefined)
      | undefined;

    // 值未变化返回 undefined
    expect(handler?.('1_1')).toBeUndefined();
    expect(handler?.('16_9')).toBeUndefined();

    // 值需要归一化时返回更新
    expect(handler?.('invalid')).toEqual({ aspectRatio: '1_1' });
  });

  it('空选项列表时使用空字符串作为 fallback', () => {
    const field = createStaticSelectField('empty', [], undefined);

    expect(field.defaultValue).toBe('');

    const handler = field.events?.[0]?.handler as
      | ((value: unknown) => Partial<Record<'empty', string>> | undefined)
      | undefined;

    expect(handler?.('anything')).toEqual({ empty: '' });
  });
});

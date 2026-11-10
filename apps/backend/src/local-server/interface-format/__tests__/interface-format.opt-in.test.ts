// 默认关闭取值（opt_in）的行为：口径见 docs/model-assets/17 的取值默认关闭段
//
// 默认关闭的取值（opt_in）：接口格式声明该值及其产物形态，但模型记录没显式启用时，
// 目录、创作面、CLI 与执行表单都不出现；显式启用后形态声明仍保留（不退化成本次新增的未知）。
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ParameterOverrides } from '@iart/contracts';
import type { GenerationFamilyTemplateSources } from '../../generation-family-templates.cts';
import { buildFormatParameterDescriptor, composeFormatSources } from '../registry.cts';

const FORMAT_ID = 'openai-image-v1';
const FIELD_KEY = 'format';

type RawEnumOption = { value?: unknown; output_form?: unknown; opt_in?: unknown };

const readFormatOptions = (sources: GenerationFamilyTemplateSources): RawEnumOption[] => {
  const parameterSchema = sources.runtimeModel.parameter_schema as unknown;
  if (parameterSchema === null || typeof parameterSchema !== 'object') return [];
  const fields = (parameterSchema as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  for (const field of fields) {
    if (field === null || typeof field !== 'object') continue;
    if ((field as { field_key?: unknown }).field_key !== FIELD_KEY) continue;
    const options = (field as { enum_options?: unknown }).enum_options;
    if (!Array.isArray(options)) return [];
    return options.filter((option): option is RawEnumOption => option !== null && typeof option === 'object');
  }
  return [];
};

const compose = (parameterOverrides?: ParameterOverrides) => {
  const result = composeFormatSources(FORMAT_ID, 'opt-in-test-model', {
    acceptedMediaSlots: [],
    ...(parameterOverrides === undefined ? {} : { parameterOverrides }),
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('unreachable');
  return result.sources;
};

void test('opt_in 取值默认不进入合成结果：OpenAI 图片格式默认只有 png/jpeg/webp', () => {
  const values = readFormatOptions(compose()).map((option) => String(option.value));
  assert.deepEqual(values, ['png', 'jpeg', 'webp']);
  assert.equal(values.includes('gif'), false);
});

void test('模型记录显式启用后取值出现在合成结果里', () => {
  const options = readFormatOptions(
    compose({
      official: [{ field_key: FIELD_KEY, enum_options: ['png', 'jpeg', 'webp', 'gif'] }],
      custom: [],
    }),
  );
  const gif = options.find((option) => option.value === 'gif');
  assert.ok(gif, '显式启用后 gif 必须出现在可选值里');
  assert.deepEqual(options.map((option) => String(option.value)), ['png', 'jpeg', 'webp', 'gif']);
});

void test('svg 同为默认关闭取值：显式启用后出现在可选值里', () => {
  const options = readFormatOptions(
    compose({
      official: [{ field_key: FIELD_KEY, enum_options: ['png', 'jpeg', 'webp', 'svg'] }],
      custom: [],
    }),
  );
  const svg = options.find((option) => option.value === 'svg');
  assert.ok(svg, '显式启用后 svg 必须出现在可选值里');
});

void test('参数描述符同样默认不列出 opt_in 取值（高级参数编辑器的初始可选值）', () => {
  const result = buildFormatParameterDescriptor(FORMAT_ID);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('unreachable');
  const formatField = result.descriptor.official_fields.find((field) => field.field_key === FIELD_KEY);
  assert.ok(formatField);
  assert.deepEqual(formatField.enum_options, ['png', 'jpeg', 'webp']);
  assert.deepEqual(formatField.opt_in_enum_options, ['gif', 'svg']);
});


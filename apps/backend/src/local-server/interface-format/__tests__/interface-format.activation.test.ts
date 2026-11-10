// 参数启动条件（visible_when）与默认关闭取值
//
// 参数启动条件（visible_when）：由接口格式声明、随合成结果下发；条件不成立的取值
// 由发送层剔除（见 parameter-activation.test.ts）。本文件钉住 openai-image-v1 的声明本身。
import assert from 'node:assert/strict';
import test from 'node:test';

import { composeFormatSources } from '../registry.cts';

const FORMAT_ID = 'openai-image-v1';

type RawField = { field_key?: unknown; visible_when?: unknown; enum_options?: unknown };

const readFields = (): RawField[] => {
  const result = composeFormatSources(FORMAT_ID, 'activation-test-model', { acceptedMediaSlots: [] });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('unreachable');
  const schema = result.sources.runtimeModel.parameter_schema as unknown;
  assert.ok(schema !== null && typeof schema === 'object');
  const fields = (schema as { fields?: unknown }).fields;
  assert.ok(Array.isArray(fields));
  return fields.filter((field): field is RawField => field !== null && typeof field === 'object');
};

void test('GIF 帧参数以 format=gif 为启动条件，并带默认值', () => {
  const fields = readFields();
  for (const key of ['frame_count', 'frame_duration_ms']) {
    const field = fields.find((item) => item.field_key === key);
    assert.ok(field, `${key} 必须存在`);
    assert.deepEqual(field.visible_when, { field: 'format', op: 'eq', value: 'gif' });
  }
});

void test('output_compression 以 jpeg/webp 为启动条件', () => {
  const field = readFields().find((item) => item.field_key === 'output_compression');
  assert.ok(field);
  assert.deepEqual(field.visible_when, { field: 'format', op: 'in', value: ['jpeg', 'webp'] });
});

void test('无条件字段不带 visible_when；quality 含 xhigh/max', () => {
  const fields = readFields();
  const size = fields.find((item) => item.field_key === 'size');
  assert.ok(size);
  assert.equal(size.visible_when, undefined);
  const quality = fields.find((item) => item.field_key === 'quality');
  assert.ok(quality);
  const values = (quality.enum_options as Array<{ value?: unknown }>).map((option) => String(option.value));
  for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.ok(values.includes(value), `quality 必须含 ${value}`);
  }
});

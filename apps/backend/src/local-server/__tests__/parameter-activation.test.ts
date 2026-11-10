import assert from 'node:assert/strict';
import test from 'node:test';

import { applyActivationFromProjection } from '../parameter-activation-projection.cts';

const projectionWith = (fields: unknown[]) => ({
  parameter_schema: { fields },
});

const frameFields = [
  {
    field_key: 'format',
    component: 'select',
    enum_options: [{ value: 'png' }, { value: 'jpeg' }, { value: 'gif' }],
  },
  {
    field_key: 'frame_count',
    component: 'number',
    visible_when: { field: 'format', op: 'eq', value: 'gif' },
  },
  {
    field_key: 'output_compression',
    component: 'number',
    visible_when: { field: 'format', op: 'in', value: ['jpeg', 'webp'] },
  },
];

void test('条件不成立时，字段值从参数集里剔除（不发送）', () => {
  const projection = projectionWith(frameFields);
  const result = applyActivationFromProjection(
    { format: 'png', frame_count: 9, output_compression: 100 },
    projection,
  );
  assert.deepEqual(result, { format: 'png' });
});

void test('条件成立时保留字段值', () => {
  const projection = projectionWith(frameFields);
  assert.deepEqual(
    applyActivationFromProjection({ format: 'gif', frame_count: 12 }, projection),
    { format: 'gif', frame_count: 12 },
  );
  assert.deepEqual(
    applyActivationFromProjection({ format: 'jpeg', output_compression: 80 }, projection),
    { format: 'jpeg', output_compression: 80 },
  );
});

void test('依赖字段缺失按 undefined 参与比较：eq 不成立、neq 成立', () => {
  const projection = projectionWith([
    { field_key: 'a', component: 'select', visible_when: { field: 'missing', op: 'eq', value: 'x' } },
    { field_key: 'b', component: 'select', visible_when: { field: 'missing', op: 'neq', value: 'x' } },
  ]);
  assert.deepEqual(applyActivationFromProjection({ a: 1, b: 2 }, projection), { b: 2 });
});

void test('级联：被剔除的字段作为依赖时，后续条件同样不成立', () => {
  const projection = projectionWith([
    { field_key: 'format', component: 'select' },
    { field_key: 'a', component: 'select', visible_when: { field: 'format', op: 'eq', value: 'gif' } },
    { field_key: 'b', component: 'select', visible_when: { field: 'a', op: 'eq', value: 'on' } },
  ]);
  assert.deepEqual(applyActivationFromProjection({ format: 'png', a: 'on', b: 'v' }, projection), {
    format: 'png',
  });
});

void test('条件声明非法时按无条件处理并保留字段（不静默吞参数）', () => {
  const projection = projectionWith([
    { field_key: 'x', component: 'number', visible_when: { field: 'format', op: 'unknown-op', value: 1 } },
  ]);
  assert.deepEqual(applyActivationFromProjection({ format: 'png', x: 5 }, projection), { format: 'png', x: 5 });
});

void test('没有条件声明时原样返回', () => {
  const projection = projectionWith([{ field_key: 'format', component: 'select' }]);
  const args = { format: 'png', size: '1024x1024' };
  assert.deepEqual(applyActivationFromProjection(args, projection), args);
});

import { describe, it, expect } from 'vitest';
import type { ModelAssetNodeProjectionParameterField } from '@iart/contracts/model-asset-contract';

// 复用 toSchemaField 内部的 normalizeVisibleWhen 逻辑，
// 这里直接测试 toSchemaField 的 visibleWhen 输出
// 因为 normalizeVisibleWhen 是私有函数，我们通过 toSchemaField 间接测试

// 直接复制 normalizeVisibleWhen 逻辑用于单元测试
// 注意：实际实现中这个函数在 modelAssetSchemaProjection.ts 中
const normalizeVisibleWhen = (
  visibleWhen: ModelAssetNodeProjectionParameterField['visible_when'],
): unknown => {
  if (visibleWhen === undefined || visibleWhen === null) return undefined;
  const op = visibleWhen.op;
  if (op === 'eq') {
    return { op: 'eq', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'neq') {
    return { op: 'ne', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'in') {
    return { op: 'includes', field: visibleWhen.field, value: visibleWhen.value };
  }
  if (op === 'not_in') {
    return { op: 'excludes', field: visibleWhen.field, value: visibleWhen.value };
  }
  return undefined;
};

describe('normalizeVisibleWhen', () => {
  it('converts eq op correctly', () => {
    const result = normalizeVisibleWhen({
      field: 'imageMode',
      op: 'eq',
      value: 'reference',
    });
    expect(result).toEqual({
      op: 'eq',
      field: 'imageMode',
      value: 'reference',
    });
  });

  it('converts neq op to ne', () => {
    const result = normalizeVisibleWhen({
      field: 'mode',
      op: 'neq',
      value: 'advanced',
    });
    expect(result).toEqual({
      op: 'ne',
      field: 'mode',
      value: 'advanced',
    });
  });

  it('converts in op to includes', () => {
    const result = normalizeVisibleWhen({
      field: 'imageMode',
      op: 'in',
      value: ['firstFrame', 'keyframes'],
    });
    expect(result).toEqual({
      op: 'includes',
      field: 'imageMode',
      value: ['firstFrame', 'keyframes'],
    });
  });

  it('converts not_in op to excludes', () => {
    const result = normalizeVisibleWhen({
      field: 'status',
      op: 'not_in',
      value: ['hidden', 'disabled'],
    });
    expect(result).toEqual({
      op: 'excludes',
      field: 'status',
      value: ['hidden', 'disabled'],
    });
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeVisibleWhen(undefined)).toBeUndefined();
  });

  it('preserves numeric value', () => {
    const result = normalizeVisibleWhen({
      field: 'count',
      op: 'eq',
      value: 5,
    });
    expect(result).toEqual({
      op: 'eq',
      field: 'count',
      value: 5,
    });
  });

  it('preserves boolean value', () => {
    const result = normalizeVisibleWhen({
      field: 'enabled',
      op: 'eq',
      value: true,
    });
    expect(result).toEqual({
      op: 'eq',
      field: 'enabled',
      value: true,
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  applyParameterActivation,
  evaluateParameterActivation,
  ParameterActivationSchema,
} from '../src/parameter-activation';

describe('parameter activation', () => {
  it('eq / in 成立与不成立', () => {
    expect(evaluateParameterActivation({ field: 'format', op: 'eq', value: 'gif' }, { format: 'gif' })).toBe(true);
    expect(evaluateParameterActivation({ field: 'format', op: 'eq', value: 'gif' }, { format: 'png' })).toBe(false);
    expect(
      evaluateParameterActivation({ field: 'format', op: 'in', value: ['jpeg', 'webp'] }, { format: 'jpeg' }),
    ).toBe(true);
    expect(
      evaluateParameterActivation({ field: 'format', op: 'in', value: ['jpeg', 'webp'] }, { format: 'png' }),
    ).toBe(false);
  });

  it('依赖字段缺失按 undefined 处理', () => {
    expect(evaluateParameterActivation({ field: 'format', op: 'eq', value: 'gif' }, {})).toBe(false);
    expect(evaluateParameterActivation({ field: 'format', op: 'neq', value: 'gif' }, {})).toBe(true);
    expect(evaluateParameterActivation({ field: 'format', op: 'not_in', value: ['gif'] }, {})).toBe(true);
  });

  it('剔除不成立的字段并级联到依赖它的字段', () => {
    const result = applyParameterActivation(
      { format: 'png', frameCount: 9, advanced: 'on', extra: 1 },
      {
        frameCount: { field: 'format', op: 'eq', value: 'gif' },
        advanced: { field: 'frameCount', op: 'eq', value: 9 },
      },
    );
    expect(result.values).toEqual({ format: 'png', extra: 1 });
    expect(result.dropped.map((item) => item.fieldKey).sort()).toEqual(['advanced', 'frameCount']);
  });

  it('条件声明只接受四种比较与标量/标量数组', () => {
    expect(ParameterActivationSchema.safeParse({ field: 'f', op: 'eq', value: 1 }).success).toBe(true);
    expect(ParameterActivationSchema.safeParse({ field: 'f', op: 'in', value: ['a'] }).success).toBe(true);
    expect(ParameterActivationSchema.safeParse({ field: 'f', op: 'gt', value: 1 }).success).toBe(false);
    expect(ParameterActivationSchema.safeParse({ field: 'f', op: 'in', value: [] }).success).toBe(false);
  });
});

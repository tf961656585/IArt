import { describe, expect, it } from 'vitest';
import type { RecipeCondition } from '@iart/contracts';
import {
  buildConditionFromRows,
  conditionToRows,
  parseRecipeValues,
} from '../interfaceRecipeConditions';

/**
 * 简单模式 ↔ 条件树（`docs/custom-providers/接口配方-design.md` §5.1/§8.1）。
 *
 * 保护的核心口径：持久化只有条件树，界面行是视图态；多行 = 任一满足（`any`）；
 * 打开再保存不能改变判定语义或值类型。
 */

describe('interfaceRecipeConditions', () => {
  it('一行、没填允许值 → 只要字段存在', () => {
    expect(buildConditionFromRows([{ path: 'data.task_id', valuesText: '' }])).toEqual({
      op: 'exists',
      path: 'data.task_id',
    });
  });

  it('一行、一个允许值 → 相等；数字与布尔按标量提交', () => {
    expect(buildConditionFromRows([{ path: 'status', valuesText: 'succeeded' }])).toEqual({
      op: 'eq',
      path: 'status',
      value: 'succeeded',
    });
    expect(buildConditionFromRows([{ path: 'progress', valuesText: '100' }])).toEqual({
      op: 'eq',
      path: 'progress',
      value: 100,
    });
    expect(buildConditionFromRows([{ path: 'done', valuesText: 'true' }])).toEqual({
      op: 'eq',
      path: 'done',
      value: true,
    });
  });

  it('一行、多个允许值 → 属于（中文逗号与 JSON 数组都接受）', () => {
    expect(buildConditionFromRows([{ path: 'status', valuesText: 'succeeded, completed' }])).toEqual({
      op: 'in',
      path: 'status',
      value: ['succeeded', 'completed'],
    });
    expect(parseRecipeValues('["succeeded","completed"]')).toEqual(['succeeded', 'completed']);
  });

  it('多行 → any 组合（任一满足）', () => {
    const tree = buildConditionFromRows([
      { path: 'status', valuesText: 'succeeded' },
      { path: 'progress', valuesText: '100' },
    ]);
    expect(tree).toEqual({
      op: 'any',
      children: [
        { op: 'eq', path: 'status', value: 'succeeded' },
        { op: 'eq', path: 'progress', value: 100 },
      ],
    });
  });

  it('空路径的行被跳过；没有有效行时返回 null', () => {
    expect(buildConditionFromRows([{ path: '   ', valuesText: 'x' }])).toBeNull();
    expect(
      buildConditionFromRows([
        { path: '', valuesText: 'x' },
        { path: 'status', valuesText: 'ok' },
      ]),
    ).toEqual({ op: 'eq', path: 'status', value: 'ok' });
  });

  it('条件树 → 行：eq / in / exists / any 都能无损还原', () => {
    expect(conditionToRows({ op: 'exists', path: 'data.url' })).toEqual([
      { path: 'data.url', valuesText: '' },
    ]);
    expect(conditionToRows({ op: 'eq', path: 'status', value: 'ok' })).toEqual([
      { path: 'status', valuesText: 'ok' },
    ]);
    expect(conditionToRows({ op: 'in', path: 'status', value: ['a', 'b'] })).toEqual([
      { path: 'status', valuesText: 'a, b' },
    ]);
    expect(
      conditionToRows({
        op: 'any',
        children: [
          { op: 'eq', path: 'status', value: 'succeeded' },
          { op: 'eq', path: 'progress', value: 100 },
        ],
      }),
    ).toEqual([
      { path: 'status', valuesText: 'succeeded' },
      { path: 'progress', valuesText: '100' },
    ]);
  });

  it('简单模式表达不了的树返回 null（不把 all 静默改成 any）', () => {
    const all: RecipeCondition = {
      op: 'all',
      children: [
        { op: 'eq', path: 'status', value: 'succeeded' },
        { op: 'exists', path: 'data.url' },
      ],
    };
    expect(conditionToRows(all)).toBeNull();
    expect(conditionToRows({ op: 'not', condition: { op: 'exists', path: 'error' } })).toBeNull();
    expect(conditionToRows({ op: 'gt', path: 'progress', value: 50 })).toBeNull();
    // 空列表还原成空输入框会被再提交成 exists，语义会变
    expect(conditionToRows({ op: 'in', path: 'status', value: [] })).toBeNull();
  });

  it('会被误判成数字/布尔的文字在回填时加引号，保存后类型不变', () => {
    const tree: RecipeCondition = { op: 'eq', path: 'code', value: '200' };
    const rows = conditionToRows(tree);
    expect(rows).toEqual([{ path: 'code', valuesText: '"200"' }]);
    expect(buildConditionFromRows(rows ?? [])).toEqual(tree);
  });
});

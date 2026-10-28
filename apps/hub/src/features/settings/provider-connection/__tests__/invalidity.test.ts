import { describe, expect, it } from 'vitest';
import { EXECUTABLE_MODEL_FAILURE_CODES, type InterfaceRecipe } from '@iart/contracts';
import {
  MODEL_FAILURE_MESSAGE,
  countModelsByConnection,
  resolveRecipeReferenceState,
} from '../invalidity';

/**
 * 原因码 → 界面文案的完整性守卫。
 *
 * 为什么需要：后端只回原因码，界面文案由 Hub 本地渲染。映射表漏掉任何一个原因码，
 * 界面上就会出现**空白状态**，而类型系统拦不住（`Record` 的键完整性只在字面量定义时校验，
 * 消费端读到 `undefined` 不会报错）。本组用 contracts 的原因码清单做全量比对，
 * 新增原因码时这里会先红。
 */

describe('MODEL_FAILURE_MESSAGE 完整性', () => {
  it('每个原因码都有文案', () => {
    for (const code of EXECUTABLE_MODEL_FAILURE_CODES) {
      expect(MODEL_FAILURE_MESSAGE[code], `缺少文案：${code}`).toBeTypeOf('string');
    }
  });

  it('可执行（none）不产生文案', () => {
    expect(MODEL_FAILURE_MESSAGE.none).toBe('');
  });

  it('除 none 外每个原因码都有非空文案，界面不会出现空白状态', () => {
    for (const code of EXECUTABLE_MODEL_FAILURE_CODES) {
      if (code === 'none') continue;
      expect(MODEL_FAILURE_MESSAGE[code].trim().length, `文案为空：${code}`).toBeGreaterThan(0);
    }
  });

  it('界面不使用「退役」措辞：retired 与 disabled 文案一致', () => {
    expect(MODEL_FAILURE_MESSAGE.connection_retired).toBe(MODEL_FAILURE_MESSAGE.connection_disabled);
    for (const code of EXECUTABLE_MODEL_FAILURE_CODES) {
      expect(MODEL_FAILURE_MESSAGE[code], `文案含退役措辞：${code}`).not.toContain('退役');
    }
  });
});

describe('resolveRecipeReferenceState', () => {
  const recipe: InterfaceRecipe = {
    recipe_id: 'recipe-openai',
    name: 'OpenAI 完成判定',
    family_adapter_id: 'openai-image-v1',
    success_when: { op: 'eq', path: 'status', value: 'succeeded' },
    result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
    requires_auth: false,
    created_at: '2026-10-24T00:00:00.000Z',
    updated_at: '2026-10-24T00:00:00.000Z',
  };

  const stateOf = (input: {
    recipeId?: string | undefined;
    recipes?: readonly InterfaceRecipe[];
    recipesUnavailable?: boolean;
  }) =>
    resolveRecipeReferenceState({
      recipeId: input.recipeId,
      familyAdapterId: 'openai-image-v1',
      recipes: input.recipes ?? [recipe],
      recipesUnavailable: input.recipesUnavailable ?? false,
    });

  it('没有引用 → none（按内置默认运行，不标失效）', () => {
    expect(stateOf({ recipeId: undefined })).toBe('none');
  });

  it('引用命中同族配方 → effective', () => {
    expect(stateOf({ recipeId: 'recipe-openai' })).toBe('effective');
  });

  it('配方库已加载但引用不在库里 → missing', () => {
    expect(stateOf({ recipeId: 'recipe-deleted' })).toBe('missing');
    expect(stateOf({ recipeId: 'recipe-openai', recipes: [] })).toBe('missing');
  });

  it('引用属于另一个接口格式 → missing（与运行时一致：族不匹配同样回落内置默认）', () => {
    expect(stateOf({ recipeId: 'recipe-openai', recipes: [{ ...recipe, family_adapter_id: 'seedance-2-0-v1' }] }))
      .toBe('missing');
  });

  it('配方库不可用 → unknown（未知不等于缺失，不得据此标失效）', () => {
    expect(stateOf({ recipeId: 'recipe-openai', recipes: [], recipesUnavailable: true })).toBe('unknown');
  });
});

describe('countModelsByConnection', () => {
  it('按服务统计模型数量，未出现的服务不落在 map 中', () => {
    const counts = countModelsByConnection([
      { connection_id: 'up_conn_1' },
      { connection_id: 'up_conn_1' },
      { connection_id: 'up_conn_2' },
    ]);
    expect(counts.get('up_conn_1')).toBe(2);
    expect(counts.get('up_conn_2')).toBe(1);
    expect(counts.has('up_conn_3')).toBe(false);
  });

  it('空列表返回空 map', () => {
    expect(countModelsByConnection([]).size).toBe(0);
  });
});

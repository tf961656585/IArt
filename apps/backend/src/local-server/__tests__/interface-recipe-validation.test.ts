import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECIPE_CONDITION_LIMITS,
  type RecipeCondition,
} from '@iart/contracts';
import {
  validateInterfaceRecipe,
  validateRecipeReference,
} from '../interface-recipe-validation.cts';
import type { InterfaceRecipe } from '@iart/contracts';

/**
 * 接口配方语义校验（docs/custom-providers/接口配方-design.md §7）。
 *
 * 每个违例分支一条断言：条件树非空 / 节点与深度上限 / 路径非空 / 需要值的操作 /
 * 需要列表的操作 / needs_fetch 的 {id} 与两种 accept / 成功失败冲突 / 族登记。
 */

const VALID_INPUT = {
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' } as RecipeCondition,
  result: {
    kind: 'direct_url' as const,
    media_field_paths: ['data.0.url'],
    media_type: 'image' as const,
  },
};

const codesOf = (violations: readonly { field?: string; message: string }[]): string[] =>
  violations.map((violation) => `${violation.field ?? ''}|${violation.message}`);

void test('validation: a well-formed recipe passes', () => {
  assert.deepEqual(validateInterfaceRecipe(VALID_INPUT), []);
});

void test('validation: unknown family adapter id is rejected', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    family_adapter_id: 'not-registered-family',
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.field, 'family_adapter_id');
});

void test('validation: empty combination node is rejected', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    success_when: { op: 'all', children: [] },
  });
  assert.ok(codesOf(violations).some((code) => code.startsWith('success_when|')));
});

void test('validation: node count and depth limits are enforced', () => {
  const atoms: RecipeCondition[] = Array.from(
    { length: RECIPE_CONDITION_LIMITS.maxNodes + 1 },
    (_unused, index) => ({ op: 'exists', path: `field_${index}` }),
  );
  const tooMany = validateInterfaceRecipe({
    ...VALID_INPUT,
    success_when: { op: 'all', children: atoms },
  });
  assert.ok(codesOf(tooMany).some((code) => code.includes('条件太多')));

  let deep: RecipeCondition = { op: 'exists', path: 'leaf' };
  for (let depth = 0; depth < RECIPE_CONDITION_LIMITS.maxDepth + 1; depth += 1) {
    deep = { op: 'all', children: [deep] };
  }
  const tooDeep = validateInterfaceRecipe({ ...VALID_INPUT, success_when: deep });
  assert.ok(codesOf(tooDeep).some((code) => code.includes('嵌套层级太深')));
});

void test('validation: blank atom path is rejected', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    success_when: { op: 'exists', path: '   ' },
  });
  assert.ok(codesOf(violations).some((code) => code.includes('没有填写字段路径')));
});

void test('validation: ops requiring a value must carry one', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    success_when: { op: 'eq', path: 'status' },
  });
  assert.ok(codesOf(violations).some((code) => code.includes('需要填写比较的值')));
});

void test('validation: in/not_in require an array value', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    success_when: { op: 'in', path: 'status', value: 'succeeded' },
  });
  assert.ok(codesOf(violations).some((code) => code.includes('比较值要写成列表')));
});

void test('validation: needs_fetch template must contain {id}', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    result: {
      kind: 'needs_fetch',
      identity_field_path: 'name',
      content_url_template: '/v1/videos/content',
      accept: 'binary',
      media_type: 'video',
    },
  });
  assert.ok(codesOf(violations).some((code) => code.includes('{id}')));
});

void test('validation: needs_fetch binary requires media_type', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    result: {
      kind: 'needs_fetch',
      identity_field_path: 'name',
      content_url_template: '/v1/videos/{id}/content',
      accept: 'binary',
    },
  });
  assert.ok(codesOf(violations).some((code) => code.includes('图片、视频还是音频')));
});

void test('validation: needs_fetch json requires after', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    result: {
      kind: 'needs_fetch',
      identity_field_path: 'name',
      content_url_template: '/v1/videos/{id}/content',
      accept: 'json',
    },
  });
  assert.ok(codesOf(violations).some((code) => code.includes('产物在哪个字段')));
});

void test('validation: same path + same value in success and failure is rejected', () => {
  const violations = validateInterfaceRecipe({
    ...VALID_INPUT,
    success_when: { op: 'any', children: [{ op: 'eq', path: 'status', value: 'done' }, { op: 'exists', path: 'id' }] },
    failure_when: { op: 'eq', path: 'status', value: 'done' },
  });
  assert.ok(codesOf(violations).some((code) => code.includes('互相矛盾')));
});

void test('validation: same path with different values is allowed', () => {
  assert.deepEqual(
    validateInterfaceRecipe({
      ...VALID_INPUT,
      failure_when: { op: 'eq', path: 'status', value: 'failed' },
    }),
    [],
  );
});

void test('validation: reference guard distinguishes missing recipe from family mismatch', () => {
  assert.ok(validateRecipeReference('openai-image-v1', null)?.includes('不存在'));

  const otherFamily: InterfaceRecipe = {
    recipe_id: 'ir_other',
    name: '别的族',
    family_adapter_id: 'veo-v1',
    success_when: { op: 'exists', path: 'id' },
    result: { kind: 'direct_url', media_field_paths: ['url'], media_type: 'video' },
    requires_auth: false,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
  assert.ok(validateRecipeReference('openai-image-v1', otherFamily)?.includes('不一致'));
  assert.equal(validateRecipeReference('veo-v1', otherFamily), null);
});

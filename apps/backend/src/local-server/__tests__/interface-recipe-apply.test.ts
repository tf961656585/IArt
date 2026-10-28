import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { InterfaceRecipe, RecipeResultForm } from '@iart/contracts';
import { buildFamilyTemplateSources } from '../generation-family-templates.registry.cts';
import { applyRecipeToSources } from '../interface-recipe-apply.cts';
import { normalizeFormalTaskExecutionPlan } from '../model-package-catalog.task-plan.cts';
import { buildDeclaredGenerationProjection } from '../generation-declaration-projection.cts';
import {
  addInterfaceRecipe,
  clearCacheForTest as clearInterfaceRecipeCache,
} from '../provider-connection/interface-recipe-store.cts';

/**
 * 接口配方 × 族模板 sources 合成（docs/custom-providers/接口配方-design.md §6/§7）。
 *
 * 验收焦点：三条合成路径
 * - 无配方 = 与现状逐字段一致（族内置默认）；
 * - 有配方 = 覆盖判定与结果段落，仍能通过执行计划归一化；
 * - 三种结果形态都能产出可归一化的执行计划（needs_fetch 含 acquisition strategy）。
 */

const buildRecipe = (
  result: RecipeResultForm,
  overrides: Partial<InterfaceRecipe> = {},
): InterfaceRecipe => ({
  recipe_id: 'ir_apply',
  name: '合成测试',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result,
  requires_auth: false,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  ...overrides,
});

const buildReadySources = (
  familyAdapterId: string,
  recipe: InterfaceRecipe | null | undefined,
) => {
  const built = buildFamilyTemplateSources(familyAdapterId, 'recipe-apply-model', {
    acceptedMediaSlots: [],
    ...(recipe === undefined ? {} : { recipe }),
  });
  assert.equal(built.kind, 'ready');
  if (built.kind !== 'ready') throw new Error('family template not ready');
  return built.sources;
};

void test('apply: no recipe keeps sources identical to the family built-in default', () => {
  const baseline = buildReadySources('openai-image-v1', undefined);
  const withNull = buildReadySources('openai-image-v1', null);
  // 逐字段比较（JSON 形状完全一致）：无配方路径必须与引入配方之前同一份执行计划。
  assert.deepEqual(withNull, baseline);
  assert.equal(JSON.stringify(withNull), JSON.stringify(baseline));
});

void test('apply: direct_url recipe overrides judgment and output mapping', () => {
  const recipe = buildRecipe(
    { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
    { failure_when: { op: 'eq', path: 'status', value: 'failed' } },
  );
  const sources = buildReadySources('openai-image-v1', recipe);

  const runtimeModel = sources.runtimeModel;
  const resultRule = runtimeModel.result_rule;
  assert.ok(resultRule && typeof resultRule === 'object' && !Array.isArray(resultRule));
  assert.equal(resultRule.mode, 'sync', 'mode keeps the family template value');
  assert.deepEqual(resultRule.success_condition, { op: 'eq', path: 'status', value: 'succeeded' });
  assert.deepEqual(resultRule.failure_condition, { op: 'eq', path: 'status', value: 'failed' });

  const mapping = runtimeModel.result_output_mapping;
  assert.ok(mapping && typeof mapping === 'object' && !Array.isArray(mapping));
  assert.equal(mapping.response_mode, 'structured_payload');
  assert.deepEqual(mapping.output_mapping_rules, [
    { target: 'output.image_url', source: { kind: 'response', path: 'data.0.url' }, required: false },
  ]);
  assert.equal(runtimeModel.result_acquisition_strategy, undefined);

  const plan = normalizeFormalTaskExecutionPlan(runtimeModel);
  assert.ok(plan);
  assert.equal(plan.result_rule.success_condition?.op, 'eq');
  assert.equal(plan.result_rule.failure_condition?.op, 'eq');
  assert.equal(plan.result_acquisition_strategy, null);
  assert.equal(plan.result_output_mapping?.response_mode, 'structured_payload');
  assert.equal(plan.result_output_mapping?.output_mapping_rules[0]?.target, 'output.image_url');
  assert.equal(plan.result_output_mapping?.output_mapping_rules[0]?.source.path, 'data.0.url');
});

void test('apply: failure_reason survives into the normalized execution plan', () => {
  const recipe = buildRecipe(
    { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'image' },
    {
      failure_when: { op: 'eq', path: 'status', value: 'failed' },
      failure_reason: '服务商拒绝了这次生成，请调整提示词后重试。',
    },
  );
  const sources = buildReadySources('openai-image-v1', recipe);
  const plan = normalizeFormalTaskExecutionPlan(sources.runtimeModel);
  assert.ok(plan);
  assert.equal(plan.result_rule.failure_reason, '服务商拒绝了这次生成，请调整提示词后重试。');
});

void test('apply: inline_media recipe produces a normalizable plan', () => {
  const recipe = buildRecipe(
    {
      kind: 'inline_media',
      media_field_paths: ['steps.[].content'],
      media_type: 'image',
      encoding: 'json_inline',
    },
  );
  const sources = buildReadySources('gemini-image-interactions-v1', recipe);
  const plan = normalizeFormalTaskExecutionPlan(sources.runtimeModel);
  assert.ok(plan);
  assert.deepEqual(plan.result_rule.success_condition, { op: 'eq', path: 'status', value: 'succeeded' });
  assert.equal(plan.result_rule.failure_condition, undefined);
  assert.equal(plan.result_output_mapping?.output_mapping_rules[0]?.target, 'output.image_url');
  assert.equal(plan.result_output_mapping?.output_mapping_rules[0]?.source.path, 'steps.[].content');
});

void test('apply: needs_fetch (json) produces an acquisition strategy accepted by the plan normalizer', () => {
  const recipe = buildRecipe(
    {
      kind: 'needs_fetch',
      identity_field_path: 'task.id',
      content_url_template: '/v1/videos/{id}/content',
      accept: 'json',
      after: { kind: 'direct_url', media_field_paths: ['data.0.url'], media_type: 'video' },
    },
    {
      family_adapter_id: 'seedance-2-0-v1',
      requires_auth: true,
    },
  );
  const sources = buildReadySources('seedance-2-0-v1', recipe);
  const plan = normalizeFormalTaskExecutionPlan(sources.runtimeModel);
  assert.ok(plan);
  assert.equal(plan.result_rule.mode, 'async', 'mode keeps the family template value');
  assert.ok(plan.result_acquisition_strategy);
  assert.equal(plan.result_acquisition_strategy.acquisition_mode, 'fetch_final_result');
  assert.equal(plan.result_acquisition_strategy.identity_source, 'query_response_path');
  assert.equal(plan.result_acquisition_strategy.identity_path, 'task.id');
  assert.equal(plan.result_acquisition_strategy.request_strategy?.method, 'GET');
  assert.equal(plan.result_acquisition_strategy.request_strategy?.endpoint, '/v1/videos/{id}/content');
  assert.equal(plan.result_output_mapping?.output_mapping_rules[0]?.target, 'output.video_url');
  assert.equal(plan.result_output_mapping?.output_mapping_rules[0]?.source.path, 'data.0.url');
});

void test('apply: needs_fetch (binary) maps the reserved acquisition path and keeps auth flag', () => {
  const recipe = buildRecipe(
    {
      kind: 'needs_fetch',
      identity_field_path: 'name',
      content_url_template: '/v1/operations/{id}/media',
      accept: 'binary',
      media_type: 'video',
    },
    { family_adapter_id: 'veo-v1', requires_auth: true },
  );
  const sources = buildReadySources('veo-v1', recipe);
  const plan = normalizeFormalTaskExecutionPlan(sources.runtimeModel);
  assert.ok(plan);
  assert.equal(plan.result_acquisition_strategy?.acquisition_mode, 'fetch_final_result');
  assert.equal(plan.result_acquisition_strategy?.accept, 'binary');
  assert.equal(plan.result_acquisition_strategy?.media_type, 'video');
  assert.equal(plan.result_acquisition_strategy?.requires_auth, true);
  assert.equal(plan.result_output_mapping?.response_mode, 'structured_payload');
  assert.equal(plan.result_output_mapping?.requires_auth, true);
  // 获取阶段把内容地址写入保留路径，映射据此复用既有下载链路。
  assert.deepEqual(plan.result_output_mapping?.output_mapping_rules, [
    {
      target: 'output.video_url',
      source: { kind: 'response', path: '__acquired_media_url' },
      required: true,
    },
  ]);
});

void test('apply: recipe application does not mutate the input sources', () => {
  const baseline = buildReadySources('openai-image-v1', undefined);
  const before = JSON.stringify(baseline);
  const recipe = buildRecipe({ kind: 'direct_url', media_field_paths: ['url'], media_type: 'image' });
  const applied = applyRecipeToSources(baseline, recipe);
  assert.equal(JSON.stringify(baseline), before, 'input sources untouched');
  assert.notEqual(applied.runtimeModel, baseline.runtimeModel);
  assert.equal(applied.node, baseline.node);
  assert.equal(applied.localizationResources, baseline.localizationResources);
});

const buildDeclaration = (recipeId: string | undefined) => ({
  model_id: 'projection-recipe-model',
  record_id: 'up_dep_projection_recipe',
  connection_id: 'conn-recipe',
  remote_model_id: 'remote-projection-recipe',
  family_adapter_id: 'openai-image-v1' as const,
  accepted_media_slots: [],
  parameter_overrides: { official: [], custom: [] },
  ...(recipeId === undefined ? {} : { recipe_id: recipeId }),
  created_at: new Date(0).toISOString(),
});

void test('projection: no recipe / recipe / invalid recipe all yield the expected execution plan', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-recipe-projection-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearInterfaceRecipeCache();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearInterfaceRecipeCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // 路径一：无配方 = 族内置默认。
  const baseline = buildDeclaredGenerationProjection(buildDeclaration(undefined));
  assert.ok(baseline);
  const baselinePlan = baseline.projection.task_execution_plan;
  assert.ok(baselinePlan);
  assert.equal(baselinePlan.result_rule.success_condition, undefined);

  // 路径二：有配方 = 覆盖判定与结果。
  const added = addInterfaceRecipe({
    recipe_id: 'ir_projection',
    name: '投影覆盖',
    family_adapter_id: 'openai-image-v1',
    success_when: { op: 'eq', path: 'recipe_marker', value: 'done' },
    failure_when: { op: 'eq', path: 'recipe_marker', value: 'failed' },
    failure_reason: '配方声明的失败原因走到执行计划',
    result: { kind: 'direct_url', media_field_paths: ['recipe.media.url'], media_type: 'image' },
  });
  assert.equal(added.ok, true);
  const withRecipe = buildDeclaredGenerationProjection(buildDeclaration('ir_projection'));
  assert.ok(withRecipe);
  const recipePlan = withRecipe.projection.task_execution_plan;
  assert.ok(recipePlan);
  assert.deepEqual(recipePlan.result_rule.success_condition, {
    op: 'eq',
    path: 'recipe_marker',
    value: 'done',
  });
  // 全链路（store 读取 → 合成 → 执行计划归一化）都携带失败原因，不只合成函数内部。
  assert.equal(recipePlan.result_rule.failure_reason, '配方声明的失败原因走到执行计划');
  assert.equal(recipePlan.result_output_mapping?.output_mapping_rules[0]?.source.path, 'recipe.media.url');

  // 路径三之一：引用不存在的配方 = 回落默认，且记录不丢投影。
  const missingRecipe = buildDeclaredGenerationProjection(buildDeclaration('ir_deleted'));
  assert.ok(missingRecipe, 'record still projects when its recipe was deleted');
  assert.deepEqual(missingRecipe.projection.task_execution_plan, baselinePlan);

  // 路径三之二：族不一致 = 回落默认，且记录不丢投影。
  const otherFamily = addInterfaceRecipe({
    recipe_id: 'ir_other_family',
    name: '别的族',
    family_adapter_id: 'veo-v1',
    success_when: { op: 'exists', path: 'done' },
    result: { kind: 'direct_url', media_field_paths: ['url'], media_type: 'video' },
  });
  assert.equal(otherFamily.ok, true);
  const mismatched = buildDeclaredGenerationProjection(buildDeclaration('ir_other_family'));
  assert.ok(mismatched, 'record still projects when the recipe family mismatches');
  assert.deepEqual(mismatched.projection.task_execution_plan, baselinePlan);
});

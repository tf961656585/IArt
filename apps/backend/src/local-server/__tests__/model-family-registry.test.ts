import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveClosedFamilyAdapter,
  resolveModelFamilyAdapter,
  type DeclaredGenerationFamily,
} from '../model-family-registry.cts';

/**
 * 模型族注册表（生成模型自建声明试点 §3.5 的族判定扩展）。
 *
 * `resolveModelFamilyAdapter` 三分支：正则命中优先、未命中走声明族、两者皆无返回 null。
 * `resolveClosedFamilyAdapter` 保持纯正则单查语义，作为回归基线一并钉住。
 */

const DECLARED: DeclaredGenerationFamily = new Map([
  ['my-image', 'openai-image-v1'],
  ['my-video', 'veo-v1'],
  // 故意放置的矛盾项：声明族与正则族不一致，用来钉住「正则命中优先」
  ['gpt-image-2', 'veo-v1'],
]);

void test('resolveModelFamilyAdapter：正则命中优先，声明矛盾也不改判', () => {
  assert.equal(resolveModelFamilyAdapter('gpt-image-2', DECLARED), 'openai-image-v1');
  assert.equal(resolveModelFamilyAdapter('veo-3', DECLARED), 'veo-v1');
  // 不传声明时纯正则路径与 resolveClosedFamilyAdapter 完全一致
  assert.equal(resolveModelFamilyAdapter('gpt-image-2'), resolveClosedFamilyAdapter('gpt-image-2'));
});

void test('resolveModelFamilyAdapter：正则未命中时用声明族', () => {
  assert.equal(resolveModelFamilyAdapter('my-image', DECLARED), 'openai-image-v1');
  assert.equal(resolveModelFamilyAdapter('my-video', DECLARED), 'veo-v1');
  // 无声明来源时同一名字判不出族
  assert.equal(resolveModelFamilyAdapter('my-image'), null);
});

void test('resolveModelFamilyAdapter：正则与声明都未命中返回 null', () => {
  assert.equal(resolveModelFamilyAdapter('totally-unknown', DECLARED), null);
  assert.equal(resolveModelFamilyAdapter('totally-unknown'), null);
  assert.equal(resolveModelFamilyAdapter('totally-unknown', new Map()), null);
});

void test('resolveClosedFamilyAdapter：纯正则单查语义保持不变', () => {
  assert.equal(resolveClosedFamilyAdapter('gpt-image-2'), 'openai-image-v1');
  assert.equal(resolveClosedFamilyAdapter('my-image'), null, '声明族不进入纯正则单查');
});

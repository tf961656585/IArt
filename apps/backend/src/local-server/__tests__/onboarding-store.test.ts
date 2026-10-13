import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';

/**
 * onboarding store 行为测试（node:test，backend 门禁入口）。
 *
 * 保护契约（docs/hub/首次指引-design.md §4.1）：
 * - 默认态 guideDismissed=false（文件缺失/损坏都回退未看过）
 * - setGuideDismissed(true) 落盘且读回一致
 * - 写入后 version 恒为当前版本、updatedAt 被刷新
 * - 损坏 JSON / 字段非法回退默认值（不抛异常）
 */

let root = '';
let storePath = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-store-'));
  process.env.IART_STORAGE_ROOT = root;
  storePath = path.join(root, 'config', 'onboarding-state.json');
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

void test('onboarding store: 默认未看过（文件缺失）', async () => {
  const { readOnboardingState, clearCacheForTest } = await import('../onboarding/onboarding-store.cts');
  clearCacheForTest();
  const state = readOnboardingState();
  assert.equal(state.guideDismissed, false);
});

void test('onboarding store: 写已看标记后读回一致，version 与 updatedAt 由 store 维护', async () => {
  const { readOnboardingState, setGuideDismissed, clearCacheForTest } = await import('../onboarding/onboarding-store.cts');
  clearCacheForTest();
  const before = readOnboardingState();
  const written = setGuideDismissed(true);
  assert.equal(written.guideDismissed, true);
  assert.notEqual(written.updatedAt, before.updatedAt);
  assert.equal(written.version, 1);
  const reread = readOnboardingState();
  assert.equal(reread.guideDismissed, true);
  const onDisk: unknown = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
  assert.deepEqual(onDisk, written);
});

void test('onboarding store: 损坏 JSON 回退默认值（未看过，不抛异常）', async () => {
  const { readOnboardingState, clearCacheForTest } = await import('../onboarding/onboarding-store.cts');
  clearCacheForTest();
  fs.writeFileSync(storePath, '{ not json', 'utf-8');
  const state = readOnboardingState();
  assert.equal(state.guideDismissed, false);
});

void test('onboarding store: 字段非法回退默认值（不抛异常）', async () => {
  const { readOnboardingState, clearCacheForTest } = await import('../onboarding/onboarding-store.cts');
  clearCacheForTest();
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, guideDismissed: 'yes' }), 'utf-8');
  const state = readOnboardingState();
  assert.equal(state.guideDismissed, false);
});

// @spec: FTB-015
//
// 批次快照的意图结构：新形态按序解析、历史单意图快照读取时归一、总数不一致拒绝。
import assert from 'node:assert/strict';
import test from 'node:test';

import { BatchIntentSnapshotSchema } from '@iart/contracts';

/**
 * 批次快照的意图结构（spec 45 §5.1 / runtime spec FTB-015）。
 *
 * 钉两件事：① 新形态按意图列表解析；② 已落库的历史批次（顶层单意图字段）读取时归一成
 * 「一个意图」——结构升级不能让历史批次的档案、复用与重试整片读不出来。
 */
void test('历史单意图快照读取时归一成一个意图（兼容）', () => {
  const parsed = BatchIntentSnapshotSchema.parse({
    batch_id: 'batch_legacy',
    model_id: 'model-a',
    model_version: '1.0.0',
    prompt: '一只猫',
    params: { size: 'auto' },
    task_count: 2,
    task_ids: ['task_1', 'task_2'],
    created_at: '2026-11-01T00:00:00.000Z',
  });
  assert.equal(parsed.intents.length, 1);
  assert.equal(parsed.intents[0]?.prompt, '一只猫');
  assert.deepEqual(parsed.intents[0]?.params, { size: 'auto' });
  assert.equal(parsed.intents[0]?.task_count, 2);
  assert.deepEqual(parsed.task_ids, ['task_1', 'task_2']);
});

void test('多意图快照按序解析，任务总数等于各意图任务数之和', () => {
  const parsed = BatchIntentSnapshotSchema.parse({
    batch_id: 'batch_multi',
    model_id: 'model-a',
    model_version: '1.0.0',
    intents: [
      { prompt: '动作A', params: {}, task_count: 2 },
      { prompt: '动作B', params: {}, task_count: 1 },
    ],
    task_ids: ['task_1', 'task_2', 'task_3'],
    created_at: '2026-11-06T00:00:00.000Z',
  });
  assert.deepEqual(
    parsed.intents.map((intent) => intent.prompt),
    ['动作A', '动作B'],
  );
  assert.equal(parsed.intents[0]?.task_count, 2);
});

void test('任务总数与意图任务数之和不一致时拒绝（固定任务成员）', () => {
  const parsed = BatchIntentSnapshotSchema.safeParse({
    batch_id: 'batch_bad',
    model_id: 'model-a',
    model_version: '1.0.0',
    intents: [{ prompt: '动作A', params: {}, task_count: 2 }],
    task_ids: ['task_1'],
    created_at: '2026-11-06T00:00:00.000Z',
  });
  assert.equal(parsed.success, false);
});

void test('既无意图列表也无历史单意图字段时拒绝（不留两条读法都空的快照）', () => {
  const parsed = BatchIntentSnapshotSchema.safeParse({
    batch_id: 'batch_empty',
    model_id: 'model-a',
    model_version: '1.0.0',
    task_ids: ['task_1'],
    created_at: '2026-11-06T00:00:00.000Z',
  });
  assert.equal(parsed.success, false);
});

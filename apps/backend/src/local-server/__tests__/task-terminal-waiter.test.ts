import assert from 'node:assert/strict';
import test from 'node:test';

import {
  awaitTaskTerminal,
  cancelTaskWaiters,
  settleTaskTerminal,
  __clearTaskTerminalWaitersForTests,
} from '../task-terminal-waiter.cts';

/**
 * 任务终态等待登记表（spec 04「工具调用循环语义」阻塞等待的底层原语）：
 * 结算幂等（先到先得）、登记先于结算不丢、取消联动以 cancelled 结算。
 */

void test('等待器：结算送达等待方，产物资产随终态带回', async () => {
  __clearTaskTerminalWaitersForTests();
  const waiting = awaitTaskTerminal('task-wait-1');
  settleTaskTerminal('task-wait-1', {
    status: 'succeeded',
    mediaAssets: [],
    errorMessage: null,
  });
  const outcome = await waiting;
  assert.equal(outcome.status, 'succeeded');
});

void test('等待器：重复结算幂等，先到先得', async () => {
  __clearTaskTerminalWaitersForTests();
  const waiting = awaitTaskTerminal('task-wait-2');
  settleTaskTerminal('task-wait-2', { status: 'failed', mediaAssets: [], errorMessage: 'boom' });
  // 迟到的成功结算不覆盖失败事实（终态不可逆）。
  settleTaskTerminal('task-wait-2', { status: 'succeeded', mediaAssets: [], errorMessage: null });
  const outcome = await waiting;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorMessage, 'boom');
});

void test('等待器：取消联动以 cancelled 结算未决条目', async () => {
  __clearTaskTerminalWaitersForTests();
  const waiting = awaitTaskTerminal('task-wait-3');
  cancelTaskWaiters(['task-wait-3']);
  const outcome = await waiting;
  assert.equal(outcome.status, 'cancelled');
  assert.deepEqual(outcome.mediaAssets, []);
});

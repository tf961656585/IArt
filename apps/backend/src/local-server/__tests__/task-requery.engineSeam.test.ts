import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { RuntimeTaskViewSchema } from '@iart/contracts';
import {
  clearActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import {
  clearCredentialForConnection,
  setCredentialForConnection,
} from '../provider-connection/credential-store.cts';
import {
  removeConnection,
  setConnectionCredential,
  setConnectionLifecycle,
} from '../provider-connection/connection-store.cts';
import { updateInterfaceRecipe } from '../provider-connection/interface-recipe-store.cts';
import { cancelTaskExecution, inFlightTasks } from '../task-executor.cts';
import { requeryFailedTask } from '../task-requery.cts';
import {
  CREDENTIAL_VALUE,
  MODEL_ID,
  RECIPE_ID,
  countRows,
  normalizeString,
  readArchiveEventTypes,
  readPersistedView,
  setupRequeryScenario,
  submitAndFailAtResultMapping,
  waitFor,
} from './task-requery.seam-helpers';

/**
 * 重新查询 × 轮询引擎 × 结果物化接缝测试（spec 03 / task-state-machine transitions.requery）。
 *
 * 主链（两端真实实现，只挡 IPC 传输腿与远端 HTTP）：
 *   真实记录创建（submitFormalTaskExecutionPlan）
 *   → 真实提交 + 轮询（executeHttpTask → executePollingTask，假 HTTP 上游）
 *   → 旧配方映射未命中（真实 executeTaskResultMaterialization 写 result_mapping 失败）
 *   → 真实读存储（better-sqlite3 + runtime writer / read model）
 *   → 改配方（真实 interface-recipe-store）
 *   → 真实 requeryFailedTask（当前投影重建查询计划 + 同一任务身份重入轮询）
 *   → 真实物化落资产。
 *
 * 红→绿自证：本测试在「入口不复位记录 / 不重建当前查询计划」的实现上跑红
 * （任务停在旧映射的 result_mapping 失败，永远到不了 succeeded），补齐后转绿。
 * 输入全部由真实记录创建链路产生，没有手工构造的理想计划。
 */

void test('接缝：重新查询按当前配方重读同一远端任务，成功并落资产', async (t) => {
  const scenario = await setupRequeryScenario(t, 'success', { mediaFieldPaths: ['url'] });
  const { taskId, remoteRequestId } = await submitAndFailAtResultMapping(scenario);
  const failedView = readPersistedView(scenario.readModel, scenario.db, taskId);
  const tasksBefore = countRows(scenario.db, 'tasks');
  const batchesBefore = countRows(scenario.db, 'batches');
  assert.equal(
    scenario.upstream.calls.filter((call) => call.method === 'POST').length,
    1,
    '首次执行只发一次生成请求',
  );

  // 修配方：同一个配方 id，读取路径从 url 改为 video_url。
  const updated = updateInterfaceRecipe(RECIPE_ID, {
    result: { kind: 'direct_url', media_field_paths: ['video_url'], media_type: 'video' },
  });
  assert.equal(updated.ok, true, 'recipe update should be accepted');

  // 干掉 active route：重新查询不得重建执行快照 / 重新解析派发目标。
  assert.equal(clearActiveDeployment(MODEL_ID), true, 'active route should be removable');

  const accepted = await requeryFailedTask(failedView);
  assert.equal(accepted.ok, true, `requery should be accepted: ${JSON.stringify(accepted)}`);
  if (!accepted.ok) return;
  assert.equal(accepted.taskId, taskId);
  assert.ok(Number.isFinite(Date.parse(accepted.requestedAt)), 'requestedAt should be an ISO timestamp');

  const inFlight = inFlightTasks.get(taskId);
  assert.ok(inFlight, '重新查询必须复用同一个在途注册表（取消按钮依赖它）');
  await inFlight.promise;

  await waitFor(
    () => normalizeString(readPersistedView(scenario.readModel, scenario.db, taskId).status) === 'succeeded',
    'requery success',
  );

  const succeeded = readPersistedView(scenario.readModel, scenario.db, taskId);
  // 同一任务身份：taskId / remoteRequestId 不变，不新建 task / batch。
  assert.equal(succeeded.taskId, taskId);
  assert.equal(succeeded.remoteRequestId, remoteRequestId);
  assert.equal(countRows(scenario.db, 'tasks'), tasksBefore, '重新查询不得新建任务行');
  assert.equal(countRows(scenario.db, 'batches'), batchesBefore, '重新查询不得新建批次行');
  assert.equal(countRows(scenario.db, 'task_outputs'), 1, '正式输出应落定一行');
  assert.equal(countRows(scenario.db, 'media_assets'), 1, '媒体资产应落定一行');
  const outputRow = scenario.db.prepare('SELECT assetId, mediaType FROM task_outputs').get();
  assert.ok(outputRow !== null && typeof outputRow === 'object');
  assert.equal(Reflect.get(outputRow, 'mediaType'), 'video');
  assert.ok(normalizeString(Reflect.get(outputRow, 'assetId')), '输出必须绑定媒体资产');
  assert.equal(succeeded.metadata?.requeryCount, 1, '重新查询次数应登记在元数据白名单内');
  assert.ok(normalizeString(succeeded.metadata?.requeryStartedAt), '首次重新查询时刻应落库');
  assert.equal(
    fs.readdirSync(path.join(scenario.projectPath, 'media')).length,
    1,
    '媒体文件应已落盘',
  );

  // 网络面：只有一次生成提交；重新查询只发查询 + 下载，不重新提交生成。
  assert.equal(
    scenario.upstream.calls.filter((call) => call.method === 'POST').length,
    1,
    '重新查询不得重新提交生成请求',
  );
  const polls = scenario.upstream.calls.filter(
    (call) => call.method === 'GET' && call.url.includes(`/tasks/${remoteRequestId}`),
  );
  assert.equal(polls.length, 2, '首轮一次 + 重新查询一次，共两次查询');
  assert.ok(
    scenario.upstream.calls.some((call) => call.url.endsWith('/out.mp4')),
    '成功路径应下载媒体',
  );
  assert.equal(
    JSON.stringify(scenario.upstream.calls).includes(CREDENTIAL_VALUE),
    false,
    '凭证明文不得进入上游地址',
  );

  // 归档：原失败事件保留，重新查询事件与最终成功事件追加，不删除历史。
  const archiveTypes = readArchiveEventTypes(scenario.projectPath, taskId);
  assert.ok(archiveTypes.includes('task.failed'), `原失败归档必须保留，实际: ${archiveTypes.join(',')}`);
  assert.ok(archiveTypes.includes('task.requery_requested'), `应有 requery_requested，实际: ${archiveTypes.join(',')}`);
  assert.ok(archiveTypes.includes('task.requery_started'), `应有 requery_started，实际: ${archiveTypes.join(',')}`);
  assert.ok(archiveTypes.includes('task.succeeded'), `应有成功归档，实际: ${archiveTypes.join(',')}`);

  // 状态通知：重新查询入口那一次写入必须是 polling，且不再携带旧失败。
  const pollingNotifications = scenario.notifications.filter(
    (notification) => notification.task?.status === 'polling',
  );
  assert.ok(pollingNotifications.length >= 2, '首轮与重新查询各应出现一次 polling 状态通知');
  const lastPolling = pollingNotifications[pollingNotifications.length - 1];
  assert.equal(lastPolling?.task?.failure, null, '重新查询进入等待时不得继续携带旧失败');
});

void test('接缝：原连接删除 / 停用 / 凭证清除时拒绝重新查询且零请求', async (t) => {
  const scenario = await setupRequeryScenario(t, 'unavailable', { mediaFieldPaths: ['url'] });
  const { taskId } = await submitAndFailAtResultMapping(scenario);
  const failedView = readPersistedView(scenario.readModel, scenario.db, taskId);
  const fetchCountAfterFirstRun = scenario.upstream.calls.length;

  assert.ok(setConnectionLifecycle(scenario.connectionId, 'disabled'), 'connection should be disabled');
  const disabledRejection = await requeryFailedTask(failedView);
  assert.equal(disabledRejection.ok, false);
  if (!disabledRejection.ok) assert.equal(disabledRejection.code, 'connection_unavailable');
  assert.equal(scenario.upstream.calls.length, fetchCountAfterFirstRun, '拒绝不得发出任何请求');

  assert.ok(setConnectionLifecycle(scenario.connectionId, 'enabled'), 'connection should be re-enabled');
  assert.equal(clearCredentialForConnection(scenario.connectionId), true, 'credential should be cleared');
  const credentialRejection = await requeryFailedTask(failedView);
  assert.equal(credentialRejection.ok, false);
  if (!credentialRejection.ok) assert.equal(credentialRejection.code, 'credential_unavailable');
  assert.equal(scenario.upstream.calls.length, fetchCountAfterFirstRun, '拒绝不得发出任何请求');

  const restored = await setCredentialForConnection(scenario.connectionId, CREDENTIAL_VALUE);
  assert.ok(restored, 'credential should be restorable');
  if (!restored) return;
  setConnectionCredential(scenario.connectionId, restored.credentialRef, restored.version, true);
  assert.equal(removeConnection(scenario.connectionId), true, 'connection should be removable');
  const deletedRejection = await requeryFailedTask(failedView);
  assert.equal(deletedRejection.ok, false);
  if (!deletedRejection.ok) assert.equal(deletedRejection.code, 'connection_unavailable');
  assert.equal(scenario.upstream.calls.length, fetchCountAfterFirstRun, '拒绝不得发出任何请求');

  // 任务身份与失败阶段不变，仍保留再次发起的入口。
  const stillFailed = readPersistedView(scenario.readModel, scenario.db, taskId);
  assert.equal(stillFailed.status, 'failed');
  assert.equal(stillFailed.failure?.stage, 'result_mapping');
});

void test('接缝：重新查询期间可被取消（同一在途注册表）', async (t) => {
  const scenario = await setupRequeryScenario(t, 'cancel', { mediaFieldPaths: ['url'] });
  const { taskId } = await submitAndFailAtResultMapping(scenario);
  const failedView = readPersistedView(scenario.readModel, scenario.db, taskId);
  // 上游一直「进行中」：重新查询进入等待，取消必须能落到这次等待上。
  scenario.upstreamConfig.pollStatus = 'running';

  const accepted = await requeryFailedTask(failedView);
  assert.equal(accepted.ok, true, `requery should be accepted: ${JSON.stringify(accepted)}`);
  const inFlight = inFlightTasks.get(taskId);
  assert.ok(inFlight, '重新查询应在同一个在途注册表中');
  assert.equal(cancelTaskExecution(taskId), true, '取消必须能作用于重新查询');
  await inFlight.promise;
  assert.equal(inFlightTasks.has(taskId), false, '结束后应释放在途占位');
});

void test('接缝：失败阶段不可重查 / 非 failed / 无远端号 / agent 派生 / 取消未结算均拒绝且零请求', async (t) => {
  const scenario = await setupRequeryScenario(t, 'eligibility', { mediaFieldPaths: ['url'] });
  const { taskId } = await submitAndFailAtResultMapping(scenario);
  const failedView = readPersistedView(scenario.readModel, scenario.db, taskId);
  assert.equal(
    RuntimeTaskViewSchema.safeParse(failedView).success,
    true,
    '读存储视图必须过消费端契约 schema',
  );
  const fetchCountAfterFirstRun = scenario.upstream.calls.length;

  const submitStage = RuntimeTaskViewSchema.parse({
    ...failedView,
    failure: { ...failedView.failure, stage: 'submit' },
  });
  const submitRejection = await requeryFailedTask(submitStage);
  assert.equal(submitRejection.ok, false);
  if (!submitRejection.ok) assert.equal(submitRejection.code, 'stage_not_requeryable');

  const legacyStage = RuntimeTaskViewSchema.parse({
    ...failedView,
    failure: { code: 'task_execution_failed', message: 'legacy' },
  });
  const legacyRejection = await requeryFailedTask(legacyStage);
  assert.equal(legacyRejection.ok, false);
  if (!legacyRejection.ok) assert.equal(legacyRejection.code, 'stage_not_requeryable');

  const succeededView = RuntimeTaskViewSchema.parse({ ...failedView, status: 'succeeded' });
  const statusRejection = await requeryFailedTask(succeededView);
  assert.equal(statusRejection.ok, false);
  if (!statusRejection.ok) assert.equal(statusRejection.code, 'task_not_failed');

  const noRemoteView = RuntimeTaskViewSchema.parse({
    ...failedView,
    remoteRequestId: null,
    metadata: { ...failedView.metadata, remoteRequestId: null, remote_request_id: null },
  });
  const remoteRejection = await requeryFailedTask(noRemoteView);
  assert.equal(remoteRejection.ok, false);
  if (!remoteRejection.ok) assert.equal(remoteRejection.code, 'missing_remote_request_id');

  const agentView = RuntimeTaskViewSchema.parse({
    ...failedView,
    metadata: { ...failedView.metadata, agentLineage: { agentSessionId: 'sess_1', toolCallId: 'call_1' } },
  });
  const agentRejection = await requeryFailedTask(agentView);
  assert.equal(agentRejection.ok, false);
  if (!agentRejection.ok) assert.equal(agentRejection.code, 'agent_derived');

  const cancelPendingView = RuntimeTaskViewSchema.parse({
    ...failedView,
    metadata: {
      ...failedView.metadata,
      taskCancelRecord: { taskId, acceptedAt: new Date(0).toISOString(), settledAt: null },
    },
  });
  const cancelRejection = await requeryFailedTask(cancelPendingView);
  assert.equal(cancelRejection.ok, false);
  if (!cancelRejection.ok) assert.equal(cancelRejection.code, 'cancel_pending');

  const snapshotMissingView = RuntimeTaskViewSchema.parse({
    ...failedView,
    metadata: { ...failedView.metadata, executionSnapshot: null, execution_snapshot: null },
  });
  const snapshotRejection = await requeryFailedTask(snapshotMissingView);
  assert.equal(snapshotRejection.ok, false);
  if (!snapshotRejection.ok) assert.equal(snapshotRejection.code, 'snapshot_unavailable');

  assert.equal(scenario.upstream.calls.length, fetchCountAfterFirstRun, '资格拒绝不得发出任何请求');
  assert.equal(
    readPersistedView(scenario.readModel, scenario.db, taskId).status,
    'failed',
    '资格拒绝不得改变任务状态',
  );
});

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { type TestContext } from 'node:test';

import { RuntimeTaskViewSchema, TaskRequeryAcceptedSchema } from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { inFlightTasks } from '../task-executor.cts';
import {
  countRows,
  normalizeString,
  readPersistedView,
  setupRequeryScenario,
  submitAndFailAtResultMapping,
  waitFor,
} from './task-requery.seam-helpers';

/**
 * `POST /api/tasks/:id/requery` 资格矩阵（spec task-state-machine transitions.requery）。
 *
 * 记录由真实创建链路产生（受理动作 → 提交 → 轮询 → 映射未命中），变体只派生资格相关字段，
 * 并逐条过 `RuntimeTaskViewSchema`（路由消费端读到的同一份契约形状）。
 * 拒绝路径必须零上游请求；受理路径只发查询（GET），不得重新提交生成（POST）。
 */

type HttpResult = { status: number; body: unknown };

const startServer = async (t: TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server address unavailable');
  return `http://127.0.0.1:${address.port}`;
};

const postRequery = async (
  baseUrl: string,
  projectPath: string,
  taskId: string,
): Promise<HttpResult> => {
  const response = await fetch(
    `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/requery?projectPath=${encodeURIComponent(projectPath)}`,
    { method: 'POST' },
  );
  const body: unknown = await response.json();
  return { status: response.status, body };
};

const readErrorCode = (body: unknown): string =>
  body !== null && typeof body === 'object' ? normalizeString(Reflect.get(body, 'code')) : '';

void test('路由：重新查询资格矩阵、状态码与零上游请求', async (t) => {
  const scenario = await setupRequeryScenario(t, 'routes', { mediaFieldPaths: ['url'] });
  const { taskId } = await submitAndFailAtResultMapping(scenario);
  const failedView = readPersistedView(scenario.readModel, scenario.db, taskId);
  const realView = RuntimeTaskViewSchema.parse(failedView);
  const baseUrl = await startServer(t);
  const callsAfterFirstRun = scenario.upstream.calls.length;
  const tasksBefore = countRows(scenario.db, 'tasks');

  // ① 任务不存在 → 404，不发任何上游请求。
  const notFound = await postRequery(baseUrl, scenario.projectPath, 'task-not-exists');
  assert.equal(notFound.status, 404);
  assert.equal(readErrorCode(notFound.body), 'task_not_found');
  assert.equal(scenario.upstream.calls.length, callsAfterFirstRun, '404 不得发出上游请求');

  // ② 资格拒绝矩阵：全部 409 + 具体拒绝码，且零上游请求。
  const rejectCases: Array<{ label: string; expectedCode: string; view: unknown }> = [
    {
      label: '非 failed',
      expectedCode: 'task_not_failed',
      view: RuntimeTaskViewSchema.parse({ ...realView, status: 'polling' }),
    },
    {
      label: '阶段不可重查（submit）',
      expectedCode: 'stage_not_requeryable',
      view: RuntimeTaskViewSchema.parse({ ...realView, failure: { ...realView.failure, stage: 'submit' } }),
    },
    {
      label: '无阶段（旧记录）',
      expectedCode: 'stage_not_requeryable',
      view: RuntimeTaskViewSchema.parse({
        ...realView,
        failure: { code: 'task_execution_failed', message: 'legacy failure' },
      }),
    },
    {
      label: '无远端任务号',
      expectedCode: 'missing_remote_request_id',
      view: RuntimeTaskViewSchema.parse({
        ...realView,
        remoteRequestId: null,
        metadata: { ...realView.metadata, remoteRequestId: null, remote_request_id: null },
      }),
    },
    {
      label: '未结算取消记录',
      expectedCode: 'cancel_pending',
      view: RuntimeTaskViewSchema.parse({
        ...realView,
        metadata: {
          ...realView.metadata,
          taskCancelRecord: { taskId, acceptedAt: new Date(0).toISOString(), settledAt: null },
        },
      }),
    },
    {
      label: 'agent 派生任务',
      expectedCode: 'agent_derived',
      view: RuntimeTaskViewSchema.parse({
        ...realView,
        metadata: {
          ...realView.metadata,
          agentLineage: { agentSessionId: 'sess_route', toolCallId: 'call_route' },
        },
      }),
    },
    {
      label: '执行快照不可用',
      expectedCode: 'snapshot_unavailable',
      view: RuntimeTaskViewSchema.parse({
        ...realView,
        metadata: { ...realView.metadata, executionSnapshot: null, execution_snapshot: null },
      }),
    },
  ];
  for (const testCase of rejectCases) {
    scenario.viewOverrides.set(taskId, testCase.view);
    const rejected = await postRequery(baseUrl, scenario.projectPath, taskId);
    assert.equal(rejected.status, 409, `${testCase.label} 应返回 409`);
    assert.equal(readErrorCode(rejected.body), testCase.expectedCode, `${testCase.label} 错误码`);
    assert.equal(
      scenario.upstream.calls.length,
      callsAfterFirstRun,
      `${testCase.label} 拒绝不得发出上游请求`,
    );
  }
  scenario.viewOverrides.delete(taskId);

  // ③ 重复点击（在途）：同一任务已在执行中 → 409，不产生第二次轮询。
  const fakeController = new AbortController();
  inFlightTasks.set(taskId, { controller: fakeController, promise: Promise.resolve(null) });
  try {
    const duplicate = await postRequery(baseUrl, scenario.projectPath, taskId);
    assert.equal(duplicate.status, 409);
    assert.equal(readErrorCode(duplicate.body), 'in_flight');
    assert.equal(scenario.upstream.calls.length, callsAfterFirstRun, '在途拒绝不得发出上游请求');
  } finally {
    inFlightTasks.delete(taskId);
  }

  // ④ 受理：200 + 契约回执；只发查询（GET），不重新提交生成（POST）。
  const accepted = await postRequery(baseUrl, scenario.projectPath, taskId);
  assert.equal(accepted.status, 200, `accepted body=${JSON.stringify(accepted.body)}`);
  const acceptedPayload = TaskRequeryAcceptedSchema.parse(accepted.body);
  assert.equal(acceptedPayload.accepted, true);
  assert.equal(acceptedPayload.taskId, taskId);
  assert.equal(acceptedPayload.status, 'polling');
  assert.ok(Number.isFinite(Date.parse(acceptedPayload.requestedAt)));

  // 旧配方仍读 url → 本轮再次停在 result_mapping（回到 failed，可再次发起）。
  await waitFor(
    () => {
      const current = readPersistedView(scenario.readModel, scenario.db, taskId);
      return normalizeString(current.status) === 'failed' && Number(current.metadata?.requeryCount) === 1;
    },
    'requery round settled back to failed',
  );
  const refailed = readPersistedView(scenario.readModel, scenario.db, taskId);
  assert.equal(refailed.failure?.stage, 'result_mapping', '再次失败按最新阶段回写');
  assert.equal(refailed.metadata?.requeryCount, 1);
  assert.equal(refailed.remoteRequestId, realView.remoteRequestId, '远端任务号不变');
  assert.equal(countRows(scenario.db, 'tasks'), tasksBefore, '重新查询不得新建任务行');
  const submitCalls = scenario.upstream.calls.filter((call) => call.method === 'POST');
  assert.equal(submitCalls.length, 1, '重新查询不得重新提交生成请求');
  assert.ok(
    scenario.upstream.calls.length > callsAfterFirstRun,
    '受理后应真实发起一次查询请求',
  );
});

// @spec: FTB-014, CM-032
import { describe, expect, it } from 'vitest';

import type { RuntimeTaskFailure, TaskFailureStage } from '@iart/contracts';

import {
  resolveRequeryRejectionMessage,
  resolveTaskFailureActions,
} from '../taskFailureActions';

/**
 * 失败动作矩阵（spec：docs/editor/失败任务重新查询-design.md §3.2）。
 *
 * 判定唯一来源是 contracts `isRequeryEligibleFailure`（阶段 ∈ 可重查集合 且 远端任务号非空），
 * 本测试同时锁定「Editor 不自行推断阶段」：无 stage、显式 unknown、缺失 remoteRequestId 都
 * 只能落到「重试」。
 */

const REMOTE_REQUEST_ID = 'remote-request-1';

const buildFailure = (stage?: TaskFailureStage): RuntimeTaskFailure => ({
  code: 'TASK_EXECUTION_FAILED',
  message: 'boom',
  ...(stage !== undefined ? { stage } : {}),
});

const REQUERY_STAGES: TaskFailureStage[] = [
  'polling_request',
  'polling_timeout',
  'result_mapping',
];

const NON_REQUERY_STAGES: TaskFailureStage[] = [
  'submit',
  'remote_failure',
  'result_acquisition',
  'download',
  'recovery',
  'unknown',
];

describe('resolveTaskFailureActions', () => {
  it.each(REQUERY_STAGES)('可重查阶段 %s → 重新查询 + 重新生成 + 删除', (stage) => {
    expect(
      resolveTaskFailureActions({
        status: 'failed',
        failure: buildFailure(stage),
        remoteRequestId: REMOTE_REQUEST_ID,
      }),
    ).toEqual({ primary: 'requery', secondary: 'regenerate', delete: true });
  });

  it.each(NON_REQUERY_STAGES)('不可重查阶段 %s → 重试 + 删除（不出现重新生成）', (stage) => {
    expect(
      resolveTaskFailureActions({
        status: 'failed',
        failure: buildFailure(stage),
        remoteRequestId: REMOTE_REQUEST_ID,
      }),
    ).toEqual({ primary: 'retry', secondary: null, delete: true });
  });

  it('无 stage 的存量失败 → 重试 + 删除，不推断阶段', () => {
    expect(
      resolveTaskFailureActions({
        status: 'failed',
        failure: buildFailure(undefined),
        remoteRequestId: REMOTE_REQUEST_ID,
      }),
    ).toEqual({ primary: 'retry', secondary: null, delete: true });
  });

  it('failure 为 null/undefined → 重试 + 删除', () => {
    expect(
      resolveTaskFailureActions({
        status: 'failed',
        failure: null,
        remoteRequestId: REMOTE_REQUEST_ID,
      }),
    ).toEqual({ primary: 'retry', secondary: null, delete: true });
    expect(
      resolveTaskFailureActions({
        status: 'failed',
        failure: undefined,
        remoteRequestId: REMOTE_REQUEST_ID,
      }),
    ).toEqual({ primary: 'retry', secondary: null, delete: true });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['空串', ''],
    ['纯空白', '   '],
  ] as const)('可重查阶段但 remoteRequestId 为 %s → 重试（共享谓词拒绝重查）', (_label, remoteRequestId) => {
    expect(
      resolveTaskFailureActions({
        status: 'failed',
        failure: buildFailure('polling_request'),
        remoteRequestId,
      }),
    ).toEqual({ primary: 'retry', secondary: null, delete: true });
  });

  it.each(['submitting', 'generating', 'polling', 'downloading', 'succeeded', 'cancelled'] as const)(
    '非 failed 状态 %s → 不提供失败动作',
    (status) => {
      expect(
        resolveTaskFailureActions({
          status,
          failure: buildFailure('polling_request'),
          remoteRequestId: REMOTE_REQUEST_ID,
        }),
      ).toEqual({ primary: null, secondary: null, delete: true });
    },
  );
});

describe('resolveRequeryRejectionMessage', () => {
  const apiError = (code: string) => ({
    message: 'HTTP 409',
    status: 409,
    body: { code, message: 'internal detail' },
  });

  it('连接不可用 → 指向检查服务商设置或重新生成', () => {
    expect(resolveRequeryRejectionMessage(apiError('connection_unavailable'))).toBe(
      '没能重新查询：这个任务原来的服务商连接已经不可用。检查服务商设置，或用「重新生成」新建一次任务。',
    );
  });

  it('凭证不可用 → 指向检查服务商与密钥或重新生成', () => {
    expect(resolveRequeryRejectionMessage(apiError('credential_unavailable'))).toBe(
      '没能重新查询：这个任务原来的密钥已经不可用。检查服务商与密钥，或用「重新生成」新建一次任务。',
    );
  });

  it('执行配置/接口配置不可用 → 指向重新生成，不暴露内部措辞', () => {
    expect(resolveRequeryRejectionMessage(apiError('snapshot_unavailable'))).toContain(
      '用「重新生成」新建一次任务',
    );
    expect(resolveRequeryRejectionMessage(apiError('interface_format_unavailable'))).toBe(
      '没能重新查询：这个任务的接口配置不可用。用「重新生成」新建一次任务。',
    );
  });

  it('在途重复请求 → 请稍候', () => {
    expect(resolveRequeryRejectionMessage(apiError('in_flight'))).toBe('正在重新查询，请稍候。');
  });

  it('其他拒绝码 / 无拒绝码 / 非 ApiError → 最短通用文案', () => {
    expect(resolveRequeryRejectionMessage(apiError('unknown_code'))).toBe('没能重新查询。');
    expect(resolveRequeryRejectionMessage({ message: 'HTTP 409', status: 409, body: null })).toBe(
      '没能重新查询。',
    );
    expect(resolveRequeryRejectionMessage(new Error('network down'))).toBe('没能重新查询。');
  });
});

// @spec: FTB-013, FTB-014
import { describe, expect, it } from 'vitest';

import { RuntimeTaskFailureSchema } from '../src/schemas/runtime-transaction.schema';
import {
  isRequeryEligibleFailure,
  TaskRequeryAcceptedSchema,
} from '../src/task-requery-contract';
import {
  isRequeryEligibleFailureStage,
  isTaskFailureStage,
  TASK_FAILURE_STAGES,
  type TaskFailureStage,
} from '../src/task-failure-stage';

describe('TASK_FAILURE_STAGES', () => {
  it('包含已拍板的全部失败阶段', () => {
    expect([...TASK_FAILURE_STAGES].sort()).toEqual(
      [
        'download',
        'polling_request',
        'polling_timeout',
        'recovery',
        'remote_failure',
        'result_acquisition',
        'result_mapping',
        'submit',
        'unknown',
      ].sort(),
    );
  });

  it('类型守卫只接受枚举成员', () => {
    for (const stage of TASK_FAILURE_STAGES) {
      expect(isTaskFailureStage(stage)).toBe(true);
    }
    expect(isTaskFailureStage('not_a_stage')).toBe(false);
    expect(isTaskFailureStage(undefined)).toBe(false);
    expect(isTaskFailureStage(null)).toBe(false);
  });
});

describe('RuntimeTaskFailureSchema.stage', () => {
  it('旧 failureJson（无 stage）仍可 parse', () => {
    const parsed = RuntimeTaskFailureSchema.parse({
      code: 'result_output_mapping_missed',
      message: '结果输出映射未命中正式输出',
      retryable: null,
    });
    expect(parsed.code).toBe('result_output_mapping_missed');
    expect(parsed.stage).toBeUndefined();
  });

  it('新 stage 可 parse', () => {
    const parsed = RuntimeTaskFailureSchema.parse({
      code: 'polling_timeout',
      stage: 'polling_timeout',
    });
    expect(parsed.stage).toBe('polling_timeout');
  });

  it('stage 允许显式 null', () => {
    const parsed = RuntimeTaskFailureSchema.parse({ code: 'x', stage: null });
    expect(parsed.stage).toBeNull();
  });

  it('非法 stage 被拒绝（strict 语义不放松）', () => {
    expect(() =>
      RuntimeTaskFailureSchema.parse({ code: 'x', stage: 'not_a_stage' }),
    ).toThrow();
  });

  it('未知字段仍被 strict 拒绝', () => {
    expect(() =>
      RuntimeTaskFailureSchema.parse({ code: 'x', unexpected: true }),
    ).toThrow();
  });
});

describe('isRequeryEligibleFailureStage', () => {
  it('只对 polling_request / polling_timeout / result_mapping 返回 true', () => {
    const expectedTrue: TaskFailureStage[] = [
      'polling_request',
      'polling_timeout',
      'result_mapping',
    ];
    for (const stage of TASK_FAILURE_STAGES) {
      expect(isRequeryEligibleFailureStage(stage)).toBe(expectedTrue.includes(stage));
    }
  });

  it('缺失或非法 stage 返回 false', () => {
    expect(isRequeryEligibleFailureStage(undefined)).toBe(false);
    expect(isRequeryEligibleFailureStage(null)).toBe(false);
    expect(isRequeryEligibleFailureStage('submit')).toBe(false);
  });
});

describe('isRequeryEligibleFailure', () => {
  it('可重查 stage + 非空远端任务号 → true', () => {
    expect(
      isRequeryEligibleFailure({ stage: 'polling_timeout' }, 'remote-123'),
    ).toBe(true);
  });

  it('远端任务号为空或非字符串 → false', () => {
    expect(isRequeryEligibleFailure({ stage: 'polling_timeout' }, '')).toBe(false);
    expect(isRequeryEligibleFailure({ stage: 'polling_timeout' }, '   ')).toBe(false);
    expect(isRequeryEligibleFailure({ stage: 'polling_timeout' }, null)).toBe(false);
  });

  it('不可重查 stage 或缺失失败信息 → false', () => {
    expect(isRequeryEligibleFailure({ stage: 'download' }, 'remote-123')).toBe(false);
    expect(isRequeryEligibleFailure({ code: 'x' }, 'remote-123')).toBe(false);
    expect(isRequeryEligibleFailure(null, 'remote-123')).toBe(false);
  });
});

describe('TaskRequeryAcceptedSchema', () => {
  it('parse 合法受理回执', () => {
    const parsed = TaskRequeryAcceptedSchema.parse({
      accepted: true,
      taskId: 'task-1',
      status: 'polling',
      requestedAt: '2026-10-27T10:00:00.000Z',
    });
    expect(parsed.status).toBe('polling');
  });

  it('accepted 非 true / status 非 polling / 空 taskId 被拒绝', () => {
    expect(() =>
      TaskRequeryAcceptedSchema.parse({
        accepted: false,
        taskId: 'task-1',
        status: 'polling',
        requestedAt: 'x',
      }),
    ).toThrow();
    expect(() =>
      TaskRequeryAcceptedSchema.parse({
        accepted: true,
        taskId: 'task-1',
        status: 'failed',
        requestedAt: 'x',
      }),
    ).toThrow();
    expect(() =>
      TaskRequeryAcceptedSchema.parse({
        accepted: true,
        taskId: '',
        status: 'polling',
        requestedAt: 'x',
      }),
    ).toThrow();
  });

  it('strict：未知字段被拒绝', () => {
    expect(() =>
      TaskRequeryAcceptedSchema.parse({
        accepted: true,
        taskId: 'task-1',
        status: 'polling',
        requestedAt: 'x',
        extra: 1,
      }),
    ).toThrow();
  });
});

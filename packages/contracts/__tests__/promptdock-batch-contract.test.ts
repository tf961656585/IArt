import { describe, expect, it } from 'vitest';

import {
  BatchIntentSnapshotSchema,
  ExecutionSnapshotSchema,
  TaskProviderOverrideSchema,
} from '../src/provider-connection-contract';
import {
  PromptDockBatchSubmitRequestSchema,
  PromptDockBatchSubmitResponseSchema,
  PromptDockBatchTaskAcceptanceSchema,
} from '../src/promptdock-batch-contract';

/**
 * BatchIntentSnapshot / ExecutionSnapshot / GenerationBatch 受理契约测试。
 *
 * 口径：docs/model-assets/45 §5.1/§5.2、docs/runtime/固定任务数批次提交与投影语义.md、
 * docs/architecture/PromptDock生成主链.md。
 * - BatchIntentSnapshot 只承载用户意图（model_id/参数/媒体引用/固定任务成员），
 *   不含 Provider/连接/Base URL/Key/remote_model_id/ExecutionSnapshot。
 * - ExecutionSnapshot 在派发时冻结连接/适配器/凭证版本/租约，远端请求开始后不可改写。
 * - GenerationBatch 受理是原子的：一个 Batch + 一个快照 + 恰好 N 个任务身份。
 */

const ISO = '2026-08-20T00:00:00.000Z';

const validBatchIntent = (): unknown => ({
  batch_id: 'batch_1',
  model_id: 'seedance-2-0',
  model_version: 'cap-v3',
  prompt: 'hello',
  params: { size: 'auto' },
  media_refs: [
    {
      media_kind: 'image',
      source_kind: 'url',
      value: 'https://example.com/a.png',
      mime_type: 'image/png',
      filename: 'a.png',
    },
  ],
  task_count: 2,
  task_ids: ['task_a', 'task_b'],
  created_at: ISO,
});

describe('BatchIntentSnapshotSchema', () => {
  it('接受含固定任务成员的完整用户意图快照', () => {
    const parsed = BatchIntentSnapshotSchema.safeParse(validBatchIntent());
    expect(parsed.success).toBe(true);
  });

  it('task_ids 长度必须等于 task_count（固定任务成员）', () => {
    const bad = validBatchIntent() as Record<string, unknown>;
    bad.task_count = 3;
    const parsed = BatchIntentSnapshotSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes('task_count'))).toBe(true);
    }
  });

  it('拒绝携带 Provider 侧字段（base_url / remote_model_id / key / ExecutionSnapshot）', () => {
    const bad = validBatchIntent() as Record<string, unknown>;
    bad.base_url = 'https://api.example.com';
    bad.remote_model_id = 'remote-x';
    bad.api_key = 'secret';
    const parsed = BatchIntentSnapshotSchema.safeParse(bad);
    // .strict()：未声明字段必须被拒绝
    expect(parsed.success).toBe(false);
  });

  it('media_refs 必须对齐 TaskSubmitMediaInput 结构（拒绝任意对象泛化）', () => {
    const bad = validBatchIntent() as Record<string, unknown>;
    bad.media_refs = [{ foo: 'bar' }];
    const parsed = BatchIntentSnapshotSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it('model_version 接受能力投影版本字符串', () => {
    const parsed = BatchIntentSnapshotSchema.safeParse(validBatchIntent());
    expect(parsed.success).toBe(true);
  });
});

describe('ExecutionSnapshotSchema', () => {
  const validSnapshot = (): unknown => ({
    snapshot_id: 'snap_1',
    model_id: 'seedance-2-0',
    model_version: 'cap-v3',
    deployment_id: 'up_dep_1',
    connection_id: 'up_conn_1',
    connection_revision: 3,
    adapter_id: 'seedance-2-0-v1',
    adapter_version: '1.0.0',
    base_url: 'https://api.example.com',
    remote_model_id: 'remote-x',
    credential_ref: 'cred_1',
    credential_version: 2,
    credential_lease: {
      lease_state: 'active',
      connection_revision: 3,
      credential_version: 2,
    },
    resolved_endpoint: 'https://api.example.com/v1/images/generations',
    resolved_params: { n: 1 },
    created_at: ISO,
  });

  it('接受含 credential lease 的完整冻结快照', () => {
    const parsed = ExecutionSnapshotSchema.safeParse(validSnapshot());
    expect(parsed.success).toBe(true);
  });

  it('credential_lease 可选：released 状态可表达', () => {
    const base = validSnapshot() as Record<string, unknown>;
    base.credential_lease = { lease_state: 'released', connection_revision: 3, credential_version: 2 };
    expect(ExecutionSnapshotSchema.safeParse(base).success).toBe(true);
    const noLease = validSnapshot() as Record<string, unknown>;
    delete noLease.credential_lease;
    expect(ExecutionSnapshotSchema.safeParse(noLease).success).toBe(true);
  });

  it('拒绝明文 key / 非 https base_url', () => {
    const bad = validSnapshot() as Record<string, unknown>;
    bad.api_key = 'secret';
    expect(ExecutionSnapshotSchema.safeParse(bad).success).toBe(false);
    bad.api_key = undefined;
    bad.base_url = 'http://api.example.com';
    expect(ExecutionSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe('PromptDockBatchSubmitRequestSchema', () => {
  it('接受 model_id + prompt + arguments + 固定 task_count', () => {
    const parsed = PromptDockBatchSubmitRequestSchema.safeParse({
      model_id: 'seedance-2-0',
      prompt: 'hello',
      arguments: { size: 'auto' },
      task_count: 2,
      model_version: 'cap-v3',
      project_path: '/tmp/p.iartproj',
    });
    expect(parsed.success).toBe(true);
  });

  it('拒绝携带 Provider 侧字段（strict）', () => {
    const parsed = PromptDockBatchSubmitRequestSchema.safeParse({
      model_id: 'seedance-2-0',
      prompt: '',
      arguments: {},
      task_count: 1,
      model_version: 'cap-v3',
      project_path: '/tmp/p.iartproj',
      connection_id: 'up_conn_1',
    });
    expect(parsed.success).toBe(false);
  });

  it('task_count 边界 1..10', () => {
    const base = {
      model_id: 'seedance-2-0',
      prompt: '',
      arguments: {},
      model_version: 'cap-v3',
      project_path: '/tmp/p.iartproj',
    };
    expect(PromptDockBatchSubmitRequestSchema.safeParse({ ...base, task_count: 0 }).success).toBe(false);
    expect(PromptDockBatchSubmitRequestSchema.safeParse({ ...base, task_count: 1 }).success).toBe(true);
    expect(PromptDockBatchSubmitRequestSchema.safeParse({ ...base, task_count: 10 }).success).toBe(true);
    expect(PromptDockBatchSubmitRequestSchema.safeParse({ ...base, task_count: 11 }).success).toBe(false);
  });
});

describe('PromptDockBatchSubmitResponseSchema（原子受理）', () => {
  const acceptance = (taskId: string, taskIndex: number) => ({ task_id: taskId, task_index: taskIndex });
  const snapshot = validBatchIntent();

  it('接受 batch + 快照 + 恰好 N 个任务身份', () => {
    const parsed = PromptDockBatchSubmitResponseSchema.safeParse({
      batch_id: 'batch_1',
      intent_snapshot: snapshot,
      tasks: [acceptance('task_a', 0), acceptance('task_b', 1)],
    });
    expect(parsed.success).toBe(true);
  });

  it('受理任务数必须等于快照 task_count（原子受理，拒绝部分集合）', () => {
    const parsed = PromptDockBatchSubmitResponseSchema.safeParse({
      batch_id: 'batch_1',
      intent_snapshot: snapshot,
      tasks: [acceptance('task_a', 0)],
    });
    expect(parsed.success).toBe(false);
  });

  it('响应 batch_id 必须与快照 batch_id 一致', () => {
    const parsed = PromptDockBatchSubmitResponseSchema.safeParse({
      batch_id: 'batch_other',
      intent_snapshot: snapshot,
      tasks: [acceptance('task_a', 0), acceptance('task_b', 1)],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('TaskProviderOverrideSchema（@deprecated 兼容导出）', () => {
  it('仍可解析 { providerId, keyId }（backend until-x append 过渡消费）', () => {
    const parsed = TaskProviderOverrideSchema.safeParse({ providerId: 'up_1', keyId: 'key_1' });
    expect(parsed.success).toBe(true);
  });
});

describe('PromptDockBatchTaskAcceptanceSchema', () => {
  it('task_index 从 0 起且非负', () => {
    expect(PromptDockBatchTaskAcceptanceSchema.safeParse({ task_id: 't', task_index: 0 }).success).toBe(true);
    expect(PromptDockBatchTaskAcceptanceSchema.safeParse({ task_id: 't', task_index: -1 }).success).toBe(false);
  });
});

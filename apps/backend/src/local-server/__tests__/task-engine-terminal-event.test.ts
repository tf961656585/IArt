import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeTransactionResult } from "@iart/contracts";

import { setBackendIpcTestHandler } from "../backend-ipc-sender.cts";
import { patchTaskRecord, patchTaskRecordWithOutputs } from "../task-engine-state.cts";

// Backend→Main IPC 测试替身：拦截 sendRuntimeTransaction / sendTaskEvent（请求-响应类唯一发送路径），
// 记录消息并返回成功回执。sendTaskStateNotification（fire-and-forget）在无 process.send 时为 no-op。
type CapturedMessage = {
  type?: unknown;
  transactionId?: unknown;
  tasks?: Array<{
    taskId?: unknown;
    startedAt?: unknown;
    finishedAt?: unknown;
    progressPhase?: unknown;
  }>;
  event?: { taskId?: unknown; eventType?: unknown; payload?: unknown };
};

const makeSuccessResult = (transactionId: string): RuntimeTransactionResult => ({
  type: "runtime:transaction-result",
  transactionId,
  success: true,
});

const buildRecord = (taskId: string, projectPath: string) => ({
  id: taskId,
  status: "generating",
  createdAt: 1000,
  updatedAt: 2000,
  startedAt: 1500,
  projectPath,
  metadata: { taskId, projectPath },
});

const buildRecordWithProgress = (taskId: string, projectPath: string) => ({
  ...buildRecord(taskId, projectPath),
  progress: { phase: "requesting", percent: 37 },
});

const findTransactionRow = (captured: CapturedMessage[], taskId: string) =>
  captured.find(
    (message) =>
      message.type === "runtime:execute-transaction" &&
      message.tasks?.some((row) => row.taskId === taskId),
  )?.tasks?.find((row) => row.taskId === taskId);

void test("带产物成功终态：补写 task.succeeded 事件并投影 startedAt/finishedAt", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-terminal-ev-"));
  const captured: CapturedMessage[] = [];
  setBackendIpcTestHandler(async (message) => {
    captured.push(message as CapturedMessage);
    return makeSuccessResult(message.transactionId);
  });
  try {
    const taskId = "task-ev-success";
    const persisted = (await patchTaskRecordWithOutputs(
      buildRecord(taskId, tempDir),
      { status: "succeeded", finishedAt: 9999 },
      {
        taskOutputs: [
          {
            outputId: "out-1",
            taskId,
            mediaType: "image",
            assetId: "asset-ev-1",
            sortOrder: 0,
          },
        ],
        mediaAssets: [],
      },
    )) as { startedAt?: unknown; finishedAt?: unknown; status?: unknown };

    // 内存任务记录保真：执行真实开始/结束时刻不得被归一化丢弃（受理时刻 createdAt 不互替）。
    assert.equal(persisted.startedAt, 1500, "in-memory record should keep startedAt");
    assert.equal(persisted.finishedAt, 9999, "in-memory record should keep finishedAt");
    assert.equal(persisted.status, "succeeded");

    // 落库行投影：runtime transaction 的 tasks 行携带 startedAt/finishedAt（v19 新列写路径）。
    const transaction = captured.find(
      (message) => message.type === "runtime:execute-transaction",
    );
    assert.ok(transaction, "runtime transaction should be sent");
    const row = transaction.tasks?.[0];
    assert.ok(row, "transaction should carry one task row");
    assert.equal(row.startedAt, 1500, "task row should project startedAt");
    assert.equal(row.finishedAt, 9999, "task row should project finishedAt");

    // task_events 轻量时序：带产物成功路径与无产物路径同口径补写 task.succeeded。
    const succeededEvent = captured.find(
      (message) =>
        message.type === "runtime:write-task-event" &&
        message.event?.eventType === "task.succeeded",
    );
    assert.ok(succeededEvent, "task.succeeded event should be written to task_events");
    assert.equal(succeededEvent.event?.taskId, taskId);
    assert.deepEqual(succeededEvent.event?.payload, { status: "succeeded", error: null });
  } finally {
    setBackendIpcTestHandler(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test("带产物失败终态：补写 task.failed 事件，payload 与无产物路径同形", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-terminal-ev-"));
  const captured: CapturedMessage[] = [];
  setBackendIpcTestHandler(async (message) => {
    captured.push(message as CapturedMessage);
    return makeSuccessResult(message.transactionId);
  });
  try {
    const taskId = "task-ev-failed";
    await patchTaskRecordWithOutputs(
      buildRecord(taskId, tempDir),
      {
        status: "failed",
        finishedAt: 9999,
        error: { code: "runtime_failed", message: "远端失败" },
      },
      {
        taskOutputs: [],
        mediaAssets: [],
      },
    );

    const failedEvent = captured.find(
      (message) =>
        message.type === "runtime:write-task-event" &&
        message.event?.eventType === "task.failed",
    );
    assert.ok(failedEvent, "task.failed event should be written to task_events");
    assert.equal(failedEvent.event?.taskId, taskId);
    const payload = failedEvent.event?.payload as
      | { status?: unknown; error?: { code?: unknown; message?: unknown } }
      | undefined;
    assert.equal(payload?.status, "failed");
    assert.equal(payload?.error?.code, "runtime_failed");
    assert.equal(payload?.error?.message, "远端失败");
  } finally {
    setBackendIpcTestHandler(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test("失败终态：progress.phase 归零，落库行 progressPhase 为 null", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-terminal-phase-"));
  const captured: CapturedMessage[] = [];
  setBackendIpcTestHandler(async (message) => {
    captured.push(message as CapturedMessage);
    return makeSuccessResult(message.transactionId);
  });
  try {
    const taskId = "task-phase-failed";
    const persisted = (await patchTaskRecord(buildRecordWithProgress(taskId, tempDir), {
      status: "failed",
      finishedAt: 9999,
      error: { code: "task_execution_failed", message: "fetch failed" },
    } as Parameters<typeof patchTaskRecord>[1])) as { progress?: { phase?: unknown; percent?: unknown } };

    assert.equal(persisted.progress?.phase, null, "失败任务内存记录不得残留 progress.phase");
    assert.equal(persisted.progress?.percent, 37, "归一只清 phase，其余 progress 字段保留");

    const row = findTransactionRow(captured, taskId);
    assert.ok(row, "失败终态应写出任务行");
    assert.equal(row.progressPhase, null, "失败任务落库行 progressPhase 必须为 null");
  } finally {
    setBackendIpcTestHandler(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test("取消终态：progress.phase 归零，落库行 progressPhase 为 null", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-terminal-phase-"));
  const captured: CapturedMessage[] = [];
  setBackendIpcTestHandler(async (message) => {
    captured.push(message as CapturedMessage);
    return makeSuccessResult(message.transactionId);
  });
  try {
    const taskId = "task-phase-cancelled";
    const persisted = (await patchTaskRecord(buildRecordWithProgress(taskId, tempDir), {
      status: "cancelled",
      finishedAt: 9999,
    } as Parameters<typeof patchTaskRecord>[1])) as { progress?: { phase?: unknown } };

    assert.equal(persisted.progress?.phase, null, "取消任务内存记录不得残留 progress.phase");

    const row = findTransactionRow(captured, taskId);
    assert.ok(row, "取消终态应写出任务行");
    assert.equal(row.progressPhase, null, "取消任务落库行 progressPhase 必须为 null");
  } finally {
    setBackendIpcTestHandler(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

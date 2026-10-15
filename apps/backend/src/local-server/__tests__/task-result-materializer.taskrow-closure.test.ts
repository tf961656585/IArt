import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeTransactionResult } from "@iart/contracts";

import { setBackendIpcTestHandler } from "../backend-ipc-sender.cts";
import { createTaskRecordFromFormalSpec } from "../task-store.cts";
import { patchTaskRecord } from "../task-engine-state.cts";
import { executeTaskResultMaterialization } from "../task-result-materializer.cts";
import type { PlainObject } from "../task-engine-shared.cts";

// Backend→Main IPC 测试替身：只挡 IPC 传输层（真实实现全链路参与）。
type CapturedMessage = {
  type?: unknown;
  tasks?: Array<Record<string, unknown>>;
  taskOutputs?: Array<Record<string, unknown>>;
  mediaAssets?: Array<Record<string, unknown>>;
  event?: { eventType?: unknown };
};

// 1x1 PNG：真实可解码内联媒体；data: URL 走物化链本地落盘分支，无网络参与。
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

void test(
  "物化链行投影闭环：受理记录 → 物化入口 → 终态 patch → 行构建，createdAt/request/startedAt/finishedAt 不被剥字段降级",
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-mat-row-"));
    const projectDir = path.join(tempDir, "demo.iartproj");
    fs.mkdirSync(projectDir, { recursive: true });
    // 合法项目文件夹：物化链入口校验 isValidProjectFolder（sqlite 或 manifest 存在）。
    fs.writeFileSync(path.join(projectDir, "project.sqlite"), "");

    // 真实受理：createTaskRecordFromFormalSpec 是 formal-task / generation-batch 共用的记录工厂。
    const accepted = createTaskRecordFromFormalSpec({
      request: {
        url: "https://provider.example/v1/generate",
        method: "POST",
      },
      metadata: {
        projectPath: projectDir,
        modelId: "model-mat-closure",
        taskExecutionPlan: {
          result_output_mapping: {
            response_mode: "structured_payload",
            output_mapping_rules: [
              {
                target: "output.image_url",
                source: { kind: "response", path: "image_url" },
              },
            ],
          },
        },
      },
    }) as { taskId: string; createdAt: number };
    const acceptedCreatedAt = accepted.createdAt;

    // 真实引擎 patch 链（同一 store 合并机器）：提交准备打 startedAt → 轮询成功回填 response。
    const startedPatch = (await patchTaskRecord(accepted, {
      status: "generating",
      startedAt: Date.now(),
    } as PlainObject)) as { startedAt?: unknown };
    const startedAt = startedPatch.startedAt;
    assert.equal(typeof startedAt, "number", "store chain should keep startedAt");

    const withResponse = await patchTaskRecord(startedPatch, {
      status: "generating",
      response: { body: { image_url: TINY_PNG_DATA_URL }, bodyType: "json" },
    } as PlainObject);

    // 保证「物化时刻 Date.now()」与受理时刻可区分（红态 createdAt 回落才必然暴露）。
    await new Promise((resolve) => setTimeout(resolve, 20));

    const captured: CapturedMessage[] = [];
    setBackendIpcTestHandler(async (message) => {
      captured.push(message as CapturedMessage);
      return {
        type: "runtime:transaction-result",
        transactionId: message.transactionId,
        success: true,
      } satisfies RuntimeTransactionResult;
    });
    try {
      const localOutputs = (await executeTaskResultMaterialization(
        withResponse,
        new AbortController(),
      )) as Array<{ mediaType?: unknown; assetId?: unknown }>;
      assert.equal(localOutputs.length, 1);
      assert.equal(localOutputs[0]?.mediaType, "image");

      // 行构建输入 = 终态 patch 后的真实落库行（buildRuntimeTaskRowForTransaction 产物）。
      // 物化链会先写 downloading 性行（patchTaskRecord 的 awaitRuntimeTaskRowWrite），
      // 终态事务（携带 outputs/mediaAssets）是最后一个 execute-transaction 消息。
      const transactions = captured.filter(
        (message) => message.type === "runtime:execute-transaction",
      );
      const transaction = transactions.at(-1);
      assert.ok(transaction, "runtime transaction should be sent");
      assert.ok(
        (transaction.taskOutputs?.length ?? 0) > 0,
        "terminal transaction should carry task outputs",
      );
      const row = transaction.tasks?.[0];
      assert.ok(row, "transaction should carry one task row");
      assert.equal(row.status, "succeeded");
      assert.equal(row.taskId, accepted.taskId);

      // 受理时刻保留：整行 INSERT OR REPLACE 不得把 createdAt 回落成物化时刻。
      assert.equal(row.createdAt, acceptedCreatedAt);
      // 请求摘要保留：不得被剥字段洗成 null。
      assert.equal(typeof row.requestJson, "string", "requestJson should survive materialization");
      assert.ok(
        String(row.requestJson).includes("v1/generate"),
        "requestJson should keep the accepted request url",
      );
      // 执行真实时刻保留：startedAt 不被剥字段重置为 null，finishedAt 为终态打点。
      assert.equal(row.startedAt, startedAt);
      assert.equal(typeof row.finishedAt, "number");
      assert.ok(
        (row.finishedAt as number) >= (startedAt as number),
        "finishedAt should be at or after startedAt",
      );

      // 产物行与资产随事务落库。
      assert.equal(transaction.taskOutputs?.length, 1);
      assert.equal(transaction.mediaAssets?.length, 1);
      // 数据库内轻量时序（链级双检）：带产物成功路径补写 task.succeeded。
      assert.ok(
        captured.some(
          (message) =>
            message.type === "runtime:write-task-event" &&
            message.event?.eventType === "task.succeeded",
        ),
        "task.succeeded event should be written through the materialization chain",
      );
    } finally {
      setBackendIpcTestHandler(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

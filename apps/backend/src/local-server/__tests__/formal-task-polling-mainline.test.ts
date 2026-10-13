import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeFormalTaskExecutionPlan,
} from "../business-actions/formal-task.cts";
import { createTaskRecordFromFormalSpec } from "../task-store.cts";

const buildPollingStrategy = () => ({
  request: {
    url_template: "/v1/poll/{id}",
    method: "GET",
  },
  polling: {
    intervalMs: 1500,
    maxAttempts: 20,
    successPath: "/data/result/url",
    statusFieldPaths: ["/data/status"],
    successStatuses: ["succeeded"],
  },
});

void test("normalizeFormalTaskExecutionPlan: formal submit 不再重复投影 polling 平面", () => {
  const normalized = normalizeFormalTaskExecutionPlan({
    model_id: "formal-polling-model",
    submit_request: {
      url: "https://provider.example/v1/submit",
      method: "POST",
      body: {
        prompt: "hello",
      },
    },
    polling_strategy: buildPollingStrategy(),
    result_rule: {
      mode: "async",
      submit_response_id_path: "/data/id",
    },
    metadata: {
      modelId: "formal-polling-model",
    },
  });

  assert.equal(normalized.ok, true);
  if (!normalized.ok) {
    throw new Error("Expected normalized execution plan");
  }
  assert.equal(normalized.value.polling, null);
  assert.deepEqual(
    (normalized.value.metadata.taskExecutionPlan as {
      polling_strategy?: unknown;
    }).polling_strategy,
    buildPollingStrategy(),
  );
});

void test("createTaskRecordFromFormalSpec: 从 formal plan 的 polling_strategy.polling 派生运行时 polling record", () => {
  const record = createTaskRecordFromFormalSpec({
    request: {
      url: "https://gateway.example.com/v1/submit",
      method: "POST",
      body: {
        prompt: "hello",
      },
    },
    polling: {
      intervalMs: 9999,
      maxAttempts: 1,
      successPath: "/legacy/should-not-win",
    },
    metadata: {
      modelId: "formal-polling-model",
      taskExecutionPlan: {
        polling_strategy: buildPollingStrategy(),
        result_rule: {
          mode: "async",
          submit_response_id_path: "/data/id",
        },
      },
    },
  });

  assert.deepEqual(record?.polling, {
    intervalMs: 1500,
    maxAttempts: 20,
    maxConsecutiveFailures: 3,
    successPath: "/data/result/url",
    successFieldPaths: undefined,
    successStatuses: ["succeeded"],
    progressFieldPath: undefined,
    statusFieldPaths: ["/data/status"],
    failureStatuses: undefined,
    failureCodePaths: undefined,
    failureMessagePaths: undefined,
  });
});

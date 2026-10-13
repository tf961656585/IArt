import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPollingRequestFromPlan,
  detectTaskFailure,
  readValueByPath,
} from "../task-engine-polling-utils.cts";

const buildRecord = (taskExecutionPlan: object, metadata: object = {}) => ({
  metadata: {
    ...metadata,
    taskExecutionPlan,
  },
});

const asyncPlan = {
  polling_strategy: {
    request: {
      url_template: "/kling/v1/videos/image2video/{id}",
      method: "GET",
    },
    polling: {
      intervalMs: 1000,
      maxAttempts: 20,
      successPath: "/data/task_result/videos/0/url",
    },
  },
  result_rule: {
    mode: "async",
    submit_response_id_path: "/data/task_id",
  },
};

void test("buildPollingRequestFromPlan: 按 result_rule.submit_response_id_path 解析 /data/task_id 并构造轮询请求", () => {
  const result = buildPollingRequestFromPlan(buildRecord(asyncPlan), {
    code: 0,
    data: { task_id: "remote-123", task_status: "submitted" },
  });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected polling ready");
  assert.equal(result.remoteRequestId, "remote-123");
  assert.equal(result.submitResponseIdPath, "/data/task_id");
  assert.equal(result.request.url, "/kling/v1/videos/image2video/remote-123");
  assert.equal(result.polling.successPath, "/data/task_result/videos/0/url");
});

void test("buildPollingRequestFromPlan: 有 polling_strategy 但 result_rule 路径未命中时返回 blocked，不回退猜测 /id", () => {
  const result = buildPollingRequestFromPlan(buildRecord(asyncPlan), {
    id: "should-not-be-used",
    code: 0,
    data: { task_status: "submitted" },
  });

  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") throw new Error("Expected polling blocked");
  assert.equal(result.reason, "remote_request_id_missing");
  assert.equal(result.submitResponseIdPath, "/data/task_id");
});

void test("buildPollingRequestFromPlan: 已有 metadata.remoteRequestId 时优先用于恢复轮询", () => {
  const result = buildPollingRequestFromPlan(
    buildRecord(asyncPlan, { remoteRequestId: "cached-456" }),
    { code: 0, data: { task_status: "submitted" } },
  );

  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected polling ready");
  assert.equal(result.remoteRequestId, "cached-456");
  assert.equal(result.request.url, "/kling/v1/videos/image2video/cached-456");
});

void test("readValueByPath: 支持轮询 successPath 中的数组下标", () => {
  const value = readValueByPath(
    {
      data: {
        task_result: {
          videos: [{ url: "https://cdn.example.com/video.mp4" }],
        },
      },
    },
    "/data/task_result/videos/0/url",
  );

  assert.equal(value, "https://cdn.example.com/video.mp4");
});

void test("detectTaskFailure: 状态只在响应头（x-task-status: FAILED）时判定失败", () => {
  const headers = new Headers({ "x-task-status": "FAILED" });
  const result = detectTaskFailure(
    { outputs: [] },
    { statusFieldPaths: ["status", "state", "x-task-status"] } as never,
    headers,
  );
  assert.equal(result.failed, true);
  assert.equal(result.status, "FAILED");
});

void test("detectTaskFailure: body 有 status 时优先于响应头", () => {
  const headers = new Headers({ "x-task-status": "FAILED" });
  const result = detectTaskFailure(
    { status: "IN_PROGRESS" },
    { statusFieldPaths: ["status", "x-task-status"] } as never,
    headers,
  );
  assert.equal(result.failed, false);
  assert.equal(result.status, "IN_PROGRESS");
});

void test("detectTaskFailure: 不传响应头时行为不变（仅读 body）", () => {
  const result = detectTaskFailure(
    { status: "failed" },
    { statusFieldPaths: ["status", "x-task-status"] } as never,
  );
  assert.equal(result.failed, true);
});

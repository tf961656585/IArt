import assert from "node:assert/strict";
import test from "node:test";

import { resolvePollingSuccessValue } from "../task-engine-polling.cts";

// 视频类模型 polling 配置样本（本用例用预置 payload，不加载模型包）：
// successFieldPaths 指向结果产出物（视频 URL），
// successStatuses 指向状态枚举（done），
// statusFieldPaths 指向状态字段。
// 成功判定的正确语义：证据非空 AND 状态命中。
const asyncVideoPolling = {
  successFieldPaths: ["video.url"],
  successStatuses: ["done"],
  statusFieldPaths: ["status"],
};

void test("resolvePollingSuccessValue: 视频任务场景（status=done 且 video.url 存在）判定成功", () => {
  const body = {
    model: "veo-3.1-generate-preview",
    video: { url: "https://cdn.example.com/generated-video.mp4", duration: 1 },
    status: "done",
    progress: 100,
  };
  const result = resolvePollingSuccessValue(asyncVideoPolling as never, body);
  assert.equal(result, "https://cdn.example.com/generated-video.mp4");
});

void test("resolvePollingSuccessValue: 证据存在但 status 非 done 时不判定成功（继续轮询）", () => {
  const body = {
    video: { url: "https://cdn.example.com/draft-video.mp4" },
    status: "generating",
    progress: 50,
  };
  const result = resolvePollingSuccessValue(asyncVideoPolling as never, body);
  assert.equal(result, undefined);
});

void test("resolvePollingSuccessValue: status=done 但证据缺失时不判定成功", () => {
  const body = { status: "done", progress: 100 };
  const result = resolvePollingSuccessValue(asyncVideoPolling as never, body);
  assert.equal(result, undefined);
});

void test("resolvePollingSuccessValue: status 与证据都缺失时不判定成功", () => {
  const body = { status: "queued", progress: 0 };
  const result = resolvePollingSuccessValue(asyncVideoPolling as never, body);
  assert.equal(result, undefined);
});

// successStatuses 为空（无状态枚举）的 polling 配置：只看证据。
// 修复后不得破坏这类既有行为。
void test("resolvePollingSuccessValue: successStatuses 为空时仅靠证据非空判定成功（无状态枚举配置兼容）", () => {
  const polling = {
    successFieldPaths: ["video_url"],
    successStatuses: [] as string[],
    statusFieldPaths: ["status"],
  };
  const body = { video_url: "https://cdn.example.com/v.mp4", status: "anything" };
  const result = resolvePollingSuccessValue(polling as never, body);
  assert.equal(result, "https://cdn.example.com/v.mp4");
});

// 旧字段 successPath（非数组）也应保持工作。
void test("resolvePollingSuccessValue: successPath 单路径 + successStatuses 组合", () => {
  const polling = {
    successPath: "data.result.url",
    successStatuses: ["succeeded"],
    statusFieldPaths: ["data.status"],
  };
  const body = {
    data: {
      result: { url: "https://example.com/result.mp4" },
      status: "succeeded",
    },
  };
  const result = resolvePollingSuccessValue(polling as never, body);
  assert.equal(result, "https://example.com/result.mp4");
});

void test("resolvePollingSuccessValue: successPath 单路径 + successStatuses 但 status 不匹配时不判定成功", () => {
  const polling = {
    successPath: "data.result.url",
    successStatuses: ["succeeded"],
    statusFieldPaths: ["data.status"],
  };
  const body = {
    data: {
      result: { url: "https://example.com/result.mp4" },
      status: "processing",
    },
  };
  const result = resolvePollingSuccessValue(polling as never, body);
  assert.equal(result, undefined);
});

void test("resolvePollingSuccessValue: status 匹配大小写不敏感", () => {
  const body = { video: { url: "https://example.com/v.mp4" }, status: "Done" };
  const result = resolvePollingSuccessValue(asyncVideoPolling as never, body);
  assert.equal(result, "https://example.com/v.mp4");
});

// 3p-images 结果端点真实场景：
// 完成态 body 无 status 字段，状态只在 x-task-status 响应头；
// 证据 /outputs/0/image/presignedUrl 在 body。
const headerStatusPolling = {
  successFieldPaths: ["/outputs/0/image/presignedUrl"],
  successStatuses: ["COMPLETED", "SUCCEEDED"],
  statusFieldPaths: ["status", "state", "x-task-status"],
};

const completedBody = {
  modelId: "gpt-image",
  outputs: [{ seed: 1009034623, image: { id: "img-1", presignedUrl: "https://storage.example.com/images/img-1" } }],
  contentType: "image/png",
};

void test("resolvePollingSuccessValue: 完成态——body 无 status、x-task-status 响应头 COMPLETED 时判定成功", () => {
  const headers = new Headers({ "x-task-status": "COMPLETED" });
  const result = resolvePollingSuccessValue(headerStatusPolling as never, completedBody, headers);
  assert.equal(result, "https://storage.example.com/images/img-1");
});

void test("resolvePollingSuccessValue: 进行中——x-task-status 响应头 IN_PROGRESS 时不判定成功", () => {
  const headers = new Headers({ "x-task-status": "IN_PROGRESS" });
  const result = resolvePollingSuccessValue(headerStatusPolling as never, completedBody, headers);
  assert.equal(result, undefined);
});

void test("resolvePollingSuccessValue: body 无 status 且未传响应头时不判定成功（保持与关系语义）", () => {
  const result = resolvePollingSuccessValue(headerStatusPolling as never, completedBody);
  assert.equal(result, undefined);
});

// 无产物路径的异步接口（/v1/videos 形态）：完成态响应本就没有产物地址，
// 只要有成功状态约束且状态命中，就应判定成功——返回命中的状态值作为成功证据。
const statusOnlyPolling = {
  successStatuses: ["completed"],
  statusFieldPaths: ["status"],
};

void test("resolvePollingSuccessValue: 只有成功状态、无产物路径时状态命中即成功并返回命中状态", () => {
  const result = resolvePollingSuccessValue(statusOnlyPolling as never, {
    id: "video-1",
    status: "completed",
  });
  assert.equal(result, "completed");
});

void test("resolvePollingSuccessValue: 只有成功状态、无产物路径时状态未命中仍不判定成功", () => {
  const result = resolvePollingSuccessValue(statusOnlyPolling as never, {
    id: "video-1",
    status: "processing",
  });
  assert.equal(result, undefined);
});

void test("resolvePollingSuccessValue: 无产物路径且状态在响应头时返回响应头状态值", () => {
  const polling = {
    successStatuses: ["COMPLETED"],
    statusFieldPaths: ["x-task-status"],
  };
  const headers = new Headers({ "x-task-status": "COMPLETED" });
  const result = resolvePollingSuccessValue(
    polling as never,
    { id: "video-1" },
    headers,
  );
  assert.equal(result, "COMPLETED");
});

// 回归：声明了产物路径的既有族行为不变——返回值仍是产物值，不是状态值。
void test("resolvePollingSuccessValue: 有产物路径时行为不变（返回产物值而非状态）", () => {
  const result = resolvePollingSuccessValue(
    asyncVideoPolling as never,
    {
      video: { url: "https://cdn.example.com/regression.mp4" },
      status: "done",
    },
  );
  assert.equal(result, "https://cdn.example.com/regression.mp4");
});

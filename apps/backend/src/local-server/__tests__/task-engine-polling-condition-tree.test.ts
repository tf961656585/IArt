import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";

import {
  clearCacheForTest as clearConnectionCache,
  createConnection,
} from "../provider-connection/connection-store.cts";
import {
  executePollingTask,
  shouldRefreshUnseenConditionMessage,
} from "../task-engine-polling.cts";

/** 用户可见提示定稿文案（逐字；改动需同步任务监视器文案评审）。 */
const UNSEEN_CONDITION_MESSAGE =
  "长时间没有匹配到成功判定，请检查这个模型引用的接口配方。";

/**
 * 轮询判定消费声明式条件树（result_rule.success_condition / failure_condition）的主链测试。
 *
 * 走真实 `executePollingTask`：真实条件树求值 + 真实响应解析 + 扁平策略，只挡掉网络
 * （globalThis.fetch 返回固定样本阶段）与存储/IPC（record 不带 projectPath，
 * patchTaskRecord 不落库、不发 IPC）。
 */

type PollingScenario = {
  id: string;
  maxAttempts?: number;
  polling?: Record<string, unknown>;
  resultRule?: Record<string, unknown>;
};

type StubbedResponse = {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
};

type PollingResult = {
  status?: unknown;
  response?: unknown;
  progress?: { attempt?: unknown; message?: unknown; phase?: unknown } | null;
  error?: { code?: unknown; message?: unknown; userMessage?: unknown } | null;
};

const asResult = (value: unknown): PollingResult =>
  value !== null && typeof value === "object"
    ? (value as PollingResult)
    : {};

const buildRecord = (scenario: PollingScenario) => ({
  id: scenario.id,
  type: "http",
  status: "submitting",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  request: {
    url: `https://provider.example/v1/poll/${scenario.id}`,
    method: "GET",
    headers: {},
  },
  polling: {
    intervalMs: 1,
    maxAttempts: scenario.maxAttempts ?? 3,
    ...scenario.polling,
  },
  metadata: {
    taskExecutionPlan: {
      result_rule: {
        mode: "async",
        submit_response_id_path: "/id",
        ...scenario.resultRule,
      },
    },
  },
});

const stubFetch = (
  t: TestContext,
  responses: StubbedResponse[],
): (() => number) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    const index = Math.min(calls, responses.length - 1);
    const spec = responses[index];
    calls += 1;
    if (!spec) throw new Error("missing stubbed response");
    return new Response(JSON.stringify(spec.body), {
      status: spec.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...spec.headers,
      },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return () => calls;
};

const runPolling = async (scenario: PollingScenario): Promise<PollingResult> =>
  asResult(await executePollingTask(buildRecord(scenario), new AbortController()));

let storageRoot = "";
let previousStorageRoot: string | undefined;

before(() => {
  previousStorageRoot = process.env["IART_STORAGE_ROOT"];
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polling-condition-tree-"));
  process.env["IART_STORAGE_ROOT"] = storageRoot;
  clearConnectionCache();
  createConnection({
    display_name: "polling-condition-tree",
    base_url: "https://provider.example",
  });
});

after(() => {
  clearConnectionCache();
  if (previousStorageRoot === undefined) delete process.env["IART_STORAGE_ROOT"];
  else process.env["IART_STORAGE_ROOT"] = previousStorageRoot;
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

// 形态 1：状态词
void test("条件树形态一·状态词：success_condition eq status=completed 命中即成功", async (t) => {
  stubFetch(t, [{ body: { status: "COMPLETED", progress: 100 } }]);
  const result = await runPolling({
    id: "tree-status-word",
    resultRule: { success_condition: { op: "eq", path: "status", value: "completed" } },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.progress?.attempt, 1);
});

// 形态 2：数字枚举
void test("条件树形态二·数字枚举：success_condition in code=[0,200] 命中即成功", async (t) => {
  stubFetch(t, [{ body: { code: 200, payload: { ok: true } } }]);
  const result = await runPolling({
    id: "tree-numeric-enum",
    resultRule: { success_condition: { op: "in", path: "code", value: [0, 200] } },
  });
  assert.equal(result.status, "succeeded");
});

// 形态 3：布尔完成位
void test("条件树形态三·布尔完成位：success_condition eq done=true 命中即成功", async (t) => {
  stubFetch(t, [{ body: { done: true } }, { body: { done: false } }]);
  const result = await runPolling({
    id: "tree-boolean-flag",
    resultRule: { success_condition: { op: "eq", path: "done", value: true } },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.progress?.attempt, 1);
});

// 形态 4：产物出现即成功
void test("条件树形态四·产物出现即成功：success_condition not_empty data.video_url", async (t) => {
  stubFetch(t, [
    { body: { data: { video_url: "https://cdn.example.com/video.mp4" } } },
  ]);
  const result = await runPolling({
    id: "tree-artifact-present",
    resultRule: { success_condition: { op: "not_empty", path: "data.video_url" } },
  });
  assert.equal(result.status, "succeeded");
});

// 形态 5：数值阈值
void test("条件树形态五·数值阈值：success_condition gte progress=100", async (t) => {
  stubFetch(t, [{ body: { progress: 99 } }, { body: { progress: 100 } }]);
  const result = await runPolling({
    id: "tree-numeric-threshold",
    resultRule: { success_condition: { op: "gte", path: "progress", value: 100 } },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.progress?.attempt, 2);
});

// 形态 6：两级组合条件（all + any）
void test("条件树形态六·两级组合条件：all(state=done, any(url,b64))", async (t) => {
  stubFetch(t, [
    { body: { state: "done", result: { url: "https://cdn.example.com/a.mp4" } } },
  ]);
  const result = await runPolling({
    id: "tree-composed",
    resultRule: {
      success_condition: {
        op: "all",
        children: [
          { op: "eq", path: "state", value: "done" },
          {
            op: "any",
            children: [
              { op: "not_empty", path: "result.url" },
              { op: "not_empty", path: "result.b64" },
            ],
          },
        ],
      },
    },
  });
  assert.equal(result.status, "succeeded");
});

// 判定顺序：failure_condition 先于 success_condition；失败命中即收口。
void test("failure_condition 命中优先于 success_condition 与扁平成功策略", async (t) => {
  stubFetch(t, [
    {
      body: {
        status: "error",
        error: { code: "remote_rejected", message: "rejected" },
        result: { url: "https://cdn.example.com/should-not-win.mp4" },
      },
    },
  ]);
  const result = await runPolling({
    id: "tree-failure-first",
    polling: {
      successPath: "/result/url",
      successStatuses: ["error"],
      failureStatuses: ["error"],
      failureCodePaths: ["error.code"],
      failureMessagePaths: ["error.message"],
    },
    resultRule: {
      failure_condition: { op: "not_empty", path: "error.code" },
      success_condition: { op: "eq", path: "status", value: "done" },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.message, "rejected");
  assert.equal(result.error?.code, "remote_rejected");
});

// 配方声明的失败原因优先于扁平失败 message 与通用兜底文案。
void test("failure_condition 命中时任务失败提示使用配方声明的失败原因", async (t) => {
  stubFetch(t, [{ body: { status: "FAILED" } }]);
  const result = await runPolling({
    id: "tree-failure-reason",
    resultRule: {
      failure_condition: { op: "eq", path: "status", value: "failed" },
      failure_reason: "服务商判定这条请求不合规，请修改提示词后重试。",
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.message, "服务商判定这条请求不合规，请修改提示词后重试。");
  assert.equal(result.error?.userMessage, "服务商判定这条请求不合规，请修改提示词后重试。");
});

// 原因为空：回落到既有扁平失败 message。
void test("配方未声明失败原因时回落到扁平失败 message", async (t) => {
  stubFetch(t, [{ body: { status: "FAILED", error: { message: "upstream rejected" } } }]);
  const result = await runPolling({
    id: "tree-failure-no-reason-flat",
    polling: { failureMessagePaths: ["error.message"] },
    resultRule: {
      failure_condition: { op: "eq", path: "status", value: "failed" },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.message, "upstream rejected");
});

// 原因为空且扁平策略也没有给出 message：用现存通用文案（不新增兜底）。
void test("配方未声明失败原因且无扁平 message 时用既有通用文案", async (t) => {
  stubFetch(t, [{ body: { state: "bad" } }]);
  const result = await runPolling({
    id: "tree-failure-no-reason-generic",
    resultRule: {
      failure_condition: { op: "eq", path: "state", value: "bad" },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.message, "Task failed");
});

// 状态在响应头：条件树同样走 body 优先、响应头回落。
void test("条件树状态词可回落响应头（x-task-status）", async (t) => {
  stubFetch(t, [
    {
      body: { outputs: [{ url: "https://cdn.example.com/a.png" }] },
      headers: { "x-task-status": "COMPLETED" },
    },
  ]);
  const result = await runPolling({
    id: "tree-header-status",
    resultRule: {
      success_condition: { op: "in", path: "x-task-status", value: ["COMPLETED", "SUCCEEDED"] },
    },
  });
  assert.equal(result.status, "succeeded");
});

// 关键回归：存在 success_condition 但未命中时不得回落到扁平策略。
// 扁平策略（successPath 有值 + successStatuses=running）在第一轮就能判定成功；
// 若回落，第一轮即 succeeded，attempt 恒为 1。
void test("有 success_condition 未命中时不回落扁平成功策略（必须继续轮询）", async (t) => {
  const calls = stubFetch(t, [
    {
      body: {
        status: "running",
        result: { url: "https://cdn.example.com/early.mp4" },
      },
    },
    {
      body: {
        status: "done",
        result: { url: "https://cdn.example.com/final.mp4" },
      },
    },
  ]);
  const result = await runPolling({
    id: "tree-no-flat-fallback",
    polling: {
      successPath: "/result/url",
      successStatuses: ["running"],
    },
    resultRule: {
      success_condition: { op: "eq", path: "status", value: "done" },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.progress?.attempt, 2, "第一轮条件树未命中必须继续轮询");
  assert.equal(calls(), 2, "第一轮不得因扁平策略命中而提前收口");
});

// 兼容：不存在任何条件树时，扁平策略行为零变化。
void test("无条件树时完全走扁平策略（行为与改造前一致）", async (t) => {
  const calls = stubFetch(t, [
    {
      body: {
        data: {
          task_status: "succeed",
          task_result: { videos: [{ url: "https://cdn.example.com/v.mp4" }] },
        },
      },
    },
  ]);
  const result = await runPolling({
    id: "flat-only",
    polling: {
      successPath: "/data/task_result/videos/0/url",
      successStatuses: ["succeed"],
      statusFieldPaths: ["data.task_status"],
      failureStatuses: ["failed"],
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.progress?.attempt, 1);
  assert.equal(calls(), 1);
});

// 扁平策略无产物路径（/v1/videos 形态）：状态命中即成功，不再耗完轮询预算。
void test("扁平策略无产物路径时状态命中即成功（/v1/videos 形态）", async (t) => {
  const calls = stubFetch(t, [
    { body: { id: "video-1", status: "completed" } },
  ]);
  const result = await runPolling({
    id: "flat-status-only",
    polling: {
      successStatuses: ["completed"],
      statusFieldPaths: ["status"],
      failureStatuses: ["failed"],
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.progress?.attempt, 1);
  assert.equal(calls(), 1);
});

// 条件树在最大尝试次数内始终未命中：收口为轮询超时失败，且从未消费扁平策略。
void test("条件树始终未命中时按最大尝试次数收口失败（不回落扁平策略）", async (t) => {
  const calls = stubFetch(t, [
    { body: { status: "running", result: { url: "https://cdn.example.com/a.mp4" } } },
  ]);
  const result = await runPolling({
    id: "tree-never-matched",
    maxAttempts: 2,
    polling: {
      successPath: "/result/url",
      successStatuses: ["running"],
    },
    resultRule: {
      success_condition: { op: "eq", path: "status", value: "done" },
    },
  });
  assert.equal(result.status, "failed");
  assert.match(String(result.error?.message), /最大尝试次数/);
  assert.equal(calls(), 2, "扁平策略可在每轮命中，但条件树存在时不得参与判定");
});

// 诊断：连续 5 轮「条件树引用路径全部不可观测」写一条告警留痕 + 用户可见提示。
void test("连续 5 轮引用路径全部不可观测时写告警留痕与用户可见提示", async (t) => {
  stubFetch(t, [{ body: {} }]);
  const result = await runPolling({
    id: "tree-unseen-paths",
    maxAttempts: 5,
    resultRule: {
      success_condition: { op: "not_empty", path: "typo.never.exists" },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(
    result.progress?.message,
    UNSEEN_CONDITION_MESSAGE,
    "第 5 轮跨过阈值时 progress.message 应写入定稿文案",
  );
  // 文案不得占用 phase 的状态机语义（失败终态 phase 归零）
  assert.equal(result.progress?.phase, null);
  const logPath = path.join(storageRoot, "logs", "backend.log");
  assert.equal(fs.existsSync(logPath), true, "backend.log 应存在");
  const logText = fs.readFileSync(logPath, "utf-8");
  assert.match(
    logText,
    /polling condition tree references paths never observed in body or headers/,
  );
  assert.match(logText, /typo\.never\.exists/);
});

// 用户可见提示的写入节奏：首次跨阈值写一次，之后每 20 轮刷新一次，其余轮次不 patch。
void test("shouldRefreshUnseenConditionMessage: 阈值首写 + 每 20 轮刷新", () => {
  assert.equal(shouldRefreshUnseenConditionMessage(4), false);
  assert.equal(shouldRefreshUnseenConditionMessage(5), true);
  assert.equal(shouldRefreshUnseenConditionMessage(6), false);
  assert.equal(shouldRefreshUnseenConditionMessage(24), false);
  assert.equal(shouldRefreshUnseenConditionMessage(25), true);
  assert.equal(shouldRefreshUnseenConditionMessage(26), false);
  assert.equal(shouldRefreshUnseenConditionMessage(45), true);
});

// 第 6 轮不重复写入：提示仍在，且不被清空、不被改写为其它语义。
void test("跨过阈值后的下一轮不重复写入提示（消息保留）", async (t) => {
  stubFetch(t, [{ body: {} }]);
  const result = await runPolling({
    id: "tree-unseen-no-repeat",
    maxAttempts: 6,
    resultRule: {
      success_condition: { op: "not_empty", path: "typo.never.exists" },
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.progress?.attempt, 6);
  assert.equal(result.progress?.message, UNSEEN_CONDITION_MESSAGE);
  assert.equal(result.progress?.phase, null);
});

// 条件在第 6 轮命中成功：提示不影响成功收口（状态/阶段覆盖用户注意力，消息不清空）。
void test("提示写入后条件命中成功：成功收口不受影响", async (t) => {
  const calls = stubFetch(t, [
    { body: {} },
    { body: {} },
    { body: {} },
    { body: {} },
    { body: {} },
    { body: { result: { url: "https://cdn.example.com/late.mp4" } } },
  ]);
  const result = await runPolling({
    id: "tree-unseen-then-success",
    maxAttempts: 6,
    resultRule: {
      success_condition: { op: "not_empty", path: "result.url" },
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.progress?.attempt, 6);
  assert.equal(result.progress?.phase, null);
  assert.equal(result.progress?.message, UNSEEN_CONDITION_MESSAGE);
  assert.equal(calls(), 6);
});

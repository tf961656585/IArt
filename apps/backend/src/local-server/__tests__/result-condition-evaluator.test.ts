import assert from "node:assert/strict";
import test from "node:test";

import {
  collectRecipeConditionPaths,
  evaluateRecipeCondition,
  isRecipeConditionPathObservable,
} from "../result-condition-evaluator.cts";
import { evaluateResultCondition } from "../task-failure-mapping.cts";

const matched = (condition: unknown, body: unknown, headers?: Headers) =>
  evaluateRecipeCondition(condition, body, headers).matched;

void test("exists / missing: 路径存在即可，null 也算存在", () => {
  assert.equal(matched({ op: "exists", path: "data.url" }, { data: { url: "u" } }), true);
  assert.equal(matched({ op: "exists", path: "data.url" }, { data: {} }), false);
  assert.equal(matched({ op: "exists", path: "data.url" }, { data: { url: null } }), true);
  assert.equal(matched({ op: "missing", path: "data.url" }, { data: {} }), true);
  assert.equal(matched({ op: "missing", path: "data.url" }, { data: { url: null } }), false);
});

void test("empty / not_empty: 空串、空白串、空数组、空对象、null 视为空", () => {
  const emptyCases: unknown[] = [undefined, null, "", "   ", [], {}];
  for (const value of emptyCases) {
    assert.equal(
      matched({ op: "empty", path: "v" }, { v: value }),
      true,
      `empty 应对 ${JSON.stringify(value)} 成立`,
    );
    assert.equal(matched({ op: "not_empty", path: "v" }, { v: value }), false);
  }
  assert.equal(matched({ op: "empty", path: "v" }, { v: 0 }), false);
  assert.equal(matched({ op: "empty", path: "v" }, { v: false }), false);
  assert.equal(matched({ op: "not_empty", path: "v" }, { v: "done" }), true);
  assert.equal(matched({ op: "not_empty", path: "v" }, { v: ["x"] }), true);
});

void test("eq / neq: 字符串忽略大小写，数字按数值比较，布尔严格", () => {
  assert.equal(matched({ op: "eq", path: "status", value: "done" }, { status: "DONE" }), true);
  assert.equal(matched({ op: "eq", path: "status", value: "Done" }, { status: "dOnE" }), true);
  assert.equal(matched({ op: "eq", path: "n", value: 200 }, { n: "200" }), true);
  assert.equal(matched({ op: "eq", path: "n", value: "200" }, { n: 200 }), true);
  assert.equal(matched({ op: "eq", path: "n", value: 200 }, { n: 201 }), false);
  assert.equal(matched({ op: "eq", path: "ok", value: true }, { ok: true }), true);
  assert.equal(matched({ op: "eq", path: "ok", value: true }, { ok: "true" }), false);
  assert.equal(matched({ op: "eq", path: "ok", value: false }, { ok: 0 }), false);
  assert.equal(matched({ op: "neq", path: "status", value: "done" }, { status: "running" }), true);
  assert.equal(matched({ op: "neq", path: "status", value: "done" }, { status: "DONE" }), false);
});

void test("in / not_in: 数字枚举与字符串枚举（忽略大小写）", () => {
  assert.equal(matched({ op: "in", path: "code", value: [0, 200] }, { code: 200 }), true);
  assert.equal(matched({ op: "in", path: "code", value: [0, 200] }, { code: "200" }), true);
  assert.equal(matched({ op: "in", path: "code", value: [0, 200] }, { code: 500 }), false);
  assert.equal(
    matched({ op: "in", path: "state", value: ["completed", "succeeded"] }, { state: "COMPLETED" }),
    true,
  );
  assert.equal(matched({ op: "in", path: "state", value: "completed" }, { state: "completed" }), false);
  assert.equal(matched({ op: "not_in", path: "state", value: ["failed"] }, { state: "running" }), true);
  assert.equal(matched({ op: "not_in", path: "state", value: ["failed"] }, { state: "FAILED" }), false);
  assert.equal(matched({ op: "not_in", path: "state", value: "failed" }, { state: "failed" }), true);
});

void test("contains: 字符串包含与数组包含", () => {
  assert.equal(matched({ op: "contains", path: "msg", value: "success" }, { msg: "task success!" }), true);
  assert.equal(matched({ op: "contains", path: "msg", value: "missing" }, { msg: "task success!" }), false);
  assert.equal(matched({ op: "contains", path: "tags", value: "done" }, { tags: ["queued", "done"] }), true);
  assert.equal(matched({ op: "contains", path: "tags", value: 2 }, { tags: [1, 2, 3] }), true);
  assert.equal(matched({ op: "contains", path: "tags", value: 9 }, { tags: [1, 2, 3] }), false);
  assert.equal(matched({ op: "contains", path: "n", value: 1 }, { n: 12 }), false);
});

void test("gt / gte / lt / lte: 只对可转成有限数字的值生效", () => {
  assert.equal(matched({ op: "gt", path: "progress", value: 99 }, { progress: 100 }), true);
  assert.equal(matched({ op: "gt", path: "progress", value: 100 }, { progress: 100 }), false);
  assert.equal(matched({ op: "gte", path: "progress", value: 100 }, { progress: 100 }), true);
  assert.equal(matched({ op: "gte", path: "progress", value: 100 }, { progress: "100" }), true);
  assert.equal(matched({ op: "lt", path: "progress", value: 100 }, { progress: 99 }), true);
  assert.equal(matched({ op: "lte", path: "progress", value: 100 }, { progress: 100 }), true);
  // 非数值 / 不可解析 / 布尔 / 缺失一律 false
  assert.equal(matched({ op: "gt", path: "progress", value: 1 }, { progress: "done" }), false);
  assert.equal(matched({ op: "gt", path: "progress", value: 1 }, { progress: true }), false);
  assert.equal(matched({ op: "gt", path: "progress", value: 1 }, { progress: null }), false);
  assert.equal(matched({ op: "gte", path: "progress", value: 1 }, {}), false);
  assert.equal(matched({ op: "gte", path: "progress", value: "abc" }, { progress: 100 }), false);
});

void test("all / any / not: 组合语义与空 children", () => {
  const body = { state: "done", result: { url: "https://cdn.example.com/a.mp4" } };
  assert.equal(
    matched(
      {
        op: "all",
        children: [
          { op: "eq", path: "state", value: "done" },
          { op: "not_empty", path: "result.url" },
        ],
      },
      body,
    ),
    true,
  );
  assert.equal(
    matched(
      {
        op: "all",
        children: [
          { op: "eq", path: "state", value: "done" },
          { op: "not_empty", path: "result.missing" },
        ],
      },
      body,
    ),
    false,
  );
  assert.equal(
    matched(
      {
        op: "any",
        children: [
          { op: "eq", path: "state", value: "failed" },
          { op: "not_empty", path: "result.url" },
        ],
      },
      body,
    ),
    true,
  );
  assert.equal(
    matched(
      {
        op: "any",
        children: [
          { op: "eq", path: "state", value: "failed" },
          { op: "eq", path: "state", value: "queued" },
        ],
      },
      body,
    ),
    false,
  );
  assert.equal(matched({ op: "all", children: [] }, body), false);
  assert.equal(matched({ op: "any", children: [] }, body), false);
  assert.equal(
    matched({ op: "not", condition: { op: "eq", path: "state", value: "failed" } }, body),
    true,
  );
  assert.equal(
    matched({ op: "not", condition: { op: "eq", path: "state", value: "done" } }, body),
    false,
  );
  // 旧形态：not 用 children[0] 承载子条件
  assert.equal(
    matched({ op: "not", children: [{ op: "eq", path: "state", value: "failed" }] }, body),
    true,
  );
});

void test("not 缺少子条件时判定为 false", () => {
  assert.equal(matched({ op: "not" }, { a: 1 }), false);
  assert.equal(matched({ op: "not", children: [] }, { a: 1 }), false);
});

void test("body 未命中时回落到同名响应头", () => {
  const body = { outputs: [{ url: "https://cdn.example.com/a.png" }] };
  const headers = new Headers({ "x-task-status": "COMPLETED" });
  assert.equal(
    matched({ op: "eq", path: "x-task-status", value: "completed" }, body, headers),
    true,
  );
  assert.equal(
    matched({ op: "in", path: "x-task-status", value: ["COMPLETED", "SUCCEEDED"] }, body, headers),
    true,
  );
  assert.equal(
    matched(
      { op: "all", children: [{ op: "not_empty", path: "outputs.0.url" }, { op: "eq", path: "x-task-status", value: "completed" }] },
      body,
      headers,
    ),
    true,
  );
  // 无响应头时不成立
  assert.equal(matched({ op: "eq", path: "x-task-status", value: "completed" }, body), false);
});

void test("body 值优先于响应头；body 空串时回落响应头", () => {
  const headers = new Headers({ status: "done" });
  assert.equal(
    matched({ op: "eq", path: "status", value: "done" }, { status: "running" }, headers),
    false,
  );
  assert.equal(
    matched({ op: "eq", path: "status", value: "done" }, { status: "" }, headers),
    true,
  );
});

void test("matchedPaths 记录命中的原子路径与值，用于诊断", () => {
  const result = evaluateRecipeCondition(
    {
      op: "all",
      children: [
        { op: "eq", path: "state", value: "done" },
        { op: "gte", path: "progress", value: 100 },
        { op: "not_empty", path: "result.missing" },
      ],
    },
    { state: "done", progress: 100 },
  );
  assert.equal(result.matched, false);
  assert.deepEqual(result.matchedPaths, [
    { path: "state", value: "done" },
    { path: "progress", value: 100 },
  ]);
});

void test("collectRecipeConditionPaths 去重收集原子路径（含嵌套 not）", () => {
  const paths = collectRecipeConditionPaths({
    op: "all",
    children: [
      { op: "not_empty", path: "result.url" },
      { op: "any", children: [{ op: "eq", path: "state", value: "done" }] },
      { op: "not", condition: { op: "missing", path: "error.code" } },
      { op: "not_empty", path: "result.url" },
    ],
  });
  assert.deepEqual(paths, ["result.url", "state", "error.code"]);
});

void test("isRecipeConditionPathObservable: body 与响应头任一可读到非空值即可观测", () => {
  const headers = new Headers({ "x-task-status": "COMPLETED" });
  assert.equal(isRecipeConditionPathObservable({ a: 1 }, "a", headers), true);
  assert.equal(isRecipeConditionPathObservable({ a: 0 }, "a", headers), true);
  assert.equal(isRecipeConditionPathObservable({}, "x-task-status", headers), true);
  assert.equal(isRecipeConditionPathObservable({}, "missing.path", headers), false);
  assert.equal(isRecipeConditionPathObservable({ a: "" }, "a", null), false);
});

// 既有 9 个原子在 failure_condition 调用点的判定结果必须保持一致。
// 注意：新求值器把字符串比较放宽为忽略大小写、数字跨类型按数值比较，
// 因此这里只选「同类型、同大小写」的既有语义样本做等价性证明。
void test("既有 9 原子在 failure_condition 调用点判定结果保持不变", () => {
  const body = {
    status: "failed",
    error: { code: "moderation_blocked", message: "rejected" },
    data: [],
    emptyText: "",
    ok: true,
    n: 200,
    list: ["a", "b"],
  };
  const cases: Array<{ condition: unknown; expected: boolean }> = [
    { condition: { op: "exists", path: "error.code" }, expected: true },
    { condition: { op: "missing", path: "error.detail" }, expected: true },
    { condition: { op: "empty", path: "data" }, expected: true },
    { condition: { op: "not_empty", path: "error.message" }, expected: true },
    { condition: { op: "eq", path: "status", value: "failed" }, expected: true },
    { condition: { op: "neq", path: "status", value: "failed" }, expected: false },
    { condition: { op: "in", path: "status", value: ["failed", "error"] }, expected: true },
    { condition: { op: "not_in", path: "status", value: ["failed"] }, expected: false },
    { condition: { op: "contains", path: "list", value: "b" }, expected: true },
    {
      condition: {
        op: "any",
        children: [
          { op: "not_empty", path: "error.message" },
          { op: "not_empty", path: "error.code" },
        ],
      },
      expected: true,
    },
    {
      condition: {
        op: "not",
        condition: { op: "not_empty", path: "error.message" },
      },
      expected: false,
    },
  ];
  for (const { condition, expected } of cases) {
    assert.equal(
      evaluateResultCondition(condition, body),
      expected,
      `旧入口判定不符: ${JSON.stringify(condition)}`,
    );
    assert.equal(
      evaluateRecipeCondition(condition, body, null).matched,
      expected,
      `新求值器判定不符: ${JSON.stringify(condition)}`,
    );
  }
});

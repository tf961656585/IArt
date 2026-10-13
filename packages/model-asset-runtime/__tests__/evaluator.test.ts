import { describe, it, expect } from "vitest";

import {
  evaluateRuntimeCondition,
  type ModelAssetRuntimeEvaluationContext,
} from "../src/runtime-utils";
import { evaluateRuntimeValueRule } from "../src/evaluator";
import type { ModelAssetNodeProjectionRuntimeValueRule } from "@iart/contracts/model-asset-contract";

const makeContext = (fields: Record<string, unknown>): ModelAssetRuntimeEvaluationContext => ({
  fields,
  runtime: {},
  projection: {},
  currentItem: undefined,
  projectPath: null,
});

describe("evaluateRuntimeCondition: 原子运算符", () => {
  it("truthy 在字段非空数组时返回 true", async () => {
    const ctx = makeContext({ image: ["a.png"] });
    const result = await evaluateRuntimeCondition({ op: "truthy", field: "image" }, ctx);
    expect(result).toBe(true);
  });

  it("truthy 在字段为空数组时仍返回 true（JavaScript Boolean([]) === true，必须用 ne value:[] 判空数组）", async () => {
    // 这是 JavaScript 语义陷阱：Boolean([]) === true，因为数组是对象。
    // 判断"数组是否非空"必须用 { op: "ne", field: "xxx", value: [] }，不能用 truthy。
    const ctx = makeContext({ image: [] });
    const result = await evaluateRuntimeCondition({ op: "truthy", field: "image" }, ctx);
    expect(result).toBe(true);
  });

  it("truthy 在字段未定义时返回 false", async () => {
    const ctx = makeContext({});
    const result = await evaluateRuntimeCondition({ op: "truthy", field: "image" }, ctx);
    expect(result).toBe(false);
  });

  it("falsy 是 truthy 的反向", async () => {
    // 注意：image:[] 是 truthy，所以 falsy 返回 false
    expect(await evaluateRuntimeCondition({ op: "falsy", field: "image" }, makeContext({ image: [] }))).toBe(false);
    expect(await evaluateRuntimeCondition({ op: "falsy", field: "image" }, makeContext({ image: ["x"] }))).toBe(false);
    expect(await evaluateRuntimeCondition({ op: "falsy", field: "image" }, makeContext({}))).toBe(true);
  });

  it("ne value:[] 判断数组是否非空（推荐写法）", async () => {
    // 这是 gpt-image-2-merge 和 kling-v3-video-merge 使用的写法
    expect(await evaluateRuntimeCondition({ op: "ne", field: "image", value: [] }, makeContext({ image: ["x"] }))).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "ne", field: "image", value: [] }, makeContext({ image: [] }))).toBe(false);
    expect(await evaluateRuntimeCondition({ op: "ne", field: "image", value: [] }, makeContext({}))).toBe(false);
  });

  it("eq 在值严格相等时返回 true", async () => {
    const ctx = makeContext({ mode: "edit" });
    expect(await evaluateRuntimeCondition({ op: "eq", field: "mode", value: "edit" }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "eq", field: "mode", value: "text" }, ctx)).toBe(false);
  });

  it("ne 是 eq 的反向", async () => {
    const ctx = makeContext({ mode: "edit" });
    expect(await evaluateRuntimeCondition({ op: "ne", field: "mode", value: "text" }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "ne", field: "mode", value: "edit" }, ctx)).toBe(false);
  });

  it("eq 与空数组字面量对比", async () => {
    // 这是 gpt-image-2-merge 不会用到的语义，但 kling 用过 ne field value: []
    // 验证空数组语义稳定
    const ctx = makeContext({ image: [] });
    expect(await evaluateRuntimeCondition({ op: "eq", field: "image", value: [] }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "ne", field: "image", value: [] }, ctx)).toBe(false);
  });

  it("gt / gte / lt / lte 数值比较", async () => {
    const ctx = makeContext({ count: 5 });
    expect(await evaluateRuntimeCondition({ op: "gt", field: "count", value: 3 }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "gt", field: "count", value: 5 }, ctx)).toBe(false);
    expect(await evaluateRuntimeCondition({ op: "gte", field: "count", value: 5 }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "lt", field: "count", value: 5 }, ctx)).toBe(false);
    expect(await evaluateRuntimeCondition({ op: "lte", field: "count", value: 5 }, ctx)).toBe(true);
  });

  it("includes 在数组包含元素时返回 true", async () => {
    const ctx = makeContext({ tags: ["a", "b", "c"] });
    expect(await evaluateRuntimeCondition({ op: "includes", field: "tags", value: "b" }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "includes", field: "tags", value: "z" }, ctx)).toBe(false);
  });

  it("includes 在字符串包含子串时返回 true", async () => {
    const ctx = makeContext({ prompt: "a cat on the sofa" });
    expect(await evaluateRuntimeCondition({ op: "includes", field: "prompt", value: "cat" }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "includes", field: "prompt", value: "dog" }, ctx)).toBe(false);
  });

  it("excludes 是 includes 的反向（数组）", async () => {
    const ctx = makeContext({ tags: ["a", "b"] });
    expect(await evaluateRuntimeCondition({ op: "excludes", field: "tags", value: "z" }, ctx)).toBe(true);
    expect(await evaluateRuntimeCondition({ op: "excludes", field: "tags", value: "a" }, ctx)).toBe(false);
  });
});

describe("evaluateRuntimeCondition: 组合运算符", () => {
  it("and: 所有子条件成立才 true", async () => {
    const ctx = makeContext({ a: 1, b: 2 });
    const condition = {
      op: "and",
      conditions: [
        { op: "eq", field: "a", value: 1 },
        { op: "eq", field: "b", value: 2 },
      ],
    };
    expect(await evaluateRuntimeCondition(condition, ctx)).toBe(true);
    const falseCondition = {
      op: "and",
      conditions: [
        { op: "eq", field: "a", value: 1 },
        { op: "eq", field: "b", value: 999 },
      ],
    };
    expect(await evaluateRuntimeCondition(falseCondition, ctx)).toBe(false);
  });

  it("or: 任一子条件成立即 true", async () => {
    const ctx = makeContext({ a: 1, b: 2 });
    const condition = {
      op: "or",
      conditions: [
        { op: "eq", field: "a", value: 999 },
        { op: "eq", field: "b", value: 2 },
      ],
    };
    expect(await evaluateRuntimeCondition(condition, ctx)).toBe(true);
  });

  it("not: 反转子条件", async () => {
    const ctx = makeContext({ a: 1 });
    const condition = {
      op: "not",
      condition: { op: "eq", field: "a", value: 2 },
    };
    expect(await evaluateRuntimeCondition(condition, ctx)).toBe(true);
  });

  it("嵌套 and/or/not 复合条件", async () => {
    const ctx = makeContext({ mode: "edit", hasRef: true });
    const condition = {
      op: "and",
      conditions: [
        { op: "eq", field: "mode", value: "edit" },
        {
          op: "or",
          conditions: [
            { op: "truthy", field: "hasRef" },
            { op: "truthy", field: "nonExistent" },
          ],
        },
      ],
    };
    expect(await evaluateRuntimeCondition(condition, ctx)).toBe(true);
  });
});

describe("evaluateRuntimeCondition: 边界", () => {
  it("condition 为 undefined 时返回 true", async () => {
    expect(await evaluateRuntimeCondition(undefined, makeContext({}))).toBe(true);
  });

  it("未知 op 返回 false", async () => {
    const ctx = makeContext({ a: 1 });
    // 类型断言绕过 TS，模拟运行时未知 op
    expect(await evaluateRuntimeCondition({ op: "unknown_op", field: "a" } as never, ctx)).toBe(false);
  });
});

describe("evaluateRuntimeValueRule: literal", () => {
  it("返回字面量值的克隆", async () => {
    const value = { foo: [1, 2, 3] };
    const rule: ModelAssetNodeProjectionRuntimeValueRule = { kind: "literal", value };
    const result = await evaluateRuntimeValueRule(rule, makeContext({}));
    expect(result).toEqual({ foo: [1, 2, 3] });
    // 修改结果不影响原始 value
    (result as { foo: number[] }).foo.push(4);
    expect(value.foo).toEqual([1, 2, 3]);
  });

  it("null 字面量", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = { kind: "literal", value: null };
    expect(await evaluateRuntimeValueRule(rule, makeContext({}))).toBeNull();
  });

  it("rule 为 undefined 时返回 undefined", async () => {
    expect(await evaluateRuntimeValueRule(undefined, makeContext({}))).toBeUndefined();
  });
});

describe("evaluateRuntimeValueRule: field", () => {
  it("读取字段并应用 transforms", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = {
      kind: "field",
      field_key: "prompt",
      transforms: ["trim"],
    };
    const result = await evaluateRuntimeValueRule(rule, makeContext({ prompt: "  hello  " }));
    expect(result).toBe("hello");
  });

  it("字段未定义时返回 undefined", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = {
      kind: "field",
      field_key: "nonExistent",
      transforms: [],
    };
    const result = await evaluateRuntimeValueRule(rule, makeContext({}));
    expect(result).toBeUndefined();
  });

  it("字段未定义但有 fallback 时返回 fallback", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = {
      kind: "field",
      field_key: "nonExistent",
      fallback: { kind: "literal", value: "default" },
    };
    const result = await evaluateRuntimeValueRule(rule, makeContext({}));
    expect(result).toBe("default");
  });
});

describe("evaluateRuntimeValueRule: when", () => {
  it("条件成立时返回 truthy 分支", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: { kind: "literal", value: "multipart" },
      falsy: { kind: "literal", value: "json" },
    };
    const truthyResult = await evaluateRuntimeValueRule(rule, makeContext({ image: ["a.png"] }));
    expect(truthyResult).toBe("multipart");
  });

  it("条件不成立时返回 falsy 分支", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: { kind: "literal", value: "multipart" },
      falsy: { kind: "literal", value: "json" },
    };
    const falsyResult = await evaluateRuntimeValueRule(rule, makeContext({ image: [] }));
    expect(falsyResult).toBe("json");
  });

  it("falsy 为 undefined 时返回 undefined", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: { kind: "literal", value: "has-image" },
      falsy: undefined,
    };
    const result = await evaluateRuntimeValueRule(rule, makeContext({ image: [] }));
    expect(result).toBeUndefined();
  });

  it("嵌套 when（用于复杂分支场景）", async () => {
    const rule: ModelAssetNodeProjectionRuntimeValueRule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: {
        kind: "when",
        condition: { op: "eq", field: "mode", value: "high" },
        truthy: { kind: "literal", value: "high-quality-with-image" },
        falsy: { kind: "literal", value: "standard-with-image" },
      },
      falsy: { kind: "literal", value: "text-only" },
    };
    expect(await evaluateRuntimeValueRule(rule, makeContext({ image: ["x"], mode: "high" }))).toBe("high-quality-with-image");
    expect(await evaluateRuntimeValueRule(rule, makeContext({ image: ["x"], mode: "std" }))).toBe("standard-with-image");
    expect(await evaluateRuntimeValueRule(rule, makeContext({ image: [] }))).toBe("text-only");
  });
});

describe("evaluateRuntimeValueRule: compute (核心 operator 矩阵)", () => {
  it("coalesce 返回第一个非 undefined arg", async () => {
    const rule = {
      kind: "compute",
      operator: "coalesce",
      args: [
        { kind: "field", field_key: "missing" },
        { kind: "literal", value: "fallback" },
      ],
    } as ModelAssetNodeProjectionRuntimeValueRule;
    expect(await evaluateRuntimeValueRule(rule, makeContext({}))).toBe("fallback");
  });

  it("assert_non_empty 在字段非空时返回字段值", async () => {
    const rule = {
      kind: "compute",
      operator: "assert_non_empty",
      args: [{ kind: "field", field_key: "prompt", transforms: ["trim"] }],
    } as ModelAssetNodeProjectionRuntimeValueRule;
    expect(await evaluateRuntimeValueRule(rule, makeContext({ prompt: "hello" }))).toBe("hello");
  });

  it("assert_non_empty 在字段为空时抛错", async () => {
    const rule = {
      kind: "compute",
      operator: "assert_non_empty",
      args: [{ kind: "field", field_key: "prompt", transforms: ["trim"] }],
    } as ModelAssetNodeProjectionRuntimeValueRule;
    await expect(evaluateRuntimeValueRule(rule, makeContext({ prompt: "  " }))).rejects.toThrow();
  });

  it("normalize_enum 返回允许的值", async () => {
    // options 字段的字面量与 ModelAssetNodeProjectionRuntimeNormalizeEnumComputeValueRule
    // 的 options 类型存在结构差异（测试 fixture 不必精确建模），用类型断言一次跳过编译期对齐。
    const rule = {
      kind: "compute",
      operator: "normalize_enum",
      args: [{ kind: "field", field_key: "size", transforms: ["trim"] }],
      options: { allowed_values: ["1024x1024", "1536x1536"], fallback: "1024x1024" },
    } as ModelAssetNodeProjectionRuntimeValueRule;
    expect(await evaluateRuntimeValueRule(rule, makeContext({ size: "1536x1536" }))).toBe("1536x1536");
    expect(await evaluateRuntimeValueRule(rule, makeContext({ size: "weird" }))).toBe("1024x1024");
  });
});

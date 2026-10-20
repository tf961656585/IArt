/**
 * gpt-image-2 合并包 payload 求值测试
 *
 * 验证合并后的 gpt-image-2 单节点双模式在不同输入下生成的 payload 与原始两个独立包
 * （gpt-image-2 文生图 + gpt-image-2-edit 图生图）一致。
 *
 * 关键约束：
 * - 服务端 API 是项目自有服务，请求体格式不能变。
 * - 文生图模式（image 为空）：JSON /v1/images/generations
 * - 图生图模式（image 非空）：multipart /v1/images/edits
 *
 * 这组测试不依赖磁盘上的任何资产文件：直接用 inline fixture 模拟合并形态的 payload_rules，
 * 验证 evaluateRule 的求值行为。族模板侧的同形契约由
 * `gpt-image-2-merge.alias.test.ts`（投影层）与 `openai-image-family.wire-injection.test.ts`
 * （求值 → 注入 → wire 全链）覆盖。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateRule } from "../request-assembler-runtime.cts";
import type { EvaluateState } from "../request-assembler-shared.cts";

/**
 * 判断 image 数组是否非空。
 *
 * 关键约束：不能用 `{ op: "truthy", field: "image" }`——
 * JavaScript 的 Boolean([]) === true，空数组也会被判定 truthy。
 * 必须用 `{ op: "ne", field: "image", value: [] }`。
 */
const IMAGE_NON_EMPTY_CONDITION = { op: "ne", field: "image", value: [] } as const;

// 合并包的 payload_format_rule（与子计划 4 的 runtime_model.json 一致）
const payloadFormatRule = {
  kind: "when" as const,
  condition: IMAGE_NON_EMPTY_CONDITION,
  truthy: { kind: "literal" as const, value: "multipart" },
  falsy: { kind: "literal" as const, value: "json" },
};

// 合并包的 api.endpoint 规则
const apiEndpointRule = {
  kind: "when" as const,
  condition: IMAGE_NON_EMPTY_CONDITION,
  truthy: { kind: "literal" as const, value: "/v1/images/edits" },
  falsy: { kind: "literal" as const, value: "/v1/images/generations" },
};

// 合并包的 api.contentType 规则
// multipart 模式需要 contentType=null（让 HTTP 客户端自动加 boundary）；
// json 模式需要 contentType=application/json
const apiContentTypeRule = {
  kind: "when" as const,
  condition: IMAGE_NON_EMPTY_CONDITION,
  truthy: { kind: "literal" as const, value: null },
  falsy: { kind: "literal" as const, value: "application/json" },
};

// 合并包的 body.model 规则（两种模式都是 gpt-image-2）
const bodyModelRule = { kind: "literal" as const, value: "gpt-image-2" };

// 合并包的 body.image 规则
const bodyImageRule = {
  kind: "when" as const,
  condition: IMAGE_NON_EMPTY_CONDITION,
  truthy: {
    kind: "compute" as const,
    operator: "assert_array_length" as const,
    cache_key: "gptImage2.image",
    args: [{ kind: "field" as const, field_key: "image" }],
    options: { min_items: 1, max_items: 16 },
    media_target: "multipart_file",
    transforms: ["allUploadFiles"],
  },
  falsy: { kind: "literal" as const, value: null },
};

// 合并包的 body.output_format 规则：两条路径（t2i JSON / edits multipart）都透传 format 值，
// wire 字段为官方名 output_format（旧 body.format when 规则已移除）。
const bodyOutputFormatRule = {
  kind: "field" as const,
  field_key: "format",
  transforms: ["trim"],
};

// 合并包的 body.n 规则（只有文生图模式输出 n=1）
const bodyNRule = {
  kind: "when" as const,
  condition: IMAGE_NON_EMPTY_CONDITION,
  truthy: { kind: "literal" as const, value: null },
  falsy: { kind: "literal" as const, value: 1 },
};

const makeText2ImageState = (): EvaluateState => ({
  fields: {
    image: [],
    prompt: "a cat sitting on a sofa",
    size: "1024x1024",
    quality: "high",
    format: "png",
    moderation: "auto",
  },
  runtime: {},
  projection: {},
  currentItem: undefined,
  projectPath: null,
});

const makeImage2ImageState = (): EvaluateState => ({
  fields: {
    image: [
      {
        source_kind: "base64",
        value: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        mime_type: "image/png",
        filename: "reference.png",
      },
    ],
    prompt: "make the cat wear a hat",
    size: "1024x1024",
    quality: "high",
    format: "jpeg",
    moderation: "auto",
  },
  runtime: {},
  projection: {},
  currentItem: undefined,
  projectPath: null,
});

void describe("gpt-image-2 merged package: payload_format_rule", () => {
  void it("text2image mode (image empty): payload_format = json", async () => {
    const state = makeText2ImageState();
    const result = await evaluateRule(payloadFormatRule, state);
    assert.equal(result, "json");
  });

  void it("image2image mode (image present): payload_format = multipart", async () => {
    const state = makeImage2ImageState();
    const result = await evaluateRule(payloadFormatRule, state);
    assert.equal(result, "multipart");
  });
});

void describe("gpt-image-2 merged package: api.endpoint", () => {
  void it("text2image mode: endpoint = /v1/images/generations", async () => {
    const state = makeText2ImageState();
    const result = await evaluateRule(apiEndpointRule, state);
    assert.equal(result, "/v1/images/generations");
  });

  void it("image2image mode: endpoint = /v1/images/edits", async () => {
    const state = makeImage2ImageState();
    const result = await evaluateRule(apiEndpointRule, state);
    assert.equal(result, "/v1/images/edits");
  });
});

void describe("gpt-image-2 merged package: api.contentType", () => {
  void it("text2image mode: contentType = application/json", async () => {
    const state = makeText2ImageState();
    const result = await evaluateRule(apiContentTypeRule, state);
    assert.equal(result, "application/json");
  });

  void it("image2image mode: contentType = null (HTTP 客户端自动加 boundary)", async () => {
    const state = makeImage2ImageState();
    const result = await evaluateRule(apiContentTypeRule, state);
    assert.equal(result, null);
  });
});

void describe("gpt-image-2 merged package: body.model", () => {
  void it("两种模式都是 gpt-image-2（远端模型 ID 不变）", async () => {
    const textState = makeText2ImageState();
    const imageState = makeImage2ImageState();
    assert.equal(await evaluateRule(bodyModelRule, textState), "gpt-image-2");
    assert.equal(await evaluateRule(bodyModelRule, imageState), "gpt-image-2");
  });
});

void describe("gpt-image-2 merged package: body.image", () => {
  void it("text2image mode: body.image = null（不输出）", async () => {
    const state = makeText2ImageState();
    const result = await evaluateRule(bodyImageRule, state);
    assert.equal(result, null);
  });

  void it("image2image mode: body.image 产出 MediaRefPlaceholder（truthy）", async () => {
    const state = makeImage2ImageState();
    const result = await evaluateRule(bodyImageRule, state);
    assert.ok(result, "body.image should be truthy when image is present");
    assert.equal(typeof result, "object");
    // body.image 可能是数组（allUploadFiles transform 输出）或单个 MediaRefPlaceholder。
    // 关键约束：result 必须是 truthy 对象（说明图像字段被正确求值与转换）。
    // 具体形态由 assert_array_length + allUploadFiles + media_target=multipart_file 共同决定。
    const resultObj = result as Record<string, unknown>;
    if (Array.isArray(result)) {
      // 数组形态：每个元素应为 MediaRefPlaceholder
      assert.ok(result.length > 0, "array should have at least one item");
    } else {
      // 单对象形态：应有 __media_ref__ 标记
      assert.ok(
        resultObj["__media_ref__"] === true || resultObj["source"] !== undefined,
        `unexpected body.image shape: ${JSON.stringify(resultObj).slice(0, 200)}`,
      );
    }
  });
});

void describe("gpt-image-2 merged package: body.output_format (两条路径都输出官方字段)", () => {
  void it("text2image mode: body.output_format = field format value (png)", async () => {
    const state = makeText2ImageState();
    const result = await evaluateRule(bodyOutputFormatRule, state);
    assert.equal(result, "png");
  });

  void it("image2image mode: body.output_format = field format value (jpeg，edits 端点支持 output_format)", async () => {
    const state = makeImage2ImageState();
    const result = await evaluateRule(bodyOutputFormatRule, state);
    assert.equal(result, "jpeg");
  });
});

void describe("gpt-image-2 merged package: body.n (只在文生图模式输出)", () => {
  void it("text2image mode: body.n = 1", async () => {
    const state = makeText2ImageState();
    const result = await evaluateRule(bodyNRule, state);
    assert.equal(result, 1);
  });

  void it("image2image mode: body.n = null（不输出）", async () => {
    const state = makeImage2ImageState();
    const result = await evaluateRule(bodyNRule, state);
    assert.equal(result, null);
  });
});

void describe("gpt-image-2 merged package: 字节级等价原则", () => {
  void it("text2image 模式生成的请求结构等价于原 gpt-image-2 包", async () => {
    // 等价于原 gpt-image-2 包：JSON /v1/images/generations，body 含 model/prompt/size/quality/format/moderation/n
    const state = makeText2ImageState();
    const payloadFormat = await evaluateRule(payloadFormatRule, state);
    const endpoint = await evaluateRule(apiEndpointRule, state);
    const contentType = await evaluateRule(apiContentTypeRule, state);
    const model = await evaluateRule(bodyModelRule, state);
    const image = await evaluateRule(bodyImageRule, state);
    const outputFormat = await evaluateRule(bodyOutputFormatRule, state);
    const n = await evaluateRule(bodyNRule, state);

    assert.equal(payloadFormat, "json");
    assert.equal(endpoint, "/v1/images/generations");
    assert.equal(contentType, "application/json");
    assert.equal(model, "gpt-image-2");
    assert.equal(image, null); // 不输出 image 字段
    assert.equal(outputFormat, "png"); // wire 字段名由 payload_rules 键承载：body.output_format
    assert.equal(n, 1);
  });

  void it("image2image 模式生成的请求结构等价于原 gpt-image-2-edit 包", async () => {
    // 等价于原 gpt-image-2-edit 包：multipart /v1/images/edits，body 含 model/prompt/size/quality/moderation/image
    const state = makeImage2ImageState();
    const payloadFormat = await evaluateRule(payloadFormatRule, state);
    const endpoint = await evaluateRule(apiEndpointRule, state);
    const contentType = await evaluateRule(apiContentTypeRule, state);
    const model = await evaluateRule(bodyModelRule, state);
    const image = await evaluateRule(bodyImageRule, state);
    const outputFormat = await evaluateRule(bodyOutputFormatRule, state);
    const n = await evaluateRule(bodyNRule, state);

    assert.equal(payloadFormat, "multipart");
    assert.equal(endpoint, "/v1/images/edits");
    assert.equal(contentType, null); // 不显式设置，HTTP 客户端加 multipart boundary
    assert.equal(model, "gpt-image-2");
    assert.ok(image, "image must be present as multipart_file");
    assert.equal(outputFormat, "jpeg"); // edits 端点同样发送 output_format
    assert.equal(n, null); // edits 接口不接受 n
  });
});

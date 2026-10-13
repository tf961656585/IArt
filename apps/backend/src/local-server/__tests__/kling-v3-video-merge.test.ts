/**
 * kling-v3-video 合并包 payload 对比测试
 *
 * 验证合并后的 kling-v3-video 包在不同模式下生成的 payload
 * 与原始独立包（kling-v3-text2video / kling-v3-image2video）一致。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import path from "node:path";

import { evaluateRule } from "../request-assembler-runtime.cts";
import type { EvaluateState } from "../request-assembler-shared.cts";
import { resetBackendConfigForTest } from "../config-store.cts";
import { findProjectionByModelIdOrAlias } from "../model-package-catalog.cts";

// 公共中转端点是运行时用户配置事实（用户自带语义）：测试自置占位端点并重载
// 后端配置单例，保证投影解析不依赖开发机 .env / 本机 backend.json。
process.env["IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT"] = "https://relay.example.com/upload";
process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"] = "https://image-relay.example.com/api/upload";
resetBackendConfigForTest();

/**
 * 从测试文件位置向上导航到仓库根目录的 .model-assets/packages。
 * 测试文件在 apps/backend/src/local-server/__tests__/，
 * 所以需要向上 5 级到达项目根。
 */
const REPO_PACKAGES_DIR = path.resolve(
  process.cwd(),
  ".model-assets", "packages",
);

const makeText2VideoState = (): EvaluateState => ({
  fields: {
    image: [],
    tailImage: [],
    prompt: "一只猫在草地上奔跑",
    negativePrompt: "模糊",
    duration: "5",
    mode: "pro",
    aspectRatio: "16:9",
    cfgScale: 0.5,
    sound: "off",
    watermark: false,
  },
  runtime: {},
  projection: {},
  currentItem: undefined,
  projectPath: null,
});

const makeImage2VideoState = (): EvaluateState => ({
  fields: {
    image: ["https://example.com/cat.jpg"],
    tailImage: [],
    prompt: "一只猫在草地上奔跑",
    negativePrompt: "模糊",
    duration: "5",
    mode: "pro",
    cfgScale: 0.5,
    sound: "off",
    watermark: false,
  },
  runtime: {},
  projection: {},
  currentItem: undefined,
  projectPath: null,
});

void describe("kling-v3-video merged package: endpoint selection", () => {
  void it("text2video mode (image empty): endpoint = /kling/v1/videos/text2video", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: { kind: "literal", value: "/kling/v1/videos/image2video" },
      falsy: { kind: "literal", value: "/kling/v1/videos/text2video" },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "/kling/v1/videos/text2video");
  });

  void it("image2video mode (image present): endpoint = /kling/v1/videos/image2video", async () => {
    const state = makeImage2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: { kind: "literal", value: "/kling/v1/videos/image2video" },
      falsy: { kind: "literal", value: "/kling/v1/videos/text2video" },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "/kling/v1/videos/image2video");
  });
});

void describe("kling-v3-video merged package: meta.taskType", () => {
  void it("text2video mode: meta.taskType = text2video", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: { kind: "literal", value: "image2video" },
      falsy: { kind: "literal", value: "text2video" },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "text2video");
  });

  void it("image2video mode: meta.taskType = image2video", async () => {
    const state = makeImage2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: { kind: "literal", value: "image2video" },
      falsy: { kind: "literal", value: "text2video" },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "image2video");
  });
});

void describe("kling-v3-video merged package: body.image presence", () => {
  void it("text2video mode: body.image = null", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: {
        kind: "compute",
        operator: "assert_non_empty",
        cache_key: "klingV3Video.image",
        args: [
          {
            kind: "field",
            field_key: "image",
            transforms: ["extractFirstUrl"],
          },
        ],
        options: { message: "请上传输入图。" },
      },
      falsy: { kind: "literal", value: null },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, null);
  });

  void it("image2video mode: body.image resolves to a media ref (truthy)", async () => {
    const state = makeImage2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "ne", field: "image", value: [] },
      truthy: {
        kind: "compute",
        operator: "assert_non_empty",
        cache_key: "klingV3Video.image",
        args: [
          {
            kind: "field",
            field_key: "image",
            transforms: ["extractFirstUrl"],
          },
        ],
        options: { message: "请上传输入图。" },
      },
      falsy: { kind: "literal", value: null },
    };
    const result = await evaluateRule(rule, state);
    assert.ok(result, "body.image should be truthy (media ref) when image is present");
    assert.equal(typeof result, "object");
    assert.equal((result as Record<string, unknown>)["__media_ref__"], true);
  });
});

void describe("kling-v3-video merged package: body.aspect_ratio presence", () => {
  void it("text2video mode: body.aspect_ratio is computed (not null)", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "eq", field: "image", value: [] },
      truthy: {
        kind: "compute",
        operator: "normalize_enum",
        cache_key: "klingV3Video.aspectRatio",
        args: [{ kind: "field", field_key: "aspectRatio", transforms: ["trim"] }],
        options: {
          allowed_values: ["16:9", "9:16", "1:1"],
          fallback: "16:9",
        },
      },
      falsy: { kind: "literal", value: null },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "16:9");
  });

  void it("image2video mode: body.aspect_ratio = null", async () => {
    const state = makeImage2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "eq", field: "image", value: [] },
      truthy: {
        kind: "compute",
        operator: "normalize_enum",
        cache_key: "klingV3Video.aspectRatio",
        args: [{ kind: "field", field_key: "aspectRatio", transforms: ["trim"] }],
        options: {
          allowed_values: ["16:9", "9:16", "1:1"],
          fallback: "16:9",
        },
      },
      falsy: { kind: "literal", value: null },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, null);
  });
});

void describe("kling-v3-video merged package: shared fields", () => {
  void it("body.model_name always = kling-v3", async () => {
    const rule = { kind: "literal", value: "kling-v3" };
    const result = await evaluateRule(rule, makeText2VideoState());
    assert.equal(result, "kling-v3");
  });

  void it("body.prompt is trimmed prompt", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "compute",
      operator: "assert_non_empty",
      cache_key: "klingV3Video.prompt",
      args: [{ kind: "field", field_key: "prompt", transforms: ["trim"] }],
      options: { message: "请填写提示词。" },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "一只猫在草地上奔跑");
  });

  void it("body.duration is normalized enum", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "compute",
      operator: "normalize_enum",
      cache_key: "klingV3Video.duration",
      args: [{ kind: "field", field_key: "duration", transforms: ["trim"] }],
      options: {
        allowed_values: ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
        fallback: "5",
      },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "5");
  });

  void it("body.mode is normalized enum", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "compute",
      operator: "normalize_enum",
      cache_key: "klingV3Video.mode",
      args: [{ kind: "field", field_key: "mode", transforms: ["trim"] }],
      options: {
        allowed_values: ["std", "pro", "4k"],
        fallback: "pro",
      },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, "pro");
  });

  void it("body.cfg_scale produces a number within range", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "compute",
      operator: "coalesce",
      cache_key: "klingV3Video.cfgScale",
      args: [
        {
          kind: "compute",
          operator: "clamp_number",
          args: [{ kind: "field", field_key: "cfgScale", transforms: ["toNumber"] }],
          options: { min: 0, max: 1 },
        },
        { kind: "literal", value: 0.5 },
      ],
    };
    const result = await evaluateRule(rule, state);
    assert.equal(typeof result, "number");
    assert.ok((result as number) >= 0 && (result as number) <= 1, `cfg_scale ${result as number} out of range`);
  });

  void it("body.watermark_info.enabled = false when watermark=false", async () => {
    const state = makeText2VideoState();
    const rule = {
      kind: "when",
      condition: { op: "truthy", field: "watermark" },
      truthy: { kind: "literal", value: true },
      falsy: { kind: "literal", value: false },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, false);
  });

  void it("body.watermark_info.enabled = true when watermark=true", async () => {
    const state = makeText2VideoState();
    state.fields["watermark"] = true;
    const rule = {
      kind: "when",
      condition: { op: "truthy", field: "watermark" },
      truthy: { kind: "literal", value: true },
      falsy: { kind: "literal", value: false },
    };
    const result = await evaluateRule(rule, state);
    assert.equal(result, true);
  });
});

void describe("kling 包现状：text2video / image2video 独立包，无 kling-v3-video 合并包", () => {
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];

  void it("kling-v3-video 合并包不存在（无 sources/packages 实现）", () => {
    process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = REPO_PACKAGES_DIR;
    try {
      const result = findProjectionByModelIdOrAlias("kling-v3-video");
      assert.equal(result, undefined, "kling-v3-video 合并包未实现，不应可解析");
    } finally {
      if (previousPackageRoot !== undefined) {
        process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackageRoot;
      } else {
        delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
      }
    }
  });

  void it("kling-v3-text2video 是独立包，可按自身 model_id 解析", () => {
    process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = REPO_PACKAGES_DIR;
    try {
      const result = findProjectionByModelIdOrAlias("kling-v3-text2video");
      assert.ok(result, "should find kling-v3-text2video by model_id");
      assert.equal(result.projection.model_id, "kling-v3-text2video");
    } finally {
      if (previousPackageRoot !== undefined) {
        process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackageRoot;
      } else {
        delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
      }
    }
  });

  void it("kling-v3-image2video 是独立包，可按自身 model_id 解析", () => {
    process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = REPO_PACKAGES_DIR;
    try {
      const result = findProjectionByModelIdOrAlias("kling-v3-image2video");
      assert.ok(result, "should find kling-v3-image2video by model_id");
      assert.equal(result.projection.model_id, "kling-v3-image2video");
    } finally {
      if (previousPackageRoot !== undefined) {
        process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackageRoot;
      } else {
        delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
      }
    }
  });
});

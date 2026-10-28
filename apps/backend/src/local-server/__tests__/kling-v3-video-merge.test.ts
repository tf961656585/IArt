/**
 * 可灵视频 payload 规则求值测试。
 *
 * payload 断言本身是**内联 DSL 规则**（不读任何包/模板文件），验证 `evaluateRule` 在
 * 文生视频 / 图生视频两种字段形态下的求值语义（endpoint 选择、meta.taskType、file/媒体引用、
 * 归一化枚举、水印开关）。2026-10-20 模型能力包退场、包目录删除后，原先末尾那块「包现状」
 * 核对改为**族模板现状**核对（见文件末）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GENERATION_FAMILY_ADAPTER_IDS,
  type GenerationFamilyAdapterId,
} from "@iart/contracts";
import { evaluateRule } from "../request-assembler-runtime.cts";
import type { EvaluateState } from "../request-assembler-shared.cts";
import { resetBackendConfigForTest } from "../config-store.cts";
import {
  requireFamilyTemplate,
  getFamilyTemplate,
} from "../generation-family-templates.registry.cts";
import { projectFamilyTemplate } from "./family-template-projection-test-helpers";

// 公共中转端点是运行时用户配置事实（用户自带语义）：测试自置占位端点并重载
// 后端配置单例，保证投影解析不依赖开发机 .env / 本机 backend.json。
process.env["IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT"] = "https://relay.example.com/upload";
process.env["IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT"] = "https://image-relay.example.com/api/upload";
resetBackendConfigForTest();

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

/**
 * 可灵三族现状：文生视频 / 图生视频 / 全模态视频各自独立，没有「合并成单族」的形态。
 *
 * 历史：本块原本核对磁盘上的真实包（kling-v3-text2video / kling-v3-image2video 独立存在、
 * kling-v3-video 合并包不存在）。2026-10-20 模型能力包退场、包目录删除后，同样的**事实**改由
 * 族模板核对——三个接口类型各是一个独立族模板，用户模型记录一次只能选一个族，因此「合并族」
 * 在契约层就不可表达（`GENERATION_FAMILY_ADAPTER_IDS` 无该键）。
 *
 * 这里经真实投影管线取三族投影，钉住「各自可独立成模、身份互不覆盖」。
 */
void describe("可灵族现状：text2video / image2video / omni-video 三族独立，无合并族", () => {
  // 显式标注类型：注册表是 `Record<GenerationFamilyAdapterId, ...>`，用 string[] 索引会
  // 隐式退化到 any（TS7053）。类型来源仍是 contracts 的值域，不在测试里放宽。
  const KLING_ADAPTER_IDS: readonly GenerationFamilyAdapterId[] = [
    'kling-text2video-v1',
    'kling-image2video-v1',
    'kling-omni-video-v1',
  ];

  void it("没有 kling-v3-video 合并族（接口类型值域里不存在）", () => {
    assert.equal(
      (GENERATION_FAMILY_ADAPTER_IDS as readonly string[]).includes("kling-v3-video"),
      false,
      "kling-v3-video 合并不在接口类型值域内，因此不可能有对应族模板",
    );
    assert.equal(
      getFamilyTemplate("kling-v3-video"),
      null,
      "未登记的接口类型必须返回 null（不是命中某个默认族）",
    );
  });

  void it("三族各自可独立成模，投影 model_id 与虚拟包身份互不覆盖", () => {
    const seenModelIds = new Set<string>();
    const seenPackageIds = new Set<string>();
    for (const familyAdapterId of KLING_ADAPTER_IDS) {
      const entry = requireFamilyTemplate(familyAdapterId);
      assert.equal(entry.status, "ready", `${familyAdapterId} 必须已就绪`);
      if (entry.status !== "ready") continue;

      const projected = projectFamilyTemplate({
        familyAdapterId,
        buildBaseSources: entry.buildBaseSources,
        supportsMediaSlots: entry.supportsMediaSlots,
      });
      assert.equal(projected.projection.model_id, `declared-${familyAdapterId}-test`);
      assert.equal(projected.packageId, `declared-${familyAdapterId}`);
      seenModelIds.add(projected.projection.model_id);
      seenPackageIds.add(projected.packageId);
    }
    assert.equal(seenModelIds.size, KLING_ADAPTER_IDS.length, "三族 model_id 不得互相覆盖");
    assert.equal(seenPackageIds.size, KLING_ADAPTER_IDS.length, "三族虚拟包身份不得互相覆盖");
  });

  void it("三族投影都产出 video 输出端口（同一族系的结果形态）", () => {
    for (const familyAdapterId of KLING_ADAPTER_IDS) {
      const entry = requireFamilyTemplate(familyAdapterId);
      if (entry.status !== "ready") continue;
      const projected = projectFamilyTemplate({
        familyAdapterId,
        buildBaseSources: entry.buildBaseSources,
        supportsMediaSlots: entry.supportsMediaSlots,
      });
      assert.ok(
        projected.projection.ports.outputs.some((port) => port.data_type === "video"),
        `${familyAdapterId} 必须产出 video 输出端口`,
      );
    }
  });
});

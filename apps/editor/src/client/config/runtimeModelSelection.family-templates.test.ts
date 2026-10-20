// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPayloadFromConfig } from "@/features/workspace/modelFormAdapter";
import * as runtimeFixtures from "./__tests__/fixtures/runtimeModelSelectionRealPackagesFixtures";
import {
  projectFamilyModel,
  supportedMediaSlotsOf,
} from "./__tests__/fixtures/familyTemplateProjectionFixtures";
import { setRuntimeProjectedModels } from "./models.config";
import {
  listRuntimeProjectedImageToImageModels,
  resolveRuntimeProjectedImageToImageModel,
} from "./runtimeModelSelection";

/**
 * 族模板投影 → Editor 表单 → payload 的整链测试。
 *
 * 历史：本文件原名 `runtimeModelSelection.real-packages.test.ts`，样本取自
 * 包目录下的真实能力包。2026-10-20 模型能力包退场、包目录删除后，样本改为
 * **族模板经真实投影管线产出的投影**（`familyTemplateProjectionFixtures`）。
 *
 * 覆盖范围随之收窄到「族模板能表达的形态」：qwen-image-max（dashscope 协议）与
 * doubao-seedream-4-5（另一套文生图协议）在契约的 7 个接口类型里都没有对应族，它们的 payload
 * 契约随包一起退役——不再有第二个入口能产出这两个 model_id，为它们保留测试就是给不存在的
 * 模型留保护。
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            url: "https://backend-owned.example/runtime-input.png",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
    ),
  );
});
afterEach(() => {
  setRuntimeProjectedModels([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GPT_IMAGE_MODEL_ID = "runtime-gpt-image-2";
const GEMINI_MODEL_ID = "runtime-gemini-image";
const VEO_MODEL_ID = "runtime-veo";

describe("runtimeModelSelection（族模板投影）", () => {
  it("族模板投影可提供 runtime i2i 候选", () => {
    const gptImage = projectFamilyModel({
      familyAdapterId: "openai-image-v1",
      modelId: GPT_IMAGE_MODEL_ID,
    }).projection;
    const gemini = projectFamilyModel({
      familyAdapterId: "gemini-image-interactions-v1",
      modelId: GEMINI_MODEL_ID,
    }).projection;
    const configs = runtimeFixtures.buildModelConfigsFromNodeProjections([
      gptImage,
      gemini,
    ]);

    setRuntimeProjectedModels(configs);

    const imageToImageModelIds = listRuntimeProjectedImageToImageModels().map(
      (item) => item.modelId,
    );
    expect(imageToImageModelIds).toContain(GPT_IMAGE_MODEL_ID);
    expect(imageToImageModelIds).toContain(GEMINI_MODEL_ID);
    expect(resolveRuntimeProjectedImageToImageModel(GPT_IMAGE_MODEL_ID)).not.toBeNull();
    // 未投影的 id 不是 i2i 候选
    expect(resolveRuntimeProjectedImageToImageModel("not-a-projected-model")).toBeNull();
  });

  it("openai-image 族使用 constrained imageSize 并生成正式 payload", async () => {
    const projection = projectFamilyModel({
      familyAdapterId: "openai-image-v1",
      modelId: GPT_IMAGE_MODEL_ID,
    }).projection;

    expect(projection.runtime?.payload_rules?.["body.model"]).toMatchObject({
      kind: "literal",
      value: GPT_IMAGE_MODEL_ID,
    });
    // body.n 是 when 规则：image 非空时不输出，image 为空时 literal 1
    const bodyNRule = projection.runtime?.payload_rules?.["body.n"] as
      | { kind?: string; falsy?: { kind?: string; value?: unknown } }
      | undefined;
    expect(bodyNRule?.kind).toBe("when");
    expect(bodyNRule?.falsy).toMatchObject({
      kind: "literal",
      value: 1,
    });

    const sizeField = projection.parameter_schema.fields.find(
      (field) => field.field_key === "size",
    );
    expect(sizeField?.component).toBe("imageSize");
    const componentProps = sizeField?.component_props;
    expect(componentProps).toMatchObject({
      mode: "constrainedResolution",
      allowAuto: true,
      sizeLevels: [
        { id: "1k", pixelBudget: 1048576 },
        { id: "2k", pixelBudget: 4194304 },
        { id: "4k", pixelBudget: 8294400 },
      ],
      constraints: {
        dimensionMultiple: 16,
        maxLongEdge: 3840,
        minPixels: 655360,
        maxPixels: 8294400,
        maxAspectRatio: 3,
      },
    });
    const aspectPresetsValue = componentProps?.["aspectPresets"];
    const aspectPresets = Array.isArray(aspectPresetsValue) ? aspectPresetsValue : [];
    expect(aspectPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "16:9", ratio: 1.7777777778 }),
        expect.objectContaining({ id: "9:16", ratio: 0.5625 }),
      ]),
    );
    const formatField = projection.parameter_schema.fields.find(
      (field) => field.field_key === "format",
    );
    expect(formatField).toMatchObject({
      component: "select",
      required: false,
      default_value: "jpeg",
    });
    expect(formatField?.enum_options?.map((option) => option.value)).toEqual([
      "png",
      "jpeg",
      "webp",
    ]);
    // 枚举文案是投影后的本地化 key（投影处不硬编码文案）
    const formatOptionLabels = (formatField?.enum_options ?? []).map(
      (option) => option.label ?? "",
    );
    expect(formatOptionLabels.length).toBeGreaterThan(0);
    expect(
      formatOptionLabels.every((label) => label.startsWith("model-asset/")),
    ).toBe(true);

    const config = runtimeFixtures.buildSingleConfig(projection);
    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "  draw a quiet studio  ",
      size: "2048x1152",
    })) as {
      body?: Record<string, unknown>;
      prompt?: string;
      input?: string;
      meta?: Record<string, unknown>;
    };

    expect(payload.body).toMatchObject({
      model: GPT_IMAGE_MODEL_ID,
      prompt: "draw a quiet studio",
      n: 1,
      size: "2048x1152",
      quality: "auto",
      output_format: "jpeg",
      moderation: "auto",
    });
    // wire 报文不得出现 OpenAI Images API 未定义的 format 字段
    expect(payload.body).not.toHaveProperty("format");
    expect(payload.prompt).toBe("draw a quiet studio");
    expect(payload.input).toBe("draw a quiet studio");
    expect(payload.meta?.["size"]).toBe("2048x1152");
  });

  it("openai-image 族按 payload_format_rule 在 json 与 multipart 之间切换", async () => {
    const projection = projectFamilyModel({
      familyAdapterId: "openai-image-v1",
      modelId: GPT_IMAGE_MODEL_ID,
    }).projection;
    expect(projection.runtime?.url_input_upload_mode).toBeUndefined();
    const payloadFormatRule = projection.runtime?.payload_format_rule;
    expect(payloadFormatRule?.kind).toBe("when");
    expect(JSON.stringify(payloadFormatRule ?? {})).toContain('"multipart"');

    const config = runtimeFixtures.buildSingleConfig(projection);

    const editPayload = await buildPayloadFromConfig(config, {
      __prompt: "  gpt edit  ",
      image: [
        { id: "edit-source", file: new Blob(["edit-source"], { type: "image/png" }) },
      ],
      size: "2048x2048",
    });

    expect(editPayload.api).toMatchObject({
      endpoint: "/v1/images/edits",
      method: "POST",
      contentType: null,
    });
    expect(editPayload.body).toBeInstanceOf(FormData);
    if (!(editPayload.body instanceof FormData)) return;
    expect(editPayload.body.get("model")).toBe(GPT_IMAGE_MODEL_ID);
    expect(editPayload.body.get("prompt")).toBe("gpt edit");
    expect(editPayload.body.get("size")).toBe("2048x2048");
    expect(editPayload.body.get("image")).toBeInstanceOf(Blob);
    // edits multipart 路径同样发送官方字段 output_format，且不再发送 format
    expect(editPayload.body.get("output_format")).toBe("jpeg");
    expect(editPayload.body.get("format")).toBeNull();

    const textPayload = await buildPayloadFromConfig(config, {
      __prompt: "  gpt text  ",
      image: [],
    });

    expect(textPayload.api).toMatchObject({
      endpoint: "/v1/images/generations",
      contentType: "application/json",
    });
    expect(textPayload.body).toMatchObject({
      model: GPT_IMAGE_MODEL_ID,
      prompt: "gpt text",
      image: null,
      n: 1,
      size: "auto",
      output_format: "jpeg",
    });
    // t2i JSON 路径同样不得出现 format 字段
    expect(textPayload.body).not.toHaveProperty("format");
  });

  it("gemini-image 族用纯 DSL 构建结构化输入与尺寸归一化规则", async () => {
    // 该族只有一个素材位（参考图）：全开形态即「带图」形态。
    expect(supportedMediaSlotsOf("gemini-image-interactions-v1")).toEqual([
      "reference_image",
    ]);
    const projection = projectFamilyModel({
      familyAdapterId: "gemini-image-interactions-v1",
      modelId: GEMINI_MODEL_ID,
    }).projection;

    expect(projection.runtime?.payload_rules?.["body.input"]).toMatchObject({
      kind: "compute",
      operator: "build_content_blocks",
    });
    const responseFormat = projection.runtime?.payload_rules?.[
      "body.response_format"
    ] as
      | { kind?: string; operator?: string; entries?: Record<string, unknown> }
      | undefined;
    expect(responseFormat).toMatchObject({
      kind: "compute",
      operator: "compact_object",
    });
    // image_size 是「空值不发」的 when 守卫，真值侧才是归一枚举（族模板的当前形态）
    expect(responseFormat?.entries?.["image_size"]).toMatchObject({
      kind: "when",
      truthy: {
        kind: "compute",
        operator: "normalize_enum",
      },
    });

    const config = runtimeFixtures.buildSingleConfig(projection);
    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "test",
      aspectRatio: "auto",
      imageSize: "bad",
      image: ["data:image/png;base64,R0VNSU5J"],
    })) as { body?: Record<string, unknown> };

    expect(payload.body?.["input"]).toMatchObject([
      {
        role: "user",
        parts: [
          { text: "test" },
          { inline_data: { mime_type: "image/png", data: "R0VNSU5J" } },
        ],
      },
    ]);
    expect(payload.body?.["response_format"]).toMatchObject({
      type: "image",
      // aspectRatio=auto 时不下发 aspect_ratio（when 规则丢弃该键）
      image_size: "1K",
    });
    expect(
      runtimeFixtures.readRecordProperty(payload.body, "response_format")?.[
        "aspect_ratio"
      ],
    ).toBeUndefined();
  });

  it("veo 族已迁成纯 DSL aspect ratio 归一化规则", async () => {
    const projection = projectFamilyModel({
      familyAdapterId: "veo-v1",
      modelId: VEO_MODEL_ID,
    }).projection;

    const parameters = projection.runtime?.payload_rules?.["body.parameters"] as
      | { entries?: Record<string, unknown> }
      | undefined;
    expect(parameters?.entries?.["aspectRatio"]).toMatchObject({
      kind: "compute",
      operator: "normalize_enum",
    });

    const config = runtimeFixtures.buildSingleConfig(projection);
    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "  veo ratio  ",
      aspectRatio: "bad-ratio",
      firstFrameImage: [],
      lastFrameImage: [],
    })) as { body?: Record<string, unknown>; meta?: Record<string, unknown> };

    expect(payload.body?.["parameters"]).toMatchObject({
      aspectRatio: "16:9",
    });
    expect(payload.meta).toMatchObject({
      aspectRatio: "bad-ratio",
    });
  });
});

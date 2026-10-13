// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildPayloadFromConfig } from "@/features/workspace/modelFormAdapter";
import * as runtimeFixtures from "./__tests__/fixtures/runtimeModelSelectionRealPackagesFixtures";
import { setRuntimeProjectedModels } from "./models.config";
import {
  listRuntimeProjectedImageToImageModels,
  resolveRuntimeProjectedImageToImageModel,
} from "./runtimeModelSelection";
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
describe("runtimeModelSelection.real-packages", () => {
  it("真实资产包可提供 runtime i2i 候选", () => {
    const projections = runtimeFixtures.loadPackageProjections();
    const configs =
      runtimeFixtures.buildModelConfigsFromNodeProjections(projections);

    setRuntimeProjectedModels(configs);

    expect(projections.length).toBeGreaterThan(10);

    const imageToImageModelIds = listRuntimeProjectedImageToImageModels().map(
      (item) => item.modelId,
    );
    expect(imageToImageModelIds).toContain("gemini-3-pro-image");
    expect(imageToImageModelIds).toContain("gemini-3.1-flash-image");
    expect(imageToImageModelIds).toContain("gemini-3.1-flash-lite-image");
    // 合并后 gpt-image-2 单节点同时支持文生图与图生图，因此也是 i2i 候选；
    // gpt-image-2-edit 不再是独立 model_id（已通过 alias 合并入 gpt-image-2）。
    expect(imageToImageModelIds).toContain("gpt-image-2");
    expect(imageToImageModelIds).not.toContain("gpt-image-2-edit");
    expect(
      resolveRuntimeProjectedImageToImageModel("gemini-3.1-flash-image"),
    ).not.toBeNull();
    expect(
      resolveRuntimeProjectedImageToImageModel("gpt-image-2"),
    ).not.toBeNull();
  });

  it("真实资产投影的纯 DSL 规则可生成 payload", async () => {
    const qwenProjection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "qwen-image-max");
    expect(qwenProjection).toBeTruthy();
    expect(qwenProjection?.runtime?.payload_rules?.["body.size"]).toMatchObject(
      {
        kind: "compute",
        operator: "normalize_enum",
      },
    );
    expect(
      qwenProjection?.runtime?.payload_rules?.["body.prompt"],
    ).toMatchObject({
      kind: "field",
      field_key: "__prompt",
      transforms: ["trim"],
    });

    const config = runtimeFixtures.buildSingleConfig(qwenProjection);
    expect(typeof config?.adapter?.generate).toBe("function");

    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "  hello asset runtime  ",
      size: "bad-size",
      watermark: true,
      promptExtend: false,
    })) as { body?: Record<string, unknown> };

    expect(payload.body).toMatchObject({
      model: "qwen-image-max",
      prompt: "hello asset runtime",
      watermark: true,
      prompt_extend: false,
    });
    expect(payload.body?.["size"]).toBe("1664x928");
  });

  it("gpt-image-2 真实资产包使用 constrained imageSize 并生成正式 payload", async () => {
    const projection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gpt-image-2");
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.payload_rules?.["body.model"]).toMatchObject({
      kind: "literal",
      value: "gpt-image-2",
    });
    // 合并后 body.n 是 when 规则：image 非空时不输出，image 为空时 literal 1（与原 gpt-image-2 包一致）
    const bodyNRule = projection?.runtime?.payload_rules?.["body.n"] as
      | { kind?: string; falsy?: { kind?: string; value?: unknown } }
      | undefined;
    expect(bodyNRule?.kind).toBe("when");
    expect(bodyNRule?.falsy).toMatchObject({
      kind: "literal",
      value: 1,
    });
    // 输出格式统一为官方字段 output_format：t2i JSON 与 edits multipart 两条路径都透传 format 值，
    // 不再存在 body.format 的 when 规则（旧「有图时置 null」分支已移除）。
    expect(projection?.runtime?.payload_rules?.["body.format"]).toBeUndefined();
    expect(projection?.runtime?.payload_rules?.["body.output_format"]).toMatchObject({
      kind: "field",
      field_key: "format",
    });
    expect(projection?.runtime?.payload_rules?.["body.quality"]).toMatchObject({
      kind: "field",
      field_key: "quality",
    });
    expect(projection?.runtime?.payload_rules?.["body.moderation"]).toMatchObject({
      kind: "field",
      field_key: "moderation",
    });
    const rawRuntimeModel = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), ".model-assets", "packages", "gpt-image-2", "runtime_model.json"),
        "utf-8",
      ),
    ) as {
      result_output_mapping?: {
        output_mapping_rules?: Array<{ source?: Record<string, unknown> }>;
      };
    };
    expect(rawRuntimeModel.result_output_mapping?.output_mapping_rules?.[0]?.source).toMatchObject({
      kind: "response",
      path: "data",
    });

    const sizeField = projection?.parameter_schema.fields.find(
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
    const aspectPresets = Array.isArray(aspectPresetsValue)
      ? aspectPresetsValue
      : [];
    expect(aspectPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "16:9", ratio: 1.7777777778 }),
        expect.objectContaining({ id: "9:16", ratio: 0.5625 }),
      ]),
    );
    const formatField = projection?.parameter_schema.fields.find(
      (field) => field.field_key === "format",
    );
    expect(formatField).toMatchObject({
      component: "select",
      required: false,
      default_value: "jpeg",
      enum_options: [
        { value: "png", label: "fields.format.options.png.label" },
        { value: "jpeg", label: "fields.format.options.jpeg.label" },
        { value: "webp", label: "fields.format.options.webp.label" },
      ],
    });

    const config = runtimeFixtures.buildSingleConfig(projection);
    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "  draw a quiet studio  ",
      size: "2048x1152",
    })) as { body?: Record<string, unknown>; prompt?: string; input?: string; meta?: Record<string, unknown> };

    expect(payload.body).toMatchObject({
      model: "gpt-image-2",
      prompt: "draw a quiet studio",
      n: 1,
      size: "2048x1152",
      quality: "auto",
      output_format: "jpeg",
      moderation: "auto",
    });
    expect(payload.body?.["output_format"]).toBe("jpeg");
    // wire 报文不得再出现 OpenAI Images API 未定义的 format 字段
    expect(payload.body).not.toHaveProperty("format");
    expect(payload.prompt).toBe("draw a quiet studio");
    expect(payload.input).toBe("draw a quiet studio");
    expect(payload.meta?.["size"]).toBe("2048x1152");
  });

  it("gpt-image-2 真实资产包按 payload_format_rule 在 json 与 multipart 之间切换", async () => {
    const projection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gpt-image-2");
    expect(projection).toBeTruthy();
    expect(projection?.runtime?.url_input_upload_mode).toBeUndefined();
    const payloadFormatRule = projection?.runtime?.payload_format_rule;
    expect(payloadFormatRule?.kind).toBe("when");
    expect(
      JSON.stringify(payloadFormatRule ?? {}),
    ).toContain('"multipart"');

    const config = runtimeFixtures.buildSingleConfig(projection);

    const editPayload = await buildPayloadFromConfig(config, {
      __prompt: "  gpt edit  ",
      image: [{ id: "edit-source", file: new Blob(["edit-source"], { type: "image/png" }) }],
      size: "2048x2048",
    });

    expect(editPayload.api).toMatchObject({
      endpoint: "/v1/images/edits",
      method: "POST",
      contentType: null,
    });
    expect(editPayload.body).toBeInstanceOf(FormData);
    if (!(editPayload.body instanceof FormData)) return;
    expect(editPayload.body.get("model")).toBe("gpt-image-2");
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
      model: "gpt-image-2",
      prompt: "gpt text",
      image: null,
      n: 1,
      size: "auto",
      output_format: "jpeg",
    });
    // t2i JSON 路径同样不得出现 format 字段
    expect(textPayload.body).not.toHaveProperty("format");
  });

  it("gemini 图片真实资产包已迁成纯 DSL 结构化输入与尺寸归一化规则", async () => {
    const gemini3ProProjection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gemini-3-pro-image");
    const gemini31Projection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gemini-3.1-flash-image");
    const gemini31LiteProjection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gemini-3.1-flash-lite-image");

    [gemini3ProProjection, gemini31Projection, gemini31LiteProjection].forEach(
      (projection) => {
        expect(projection).toBeTruthy();
        expect(projection?.runtime?.payload_rules?.["body.input"]).toMatchObject({
          kind: "compute",
          operator: "build_content_blocks",
        });
        const responseFormat = projection?.runtime?.payload_rules?.[
          "body.response_format"
        ] as
          | { kind?: string; operator?: string; entries?: Record<string, unknown> }
          | undefined;
        expect(responseFormat).toMatchObject({
          kind: "compute",
          operator: "compact_object",
        });
        expect(responseFormat?.entries?.["image_size"]).toMatchObject({
          kind: "compute",
          operator: "normalize_enum",
        });
      },
    );

    const gemini3ProConfig =
      runtimeFixtures.buildSingleConfig(gemini3ProProjection);
    const gemini31LiteConfig =
      runtimeFixtures.buildSingleConfig(gemini31LiteProjection);

    const gemini3ProPayload = (await buildPayloadFromConfig(gemini3ProConfig, {
      __prompt: "test",
      aspectRatio: "auto",
      imageSize: "bad",
      image: ["data:image/png;base64,R0VNSU5J"],
    })) as { body?: Record<string, unknown> };
    const gemini31LitePayload = (await buildPayloadFromConfig(
      gemini31LiteConfig,
      {
        __prompt: "test",
        aspectRatio: "auto",
        imageSize: "bad",
        image: ["data:image/png;base64,R0VNSU5J"],
      },
    )) as { body?: Record<string, unknown> };

    expect(gemini3ProPayload.body?.["input"]).toMatchObject([
      {
        role: "user",
        parts: [
          { text: "test" },
          { inline_data: { mime_type: "image/png", data: "R0VNSU5J" } },
        ],
      },
    ]);
    expect(gemini3ProPayload.body?.["response_format"]).toMatchObject({
      type: "image",
      // aspectRatio=auto 时不下发 aspect_ratio（when 规则丢弃该键）
      image_size: "1K",
    });
    expect(
      runtimeFixtures.readRecordProperty(
        gemini3ProPayload.body,
        "response_format",
      )?.["aspect_ratio"],
    ).toBeUndefined();
    // gemini-3.1-flash-lite-image 只允许 1K，非法值同样回退 1K
    expect(gemini31LitePayload.body?.["response_format"]).toMatchObject({
      image_size: "1K",
    });

    const geminiImageModelIds = [
      "gemini-3-pro-image",
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-lite-image",
    ];
    for (const modelId of geminiImageModelIds) {
      const rawRuntimeModel = JSON.parse(
        fs.readFileSync(
          path.join(
            process.cwd(),
            ".model-assets",
            "packages",
            modelId,
            "runtime_model.json",
          ),
          "utf-8",
        ),
      ) as {
        result_output_mapping?: {
          output_mapping_rules?: Array<{
            target?: unknown;
            required?: unknown;
            source?: { path?: unknown };
          }>;
        };
      };
      const rules =
        rawRuntimeModel.result_output_mapping?.output_mapping_rules ?? [];
      const imageRules = rules.filter(
        (rule) => rule.target === "output.image_url",
      );
      expect(imageRules.length).toBeGreaterThan(0);
      expect(imageRules.every((rule) => rule.required === true)).toBe(true);
      const textRules = rules.filter((rule) => rule.target === "output.text");
      expect(textRules.length).toBeGreaterThan(0);
      expect(
        textRules.some((rule) => rule.source?.path === "candidates"),
      ).toBe(false);
    }
  });

  it("veo 系列真实资产包已迁成纯 DSL aspect ratio 归一化规则", async () => {
    const veoProjection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "veo-3.1-generate-preview");
    const veoFastProjection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "veo-3.1-fast-generate-preview");

    expect(veoProjection).toBeTruthy();
    expect(veoFastProjection).toBeTruthy();

    const readAspectRatioRule = (projection: typeof veoProjection) => {
      const parameters = projection?.runtime?.payload_rules?.[
        "body.parameters"
      ] as { entries?: Record<string, unknown> } | undefined;
      return parameters?.entries?.["aspectRatio"];
    };

    expect(readAspectRatioRule(veoProjection)).toMatchObject({
      kind: "compute",
      operator: "normalize_enum",
    });
    expect(readAspectRatioRule(veoFastProjection)).toMatchObject({
      kind: "compute",
      operator: "normalize_enum",
    });

    const config = runtimeFixtures.buildSingleConfig(veoProjection);
    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "  veo ratio  ",
      aspectRatio: "bad-ratio",
      firstFrameImage: [],
      lastFrameImage: [],
      referenceImages: [],
    })) as { body?: Record<string, unknown>; meta?: Record<string, unknown> };

    expect(payload.body?.["parameters"]).toMatchObject({
      aspectRatio: "16:9",
    });
    expect(payload.meta).toMatchObject({
      aspectRatio: "bad-ratio",
    });
  });

  it("doubao-seedream-4-5-251128 真实资产包原样穿透媒体对象，提交时由 taskFacade 归一化", async () => {
    const projection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "doubao-seedream-4-5-251128");
    expect(projection).toBeTruthy();
    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "  seedream package  ",
      images: [
        {
          id: "img-1",
          file: new Blob(["seedream-image"], { type: "image/png" }),
        },
      ],
      size: "2048x2048",
    })) as { body?: Record<string, unknown>; prompt?: string };

    expect(runtimeFixtures.readOptionalString(payload, "prompt")).toBe(
      "seedream package",
    );
    const images: unknown[] = Array.isArray(payload.body?.["image"])
      ? payload.body["image"]
      : [];
    expect(images).toHaveLength(1);
    // 媒体对象原样穿透 payload，提交时由 taskFacade 归一化为 media_inputs
    const image = images[0];
    expect(typeof image).toBe("object");
    expect(image).not.toBeNull();
    expect(image).toMatchObject({ id: "img-1" });
  });
});

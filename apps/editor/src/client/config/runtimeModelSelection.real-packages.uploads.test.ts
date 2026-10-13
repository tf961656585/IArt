// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPayloadFromConfig } from "@/features/workspace/modelFormAdapter";
import * as runtimeFixtures from "./__tests__/fixtures/runtimeModelSelectionRealPackagesFixtures";
import { setRuntimeProjectedModels } from "./models.config";

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

describe("runtimeModelSelection.real-packages.uploads", () => {
  it("正式 schema 为 images 的真实包已显式暴露 images 输入端口", () => {
    const projections = runtimeFixtures.loadPackageProjections();
    const packageIds = [
      "doubao-seedream-4-5-251128",
    ] as const;

    packageIds.forEach((packageId) => {
      const projection = projections.find(
        (item) => item.model_id === packageId,
      );
      expect(projection).toBeTruthy();
      expect(projection?.ports.inputs.map((port) => port.id)).toEqual([
        "images",
      ]);
      const payloadRuleText = JSON.stringify(
        projection?.runtime?.payload_rules ?? {},
      );
      expect(payloadRuleText).toContain('"field_key":"images"');
    });

    const klingProjection = projections.find(
      (item) => item.model_id === "kling-v3-image2video",
    );
    expect(klingProjection?.ports.inputs.map((port) => port.id)).not.toContain(
      "images",
    );
  });

  it("首批真实包已退出 legacy_schema_compute", () => {
    const projections = runtimeFixtures.loadPackageProjections();

    // 全量扫描：现存真实包不得再出现 legacy_schema_compute 兜底
    projections.forEach((projection) => {
      expect(
        JSON.stringify(projection?.runtime?.payload_rules ?? {}),
      ).not.toContain("legacy_schema_compute");
    });

    const packageIds = [
      "gemini-3-pro-image",
      "kling-v3-image2video",
    ];

    packageIds.forEach((packageId) => {
      const projection = projections.find(
        (item) => item.model_id === packageId,
      );
      expect(projection).toBeTruthy();
      expect(
        JSON.stringify(projection?.runtime?.payload_rules ?? {}),
      ).not.toContain("legacy_schema_compute");
    });

    const geminiProjection = projections.find(
      (item) => item.model_id === "gemini-3-pro-image",
    );
    const klingImageProjection = projections.find(
      (item) => item.model_id === "kling-v3-image2video",
    );

    expect(
      geminiProjection?.runtime?.payload_rules?.["body.input"],
    ).toMatchObject({
      kind: "compute",
      operator: "build_content_blocks",
    });
    expect(
      klingImageProjection?.runtime?.payload_rules?.["body.contents"],
    ).toMatchObject({
      kind: "compute",
      operator: "compact_array",
    });
    const klingContentsText = JSON.stringify(
      klingImageProjection?.runtime?.payload_rules?.["body.contents"] ?? {},
    );
    expect(klingContentsText).toContain('"assert_non_empty"');
    expect(klingContentsText).toContain('"media_target":"public_url"');
  });

  it("public_relay 真实包 target_type 期望表与实际集合完全一致", () => {
    const projections = runtimeFixtures.loadPackageProjections();
    const actualPublicRelay = projections
      .filter((item) => item.runtime?.url_input_upload_mode === "public_relay")
      .map((item) => item.model_id)
      .sort();
    const expectedPublicRelay = Object.keys(
      runtimeFixtures.EXPECTED_PUBLIC_RELAY_TARGET_TYPES,
    ).sort();

    expect(actualPublicRelay).toEqual(expectedPublicRelay);

    Object.entries(runtimeFixtures.EXPECTED_PUBLIC_RELAY_TARGET_TYPES).forEach(
      ([modelId, targetType]) => {
        const projection = projections.find(
          (item) => item.model_id === modelId,
        );
        expect(projection).toBeTruthy();
        expect(projection?.runtime?.url_input_upload_mode).toBe("public_relay");
        expect(projection?.runtime?.url_input_upload_target_type).toBe(
          targetType,
        );
        if (projection?.runtime?.execution_driver === "http_formal_task") {
          // 新口径：上传 transform 或 media_target=public_url 原样穿透（提交时归一化为 media_inputs）
          expect(
            JSON.stringify(projection?.runtime?.payload_rules ?? {}),
          ).toMatch(
            /extractUrls|extractFirstUrl|prepare_audio_url|"media_target":"public_url"/,
          );
        }
      },
    );

    // 不使用 public_relay 的包不得声明 public_relay 专属上传目标
    const seedreamProjection = projections.find(
      (item) => item.model_id === "doubao-seedream-4-5-251128",
    );
    expect(seedreamProjection?.runtime?.url_input_upload_mode).toBeUndefined();
    expect(
      seedreamProjection?.runtime?.url_input_upload_target_type,
    ).toBeUndefined();
  });

  it("gemini-3-pro-image 真实包已用 build_content_blocks 生成 Gemini 输入块", async () => {
    const projection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gemini-3-pro-image");
    expect(projection).toBeTruthy();
    expect(
      projection?.runtime?.payload_rules?.["body.input"],
    ).toMatchObject({
      kind: "compute",
      operator: "build_content_blocks",
    });

    const config = runtimeFixtures.buildSingleConfig(projection);

    const payload = (await buildPayloadFromConfig(config, {
      __prompt: "  package gemini  ",
      image: ["data:image/png;base64,R0VNSU5J"],
      aspectRatio: "bad",
      imageSize: "bad",
      mimeType: "image/png",
    })) as { body?: Record<string, unknown> };

    expect(payload.body?.["input"]).toMatchObject([
      {
        role: "user",
        parts: [
          { text: "package gemini" },
          { inline_data: { mime_type: "image/png", data: "R0VNSU5J" } },
        ],
      },
    ]);
    expect(payload.body?.["response_format"]).toMatchObject({
      type: "image",
      aspect_ratio: "bad",
      // imageSize 非法值回退到包声明的 fallback
      image_size: "1K",
      mime_type: "image/png",
    });
    expect(payload.body?.["model"]).toBe("gemini-3-pro-image");
  });

  it("gemini-3.1-flash-image 真实包会透传 512 并保留非法值回退", async () => {
    const projection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gemini-3.1-flash-image");
    expect(projection).toBeTruthy();
    const responseFormatRule = projection?.runtime?.payload_rules?.[
      "body.response_format"
    ] as
      | {
          entries?: {
            image_size?: { options?: { allowed_values?: unknown[] } };
          };
        }
      | undefined;
    expect(
      responseFormatRule?.entries?.image_size?.options?.allowed_values,
    ).toContain("512");

    const config = runtimeFixtures.buildSingleConfig(projection);

    const fallbackPayload = (await buildPayloadFromConfig(config, {
      __prompt: "  package gemini  ",
      image: ["data:image/png;base64,R0VNSU5J"],
      aspectRatio: "bad",
      imageSize: "bad",
    })) as { body?: Record<string, unknown> };

    expect(fallbackPayload.body?.["response_format"]).toMatchObject({
      aspect_ratio: "bad",
      image_size: "1K",
    });

    const validPayload = (await buildPayloadFromConfig(config, {
      __prompt: "  package gemini  ",
      image: ["data:image/png;base64,R0VNSU5J"],
      aspectRatio: "1:8",
      imageSize: "512",
    })) as { body?: Record<string, unknown> };

    expect(validPayload.body?.["response_format"]).toMatchObject({
      aspect_ratio: "1:8",
      image_size: "512",
    });
  });

  it("gpt-image-2 真实包在图片数量越界时应阻断，而不是静默降级", async () => {
    const projection = runtimeFixtures
      .loadPackageProjections()
      .find((item) => item.model_id === "gpt-image-2");
    expect(projection).toBeTruthy();
    expect(
      projection?.runtime?.payload_rules?.["body.image"],
    ).toMatchObject({
      kind: "when",
    });
    const imageRuleText = JSON.stringify(
      projection?.runtime?.payload_rules?.["body.image"] ?? {},
    );
    expect(imageRuleText).toContain('"operator":"assert_array_length"');
    expect(imageRuleText).toContain('"min_items":1');
    expect(imageRuleText).toContain('"max_items":16');

    const config = runtimeFixtures.buildSingleConfig(projection);

    const tooManyImages = Array.from({ length: 17 }, (_item, index) => ({
      id: `too-many-${index}`,
      file: new Blob([`too-many-${index}`], { type: "image/png" }),
    }));
    await expect(
      buildPayloadFromConfig(config, {
        __prompt: "  批量编辑  ",
        image: tooManyImages,
      }),
    ).rejects.toThrow("请至少提供 1 张要编辑的图片。");

    const singleImage = await buildPayloadFromConfig(config, {
      __prompt: "  单图编辑  ",
      image: [
        { id: "single-edit", file: new Blob(["single-edit"], { type: "image/png" }) },
      ],
    });
    expect(singleImage.body).toBeInstanceOf(FormData);
    // edits multipart 路径发送官方字段 output_format，且不发送 OpenAI 未定义的 format
    if (singleImage.body instanceof FormData) {
      expect(singleImage.body.get("output_format")).toBe("jpeg");
      expect(singleImage.body.get("format")).toBeNull();
    }
  });

});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  ModelAssetLocalizationBundle,
  ModelAssetNodeProjection,
} from "@iart/contracts/model-asset-contract";

import { buildModelConfigFromNodeProjection } from "@/client/config/modelAssetProjectionBridge";
import {
  projectAllReadyFamilyModels,
  projectFamilyModel,
} from "@/client/config/__tests__/fixtures/familyTemplateProjectionFixtures";
import type {
  SchemaFieldDefinition,
  SchemaFieldOption,
  SchemaFormDefinition,
} from "@/features/workspace/schema/types";

/**
 * 投影本地化（族模板版）。
 *
 * 历史：本文件原名 `runtimeModelLocalization.real-packages.test.ts`，从包目录读真实包的
 * locales。2026-10-20 模型能力包退场、包目录删除后，样本改为**族模板经真实投影管线产出的
 * 投影与本地化束**：模板自带 zh-CN / en 两份 locales，经 `buildProjectionFromPackageSources`
 * 的 `validateLocalizationTargets` + `rewriteProjectionLocalizationKeys` 走同一条重写路径。
 *
 * 钉住的不变量不变：投影里的文案是**命名空间化的 key**（`model-asset/<packageId>:<keyPath>`），
 * 而不是硬编码文案；同一 key 在中英文都能解析；标题恒显示 model_id（不翻译）。
 */

type SupportedLocale = "zh-CN" | "en";

const project = (familyAdapterId: string, modelId: string) =>
  projectFamilyModel({ familyAdapterId, modelId });

const resolvePath = (resource: Record<string, unknown>, keyPath: string): unknown =>
  keyPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, resource);

const parseNamespacedKey = (
  value: string | undefined,
  bundle: ModelAssetLocalizationBundle,
): { bundle: ModelAssetLocalizationBundle; keyPath: string } | null => {
  const normalized = value?.trim();
  if (!normalized) return null;
  const separatorIndex = normalized.indexOf(":");
  if (separatorIndex <= 0) return null;
  const namespace = normalized.slice(0, separatorIndex);
  const keyPath = normalized.slice(separatorIndex + 1);
  if (namespace !== bundle.namespace || !keyPath) return null;
  return { bundle, keyPath };
};

const resolveModelAssetText = (
  locale: SupportedLocale,
  value: string | undefined,
  bundle: ModelAssetLocalizationBundle,
): string | undefined => {
  const parsed = parseNamespacedKey(value, bundle);
  if (!parsed) return undefined;
  const resolved = resolvePath(parsed.bundle.resources[locale], parsed.keyPath);
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined;
};

const loadSchema = async (
  projection: ModelAssetNodeProjection,
): Promise<SchemaFormDefinition<string>> => {
  const config = buildModelConfigFromNodeProjection(projection);
  expect(config).toBeTruthy();
  const form = config?.workspace?.form;
  expect(form && form.kind === "schema").toBeTruthy();
  const schemaModule = await (form as { kind: "schema"; load: () => Promise<unknown> }).load();
  return (
    (schemaModule as { default?: SchemaFormDefinition<string>; schema?: SchemaFormDefinition<string> })
      .default ??
    (schemaModule as { schema?: SchemaFormDefinition<string> }).schema ??
    schemaModule
  ) as SchemaFormDefinition<string>;
};

const expectLocalizedValue = (
  locale: SupportedLocale,
  value: string | undefined,
  expected: string,
  bundle: ModelAssetLocalizationBundle,
): void => {
  expect(value).toMatch(/^model-asset\/[^:]+:/);
  expect(resolveModelAssetText(locale, value, bundle)).toBe(expected);
};

type SchemaFieldWithOptions = Extract<SchemaFieldDefinition<string>, { options: unknown }>;

const hasStaticOptions = (
  field: SchemaFieldDefinition<string> | undefined,
): field is SchemaFieldWithOptions & { options: { kind: "static"; options: SchemaFieldOption[] } } => {
  if (!field || !("options" in field)) return false;
  const options = field.options as { kind?: unknown };
  return options.kind === "static";
};

const findStaticOption = (
  field: SchemaFieldDefinition<string> | undefined,
  expectedValue: unknown,
): SchemaFieldOption | undefined =>
  hasStaticOptions(field) ? field.options.options.find((option) => option.value === expectedValue) : undefined;

const readHelperTextKey = (field: SchemaFieldDefinition<string> | undefined): string | undefined =>
  field !== undefined && "helperTextKey" in field ? field.helperTextKey : undefined;

describe("投影本地化（族模板）", () => {
  it("全族投影都携带自己的命名空间与双语文案，标题显示 model_id", () => {
    const projections = projectAllReadyFamilyModels((familyAdapterId) => `loc-${familyAdapterId}`);
    // 至少一个族（否则断言退化成空循环）；每个投影必须配一份同名空间本地化束。
    expect(projections.length).toBeGreaterThan(0);

    for (const { projection, localizationBundle, packageId } of projections) {
      expect(localizationBundle.package_id).toBe(packageId);
      expect(localizationBundle.namespace).toBe(`model-asset/${packageId}`);
      expect(Object.keys(localizationBundle.resources).sort()).toEqual(["en", "zh-CN"]);

      const config = buildModelConfigFromNodeProjection(projection);
      expect(config).toBeTruthy();
      // 标题恒显示 model_id，不做翻译
      expect(config?.label).toBe(projection.model_id);
      // 模型级 i18n 已退役：文案只走投影内的命名空间 key
      expect(config?.i18n).toBeUndefined();

      // 字段 label 必须是命名空间 key，且中英文都能解析出非空文案
      const fieldsWithLabel = projection.parameter_schema.fields.filter(
        (field) => field.label.length > 0,
      );
      expect(fieldsWithLabel.length).toBeGreaterThan(0);
      for (const field of fieldsWithLabel) {
        expect(field.label.startsWith(`${localizationBundle.namespace}:`)).toBe(true);
        expect(resolveModelAssetText("zh-CN", field.label, localizationBundle)).toEqual(
          expect.any(String),
        );
        expect(resolveModelAssetText("en", field.label, localizationBundle)).toEqual(
          expect.any(String),
        );
      }
      // 端口名同理（输入端口可能为空，输出端口恒有）
      for (const port of [...projection.ports.inputs, ...projection.ports.outputs]) {
        expect(port.name.startsWith(`${localizationBundle.namespace}:`)).toBe(true);
        expect(resolveModelAssetText("zh-CN", port.name, localizationBundle)).toEqual(
          expect.any(String),
        );
        expect(resolveModelAssetText("en", port.name, localizationBundle)).toEqual(
          expect.any(String),
        );
      }
    }
  });

  it("veo 族：字段、帮助、枚举与端口名可在中英文解析", async () => {
    const MODEL_ID = "loc-veo-v1";
    const { projection, localizationBundle } = project("veo-v1", MODEL_ID);
    const schema = await loadSchema(projection);
    const config = buildModelConfigFromNodeProjection(projection);

    const firstFrameField = schema.fields.find((field) => field.key === "firstFrameImage");
    const aspectRatioField = schema.fields.find((field) => field.key === "aspectRatio");
    const aspectRatioOption = findStaticOption(aspectRatioField, "16:9");
    const outputPort = config?.nodeGraphPorts?.outputs?.find((port) => port.id === "video");

    const expectations = {
      "zh-CN": {
        field: "首帧",
        helper: "作为视频起始画面；建议不低于 720p，画幅为 16:9 或 9:16。",
        enumOption: "横屏 16:9",
        output: "生成视频",
      },
      en: {
        field: "First frame image",
        helper:
          "Image used as the opening frame; 720p or higher and a 16:9 or 9:16 frame is recommended.",
        enumOption: "Landscape 16:9",
        output: "Generated video",
      },
    } satisfies Record<SupportedLocale, Record<string, string>>;

    expect(config?.label).toBe(MODEL_ID);
    expect(config?.i18n).toBeUndefined();

    (["zh-CN", "en"] as const).forEach((locale) => {
      const expected = expectations[locale];
      expectLocalizedValue(locale, firstFrameField?.labelKey, expected.field, localizationBundle);
      expectLocalizedValue(
        locale,
        readHelperTextKey(firstFrameField),
        expected.helper,
        localizationBundle,
      );
      expectLocalizedValue(
        locale,
        aspectRatioOption?.labelKey,
        expected.enumOption,
        localizationBundle,
      );
      expectLocalizedValue(locale, outputPort?.name, expected.output, localizationBundle);
    });
  });

  it("可灵文生视频族：时长/比例/音频/多镜头与输出端口可在中英文解析", async () => {
    const MODEL_ID = "loc-kling-text2video";
    const { projection, localizationBundle } = project("kling-text2video-v1", MODEL_ID);
    const schema = await loadSchema(projection);
    const config = buildModelConfigFromNodeProjection(projection);

    const durationField = schema.fields.find((field) => field.key === "duration");
    const durationOption = findStaticOption(durationField, 5);
    const aspectRatioField = schema.fields.find((field) => field.key === "aspectRatio");
    const aspectRatioOption = findStaticOption(aspectRatioField, "16:9");
    const audioField = schema.fields.find((field) => field.key === "audio");
    const audioOption = findStaticOption(audioField, "native");
    const multiShotField = schema.fields.find((field) => field.key === "multiShot");
    const outputPort = config?.nodeGraphPorts?.outputs?.find((port) => port.id === "video");

    const expectations = {
      "zh-CN": {
        duration: "视频时长",
        durationOption: "5 秒",
        aspectRatioOption: "16:9 横屏",
        audioOption: "原生音频",
        multiShot: "多镜头",
        output: "视频",
      },
      en: {
        duration: "Duration",
        durationOption: "5 seconds",
        aspectRatioOption: "16:9 landscape",
        audioOption: "Native audio",
        multiShot: "Multi-shot",
        output: "Video",
      },
    } satisfies Record<SupportedLocale, Record<string, string>>;

    expect(config?.label).toBe(MODEL_ID);
    expect(config?.i18n).toBeUndefined();

    (["zh-CN", "en"] as const).forEach((locale) => {
      const expected = expectations[locale];
      expectLocalizedValue(locale, durationField?.labelKey, expected.duration, localizationBundle);
      expectLocalizedValue(
        locale,
        durationOption?.labelKey,
        expected.durationOption,
        localizationBundle,
      );
      expectLocalizedValue(
        locale,
        aspectRatioOption?.labelKey,
        expected.aspectRatioOption,
        localizationBundle,
      );
      expectLocalizedValue(locale, audioOption?.labelKey, expected.audioOption, localizationBundle);
      expectLocalizedValue(locale, multiShotField?.labelKey, expected.multiShot, localizationBundle);
      expectLocalizedValue(locale, outputPort?.name, expected.output, localizationBundle);
    });
  });

  it("可灵图生视频族：首/尾帧字段与输入端口可在中英文解析，分辨率枚举含 4K", async () => {
    const MODEL_ID = "loc-kling-image2video";
    const { projection, localizationBundle } = project("kling-image2video-v1", MODEL_ID);
    const schema = await loadSchema(projection);
    const config = buildModelConfigFromNodeProjection(projection);

    const firstFrameField = schema.fields.find((field) => field.key === "firstFrameImage");
    const lastFrameField = schema.fields.find((field) => field.key === "lastFrameImage");
    const resolutionField = schema.fields.find((field) => field.key === "resolution");
    const resolutionOption = findStaticOption(resolutionField, "4k");
    const firstFrameInputPort = config?.nodeGraphPorts?.inputs?.find(
      (port) => port.id === "firstFrameImage",
    );
    const lastFrameInputPort = config?.nodeGraphPorts?.inputs?.find(
      (port) => port.id === "lastFrameImage",
    );
    const outputPort = config?.nodeGraphPorts?.outputs?.find((port) => port.id === "video");

    const expectations = {
      "zh-CN": {
        firstFrame: "首帧",
        lastFrame: "尾帧",
        resolution: "4K",
        output: "视频",
      },
      en: {
        firstFrame: "First frame",
        lastFrame: "Last frame",
        resolution: "4K",
        output: "Video",
      },
    } satisfies Record<SupportedLocale, Record<string, string>>;

    expect(config?.label).toBe(MODEL_ID);
    expect(config?.i18n).toBeUndefined();

    (["zh-CN", "en"] as const).forEach((locale) => {
      const expected = expectations[locale];
      expectLocalizedValue(
        locale,
        firstFrameField?.labelKey,
        expected.firstFrame,
        localizationBundle,
      );
      expectLocalizedValue(locale, lastFrameField?.labelKey, expected.lastFrame, localizationBundle);
      expectLocalizedValue(
        locale,
        resolutionOption?.labelKey,
        expected.resolution,
        localizationBundle,
      );
      expectLocalizedValue(
        locale,
        firstFrameInputPort?.name,
        expected.firstFrame,
        localizationBundle,
      );
      expectLocalizedValue(locale, lastFrameInputPort?.name, expected.lastFrame, localizationBundle);
      expectLocalizedValue(locale, outputPort?.name, expected.output, localizationBundle);
    });
  });

  it("投影不再携带 Editor 全局模型资产文案 key", () => {
    const projections = projectAllReadyFamilyModels((familyAdapterId) => `loc-ns-${familyAdapterId}`);
    const serialized = JSON.stringify(projections.map((item) => item.projection));
    expect(serialized).not.toContain("pages:modelWorkspace");
    expect(serialized).not.toContain("models.");
    expect(serialized).not.toContain("models:");
  });
});

// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  ModelAssetLocalizationBundle,
  ModelAssetNodeProjection,
} from "@iart/contracts/model-asset-contract";

import { buildModelConfigFromNodeProjection } from "@/client/config/modelAssetProjectionBridge";
import {
  cloneModelAssetFixtureValue,
  loadModelAssetPackageCatalogFixture,
} from "@/client/config/__tests__/fixtures/modelAssetPackageProjectionFixtures";
import type {
  SchemaFieldDefinition,
  SchemaFieldOption,
  SchemaFormDefinition,
} from "@/features/workspace/schema/types";

type SupportedLocale = "zh-CN" | "en";

const catalog = loadModelAssetPackageCatalogFixture();
const projectionByModelId = new Map(
  catalog.projections.map((projection) => [projection.model_id, projection]),
);
const bundleByNamespace = new Map(
  catalog.localization_bundles.map((bundle) => [bundle.namespace, bundle]),
);

const loadProjection = (modelId: string): ModelAssetNodeProjection => {
  const projection = projectionByModelId.get(modelId);
  if (!projection) {
    throw new Error(`[real-packages] projection not found for model_id=${modelId}`);
  }
  return cloneModelAssetFixtureValue(projection);
};

const resolvePath = (resource: Record<string, unknown>, keyPath: string): unknown =>
  keyPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, resource);

const parseNamespacedKey = (
  value: string | undefined,
): { bundle: ModelAssetLocalizationBundle; keyPath: string } | null => {
  const normalized = value?.trim();
  if (!normalized) return null;
  const separatorIndex = normalized.indexOf(":");
  if (separatorIndex <= 0) return null;
  const namespace = normalized.slice(0, separatorIndex);
  const keyPath = normalized.slice(separatorIndex + 1);
  const bundle = bundleByNamespace.get(namespace);
  if (!bundle || !keyPath) return null;
  return { bundle, keyPath };
};

const resolveModelAssetText = (
  locale: SupportedLocale,
  value: string | undefined,
): string | undefined => {
  const parsed = parseNamespacedKey(value);
  if (!parsed) return undefined;
  const resolved = resolvePath(parsed.bundle.resources[locale], parsed.keyPath);
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined;
};

const resolveDisplayText = (locale: SupportedLocale, value: string | undefined): string | undefined =>
  resolveModelAssetText(locale, value) ?? value;

const loadSchema = async (modelId: string): Promise<SchemaFormDefinition<string>> => {
  const config = buildModelConfigFromNodeProjection(loadProjection(modelId));
  expect(config).toBeTruthy();
  const form = config?.workspace?.form;
  expect(form && form.kind === "schema").toBeTruthy();
  const schemaModule = await (form as { kind: "schema"; load: () => Promise<unknown> }).load();
  return (
    (schemaModule as { default?: SchemaFormDefinition<string>; schema?: SchemaFormDefinition<string> }).default ??
    (schemaModule as { schema?: SchemaFormDefinition<string> }).schema ??
    schemaModule
  ) as SchemaFormDefinition<string>;
};

const expectLocalizedValue = (
  locale: SupportedLocale,
  value: string | undefined,
  expected: string,
) => {
  expect(value).toMatch(/^model-asset\/[^:]+:/);
  expect(resolveDisplayText(locale, value)).toBe(expected);
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

describe("runtimeModelLocalization real packages", () => {
  it("真实包目录投影携带动态模型资产 namespace 与字段本地化资源", () => {
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.projections.length).toBeGreaterThan(0);
    expect(catalog.localization_bundles).toHaveLength(catalog.projections.length);

    const expectations = {
      "gemini-3-pro-image": {
        fieldKey: "model-asset/gemini-3-pro-image:fields.image.label",
      },
      "gemini-3.1-flash-image": {
        fieldKey: "model-asset/gemini-3.1-flash-image:fields.image.label",
      },
      "gemini-3.1-flash-lite-image": {
        fieldKey: "model-asset/gemini-3.1-flash-lite-image:fields.image.label",
      },
    } satisfies Record<string, { fieldKey: string }>;

    Object.entries(expectations).forEach(([modelId, expectation]) => {
      const projection = loadProjection(modelId);
      const config = buildModelConfigFromNodeProjection(projection);
      expect(config?.label).toBe(modelId);
      expect(config?.i18n).toBeUndefined();
      expect(resolveModelAssetText("zh-CN", expectation.fieldKey)).toEqual(expect.any(String));
      expect(resolveModelAssetText("en", expectation.fieldKey)).toEqual(expect.any(String));
    });
  });

  it("veo-3.1-generate-preview 的字段、帮助、枚举与端口名可在中英文解析，标题显示 model_id", async () => {
    const veoSchema = await loadSchema("veo-3.1-generate-preview");
    const veoConfig = buildModelConfigFromNodeProjection(loadProjection("veo-3.1-generate-preview"));
    const veoFirstFrame = veoSchema.fields.find((field) => field.key === "firstFrameImage");
    const veoAspectRatio = veoSchema.fields.find((field) => field.key === "aspectRatio");
    const veoAspectRatioOption = findStaticOption(veoAspectRatio, "16:9");
    const veoInputPort = veoConfig?.nodeGraphPorts?.inputs?.find((port) => port.id === "referenceImages");
    const veoOutputPort = veoConfig?.nodeGraphPorts?.outputs?.find((port) => port.id === "video");

    const expectations = {
      "zh-CN": {
        veoField: "首帧图",
        veoHelper: "作为视频起始画面的图像；建议不低于 720p，画幅为 16:9 或 9:16。",
        veoEnum: "横屏 16:9",
        veoInput: "参考图",
        veoOutput: "视频",
      },
      en: {
        veoField: "First frame image",
        veoHelper:
          "Image used as the opening frame; 720p or higher and a 16:9 or 9:16 frame is recommended.",
        veoEnum: "Landscape 16:9",
        veoInput: "Reference images",
        veoOutput: "Video",
      },
    } satisfies Record<SupportedLocale, Record<string, string>>;

    expect(veoConfig?.label).toBe("veo-3.1-generate-preview");
    expect(veoConfig?.i18n).toBeUndefined();

    (["zh-CN", "en"] as const).forEach((locale) => {
      expectLocalizedValue(locale, veoFirstFrame?.labelKey, expectations[locale].veoField);
      expectLocalizedValue(locale, readHelperTextKey(veoFirstFrame), expectations[locale].veoHelper);
      expectLocalizedValue(locale, veoAspectRatioOption?.labelKey, expectations[locale].veoEnum);
      expectLocalizedValue(locale, veoInputPort?.name, expectations[locale].veoInput);
      expectLocalizedValue(locale, veoOutputPort?.name, expectations[locale].veoOutput);
    });
  });

  it("kling-v3 两个真实包的字段、枚举与端口名可在中英文解析，标题显示 model_id", async () => {
    const textSchema = await loadSchema("kling-v3-text2video");
    const textConfig = buildModelConfigFromNodeProjection(loadProjection("kling-v3-text2video"));
    // prompt 已从 parameter_schema.fields 与 input_ports 剥离（方案 B），改用仍存在的
    // duration / aspectRatio / audio 字段做文本向字段本地化解码断言。
    const textDuration = textSchema.fields.find((field) => field.key === "duration");
    const textDurationOption = findStaticOption(textDuration, 5);
    const textAspectRatio = textSchema.fields.find((field) => field.key === "aspectRatio");
    const textAspectRatioOption = findStaticOption(textAspectRatio, "16:9");
    const textAudio = textSchema.fields.find((field) => field.key === "audio");
    const textAudioOption = findStaticOption(textAudio, "native");
    const textMultiShot = textSchema.fields.find((field) => field.key === "multiShot");
    const textOutputPort = textConfig?.nodeGraphPorts?.outputs?.find((port) => port.id === "video");

    const imageSchema = await loadSchema("kling-v3-image2video");
    const imageConfig = buildModelConfigFromNodeProjection(loadProjection("kling-v3-image2video"));
    const imageFirstFrameField = imageSchema.fields.find((field) => field.key === "firstFrameImage");
    const imageLastFrameField = imageSchema.fields.find((field) => field.key === "lastFrameImage");
    const imageResolution = imageSchema.fields.find((field) => field.key === "resolution");
    const imageResolutionOption = findStaticOption(imageResolution, "4k");
    const imageFirstFrameInputPort = imageConfig?.nodeGraphPorts?.inputs?.find((port) => port.id === "firstFrameImage");
    const imageLastFrameInputPort = imageConfig?.nodeGraphPorts?.inputs?.find((port) => port.id === "lastFrameImage");
    const imageOutputPort = imageConfig?.nodeGraphPorts?.outputs?.find((port) => port.id === "video");

    const expectations = {
      "zh-CN": {
        textDuration: "视频时长",
        textDurationOption: "5 秒",
        textAspectRatio: "16:9 横屏",
        textAudio: "原生音频",
        textMultiShot: "多镜头",
        textOutput: "视频",
        imageFirstFrameField: "首帧图",
        imageLastFrameField: "尾帧图",
        imageResolution: "4K",
        imageFirstFrameInput: "首帧图",
        imageLastFrameInput: "尾帧图",
        imageOutput: "视频",
      },
      en: {
        textDuration: "Duration",
        textDurationOption: "5 seconds",
        textAspectRatio: "16:9 landscape",
        textAudio: "Native audio",
        textMultiShot: "Multi-shot",
        textOutput: "Video",
        imageFirstFrameField: "First frame image",
        imageLastFrameField: "Last frame image",
        imageResolution: "4K",
        imageFirstFrameInput: "First frame image",
        imageLastFrameInput: "Last frame image",
        imageOutput: "Video",
      },
    } satisfies Record<SupportedLocale, Record<string, string>>;

    expect(textConfig?.label).toBe("kling-v3-text2video");
    expect(textConfig?.i18n).toBeUndefined();
    expect(imageConfig?.label).toBe("kling-v3-image2video");
    expect(imageConfig?.i18n).toBeUndefined();

    (["zh-CN", "en"] as const).forEach((locale) => {
      expectLocalizedValue(locale, textDuration?.labelKey, expectations[locale].textDuration);
      expectLocalizedValue(locale, textDurationOption?.labelKey, expectations[locale].textDurationOption);
      expectLocalizedValue(locale, textAspectRatioOption?.labelKey, expectations[locale].textAspectRatio);
      expectLocalizedValue(locale, textAudioOption?.labelKey, expectations[locale].textAudio);
      expectLocalizedValue(locale, textMultiShot?.labelKey, expectations[locale].textMultiShot);
      expectLocalizedValue(locale, textOutputPort?.name, expectations[locale].textOutput);

      expectLocalizedValue(locale, imageFirstFrameField?.labelKey, expectations[locale].imageFirstFrameField);
      expectLocalizedValue(locale, imageLastFrameField?.labelKey, expectations[locale].imageLastFrameField);
      expectLocalizedValue(locale, imageResolutionOption?.labelKey, expectations[locale].imageResolution);
      expectLocalizedValue(locale, imageFirstFrameInputPort?.name, expectations[locale].imageFirstFrameInput);
      expectLocalizedValue(locale, imageLastFrameInputPort?.name, expectations[locale].imageLastFrameInput);
      expectLocalizedValue(locale, imageOutputPort?.name, expectations[locale].imageOutput);
    });
  });

  it("真实投影不再携带 Editor 全局模型资产文案 key", () => {
    const serialized = JSON.stringify(catalog.projections);
    expect(serialized).not.toContain("pages:modelWorkspace");
    expect(serialized).not.toContain("models.");
    expect(serialized).not.toContain("models:");
  });
});

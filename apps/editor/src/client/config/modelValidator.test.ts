import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationAdapter } from "@/client/adapters/types";
import type { ModelConfigEntry } from "@/client/config/models.config";
import type { ModelWorkspaceFormConfig } from "@/features/workspace/modelFormTypes";

type ModelConfigEntryTestOverrides = {
  [K in keyof ModelConfigEntry]?: ModelConfigEntry[K] | undefined;
};

const createValidConfig = (overrides: ModelConfigEntryTestOverrides = {}): ModelConfigEntry => {
  const adapter: GenerationAdapter = {
     
    generate: async () => ({}),
  };

  const base: ModelConfigEntry = {
    providerId: "fal",
    groupId: "fal",
    label: "Valid Model",
    modelId: "valid-model",
    defaultTaskType: "image",
    mode: "image",
    adapter,
    defaults: undefined,
    visible: undefined,
    role: undefined,
    description: undefined,
    aliases: undefined,
    routeSegment: undefined,
    canvasPortSpec: {
      inputs: [
        {
          fieldKey: "prompt",
          canonicalKey: undefined,
          portId: undefined,
          dataType: undefined,
          required: undefined,
          multiple: undefined,
          description: undefined,
          defaultValue: undefined,
        },
      ],
    },
    workspace: {
      form: { load: () => ({}) } as ModelWorkspaceFormConfig,
      taskList: undefined,
      output: undefined,
      dock: undefined,
      taskQueue: undefined,
      resultExtractor: {
        videoPaths: undefined,
        imagePaths: ["images"],
        textPaths: undefined,
        excludePaths: undefined,
      },
    },
    i18n: undefined,
    nodeGraphPorts: undefined,
    videoGenMode: undefined,
    canvasInspector: undefined,
    capabilities: undefined,
    assetCapabilities: undefined,
    assetInputContract: undefined,
    variantGroup: undefined,
    };

  const next: Partial<ModelConfigEntry> = { ...base };
  for (const key of Object.keys(overrides) as Array<keyof ModelConfigEntry>) {
    const value = overrides[key];
    if (value === undefined) {
      delete next[key];
    } else {
      Object.assign(next, { [key]: value });
    }
  }
  return next as ModelConfigEntry;
};

describe("modelValidator.validateModelConfig", () => {
  it("有效配置不应产生错误", async () => {
    const { validateModelConfig } = await import("@/client/config/modelValidator");
    const errors = validateModelConfig(createValidConfig());
    expect(errors).toHaveLength(0);
  });

  it("缺少 generate 应报错", async () => {
    const { validateModelConfig } = await import("@/client/config/modelValidator");
    const config = createValidConfig({ adapter: {} as GenerationAdapter });
    const errors = validateModelConfig(config);
    expect(errors.some((e) => e.field === "adapter.generate" && e.severity === "error")).toBe(true);
  });

  it("缺少端口声明应给出 warning", async () => {
    const { validateModelConfig } = await import("@/client/config/modelValidator");
    const config = createValidConfig({ canvasPortSpec: undefined, nodeGraphPorts: undefined });
    const errors = validateModelConfig(config);
    expect(errors.some((e) => e.field === "canvasPortSpec" && e.severity === "warning")).toBe(true);
  });

});

describe("modelValidator.validateAllModels", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock("@/client/config/models.config");
  });

  it("重复 modelId 应记录警告（自动发现覆盖手动）", async () => {
    const cfgA = createValidConfig({ modelId: "duplicate-model" });
    const cfgB = createValidConfig({ modelId: "duplicate-model", label: "Dup" });

    vi.doMock("@/client/config/models.config", () => ({
      listModelConfigs: () => [cfgA, cfgB],
      listModelConfigsWithSource: () => ({ manual: [cfgA], auto: [cfgB], runtime: [] }),
    }));

    const { validateAllModels } = await import("@/client/config/modelValidator");
    const errors = validateAllModels();

    expect(errors.some((e) => e.field === "modelId" && e.severity === "warning")).toBe(true);
  });
});

describe("modelValidator.runStartupValidation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@/client/config/models.config");
  });

  it("development 环境下遇到 error 应抛出异常", async () => {
    const badConfig = createValidConfig({ adapter: {} as GenerationAdapter });

    vi.doMock("@/client/config/models.config", () => ({
      listModelConfigs: () => [badConfig],
      listModelConfigsWithSource: () => ({ manual: [badConfig], auto: [], runtime: [] }),
    }));

    const validator = await import("@/client/config/modelValidator");

    vi.stubEnv("NODE_ENV", "development");

    try {
      expect(() => validator.runStartupValidation()).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("仅 warning 时不应抛出", async () => {
    const warnConfig = createValidConfig({ i18n: undefined });

    vi.doMock("@/client/config/models.config", () => ({
      listModelConfigs: () => [warnConfig],
      listModelConfigsWithSource: () => ({ manual: [warnConfig], auto: [], runtime: [] }),
    }));

    const validator = await import("@/client/config/modelValidator");

    vi.stubEnv("NODE_ENV", "development");

    try {
      expect(() => validator.runStartupValidation()).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

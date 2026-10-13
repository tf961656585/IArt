import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("modelAutoDiscovery", () => {
  const modulePath = "@/features/models/processors/local/edge-detect/index";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock(modulePath);
  });

  it("应只发现本地 builtin 模型并返回正确配置", async () => {
    vi.doMock(modulePath, () => ({
      MODEL_DEFINITION: {
        providerId: "local",
        modelId: "edge-detect",
        label: "Edge Detect 自动发现(测试)",
        defaultTaskType: "image",
        mode: "image",
        adapter: { generate: async () => ({ ok: true }) },
      },
    }));

    const { discoverModels } = await import("@/client/config/modelAutoDiscovery");

    const configs = await discoverModels();
    const edgeDetect = configs.find((cfg) => cfg.modelId === "edge-detect");

    expect(configs).toHaveLength(1);
    expect(edgeDetect).toBeTruthy();
    expect(edgeDetect?.providerId).toBe("local");
    expect(typeof edgeDetect?.adapter.generate).toBe("function");
    expect(edgeDetect?.mode).toBe("image");
  });

  it("当模型定义无效时应被过滤", async () => {
    vi.doMock(modulePath, () => ({
      MODEL_DEFINITION: {
        providerId: "local",
        modelId: "invalid-model",
        label: "Invalid",
        defaultTaskType: "image",
        mode: "image",
        adapter: {},
      },
    }));

    const { discoverModels } = await import("@/client/config/modelAutoDiscovery");
    const configs = await discoverModels();

    expect(configs.some((cfg) => cfg.modelId === "invalid-model")).toBe(false);
  });
});

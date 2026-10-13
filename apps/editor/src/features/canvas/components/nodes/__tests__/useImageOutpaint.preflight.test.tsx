import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import type * as RuntimeModelSelectionNS from "@/client/config/runtimeModelSelection";
import type * as ImageOutpaintNS from "../../../services/imageOutpaint";
import { buildRuntimeProjectedConfigFixture } from "@/client/config/__tests__/fixtures/runtimeProjectionFixtures";
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts";
import { outpaintImageWithModel } from "../../../services/imageOutpaint";
import { useExecutionStore } from "../../../store/executionStore";
import { useImageOutpaint } from "../useImageOutpaint";
import type { ImageOutpaintDialogConfirmPayload } from "../../dialogs/imageOutpaintDialogTypes";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

// 提交点 mock：不提交断言以 outpaintImageWithModel 是否被调用为准
vi.mock("../../../services/imageOutpaint", async () => {
  const actual = await vi.importActual<typeof ImageOutpaintNS>(
    "../../../services/imageOutpaint",
  );
  return {
    ...actual,
    outpaintImageWithModel: vi.fn(),
  };
});

const BASE_OUTPAINT_CONFIG = buildRuntimeProjectedConfigFixture("gemini-3-pro-image");

// prompt 上限来源已从 loadModelSchema 迁移到 assetInputContract.promptMaxLength（方案 B），
// 测试用可变变量控制 mock 返回的 config 是否携带上限。
let promptMaxLength: number | undefined;

vi.mock("@/client/config/runtimeModelSelection", async () => {
  const actual = await vi.importActual<typeof RuntimeModelSelectionNS>(
    "@/client/config/runtimeModelSelection",
  );
  return {
    ...actual,
    resolveRuntimeProjectedImageToImageModel: vi.fn(() => {
      const contract = BASE_OUTPAINT_CONFIG.assetInputContract;
      return {
        ...BASE_OUTPAINT_CONFIG,
        assetInputContract:
          contract !== null && contract !== undefined
            ? { ...contract, promptMaxLength }
            : contract,
      };
    }),
  };
});

const mockedOutpaint = vi.mocked(outpaintImageWithModel);
const mockedToast = vi.mocked(toast);

const createPayload = (
  overrides: Partial<ImageOutpaintDialogConfirmPayload> = {},
): ImageOutpaintDialogConfirmPayload => ({
  sourceImage: new Blob(["fake-image"], { type: "image/png" }),
  modelId: "outpaint-test-model",
  aspectRatio: "1:1",
  imageSize: "1K",
  userPrompt: "补全背景",
  count: 1,
  ...overrides,
});

const setupHook = () => {
  const updateNodeData = vi.fn();
  const { result } = renderHook(() =>
    useImageOutpaint("img-1", "graph-1", updateNodeData),
  );
  return { result, updateNodeData };
};

describe("useImageOutpaint 统一前置校验接入（媒体工具执行）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptMaxLength = undefined;
    useExecutionStore.getState().reset();
  });

  it("prompt 超 schema 上限：不提交任务、不写任务记录，节点级诊断定位到 prompt 字段", async () => {
    promptMaxLength = 5; // 预设 prompt 已远超 5 字符
    const { result, updateNodeData } = setupHook();

    await act(async () => {
      result.current(createPayload());
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalled();
    });

    expect(mockedOutpaint).not.toHaveBeenCalled();
    expect(updateNodeData).not.toHaveBeenCalled();
    const issues = useExecutionStore.getState().preflightIssuesByNodeId["img-1"];
    expect(issues?.[0]).toMatchObject({
      kind: "invalid-required-parameter",
      nodeId: "img-1",
      fieldKey: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
    });
  });

  it("扩图模型缺失：不提交任务，定位到 modelId 参数", async () => {
    const { result, updateNodeData } = setupHook();

    await act(async () => {
      result.current(createPayload({ modelId: "  " }));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockedToast.error).toHaveBeenCalled();
    });

    expect(mockedOutpaint).not.toHaveBeenCalled();
    expect(updateNodeData).not.toHaveBeenCalled();
    const issues = useExecutionStore.getState().preflightIssuesByNodeId["img-1"];
    expect(issues?.[0]).toMatchObject({
      kind: "invalid-required-parameter",
      nodeId: "img-1",
      fieldKey: "modelId",
    });
  });

  it("校验通过：写入任务记录并提交，清空上一轮诊断", async () => {
    useExecutionStore.getState().setPreflightIssues([
      {
        kind: "invalid-required-parameter",
        nodeId: "img-1",
        fieldKey: "prompt",
        message: "上一轮遗留问题",
      },
    ]);
    mockedOutpaint.mockReturnValue(new Promise(() => undefined));
    const { result, updateNodeData } = setupHook();

    await act(async () => {
      result.current(createPayload());
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mockedOutpaint).toHaveBeenCalledTimes(1);
    });

    // 先写任务记录（taskInfo），再提交
    expect(updateNodeData).toHaveBeenCalled();
    expect(useExecutionStore.getState().preflightIssuesByNodeId).toEqual({});
    expect(mockedToast.success).toHaveBeenCalled();
  });
});

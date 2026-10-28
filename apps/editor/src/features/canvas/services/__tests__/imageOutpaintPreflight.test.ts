import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts";
import type * as RuntimeModelSelectionNS from "@/client/config/runtimeModelSelection";
import type { ImageOutpaintDialogConfirmPayload } from "../../components/dialogs/imageOutpaintDialogTypes";
import { validateImageOutpaintPreflight } from "../imageOutpaintPreflight";

/**
 * 扩图前置校验（媒体工具执行器 runOutpaint 的唯一校验入口）。
 *
 * 这里只测校验函数本身：问题是「哪些输入必须被拦下、问题定位到哪个字段」，
 * 不启动 hook、不涉及任务提交与占位节点创建（那部分由 mediaToolExecutors 测试覆盖）。
 */

const state = vi.hoisted(() => ({
  /** null 表示模型不可用 */
  modelAvailable: true,
  /** undefined 表示该模型不限制 prompt 长度 */
  promptMaxLength: undefined as number | undefined,
}));

vi.mock("@/client/config/runtimeModelSelection", async () => {
  const actual = await vi.importActual<typeof RuntimeModelSelectionNS>(
    "@/client/config/runtimeModelSelection",
  );
  const { buildRuntimeProjectedConfigFixture } = await import(
    "@/client/config/__tests__/fixtures/runtimeProjectionFixtures"
  );
  const base = buildRuntimeProjectedConfigFixture("gemini-3-pro-image");
  return {
    ...actual,
    resolveRuntimeProjectedImageToImageModel: vi.fn((modelId: string) => {
      if (!state.modelAvailable) return null;
      const contract = base.assetInputContract;
      return {
        ...base,
        modelId,
        assetInputContract: {
          promptFieldKey: contract?.promptFieldKey,
          promptMaxLength: state.promptMaxLength,
          requiredFieldKeys: contract?.requiredFieldKeys,
          imageInputFieldKeys: contract?.imageInputFieldKeys,
        },
      };
    }),
  };
});

const createPayload = (
  overrides: Partial<
    Record<keyof ImageOutpaintDialogConfirmPayload, unknown>
  > = {},
): ImageOutpaintDialogConfirmPayload =>
  ({
    sourceImage: new Blob(["fake-image"], { type: "image/png" }),
    modelId: "gemini-3-pro-image",
    aspectRatio: "1:1",
    imageSize: "1K",
    userPrompt: "补全背景",
    count: 1,
    ...overrides,
  }) as ImageOutpaintDialogConfirmPayload;

describe("validateImageOutpaintPreflight（扩图提交前置校验）", () => {
  beforeEach(() => {
    state.modelAvailable = true;
    state.promptMaxLength = undefined;
  });

  it("prompt 超过模型上限：问题定位到 prompt 保留字段", async () => {
    state.promptMaxLength = 5; // 预设 prompt 已远超 5 字符

    const issues = await validateImageOutpaintPreflight(
      "img-1",
      createPayload(),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "invalid-required-parameter",
      nodeId: "img-1",
      fieldKey: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
    });
  });

  it("模型 id 为空：问题定位到 modelId", async () => {
    const issues = await validateImageOutpaintPreflight(
      "img-1",
      createPayload({ modelId: "   " }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "invalid-required-parameter",
      nodeId: "img-1",
      fieldKey: "modelId",
    });
  });

  it("所选模型不可用：问题定位到 modelId", async () => {
    state.modelAvailable = false;

    const issues = await validateImageOutpaintPreflight(
      "img-1",
      createPayload(),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "invalid-required-parameter",
      nodeId: "img-1",
      fieldKey: "modelId",
    });
  });

  it("源图为空：判定为引用资产不可用", async () => {
    const issues = await validateImageOutpaintPreflight(
      "img-1",
      createPayload({ sourceImage: undefined }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "upstream-asset-unavailable",
      nodeId: "img-1",
      reason: "empty-material-node",
    });
  });

  it("合法输入：返回空数组（不拦截）", async () => {
    const issues = await validateImageOutpaintPreflight(
      "img-1",
      createPayload(),
    );

    expect(issues).toEqual([]);
  });
});

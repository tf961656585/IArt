import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ProjectMediaAssets } from "@iart/contracts";
import { cropImage } from "@/client/api/imageCrop";
import { splitImage } from "@/client/api/imageSplit";
import { smartSplitImage } from "@/client/api/imageSmartSplit";
import { trimVideo } from "@/client/api/videoTrim";
import {
  createGraphNodeFixture,
  createMediaAssetFixture,
} from "../../__tests__/fixtures/canvasTestBuilders";
import { resolveChromeSubject, type ChromeSubject } from "../mediaNodeModel";
import {
  runCrop,
  runOutpaint,
  runSmartSplit,
  runSplit,
  runTrim,
} from "../mediaToolExecutors";
import { createDerivedAssetNode, createDerivedAssetNodesInGrid } from "../../../utils/assetDerivation";
import { ensureBackendConsumableImageSource } from "../../../utils/mediaUtils";
import { outpaintImageWithModel } from "../../../services/imageOutpaint";
import {
  formatOutpaintPreflightSummary,
  validateImageOutpaintPreflight,
} from "../../../services/imageOutpaintPreflight";
import { getCurrentProjectPath } from "../../../storage/backend";
import { useExecutionStore } from "../../../store/executionStore";
import type { AssetNodeData } from "../../../types";

/**
 * 媒体工具执行器（唯一执行链路）的行为保护。
 *
 * 单元级：后端 API 与派生节点创建被替换，断言执行器的决策——
 * 全部产出交给批量派生（不得只取首块）、视频裁切固定 mp4、
 * 源不可用 / 前置校验失败时绝不发起请求、绝不留占位节点。
 */

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/client/api/imageCrop", () => ({ cropImage: vi.fn() }));
vi.mock("@/client/api/imageSplit", () => ({ splitImage: vi.fn() }));
vi.mock("@/client/api/imageSmartSplit", () => ({ smartSplitImage: vi.fn() }));
vi.mock("@/client/api/videoTrim", () => ({ trimVideo: vi.fn() }));

vi.mock("../../../utils/assetDerivation", () => ({
  createDerivedAssetNode: vi.fn(),
  createDerivedAssetNodesInGrid: vi.fn(),
}));

vi.mock("../../../utils/mediaUtils", () => ({
  ensureBackendConsumableImageSource: vi.fn(async (url: string) => url),
}));

vi.mock("../../../services/imageOutpaint", () => ({
  outpaintImageWithModel: vi.fn(),
}));

vi.mock("../../../services/imageOutpaintPreflight", () => ({
  validateImageOutpaintPreflight: vi.fn(),
  formatOutpaintPreflightSummary: vi.fn(() => "校验未通过"),
}));

vi.mock("../../../storage/backend", () => ({
  getCurrentProjectPath: vi.fn(async () => "/tmp/project"),
}));

const mockedToast = vi.mocked(toast);
const mockedCropImage = vi.mocked(cropImage);
const mockedSplitImage = vi.mocked(splitImage);
const mockedSmartSplitImage = vi.mocked(smartSplitImage);
const mockedTrimVideo = vi.mocked(trimVideo);
const mockedCreateDerivedAssetNode = vi.mocked(createDerivedAssetNode);
const mockedCreateDerivedAssetNodesInGrid = vi.mocked(createDerivedAssetNodesInGrid);
const mockedEnsureConsumable = vi.mocked(ensureBackendConsumableImageSource);
const mockedOutpaint = vi.mocked(outpaintImageWithModel);
const mockedValidatePreflight = vi.mocked(validateImageOutpaintPreflight);
const mockedFormatSummary = vi.mocked(formatOutpaintPreflightSummary);
const mockedGetCurrentProjectPath = vi.mocked(getCurrentProjectPath);

/** 用真实节点 + 注册表投影出工具执行器消费的媒体主体。 */
const createSubject = (params: {
  mediaType?: "image" | "video";
  withSource?: boolean;
} = {}): ChromeSubject => {
  const mediaType = params.mediaType ?? "image";
  const withSource = params.withSource ?? true;
  const assetId = "asset-src";
  const node = createGraphNodeFixture<AssetNodeData>({
    id: "node-1",
    type: "asset",
    data: {
      label: "源资产",
      sourceBatchId: "",
      sourceTaskId: "",
      sourceModelId: "",
      mediaType,
      assetId,
      derivedFrom: { sourceAssetId: "asset-upstream", tool: "upload" },
      outpaintTaskId: undefined,
    },
  });
  const mediaAssets: ProjectMediaAssets = withSource
    ? { [assetId]: createMediaAssetFixture({ id: assetId, mediaType }) }
    : {};
  const subject = resolveChromeSubject(node, mediaAssets);
  if (!subject) throw new Error("媒体主体投影失败");
  return subject;
};

const createDerivedNode = (id: string) =>
  createGraphNodeFixture<AssetNodeData>({
    id,
    type: "asset",
    data: {
      label: "派生资产",
      sourceBatchId: "",
      sourceTaskId: "",
      sourceModelId: "",
      mediaType: "image",
      assetId: `asset-${id}`,
      derivedFrom: { sourceAssetId: "asset-src", tool: "crop" },
      outpaintTaskId: undefined,
    },
  });

type SplitTile = Awaited<ReturnType<typeof splitImage>>["tiles"][number];
type SmartSplitTile = Awaited<ReturnType<typeof smartSplitImage>>["tiles"][number];

// 夹具字段齐全（契约类型把这些字段标成可选，API 返回类型要求显式 null），
// 这里用单次窄断言对齐 API 形状，避免为了类型逐字段重写夹具。
const createSplitTile = (index: number, row: number, col: number): SplitTile => ({
  index,
  row,
  col,
  assetId: `asset-tile-${index}`,
  mediaAsset: createMediaAssetFixture({ id: `asset-tile-${index}` }),
  url: `/project-media/prj_demo/tile_${index}.png`,
  width: 100,
  height: 100,
  x: col * 100,
  y: row * 100,
} as SplitTile);

const createSmartSplitTile = (index: number): SmartSplitTile => ({
  index,
  assetId: `asset-element-${index}`,
  mediaAsset: createMediaAssetFixture({ id: `asset-element-${index}` }),
  url: `/project-media/prj_demo/element_${index}.png`,
  width: 100,
  height: 100,
  x: 0,
  y: index * 100,
} as SmartSplitTile);

describe("runSplit（图片分割：全部图块逐个成为资产节点）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreateDerivedAssetNodesInGrid.mockReturnValue([]);
  });

  it("后端返回 4 个图块 → 4 个都交给网格派生，血缘为 split", async () => {
    mockedSplitImage.mockResolvedValue({
      success: true,
      rows: 2,
      cols: 2,
      tiles: [
        createSplitTile(0, 0, 0),
        createSplitTile(1, 0, 1),
        createSplitTile(2, 1, 0),
        createSplitTile(3, 1, 1),
      ],
      originalWidth: 200,
      originalHeight: 200,
      horizontalPercents: [50],
      verticalPercents: [50],
    });

    await runSplit({ subject: createSubject() }, {
      horizontalPercents: [50],
      verticalPercents: [50],
      rows: 2,
      cols: 2,
    });

    expect(mockedCreateDerivedAssetNodesInGrid).toHaveBeenCalledTimes(1);
    const params = mockedCreateDerivedAssetNodesInGrid.mock.calls[0]?.[0];
    expect(params?.sourceNodeId).toBe("node-1");
    expect(params?.mediaType).toBe("image");
    expect(params?.derivedFrom).toEqual({
      sourceAssetId: "asset-src",
      tool: "split",
    });
    expect(params?.items.map((item) => item.assetId)).toEqual([
      "asset-tile-0",
      "asset-tile-1",
      "asset-tile-2",
      "asset-tile-3",
    ]);
    expect(params?.items.map((item) => item.label)).toEqual([
      "图片分割 1-1",
      "图片分割 1-2",
      "图片分割 2-1",
      "图片分割 2-2",
    ]);
    // 每块携带原始切分几何 + 源图总宽高：批量派生据此按原图坐标排列
    expect(params?.items.map((item) => item.sourceRect)).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 100, y: 0, width: 100, height: 100 },
      { x: 0, y: 100, width: 100, height: 100 },
      { x: 100, y: 100, width: 100, height: 100 },
    ]);
    expect(params?.sourceSize).toEqual({ width: 200, height: 200 });
    expect(mockedCreateDerivedAssetNode).not.toHaveBeenCalled();
  });
});

describe("runSmartSplit（智能切图：全部元素图块逐个成为资产节点）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreateDerivedAssetNodesInGrid.mockReturnValue([]);
  });

  it("后端返回的全部元素都交给网格派生，按每块在原图中的真实坐标排列", async () => {
    mockedSmartSplitImage.mockResolvedValue({
      tiles: [
        createSmartSplitTile(0),
        createSmartSplitTile(1),
        createSmartSplitTile(2),
      ],
      originalWidth: 200,
      originalHeight: 200,
      tileCount: 3,
    });

    await runSmartSplit({ subject: createSubject() }, {
      alphaThreshold: 10,
      minArea: 100,
      dilateIterations: 1,
      padding: 2,
    });

    expect(mockedCreateDerivedAssetNodesInGrid).toHaveBeenCalledTimes(1);
    const params = mockedCreateDerivedAssetNodesInGrid.mock.calls[0]?.[0];
    expect(params?.derivedFrom).toEqual({
      sourceAssetId: "asset-src",
      tool: "smartSplit",
    });
    expect(params?.items.map((item) => item.assetId)).toEqual([
      "asset-element-0",
      "asset-element-1",
      "asset-element-2",
    ]);
    // 不再人为单列：每块携带 tile 的真实 x/y，由批量派生按源图坐标排列
    expect(params?.items.map((item) => item.sourceRect)).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 100, width: 100, height: 100 },
      { x: 0, y: 200, width: 100, height: 100 },
    ]);
    expect(params?.items.every((item) => item.row === undefined && item.col === undefined)).toBe(true);
    expect(params?.sourceSize).toEqual({ width: 200, height: 200 });
  });
});

describe("runTrim（视频裁切）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCreateDerivedAssetNode.mockReturnValue(createDerivedNode("derived-trim"));
  });

  it("裁切固定产出 mp4", async () => {
    mockedTrimVideo.mockResolvedValue({
      url: "/project-media/prj_demo/clips/trimmed.mp4",
      assetId: "asset-trim",
      mediaAsset: createMediaAssetFixture({ id: "asset-trim", mediaType: "video" }),
      meta: undefined,
    });

    await runTrim({ subject: createSubject({ mediaType: "video" }) }, {
      startTime: 1,
      endTime: 3,
      withAudio: true,
    });

    expect(mockedTrimVideo).toHaveBeenCalledTimes(1);
    expect(mockedTrimVideo.mock.calls[0]?.[0]).toMatchObject({
      sourceUrl: "/project-media/project-a/asset-src",
      startTime: 1,
      endTime: 3,
      format: "mp4",
      withAudio: true,
    });
  });

  it("源视频不可用：不发起裁切请求", async () => {
    await runTrim({ subject: createSubject({ mediaType: "video", withSource: false }) }, {
      startTime: 0,
      endTime: 1,
      withAudio: false,
    });

    expect(mockedTrimVideo).not.toHaveBeenCalled();
    expect(mockedGetCurrentProjectPath).not.toHaveBeenCalled();
    expect(mockedToast.error).toHaveBeenCalled();
  });
});

describe("runCrop（图片裁剪前置校验）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("源图为空：不调用后端裁剪，给出错误提示", async () => {
    await runCrop(
      { subject: createSubject({ withSource: false }) },
      { x: 0, y: 0, width: 10, height: 10 },
    );

    expect(mockedCropImage).not.toHaveBeenCalled();
    expect(mockedEnsureConsumable).not.toHaveBeenCalled();
    expect(mockedToast.error).toHaveBeenCalled();
  });
});

describe("runOutpaint（扩图前置校验失败）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("校验未通过：不提交扩图任务、不创建占位节点，给出错误提示", async () => {
    mockedValidatePreflight.mockResolvedValue([
      {
        kind: "invalid-required-parameter",
        nodeId: "node-1",
        fieldKey: "modelId",
        message: "还没有选择扩图模型，请先选择。",
      },
    ]);

    await runOutpaint({ subject: createSubject() }, {
      sourceImage: new Blob(["fake-image"], { type: "image/png" }),
      modelId: "gm-3",
      aspectRatio: "1:1",
      imageSize: "1K",
      userPrompt: "补全背景",
      count: 1,
    });

    expect(mockedFormatSummary).toHaveBeenCalledTimes(1);
    expect(mockedOutpaint).not.toHaveBeenCalled();
    expect(mockedCreateDerivedAssetNode).not.toHaveBeenCalled();
    expect(mockedToast.error).toHaveBeenCalled();
  });
});

describe("加工问题落到节点（失败 / 待处理标记的状态流）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExecutionStore.getState().reset();
  });

  it("后端裁剪失败 → 节点记录可读失败原因与下一步，同时保留 toast", async () => {
    mockedCropImage.mockRejectedValue(new Error("远端服务没有响应"));

    await runCrop({ subject: createSubject() }, { x: 0, y: 0, width: 10, height: 10 });

    const issue = useExecutionStore.getState().processingIssueByNodeId["node-1"];
    expect(issue?.kind).toBe("processing-failed");
    expect(issue?.message).toBe("裁剪图片没有完成");
    expect(issue?.detail).toBe("远端服务没有响应");
    expect(issue?.hint.length).toBeGreaterThan(0);
    expect(mockedToast.error).toHaveBeenCalled();
  });

  it("源图不可用 → 节点记录「先处理」，不发起请求", async () => {
    await runCrop(
      { subject: createSubject({ withSource: false }) },
      { x: 0, y: 0, width: 10, height: 10 },
    );

    const issue = useExecutionStore.getState().processingIssueByNodeId["node-1"];
    expect(issue?.kind).toBe("processing-blocked");
    expect(issue?.message).toBe("这张图片已经不能用了，请重新选择");
    expect(mockedCropImage).not.toHaveBeenCalled();
  });

  it("重试开始即清除上一次失败标记，成功后保持清除", async () => {
    useExecutionStore.getState().setProcessingIssue("node-1", {
      kind: "processing-failed",
      message: "上一次失败",
      hint: "再试一次",
    });
    mockedCropImage.mockResolvedValue({
      success: true,
      assetId: "asset-crop",
      mediaAsset: createMediaAssetFixture({ id: "asset-crop" }),
      url: "/project-media/prj_demo/crop.png",
      width: 10,
      height: 10,
      originalWidth: undefined,
      originalHeight: undefined,
      x: undefined,
      y: undefined,
    });
    mockedCreateDerivedAssetNode.mockReturnValue(createDerivedNode("derived-crop"));

    await runCrop({ subject: createSubject() }, { x: 0, y: 0, width: 10, height: 10 });

    expect(useExecutionStore.getState().processingIssueByNodeId["node-1"]).toBeUndefined();
  });

  it("扩图前置校验未通过 → 节点记录「先处理」并带校验摘要", async () => {
    mockedValidatePreflight.mockResolvedValue([
      {
        kind: "invalid-required-parameter",
        nodeId: "node-1",
        fieldKey: "modelId",
        message: "还没有选择扩图模型，请先选择。",
      },
    ]);

    await runOutpaint({ subject: createSubject() }, {
      sourceImage: new Blob(["fake-image"], { type: "image/png" }),
      modelId: "gm-3",
      aspectRatio: "1:1",
      imageSize: "1K",
      userPrompt: "补全背景",
      count: 1,
    });

    const issue = useExecutionStore.getState().processingIssueByNodeId["node-1"];
    expect(issue?.kind).toBe("processing-blocked");
    expect(issue?.message).toBe("校验未通过");
  });
});

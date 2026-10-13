import { describe, expect, it } from "vitest";

import type { MediaAsset, ProjectMediaAssets } from "@iart/contracts";
import type {
  GraphNode,
  NodeSize,
  GraphNodeType,
} from "../types/node";
import type { NodeGraph } from "../types/nodeGraph";

import { computeLayoutModel, type LayoutModelInput } from "./computeLayoutModel";
import { buildUrlIndex } from "./urlIndex";

const makeAsset = (
  assetId: string,
  url: string,
  width: number | null | undefined,
  height: number | null | undefined,
  mediaType: "image" | "video" | "audio" = "image",
): MediaAsset => ({
  id: assetId,
  mediaType,
  original: {
    url,
    projectRef: undefined,
    fileKey: undefined,
    sourceUrl: undefined,
    sourceFileName: null,
    mimeType: undefined,
    sizeBytes: undefined,
    width,
    height,
    durationMs: undefined,
    fps: undefined,
  },
  thumbnail: {
    url: null,
    mimeType: undefined,
    width: undefined,
    height: undefined,
    status: "missing",
    generatedAt: undefined,
    error: undefined,
  },
  lifecycle: { createdAt: 0, updatedAt: 0 },
});

const defaultSizeByNodeType: Record<GraphNodeType, NodeSize | undefined> = {
  model: { width: 240, height: 160 },
  imageInput: { width: 240, height: 180 },
  videoInput: { width: 240, height: 160 },
  textInput: { width: 320, height: 200 },
  audioInput: { width: 240, height: 160 },
  task: { width: 256, height: 120 },
  asset: { width: 240, height: 180 },
  agent: { width: 240, height: 64 },
  group: { width: 220, height: 56 },
};

const makeNodeGraph = (nodes: GraphNode[]): NodeGraph => ({
  id: "test-graph",
  name: "test",
  description: undefined,
  status: "draft",
  nodes,
  annotations: undefined,
  variables: undefined,
  settings: undefined,
  viewport: undefined,
  meta: {
    version: "1",
    schemaVersion: 3,
    createdAt: "",
    updatedAt: "",
    createdBy: undefined,
    tags: undefined,
    category: undefined,
    selectedCharacterIds: undefined,
  },
});

const makeGraphNode = (
  id: string,
  type: GraphNodeType,
  data: Record<string, unknown>,
): GraphNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: data as never,
  draggable: true,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

const buildInput = (
  nodeGraph: NodeGraph,
  mediaAssets: ProjectMediaAssets = {},
): LayoutModelInput => ({
  nodeGraph,
  mediaAssets,
  urlIndex: buildUrlIndex(mediaAssets),
  defaultSizeByNodeType,
});

/**
 * 辅助：从 byNodeId 读取节点尺寸并断言非 undefined。
 *
 * 避免 test 中使用非空断言 `!`（eslint 禁止）。
 */
const getSize = (output: ReturnType<typeof computeLayoutModel>, nodeId: string): NodeSize => {
  const size = output.byNodeId[nodeId];
  if (size === undefined) {
    throw new Error(`expected node ${nodeId} to have a size, got undefined`);
  }
  return size;
};

describe("computeLayoutModel", () => {
  describe("纯函数性", () => {
    it("相同输入两次调用结果 deep equal", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "textInput", { content: "hello" }),
      ];
      const input = buildInput(makeNodeGraph(nodes));
      const a = computeLayoutModel(input);
      const b = computeLayoutModel(input);
      expect(a).toEqual(b);
    });

    it("输出包含 byNodeId / semanticKey / revision 字段", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "textInput", { content: "hello" }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      expect(output).toHaveProperty("byNodeId");
      expect(output).toHaveProperty("semanticKey");
      expect(output).toHaveProperty("revision");
      expect(typeof output.semanticKey).toBe("string");
      expect(typeof output.revision).toBe("number");
    });
  });

  describe("节点类型分支", () => {
    it("static 节点（textInput）返回 defaultSize", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "textInput", { content: "hello" }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      expect(output.byNodeId["n1"]).toEqual({ width: 320, height: 200 });
    });

    it("audioInput（layoutModel）：空态（无分段/无 audioUrl）→ chrome + 音频区，不再回落 defaultSize 240×160", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "audioInput", {
          audioUrl: null,
          segments: [],
          segmentModeEnabled: false,
        }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      // chrome{26,26} + AUDIO_AREA_HEIGHT 64 = 90；宽度下限 200
      expect(output.byNodeId["n1"]).toEqual({ width: 200, height: 90 });
    });

    it("audioInput（layoutModel）：分段数驱动高度（分段列表全量渲染，无内部滚动，含块间 gap）", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "audioInput", {
          audioUrl: "http://x/a.mp3",
          segments: [{ id: "s1" }, { id: "s2" }],
          segmentModeEnabled: true,
        }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      // 26 + 64 + (8+20+2*20+1*2) + 36 + 2*8 = 212（分段块与编辑按钮各计 1 个 gap-2）
      expect(output.byNodeId["n1"]).toEqual({ width: 200, height: 212 });
    });

    it("audioInput（layoutModel）：segmentModeEnabled=false 时忽略已有分段（与渲染条件一致，含按钮 gap）", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "audioInput", {
          audioUrl: "http://x/a.mp3",
          segments: [{ id: "s1" }, { id: "s2" }],
          segmentModeEnabled: false,
        }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      // 26 + 64 + 36 + 8 = 134（不渲染分段列表；编辑按钮前 1 个 gap-2）
      expect(output.byNodeId["n1"]).toEqual({ width: 200, height: 134 });
    });

    it("group 节点返回占位 defaultSize（实际派生由调用方通过 buildGroupDerivedSize 完成）", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("g1", "group", { name: "g", collapsed: false }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      expect(output.byNodeId["g1"]).toEqual({ width: 220, height: 56 });
    });

    it("媒体节点（imageInput）有 asset 时按策略函数 + chrome{0,0} 派生（800×600 → 320×240）", () => {
      // 800×600 aspect 1.333：computeMediaDisplaySize → {320, 240}；chrome{0,0} → total = display
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png", 800, 600),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "imageInput", { assetId: "a1", imageUrl: null }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      expect(output.byNodeId["n1"]).toEqual({ width: 320, height: 240 });
    });

    it("媒体节点（imageInput）无 asset 且无 data.imageMeta 时返回 defaultSize（meta 三级回落）", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "imageInput", { assetId: null, imageUrl: null }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      expect(output.byNodeId["n1"]).toEqual({ width: 240, height: 180 });
    });

    it("媒体节点（imageInput）asset 缺失时通过 urlIndex fallback 派生与 assetId 直连一致", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png", 800, 600),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "imageInput", {
          assetId: null,
          imageUrl: "http://x/a.png",
        }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      // assetId=null + url 命中索引 → 走 urlIndex fallback → 与直连 assetId 同结果
      const withAssetId = computeLayoutModel(
        buildInput(
          makeNodeGraph([
            makeGraphNode("n1", "imageInput", {
              assetId: "a1",
              imageUrl: null,
            }),
          ]),
          assets,
        ),
      );
      expect(output.byNodeId["n1"]).toEqual(withAssetId.byNodeId["n1"]);
      expect(output.byNodeId["n1"]).toEqual({ width: 320, height: 240 });
    });

    it("bug 样本回验：竖图 3972×6356 → 布局模型输出 ≤320×320（无钳制旧公式会算 256×424）", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/portrait.png", 3972, 6356),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "imageInput", { assetId: "a1", imageUrl: null }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      const size = getSize(output, "n1");
      expect(size).toEqual({ width: 200, height: 320 });
      expect(size.width).toBeLessThanOrEqual(320);
      expect(size.height).toBeLessThanOrEqual(320);
    });

    it("meta 来源优先级 2：MediaAsset.original 缺失时回落节点 data.imageMeta（历史数据兜底）", () => {
      // asset 没有 original width/height，但节点 data 携带 imageMeta
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png", null, null),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "imageInput", {
          assetId: "a1",
          imageUrl: null,
          imageMeta: { width: 1774, height: 887, aspectRatio: 2 },
        }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      // 1774×887 aspect 2 → {320, 160}；chrome{0,0}
      expect(output.byNodeId["n1"]).toEqual({ width: 320, height: 160 });
    });

    it("meta 来源优先级 1 覆盖优先级 2：MediaAsset.original 命中时不读 data.imageMeta", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png", 800, 600),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "imageInput", {
          assetId: "a1",
          imageUrl: null,
          // 故意写入与 asset.original 不同的 meta，验证不被采用
          imageMeta: { width: 100, height: 100, aspectRatio: 1 },
        }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      // 应走 asset.original(800×600) → {320, 240}，而非 data.imageMeta(100×100) → {180, 180}
      expect(output.byNodeId["n1"]).toEqual({ width: 320, height: 240 });
    });

    it("model 节点已退出画布：返回 defaultSize 兜底，不产出结果区几何", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "model", {
          modelId: "test-model",
          formValues: {},
          inlineControlsCollapsed: true,
        }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      // 防御性兜底：模型节点在打开阶段已被拒绝，此处只保证不崩溃并回落 defaultSize。
      expect(output.byNodeId["n1"]).toEqual({ width: 240, height: 160 });
    });
  });

  describe("asset 节点媒体比例一致性", () => {
    it("asset 节点（image）按 MediaAsset.original 派生比例（800×600 → 320×240），不落 defaultSize 240×180", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png", 800, 600),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "asset", { mediaType: "image", assetId: "a1" }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      expect(output.byNodeId["n1"]).toEqual({ width: 320, height: 240 });
    });

    it("asset 节点（video）按媒体比例派生（1920×1080 → 320×180）", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.mp4", 1920, 1080, "video"),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "asset", { mediaType: "video", assetId: "a1" }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      expect(output.byNodeId["n1"]).toEqual({ width: 320, height: 180 });
    });

    it("bug 样本回验：asset 竖图 3972×6356 → 节点比例与媒体一致（200×320），不再出现 240×180 灰边", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/portrait.png", 3972, 6356),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "asset", { mediaType: "image", assetId: "a1" }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      const size = getSize(output, "n1");
      expect(size).toEqual({ width: 200, height: 320 });
      // 节点宽高比与媒体宽高比一致（contain 渲染无灰边）
      expect(size.width / size.height).toBeCloseTo(3972 / 6356, 2);
    });

    it("asset 节点 mediaType=audio：非媒体表面，回落 defaultSize", () => {
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.mp3", 100, 100, "audio"),
      };
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "asset", { mediaType: "audio", assetId: "a1" }),
      ];
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      expect(output.byNodeId["n1"]).toEqual({ width: 240, height: 180 });
    });

    it("asset 节点 assetId 缺失 / asset 不存在 / original 尺寸缺失：回落 defaultSize", () => {
      const nodes: GraphNode[] = [
        makeGraphNode("n1", "asset", { mediaType: "image", assetId: "" }),
        makeGraphNode("n2", "asset", { mediaType: "image", assetId: "ghost" }),
        makeGraphNode("n3", "asset", { mediaType: "image", assetId: "a1" }),
      ];
      const assets: ProjectMediaAssets = {
        a1: makeAsset("a1", "http://x/a.png", null, null),
      };
      const output = computeLayoutModel(buildInput(makeNodeGraph(nodes), assets));
      expect(output.byNodeId["n1"]).toEqual({ width: 240, height: 180 });
      expect(output.byNodeId["n2"]).toEqual({ width: 240, height: 180 });
      expect(output.byNodeId["n3"]).toEqual({ width: 240, height: 180 });
    });

    it("asset 节点 assetId / mediaType 变化触发 semanticKey 变化", () => {
      const nodes1 = [
        makeGraphNode("n1", "asset", { mediaType: "image", assetId: "a1" }),
      ];
      const nodes2 = [
        makeGraphNode("n1", "asset", { mediaType: "image", assetId: "a2" }),
      ];
      const nodes3 = [
        makeGraphNode("n1", "asset", { mediaType: "video", assetId: "a1" }),
      ];
      const o1 = computeLayoutModel(buildInput(makeNodeGraph(nodes1)));
      const o2 = computeLayoutModel(buildInput(makeNodeGraph(nodes2)));
      const o3 = computeLayoutModel(buildInput(makeNodeGraph(nodes3)));
      expect(o1.semanticKey).not.toBe(o2.semanticKey);
      expect(o1.semanticKey).not.toBe(o3.semanticKey);
    });
  });

  describe("semanticKey 内容指纹", () => {
    it("媒体节点 assetId / url 变化触发 semanticKey 变化", () => {
      const nodes1 = [
        makeGraphNode("n1", "imageInput", { assetId: "a1", imageUrl: null }),
      ];
      const nodes2 = [
        makeGraphNode("n1", "imageInput", { assetId: "a2", imageUrl: null }),
      ];
      const nodes3 = [
        makeGraphNode("n1", "imageInput", { assetId: null, imageUrl: "http://x/a.png" }),
      ];
      const o1 = computeLayoutModel(buildInput(makeNodeGraph(nodes1)));
      const o2 = computeLayoutModel(buildInput(makeNodeGraph(nodes2)));
      const o3 = computeLayoutModel(buildInput(makeNodeGraph(nodes3)));
      expect(o1.semanticKey).not.toBe(o2.semanticKey);
      expect(o1.semanticKey).not.toBe(o3.semanticKey);
    });

    it("audioInput 分段数 / 分段模式 / audioUrl 变化触发 semanticKey 变化", () => {
      const base = [
        makeGraphNode("n1", "audioInput", {
          audioUrl: null,
          segments: [],
          segmentModeEnabled: false,
        }),
      ];
      const withSegments = [
        makeGraphNode("n1", "audioInput", {
          audioUrl: null,
          segments: [{ id: "s1" }],
          segmentModeEnabled: true,
        }),
      ];
      const withUrl = [
        makeGraphNode("n1", "audioInput", {
          audioUrl: "http://x/a.mp3",
          segments: [],
          segmentModeEnabled: false,
        }),
      ];
      const o1 = computeLayoutModel(buildInput(makeNodeGraph(base)));
      const o2 = computeLayoutModel(buildInput(makeNodeGraph(withSegments)));
      const o3 = computeLayoutModel(buildInput(makeNodeGraph(withUrl)));
      expect(o1.semanticKey).not.toBe(o2.semanticKey);
      expect(o1.semanticKey).not.toBe(o3.semanticKey);
    });

    it("相同输入两次调用 semanticKey 相同", () => {
      const nodes = [
        makeGraphNode("n1", "textInput", { content: "hello" }),
      ];
      const a = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      const b = computeLayoutModel(buildInput(makeNodeGraph(nodes)));
      expect(a.semanticKey).toBe(b.semanticKey);
    });
  });

  describe("边界场景", () => {
    it("空 nodes：返回空 byNodeId 与空 semanticKey", () => {
      const output = computeLayoutModel(buildInput(makeNodeGraph([])));
      expect(output.byNodeId).toEqual({});
      expect(output.semanticKey).toBe("");
    });

  });
});

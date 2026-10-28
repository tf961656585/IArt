import { beforeEach, describe, expect, it } from "vitest";
import { useCanvasStore } from "../canvasStore";
import { createNodeGraph } from "../../types/nodeGraph";
import type {
  GraphNode,
  GraphNodeData,
  ImageInputNodeData,
  ModelNodeData,
} from "../../types/node";
import {
  createGraphNodeFixture,
  createModelDataFixture,
  createModelNodeFixture,
  createNodeTaskInfoFixture,
  createResultAreaMediaSlotFixture,
} from "../../components/__tests__/fixtures/canvasTestBuilders";
import {
  createDefaultResultAreaEmbeddedData,
  createResultAreaEmbeddedData,
} from "../../services/resultAreaEmbeddedFactory";

const expectNodeGraph = () => {
  const graph = useCanvasStore.getState().nodeGraph;
  expect(graph).toBeDefined();
  if (!graph) throw new Error("Expected nodeGraph");
  return graph;
};


const expectTypedNode = <T extends GraphNodeData>(
  node: GraphNode | undefined,
): GraphNode<T> => {
  expect(node).toBeDefined();
  if (!node) throw new Error("Expected node");
  return node as GraphNode<T>;
};

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.pendingAnnotationBinding = null;
    state.isDragging = false;
    state.isConnecting = false;
    state.history = [];
    state.historyIndex = -1;
    state.hasUnsavedChanges = false;
    state.structureRevision = 0;
    state.taskRevision = 0;
    state.positionRevision = 0;
    state.viewportRevision = 0;
    state.layoutRevision = 0;
    state.clipboardPayload = null;
  });
};

describe("canvasStore.updateNodeData - no-op 检测（数组/对象）", () => {
  beforeEach(() => {
    resetStore();
  });

  it("model 节点写入桥接后的嵌套 resultArea patch（spread prev）时，outputSlotIds 正确更新且不丢 slots/collapsed/targetKeyId", () => {
    const graph = createNodeGraph({ name: 'updateNodeData-noop-array', description: undefined, tags: undefined, category: undefined });
    graph.id = "graph-updateNodeData-noop-array";
    graph.meta = {
      ...(graph.meta ?? {}),
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    graph.nodes = [
      createModelNodeFixture({
        id: "resultArea-1",
        position: { x: 0, y: 0 },
        data: createModelDataFixture({
          resultArea: createResultAreaEmbeddedData({
            targetKeyId: "resultArea-1",
            slots: [
              createResultAreaMediaSlotFixture({
                id: "item-1",
                targetKey: "gallery_gallery-1_item-1",
                mediaType: "image",
                value: "/files/out.png",
                createdAt: 1,
                updatedAt: 1,
              }),
              createResultAreaMediaSlotFixture({
                id: "item-2",
                targetKey: "gallery_gallery-1_item-2",
                mediaType: "image",
                value: "/files/out2.png",
                createdAt: 2,
                updatedAt: 2,
              }),
            ],
            outputSlotIds: ["item-1"],
            collapsed: false,
          }),
        }),
      }),
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.hasUnsavedChanges = false;
      state.structureRevision = 0;
    });

    // 模拟勾选 item-2：ResultAreaBodyImpl 桥接把扁平 { outputSlotIds }
    // 包装为 { resultArea: { ...prevResultArea, outputSlotIds: ["item-1","item-2"] } }。
    // spread prev 保证 slots/collapsed/targetKeyId 不丢。
    const prevResultArea = (useCanvasStore
      .getState()
      .nodeGraph?.nodes.find((n) => n.id === "resultArea-1")?.data as ModelNodeData | undefined)
      ?.resultArea;
    const prevResultAreaRecord = prevResultArea !== undefined
      ? prevResultArea
      : { slots: [], outputSlotIds: [], collapsed: false, targetKeyId: "" };
    useCanvasStore.getState().updateNodeData(
      "resultArea-1",
      { resultArea: { ...prevResultAreaRecord, outputSlotIds: ["item-1", "item-2"] } },
      undefined,
    );

    const nextGraph = expectNodeGraph();
    const nextResultArea = expectTypedNode<ModelNodeData>(
      nextGraph.nodes.find((n) => n.id === "resultArea-1"),
    );

    // outputSlotIds 正确更新为勾选后的集合。
    expect(nextResultArea.data.resultArea.outputSlotIds).toEqual(["item-1", "item-2"]);
    // slots / collapsed / targetKeyId 不被覆盖（spread prev 保护）。
    expect(nextResultArea.data.resultArea.slots).toHaveLength(2);
    expect(nextResultArea.data.resultArea.slots.map((s) => s.id)).toEqual(["item-1", "item-2"]);
    expect(nextResultArea.data.resultArea.collapsed).toBe(false);
    expect(nextResultArea.data.resultArea.targetKeyId).toBe("resultArea-1");
  });

  it("当写入“同内容新引用”的 plain object 时，应视为 no-op", () => {
    const taskInfo = {
      ...createNodeTaskInfoFixture(),
      taskId: "task-1",
      modelId: "model-1",
      status: "polling" as const,
      taskIndex: 0,
      createdAt: 1,
      updatedAt: 1,
    };

    const graph = createNodeGraph({ name: 'updateNodeData-noop-object', description: undefined, tags: undefined, category: undefined });
    graph.id = "graph-updateNodeData-noop-object";
    graph.meta = {
      ...(graph.meta ?? {}),
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    graph.nodes = [
      createGraphNodeFixture<ImageInputNodeData>({
        id: "image-1",
        type: "imageInput",
        position: { x: 0, y: 0 },
        data: {
          label: "图片组件",
          description: undefined,
          runtimeRef: undefined,
          assetId: null,
          imageUrl: "/files/in.png",
          imageMeta: undefined,
          lastExecutionId: undefined,
          lastSourceNodeId: undefined,
          lastSourcePortId: undefined,
          valueSource: undefined,
          mediaError: undefined,
          taskInfo,
          cachedContent: undefined,
        },
      }),
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
      state.hasUnsavedChanges = false;
      state.structureRevision = 0;
    }, undefined);

    const prevRevision = useCanvasStore.getState().structureRevision;
    const prevUpdatedAt = useCanvasStore.getState().nodeGraph?.meta?.updatedAt;

    // 同内容但新引用
    useCanvasStore.getState().updateNodeData("image-1", {
      taskInfo: {
        ...createNodeTaskInfoFixture(),
        taskId: "task-1",
        modelId: "model-1",
        status: "polling",
        taskIndex: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    }, undefined);

    const nextState = useCanvasStore.getState();
    const nextGraph = expectNodeGraph();
    const nextImage = expectTypedNode<ImageInputNodeData>(
      nextGraph.nodes.find((n) => n.id === "image-1"),
    );

    expect(nextState.structureRevision).toBe(prevRevision);
    expect(nextState.hasUnsavedChanges).toBe(false);
    expect(nextGraph.meta.updatedAt).toBe(prevUpdatedAt);
    expect(nextImage.data.taskInfo).toBe(taskInfo);
  });


  it("task-index-sync 来源必须能回写 resultArea（succeeded 产物落盘 assetId）", () => {
    const slotId = "gitem-asset-settle";
    const graph = createNodeGraph({ name: "runtime-result-area-settle", description: undefined, tags: undefined, category: undefined });
    graph.id = "graph-runtime-result-area-settle";
    graph.nodes = [
      {
        id: "model-settle-1",
        type: "model",
        position: { x: 0, y: 0 },
        data: {
          label: "模型节点",
          shellModelId: undefined,
          modelId: "test-model",
          currentOverrideId: undefined,
          formValues: { prompt: "keep-current" },
          portMapping: {},
          inlineControlsCollapsed: false,
          inlineAdvancedGroupsExpanded: {},
          lastExecutionId: undefined,
          taskInfo: undefined,
          executionPreferences: undefined,
          promptPresetSnapshots: undefined,
          description: undefined,
          runtimeRef: undefined,
          resultArea: createResultAreaEmbeddedData({
            targetKeyId: "model-settle-1",
            slots: [
              createResultAreaMediaSlotFixture({
                id: slotId,
                targetKey: `result-area_model-settle-1_${slotId}`,
                mediaType: "image",
                assetId: null,
                runtimeRef: { taskId: "task-settle-1", resultId: null, assetId: null },
                createdAt: 1,
                updatedAt: 1,
              }),
            ],
            outputSlotIds: [],
            collapsed: false,
          }),
        },
        draggable: true,
        size: undefined,
        style: undefined,
        groupId: undefined,
      },
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    // 模拟 succeeded 通知回写：buildResultAreaFormalSlotPatches 生成的 patch 只带 resultArea，
    // slot 内的 assetId / runtimeRef.assetId 被正确填充。
    useCanvasStore.getState().updateNodeData(
      "model-settle-1",
      {
        resultArea: {
          targetKeyId: "model-settle-1",
          slots: [
            {
              id: slotId,
              targetKey: `result-area_model-settle-1_${slotId}`,
              itemType: "media" as const,
              assetId: "asset-settled-1",
              textValue: null,
              createdAt: 1,
              updatedAt: 2,
              runtimeRef: {
                taskId: "task-settle-1",
                resultId: null,
                assetId: "asset-settled-1",
              },
              origin: {
                sourceNodeId: "model-settle-1",
                executionId: "exec-settle-1",
                taskId: "task-settle-1",
              },
            },
          ],
          outputSlotIds: [],
          collapsed: false,
        },
      },
      "task-index-sync",
    );

    const nextGraph = expectNodeGraph();
    const nextModel = expectTypedNode<ModelNodeData>(
      nextGraph.nodes.find((node) => node.id === "model-settle-1"),
    );
    const settledSlot = nextModel.data.resultArea.slots.find((s) => s.id === slotId);

    expect(settledSlot).toBeDefined();
    expect(settledSlot?.assetId).toBe("asset-settled-1");
    expect(settledSlot?.runtimeRef?.assetId).toBe("asset-settled-1");
    // formValues 仍然不得被覆盖
    expect(nextModel.data.formValues?.["prompt"]).toBe("keep-current");
  });


  it("model 非 formValues patch 不得把现有参数写成 undefined", () => {
    const graph = createNodeGraph({ name: "model-form-values-preserve", description: undefined, tags: undefined, category: undefined });
    graph.id = "graph-model-form-values-preserve";
    graph.nodes = [
      {
        id: "model-preserve-1",
        type: "model",
        position: { x: 0, y: 0 },
        data: {
          label: "模型节点",
          shellModelId: undefined,
          modelId: "test-model",
          formValues: {
            prompt: "keep-prompt",
            imageSize: "1024x1024",
          },
          portMapping: {},
          inlineControlsCollapsed: false,
          inlineAdvancedGroupsExpanded: {},
          lastExecutionId: undefined,
          taskInfo: undefined,
          executionPreferences: undefined,
          promptPresetSnapshots: undefined,
          description: undefined,
          runtimeRef: undefined,
          resultArea: createDefaultResultAreaEmbeddedData(),
        },
        draggable: true,
        size: undefined,
        style: undefined,
        groupId: undefined,
      },
    ];

    useCanvasStore.setState((state) => {
      state.nodeGraph = graph;
    });

    useCanvasStore.getState().updateNodeData(
      "model-preserve-1",
      {
        taskInfo: createNodeTaskInfoFixture({
          taskId: "task-1",
          status: "submitting",
          modelId: "test-model",
          taskIndex: 0,
        }),
        runtimeRef: {
          taskId: "task-1",
          assetId: null,
        },
      },
      undefined,
    );

    const nextGraph = expectNodeGraph();
    const nextModel = expectTypedNode<ModelNodeData>(
      nextGraph.nodes.find((node) => node.id === "model-preserve-1"),
    );

    expect(nextModel.data.formValues["prompt"]).toBe("keep-prompt");
    expect(nextModel.data.formValues["imageSize"]).toBe("1024x1024");
    expect(nextModel.data.taskInfo?.taskId).toBe("task-1");
    expect(nextModel.data.runtimeRef?.taskId).toBe("task-1");
  });
});

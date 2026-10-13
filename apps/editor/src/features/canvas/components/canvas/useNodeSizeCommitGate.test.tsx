import React from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useNodeSizeCommitGate } from "./useNodeSizeCommitGate";
import { useCanvasStore } from "../../store/canvasStore";
import { createNodeGraph } from "../../types/nodeGraph";
import { createGraphNode } from "../../types/node";
import type { DesiredSize } from "../../types";
import { createDefaultResultAreaEmbeddedData } from "../../services/resultAreaEmbeddedFactory";

const Harness = (props: {
  actualSizeByNodeId: Record<string, { width: number; height: number }>;
}) => {
  useNodeSizeCommitGate({
    actualSizeByNodeId: props.actualSizeByNodeId,
  });
  return <div />;
};

const resetStore = () => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.isDragging = false;
    state.isCanvasInteracting = false;
    state.isCanvasInteractingDelayed = false;
    state.ui.desiredSizeByNodeId = {};
    state.ui.placeholderNodeIds = new Set();
    // Layout-Model-Driven：commit gate 只在 runtime (phase === 'ready') 推进。
    // 测试默认设置 runtime 态以验证 flush 行为；startup 态的禁用由 phase guard 覆盖。
    state.preparationPhase = "ready";
  });
};

const seedGraph = () => {
  const graph = createNodeGraph({
    name: "gate",
    description: undefined,
    tags: undefined,
    category: undefined,
  });
  const node1 = createGraphNode({
    type: "model",
    position: { x: 0, y: 0 },
    data: {
      label: "Model-1",
      description: undefined,
      runtimeRef: undefined,
      shellModelId: undefined,
      modelId: "any",
      currentOverrideId: undefined,
      formValues: {},
      portMapping: undefined,
      inlineControlsCollapsed: false,
      inlineAdvancedGroupsExpanded: undefined,
      lastExecutionId: undefined,
      taskInfo: undefined,
      executionPreferences: undefined,
      promptPresetSnapshots: undefined,
      resultArea: createDefaultResultAreaEmbeddedData(),
    },
  });
  node1.id = "node-1";
  const node2 = createGraphNode({
    type: "model",
    position: { x: 320, y: 0 },
    data: {
      label: "Model-2",
      description: undefined,
      runtimeRef: undefined,
      shellModelId: undefined,
      modelId: "any",
      formValues: {},
      portMapping: undefined,
      inlineControlsCollapsed: false,
      inlineAdvancedGroupsExpanded: undefined,
      lastExecutionId: undefined,
      taskInfo: undefined,
      executionPreferences: undefined,
      promptPresetSnapshots: undefined,
      resultArea: createDefaultResultAreaEmbeddedData(),
    },
  });
  node2.id = "node-2";
  graph.nodes = [node1, node2];
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
  });
};

const pendingDesired = (
  size: { width: number; height: number },
  semanticKey = "semantic-test",
): DesiredSize => ({
  size,
  state: "pending",
  semanticKey,
});

const acceptedDesired = (
  size: { width: number; height: number },
  semanticKey = "semantic-test",
): DesiredSize => ({
  size,
  state: "accepted",
  semanticKey,
});

describe("useNodeSizeCommitGate", () => {
  beforeEach(() => {
    resetStore();
    seedGraph();
  });

  it("does not accept pending desired while interacting", () => {
    useCanvasStore.setState((state) => {
      state.isDragging = true;
    });
    useCanvasStore.getState().submitNodeSizeProposal({
      nodeId: "node-1",
      source: "resultAreaAutoScale",
      semanticKey: "semantic-1",
      desiredSize: { width: 360, height: 220 },
      priority: 80,
      reason: "result-area:auto-scale",
    });

    render(
      <Harness actualSizeByNodeId={{ "node-1": { width: 360, height: 220 } }} />,
    );

    const state = useCanvasStore.getState();
    expect(state.ui.desiredSizeByNodeId["node-1"]).toEqual(
      pendingDesired({ width: 360, height: 220 }, "semantic-1"),
    );
  });

  it("accepts pending desired once actual size converges after interaction ends", () => {
    useCanvasStore.getState().submitNodeSizeProposal({
      nodeId: "node-1",
      source: "embeddedResultAreaAutoSize",
      semanticKey: "semantic-2",
      desiredSize: { width: 466, height: 299 },
      priority: 100,
      reason: "embedded-result-area:auto-size",
    });

    render(
      <Harness actualSizeByNodeId={{ "node-1": { width: 466, height: 299 } }} />,
    );

    const state = useCanvasStore.getState();
    expect(state.ui.desiredSizeByNodeId["node-1"]).toEqual(
      acceptedDesired({ width: 466, height: 299 }, "semantic-2"),
    );
  });

  it("does not flush unrelated pending desired when another node newly converges", () => {
    const rendered = render(
      <Harness
        actualSizeByNodeId={{
          "node-1": { width: 180, height: 120 },
          "node-2": { width: 180, height: 120 },
        }}
      />,
    );

    act(() => {
      useCanvasStore.getState().submitNodeSizeProposal({
        nodeId: "node-2",
        source: "resultAreaAutoScale",
        semanticKey: "semantic-stale",
        desiredSize: { width: 420, height: 260 },
        priority: 80,
        reason: "result-area:auto-scale",
      });
    });

    let state = useCanvasStore.getState();
    // node-2 has a pending desired but actual has not converged yet
    expect(state.ui.desiredSizeByNodeId["node-2"]).toEqual(
      pendingDesired({ width: 420, height: 260 }, "semantic-stale"),
    );

    act(() => {
      useCanvasStore.getState().submitNodeSizeProposal({
        nodeId: "node-1",
        source: "embeddedResultAreaAutoSize",
        semanticKey: "semantic-fresh",
        desiredSize: { width: 466, height: 299 },
        priority: 100,
        reason: "embedded-result-area:auto-size",
      });
      rendered.rerender(
        <Harness
          actualSizeByNodeId={{
            "node-1": { width: 466, height: 299 },
            "node-2": { width: 180, height: 120 },
          }}
        />,
      );
    });

    state = useCanvasStore.getState();
    // node-1 converged → accepted; node-2 still pending (unconverged, untouched)
    expect(state.ui.desiredSizeByNodeId["node-1"]).toEqual(
      acceptedDesired({ width: 466, height: 299 }, "semantic-fresh"),
    );
    expect(state.ui.desiredSizeByNodeId["node-2"]).toEqual(
      pendingDesired({ width: 420, height: 260 }, "semantic-stale"),
    );
  });

  it("keeps pending desired pending when actual drifted away from desired size", () => {
    useCanvasStore.setState((state) => {
      state.isDragging = true;
    });
    useCanvasStore.getState().submitNodeSizeProposal({
      nodeId: "node-1",
      source: "embeddedResultAreaAutoSize",
      semanticKey: "semantic-stale-after-consume",
      desiredSize: { width: 466, height: 299 },
      priority: 100,
      reason: "embedded-result-area:auto-size",
    });

    const rendered = render(
      <Harness actualSizeByNodeId={{ "node-1": { width: 466, height: 299 } }} />,
    );

    // while interacting, even a converging actual does not trigger accept
    let state = useCanvasStore.getState();
    expect(state.ui.desiredSizeByNodeId["node-1"]).toEqual(
      pendingDesired({ width: 466, height: 299 }, "semantic-stale-after-consume"),
    );

    act(() => {
      useCanvasStore.setState((currentState) => {
        currentState.isDragging = false;
      });
      rendered.rerender(
        <Harness actualSizeByNodeId={{ "node-1": { width: 438, height: 272 } }} />,
      );
    });

    // interaction ended but actual drifted away from desired → stays pending (no accept)
    state = useCanvasStore.getState();
    expect(state.ui.desiredSizeByNodeId["node-1"]).toEqual(
      pendingDesired({ width: 466, height: 299 }, "semantic-stale-after-consume"),
    );
  });

  it("leaves an already accepted desired stable without re-accepting or clearing", () => {
    useCanvasStore.setState((state) => {
      state.ui.desiredSizeByNodeId["node-1"] = acceptedDesired(
        { width: 360, height: 220 },
        "semantic-committed",
      );
    });

    render(
      <Harness actualSizeByNodeId={{ "node-1": { width: 360, height: 220 } }} />,
    );

    const state = useCanvasStore.getState();
    expect(state.ui.desiredSizeByNodeId["node-1"]).toEqual(
      acceptedDesired({ width: 360, height: 220 }, "semantic-committed"),
    );
  });
});

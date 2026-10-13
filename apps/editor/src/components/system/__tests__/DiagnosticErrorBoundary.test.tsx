import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const canvasDebugMocks = vi.hoisted(() => ({
  getCanvasDebugSnapshot: vi.fn(() => ({
    ts: 1_700_000_000_000,
    graph: { nodeCount: 2 },
    recent: [
      {
        ts: 1_700_000_000_000,
        kind: "updateNodeData" as const,
        nodeId: "node-a",
        nodeType: "model",
        noOp: false,
        via: "test",
        keys: ["prompt"],
        changedKeys: ["prompt"],
        stack: "update stack",
      },
    ],
    recentEvents: [
      {
        ts: 1_700_000_000_100,
        kind: "event" as const,
        reason: "nodeCanvas:onEdgeClick",
        summary:
          "event=nodeCanvas:onEdgeClick | scope=canvas-selection | action=edge-click",
        traceScope: "canvas-selection",
        action: "edge-click",
        selectionReason: "replace-click",
        nodeId: undefined,
        edgeId: "edge-1",
        storeSelection: {
          nodeIds: [],
          edgeIds: ["edge-1"],
          annotationIds: [],
        },
        reactFlowSelection: {
          nodeIds: [],
          edgeIds: ["edge-1"],
          annotationIds: [],
        },
        renderSelection: undefined,
        targetSummary: "{\"renderEdgeCount\":1}",
        stack: "event stack",
        detailText: "{\"edgeId\":\"edge-1\"}",
      },
    ],
  })),
  logCanvasDebugSnapshot: vi.fn(),
}));

vi.mock("@/features/canvas/debug/canvasDebug", () => canvasDebugMocks);

import DiagnosticErrorBoundary from "../DiagnosticErrorBoundary";

const BrokenChild = () => {
  throw new Error("boundary render boom");
};

type DiagnosticPayload = {
  title?: string;
  error?: { message?: string };
  lastUnhandledError?: { message?: string };
};

const parseDiagnosticPayload = (text: string): DiagnosticPayload => {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object") {
    throw new Error("diagnostic payload must be an object");
  }
  return value as DiagnosticPayload;
};

describe("DiagnosticErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let clipboardWriteText: ReturnType<typeof vi.fn>;
  let copiedDiagnosticTexts: string[];

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    copiedDiagnosticTexts = [];
    clipboardWriteText = vi.fn(async (text: string) => {
      copiedDiagnosticTexts.push(text);
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "__IART_LAST_UNHANDLED_ERROR__");
    canvasDebugMocks.getCanvasDebugSnapshot.mockClear();
    canvasDebugMocks.logCanvasDebugSnapshot.mockClear();
    consoleErrorSpy.mockRestore();
  });

  it("展示用户可读的问题提示，并能复制错误详情", async () => {
    Object.defineProperty(window, "__IART_LAST_UNHANDLED_ERROR__", {
      configurable: true,
      value: new Error("last unhandled boom"),
    });

    render(
      <DiagnosticErrorBoundary label="test-boundary">
        <BrokenChild />
      </DiagnosticErrorBoundary>,
    );

    expect(screen.getByText("编辑器遇到了问题")).toBeInTheDocument();
    expect(screen.getAllByText(/boundary render boom/).length).toBeGreaterThan(
      0,
    );
    expect(canvasDebugMocks.logCanvasDebugSnapshot).toHaveBeenCalledWith(
      "ErrorBoundary(test-boundary)",
      expect.any(Error),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "复制错误详情" }),
    );

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    });
    const diagnosticText = copiedDiagnosticTexts[0];
    expect(typeof diagnosticText).toBe("string");
    const diagnostic = parseDiagnosticPayload(String(diagnosticText));
    expect(diagnostic.title).toBe("IARTStudio Editor diagnostic error");
    expect(diagnostic.error?.message).toBe("boundary render boom");
    expect(diagnostic.lastUnhandledError?.message).toBe("last unhandled boom");
  });
});

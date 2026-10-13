import React, { useRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ImageContentFrame } from "../../../utils/imageGeometry";
import type { AnnotationCanvasContext } from "../imageAnnotationRenderer";
import { measureTextBoxInImageSpace } from "../imageAnnotationRenderer";
import type {
  AnnotationSnapshot,
  Stroke,
  TextBox,
} from "../imageAnnotateDialogTypes";
import { useImageAnnotateCanvasDrawing } from "../useImageAnnotateCanvasDrawing";

const createFakeCanvasContext = (): AnnotationCanvasContext => {
  const fontSizeRef = { current: 16 };
  const context: AnnotationCanvasContext = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => {
      return { width: text.length * fontSizeRef.current * 0.5 } as TextMetrics;
    }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    lineCap: "round",
    lineJoin: "round",
    lineWidth: 1,
    strokeStyle: "#000000",
    fillStyle: "#000000",
    textAlign: "left",
    textBaseline: "top",
    font: "16px sans-serif",
  };
  Object.defineProperty(context, "font", {
    get: () => `${fontSizeRef.current}px sans-serif`,
    set: (value: string) => {
      const matched = /(\d+)px/.exec(value);
      fontSizeRef.current = matched ? Number(matched[1]) : 16;
    },
  });
  return context;
};

function DrawingHarness(props: {
  frame: ImageContentFrame;
  onSnapshot: (snapshot: AnnotationSnapshot) => void;
  onReady: (
    handlers: ReturnType<typeof useImageAnnotateCanvasDrawing>,
    canvasRef: React.RefObject<HTMLCanvasElement | null>,
  ) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const textsRef = useRef<TextBox[]>([]);
  const handlers = useImageAnnotateCanvasDrawing({
    open: true,
    activeTool: "brush",
    brushColor: "#ff0000",
    brushSize: 12,
    canvasRef,
    commitEditing: () => undefined,
    getContentFrame: () => props.frame,
    loading: false,
    pushSnapshot: props.onSnapshot,
    saving: false,
    selectedTextId: null,
    setSelectedTextId: () => undefined,
    startEditingText: () => undefined,
    strokesRef,
    syncCanvasSize: () => undefined,
    textFontSize: 24,
    textsRef,
  });
  props.onReady(handlers, canvasRef);
  return React.createElement("canvas", {
    ref: canvasRef,
  });
}

const createPointerEventLike = (params: {
  button: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  currentTarget: HTMLCanvasElement;
}): React.PointerEvent<HTMLCanvasElement> => {
  return {
    button: params.button,
    clientX: params.clientX,
    clientY: params.clientY,
    currentTarget: params.currentTarget,
    pointerId: params.pointerId,
    preventDefault: () => undefined,
  } as React.PointerEvent<HTMLCanvasElement>;
};

type HarnessBindings = {
  handlers: ReturnType<typeof useImageAnnotateCanvasDrawing> | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null> | null;
};

describe("imageAnnotate geometry", () => {
  it("ignores letterbox pointer and leaves debug trace", () => {
    const frame: ImageContentFrame = {
      left: 100,
      top: 200,
      width: 300,
      height: 150,
      scale: 1,
    };
    const snapshots: AnnotationSnapshot[] = [];
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const context = createFakeCanvasContext();
    const bindings: HarnessBindings = {
      handlers: null,
      canvasRef: null,
    };
    const { container } = render(
      React.createElement(DrawingHarness, {
        frame,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onReady: (nextHandlers, nextCanvasRef) => {
          bindings.handlers = nextHandlers;
          bindings.canvasRef = nextCanvasRef;
        },
      }),
    );
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    if (canvas === null) {
      throw new Error("canvas missing");
    }
    Object.defineProperty(canvas, "getContext", {
      value: () => context,
    });
    Object.defineProperty(canvas, "setPointerCapture", {
      value: () => undefined,
    });
    expect(bindings.handlers).not.toBeNull();
    if (bindings.handlers === null) {
      throw new Error("handlers missing");
    }
    bindings.handlers.handlePointerDown(
      createPointerEventLike({
        button: 0,
        clientX: 50,
        clientY: 50,
        pointerId: 1,
        currentTarget: canvas,
      }),
    );
    expect(snapshots).toHaveLength(0);
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
    expect(bindings.canvasRef).not.toBeNull();
    if (bindings.canvasRef === null) {
      throw new Error("canvasRef missing");
    }
    expect(bindings.canvasRef.current).toBe(canvas);
  });

  it("keeps center stroke point at image center for non-1:1 contain frame", () => {
    const frame: ImageContentFrame = {
      left: 0,
      top: 224,
      width: 1024,
      height: 576,
      scale: 1,
    };
    const snapshots: AnnotationSnapshot[] = [];
    const context = createFakeCanvasContext();
    const bindings: HarnessBindings = {
      handlers: null,
      canvasRef: null,
    };
    const { container } = render(
      React.createElement(DrawingHarness, {
        frame,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onReady: (nextHandlers, nextCanvasRef) => {
          bindings.handlers = nextHandlers;
          bindings.canvasRef = nextCanvasRef;
        },
      }),
    );
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    if (canvas === null) {
      throw new Error("canvas missing");
    }
    Object.defineProperty(canvas, "getContext", {
      value: () => context,
    });
    Object.defineProperty(canvas, "setPointerCapture", {
      value: () => undefined,
    });
    Object.defineProperty(canvas, "releasePointerCapture", {
      value: () => undefined,
    });
    expect(bindings.handlers).not.toBeNull();
    if (bindings.handlers === null) {
      throw new Error("handlers missing");
    }
    bindings.handlers.handlePointerDown(
      createPointerEventLike({
        button: 0,
        clientX: 512,
        clientY: 512,
        pointerId: 1,
        currentTarget: canvas,
      }),
    );
    bindings.handlers.handlePointerMove(
      createPointerEventLike({
        button: 0,
        clientX: 768,
        clientY: 512,
        pointerId: 1,
        currentTarget: canvas,
      }),
    );
    bindings.handlers.handlePointerUp(
      createPointerEventLike({
        button: 0,
        clientX: 768,
        clientY: 512,
        pointerId: 1,
        currentTarget: canvas,
      }),
    );
    expect(snapshots).toHaveLength(1);
    const stroke = snapshots[0]?.strokes[0];
    expect(stroke?.points[0]).toEqual({ x: 0.5, y: 0.5 });
    expect(stroke?.points[1]?.x).toBeCloseTo(0.75);
    expect(stroke?.widthRatio).toBeCloseTo(12 / 576);
  });

  it("uses proportional text metrics across preview and export sizes", () => {
    const ctx = createFakeCanvasContext();
    const textBox: TextBox = {
      id: "text-1",
      x: 0.5,
      y: 0.5,
      widthRatio: 0.4,
      rotation: 0,
      fontSizeRatio: 24 / 576,
      color: "#111111",
      text: "hello",
    };
    const preview = measureTextBoxInImageSpace({
      ctx,
      targetWidth: 1024,
      targetHeight: 576,
      textBox,
      editingTextId: null,
      editingValue: "",
    });
    const exported = measureTextBoxInImageSpace({
      ctx,
      targetWidth: 1600,
      targetHeight: 900,
      textBox,
      editingTextId: null,
      editingValue: "",
    });
    expect(exported.fontSizePx / preview.fontSizePx).toBeCloseTo(900 / 576);
    expect(exported.boxWidthPx / preview.boxWidthPx).toBeCloseTo(1600 / 1024);
  });
});

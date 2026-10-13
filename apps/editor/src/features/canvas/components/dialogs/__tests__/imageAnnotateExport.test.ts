import { describe, expect, it, vi } from "vitest";

import type { AnnotationCanvasContext } from "../imageAnnotationRenderer";
import { exportAnnotatedImageBlob } from "../imageAnnotateExport";
import type { Stroke, TextBox } from "../imageAnnotateDialogTypes";

type DrawCall =
  | { kind: "drawImage"; args: number[] }
  | { kind: "moveTo"; x: number; y: number }
  | { kind: "lineTo"; x: number; y: number }
  | { kind: "fillText"; text: string; x: number; y: number }
  | { kind: "translate"; x: number; y: number }
  | { kind: "lineWidth"; value: number };

const createFakeCanvasContext = (calls: DrawCall[]): AnnotationCanvasContext => {
  const fontSizeRef = { current: 16 };
  const context = {
    drawImage: vi.fn((...args: number[]) => {
      calls.push({ kind: "drawImage", args });
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => {
      calls.push({ kind: "moveTo", x, y });
    }),
    lineTo: vi.fn((x: number, y: number) => {
      calls.push({ kind: "lineTo", x, y });
    }),
    stroke: vi.fn(),
    fillText: vi.fn((text: string, x: number, y: number) => {
      calls.push({ kind: "fillText", text, x, y });
    }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn((x: number, y: number) => {
      calls.push({ kind: "translate", x, y });
    }),
    rotate: vi.fn(),
    measureText: vi.fn((text: string) => {
      return { width: text.length * fontSizeRef.current * 0.5 } as TextMetrics;
    }),
    set lineCap(_value: CanvasLineCap) {
      void _value;
    },
    set lineJoin(_value: CanvasLineJoin) {
      void _value;
    },
    set lineWidth(value: number) {
      calls.push({ kind: "lineWidth", value });
    },
    set strokeStyle(_value: string | CanvasGradient | CanvasPattern) {
      void _value;
    },
    set fillStyle(_value: string | CanvasGradient | CanvasPattern) {
      void _value;
    },
    set textAlign(_value: CanvasTextAlign) {
      void _value;
    },
    set textBaseline(_value: CanvasTextBaseline) {
      void _value;
    },
    set font(value: string) {
      const matched = /(\d+)px/.exec(value);
      fontSizeRef.current = matched ? Number(matched[1]) : 16;
    },
  };
  return context;
};

describe("imageAnnotate export", () => {
  it("projects center stroke and text into natural pixels with shared renderer semantics", async () => {
    const calls: DrawCall[] = [];
    const context = createFakeCanvasContext(calls);
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getContext", {
      value: () => context,
    });
    Object.defineProperty(canvas, "toBlob", {
      value: (cb: BlobCallback) => cb(new Blob(["ok"], { type: "image/png" })),
    });
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return canvas;
        }
        return originalCreateElement(tagName);
      });
    const strokes: Stroke[] = [
      {
        color: "#ff0000",
        widthRatio: 12 / 576,
        points: [
          { x: 0.5, y: 0.5 },
          { x: 0.75, y: 0.5 },
        ],
      },
    ];
    const texts: TextBox[] = [
      {
        id: "text-1",
        x: 0.5,
        y: 0.5,
        widthRatio: 0.4,
        rotation: 0,
        fontSizeRatio: 24 / 576,
        color: "#111111",
        text: "hello",
      },
    ];
    const image = document.createElement("img");
    Object.defineProperty(image, "naturalWidth", { value: 1600 });
    Object.defineProperty(image, "naturalHeight", { value: 900 });
    await exportAnnotatedImageBlob({
      image,
      strokes,
      texts,
      editingTextId: null,
      editingValue: "",
    });
    const strokeMove = calls.find((entry) => entry.kind === "moveTo");
    const strokeLine = calls.find((entry) => entry.kind === "lineTo");
    const textTranslate = calls.find((entry) => entry.kind === "translate");
    const lineWidth = calls.find((entry) => entry.kind === "lineWidth");
    expect(strokeMove).toEqual({ kind: "moveTo", x: 800, y: 450 });
    expect(strokeLine).toEqual({ kind: "lineTo", x: 1200, y: 450 });
    expect(textTranslate).toEqual({ kind: "translate", x: 800, y: 450 });
    expect(lineWidth).toEqual({ kind: "lineWidth", value: (12 / 576) * 900 });
    createElementSpy.mockRestore();
  });
});

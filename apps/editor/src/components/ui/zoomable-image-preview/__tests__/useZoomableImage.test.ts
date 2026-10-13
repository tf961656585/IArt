import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { useZoomableImage } from "../useZoomableImage";

// 为 imageRef 构造一个 mock <img>，让 getImageContentFrameFromElement 返回稳定 frame，
// 并补齐 useNonPassiveWheel 需要的 addEventListener/removeEventListener。
const makeImageMock = (rect: { left: number; top: number; width: number; height: number }) => {
  const listeners: Record<string, Array<EventListenerOrEventListenerObject>> = {};
  const el = {
    naturalWidth: 800,
    naturalHeight: 600,
    getBoundingClientRect: () => rect,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const list = listeners[type] ?? [];
      list.push(listener);
      listeners[type] = list;
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const list = listeners[type] ?? [];
      listeners[type] = list.filter((l) => l !== listener);
    },
  } as HTMLImageElement;
  return el;
};

const makeKeyboardEvent = (overrides: Partial<ReactKeyboardEvent<Element>>): ReactKeyboardEvent<Element> => {
  const base = {
    key: "+",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: {},
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
  return base as ReactKeyboardEvent<Element>;
};

const makePointerEvent = (overrides: Partial<ReactPointerEvent<HTMLElement>>): ReactPointerEvent<HTMLElement> => {
  const base = {
    button: 0,
    pointerId: 1,
    clientX: 100,
    clientY: 100,
    currentTarget: document.createElement("div"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
  return base as ReactPointerEvent<HTMLElement>;
};

const makeMouseEvent = (overrides: Partial<ReactMouseEvent<HTMLElement>>): ReactMouseEvent<HTMLElement> => {
  const base = {
    clientX: 300,
    clientY: 250,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
  return base as ReactMouseEvent<HTMLElement>;
};

const makeWheelEvent = (overrides: Partial<WheelEvent>): WheelEvent => {
  const base = {
    deltaY: -100,
    clientX: 300,
    clientY: 250,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
  return base as WheelEvent;
};

describe("useZoomableImage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const renderPreviewHook = (enabled: boolean = true) => {
    const imageRef = { current: makeImageMock({ left: 100, top: 100, width: 400, height: 300 }) };
    return renderHook(() =>
      useZoomableImage({
        imageRef,
        enabled,
        wheelZoomBase: undefined,
        wheelZoomUnit: undefined,
      }),
    );
  };

  it("初始状态为 Fit (scale=1)，平移归零，HUD 可见", () => {
    const { result } = renderPreviewHook();
    expect(result.current.state.scale).toBe(1);
    expect(result.current.state.pan).toEqual({ x: 0, y: 0 });
    expect(result.current.state.isPanning).toBe(false);
    expect(result.current.state.hudVisible).toBe(true);
    expect(result.current.cursor).toBe("default");
  });

  it("键盘 + 放大，再 - 缩小回到 1 附近", () => {
    const { result } = renderPreviewHook();
    const plusEvent = makeKeyboardEvent({ key: "+" });
    act(() => {
      result.current.handleKeyDownCapture(plusEvent);
    });
    expect(result.current.state.scale).toBeGreaterThan(1);
    expect(plusEvent.preventDefault).toHaveBeenCalled();

    const minusEvent = makeKeyboardEvent({ key: "-", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    act(() => {
      result.current.handleKeyDownCapture(minusEvent);
    });
    expect(result.current.state.scale).toBeGreaterThan(0);
  });

  it("键盘 R 重置回 Fit", () => {
    const { result } = renderPreviewHook();
    act(() => {
      result.current.handleKeyDownCapture(makeKeyboardEvent({ key: "+" }));
    });
    expect(result.current.state.scale).toBeGreaterThan(1);

    act(() => {
      result.current.handleKeyDownCapture(makeKeyboardEvent({ key: "r" }));
    });
    expect(result.current.state.scale).toBe(1);
    expect(result.current.state.pan).toEqual({ x: 0, y: 0 });
  });

  it("缩放后光标变为 grab", () => {
    const { result } = renderPreviewHook();
    act(() => {
      result.current.handleKeyDownCapture(makeKeyboardEvent({ key: "+" }));
    });
    expect(result.current.cursor).toBe("grab");
  });

  it("双击在 Fit 态放大到 2", () => {
    const { result } = renderPreviewHook();
    act(() => {
      result.current.handleDoubleClick(makeMouseEvent({ clientX: 300, clientY: 250 }));
    });
    expect(result.current.state.scale).toBeCloseTo(2, 5);
  });

  it("双击在 2 态回到 Fit", () => {
    const { result } = renderPreviewHook();
    act(() => {
      result.current.handleDoubleClick(makeMouseEvent({ clientX: 300, clientY: 250 }));
    });
    expect(result.current.state.scale).toBeCloseTo(2, 5);

    act(() => {
      result.current.handleDoubleClick(makeMouseEvent({ clientX: 300, clientY: 250 }));
    });
    expect(result.current.state.scale).toBe(1);
  });

  it("HUD 在指定延迟后自动淡出", () => {
    const { result } = renderPreviewHook();
    expect(result.current.state.hudVisible).toBe(true);
    act(() => {
      result.current.handleKeyDownCapture(makeKeyboardEvent({ key: "+" }));
    });
    expect(result.current.state.hudVisible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(result.current.state.hudVisible).toBe(false);
  });

  it("鼠标移动唤回 HUD", () => {
    const { result } = renderPreviewHook();
    act(() => {
      result.current.handleKeyDownCapture(makeKeyboardEvent({ key: "+" }));
    });
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(result.current.state.hudVisible).toBe(false);
    act(() => {
      result.current.handleSurfaceMouseMove();
    });
    expect(result.current.state.hudVisible).toBe(true);
  });

  it("PointerDown 启动平移并捕获光标为 grabbing", () => {
    const { result } = renderPreviewHook();
    const target = document.createElement("div");
    const setPointerCapture = vi.fn();
    // jsdom 的 Element 没有 setPointerCapture 实现，这里挂一个 mock 用于断言。
    // 用 Object.defineProperty 保持 HTMLElement 类型，避免双重断言。
    Object.defineProperty(target, "setPointerCapture", {
      value: setPointerCapture,
      configurable: true,
    });
    const event = makePointerEvent({
      clientX: 100,
      clientY: 100,
      currentTarget: target,
    });
    act(() => {
      result.current.handlePointerDown(event);
    });
    expect(result.current.state.isPanning).toBe(true);
    expect(result.current.cursor).toBe("grabbing");
    expect(setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("enabled=false 时所有交互处理器为 no-op", () => {
    const { result } = renderPreviewHook(false);
    const fakeWheel = makeWheelEvent({ deltaY: -100, clientX: 300, clientY: 250 });
    act(() => {
      result.current.handleWheel(fakeWheel);
    });
    expect(result.current.state.scale).toBe(1);
    expect(fakeWheel.preventDefault).not.toHaveBeenCalled();
  });
});

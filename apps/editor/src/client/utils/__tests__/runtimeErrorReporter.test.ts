import { afterEach, describe, expect, it, vi } from "vitest";
import { cast } from "@/lib/utils";

type MockRuntimeFlags = {
  electronDev: boolean;
};

type MockRuntimeFlagsHandler = (flags: MockRuntimeFlags) => void;

const canvasDebugMocks = vi.hoisted(() => ({
  logCanvasDebugSnapshot: vi.fn(),
}));

const runtimeFlagMocks = vi.hoisted(() => ({
  getRuntimeFlags: vi.fn(() => ({ electronDev: false })),
  isElectronDev: vi.fn(() => false),
  subscribeRuntimeFlags: vi.fn<(handler: MockRuntimeFlagsHandler) => () => void>(
    () => () => {},
  ),
}));

vi.mock("@/features/canvas/debug/canvasDebug", () => canvasDebugMocks);
vi.mock("../runtimeFlags", () => runtimeFlagMocks);

type RuntimeReporterTestWindow = Window & {
  __IART_RUNTIME_ERROR_REPORTER_INSTALLED__: boolean | undefined;
  __IART_CONSOLE_ERROR_PATCHED__: boolean | undefined;
  __IART_RESIZE_OBSERVER_DEBUG_PATCHED__: boolean | undefined;
  __IART_RESIZE_OBSERVER_DEBUG_SUBSCRIBED__: boolean | undefined;
  __IART_LAST_UNHANDLED_ERROR__: unknown | undefined;
  __IART_RO_DEBUG__: unknown | undefined;
  electron: unknown | undefined;
};

const getTestWindow = (): RuntimeReporterTestWindow =>
  cast<RuntimeReporterTestWindow>(window);

const resetReporterGuards = (): void => {
  const testWindow = getTestWindow();
  Reflect.deleteProperty(
    testWindow,
    "__IART_RUNTIME_ERROR_REPORTER_INSTALLED__",
  );
  Reflect.deleteProperty(testWindow, "__IART_CONSOLE_ERROR_PATCHED__");
  Reflect.deleteProperty(testWindow, "__IART_RESIZE_OBSERVER_DEBUG_PATCHED__");
  Reflect.deleteProperty(
    testWindow,
    "__IART_RESIZE_OBSERVER_DEBUG_SUBSCRIBED__",
  );
  Reflect.deleteProperty(testWindow, "__IART_LAST_UNHANDLED_ERROR__");
  Reflect.deleteProperty(testWindow, "__IART_RO_DEBUG__");
  Reflect.deleteProperty(testWindow, "electron");
};

describe("runtimeErrorReporter", () => {
  const originalConsoleError = console.error;

  afterEach(() => {
    console.error = originalConsoleError;
    resetReporterGuards();
    vi.restoreAllMocks();
    vi.resetModules();
    canvasDebugMocks.logCanvasDebugSnapshot.mockClear();
    runtimeFlagMocks.getRuntimeFlags.mockReset();
    runtimeFlagMocks.getRuntimeFlags.mockReturnValue({ electronDev: false });
    runtimeFlagMocks.isElectronDev.mockReset();
    runtimeFlagMocks.isElectronDev.mockReturnValue(false);
    runtimeFlagMocks.subscribeRuntimeFlags.mockReset();
    runtimeFlagMocks.subscribeRuntimeFlags.mockReturnValue(() => {});
  });

  it("packaged Electron 下也安装基础 error 与 unhandledrejection 捕获", async () => {
    resetReporterGuards();
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {},
    });
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const { installRuntimeErrorReporter } =
      await import("../runtimeErrorReporter");
    const testWindow = getTestWindow();

    installRuntimeErrorReporter();

    const errorHandler = addEventListenerSpy.mock.calls.find(
      ([type]) => type === "error",
    )?.[1];
    const rejectionHandler = addEventListenerSpy.mock.calls.find(
      ([type]) => type === "unhandledrejection",
    )?.[1];
    expect(errorHandler).toEqual(expect.any(Function));
    expect(rejectionHandler).toEqual(expect.any(Function));
    expect(runtimeFlagMocks.isElectronDev).toHaveBeenCalledTimes(1);
    expect(runtimeFlagMocks.subscribeRuntimeFlags).toHaveBeenCalledTimes(1);

    const windowError = new Error("packaged window error");
    if (typeof errorHandler === "function") {
      errorHandler({
        error: windowError,
        message: windowError.message,
      } as ErrorEvent);
    }
    expect(testWindow.__IART_LAST_UNHANDLED_ERROR__).toBe(windowError);
    expect(canvasDebugMocks.logCanvasDebugSnapshot).toHaveBeenCalledWith(
      "window.error",
      windowError,
    );

    const rejection = new Error("packaged rejection");
    if (typeof rejectionHandler === "function") {
      rejectionHandler({ reason: rejection } as PromiseRejectionEvent);
    }
    expect(testWindow.__IART_LAST_UNHANDLED_ERROR__).toBe(rejection);
    expect(canvasDebugMocks.logCanvasDebugSnapshot).toHaveBeenCalledWith(
      "window.unhandledrejection",
      rejection,
    );
  });

  it("非 Electron 环境不安装 reporter", async () => {
    resetReporterGuards();
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const { installRuntimeErrorReporter } =
      await import("../runtimeErrorReporter");
    const testWindow = getTestWindow();

    installRuntimeErrorReporter();

    expect(addEventListenerSpy).not.toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
    expect(
      testWindow.__IART_RUNTIME_ERROR_REPORTER_INSTALLED__,
    ).toBeUndefined();
  });

  it("初始非 dev 时在 runtime flag 变为 true 后安装 ResizeObserver debug patch", async () => {
    resetReporterGuards();
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {},
    });

    const originalResizeObserver = window.ResizeObserver;
    const resizeObserverStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: resizeObserverStub,
    });

    let runtimeFlagsHandler:
      | ((flags: MockRuntimeFlags) => void)
      | undefined;
    runtimeFlagMocks.getRuntimeFlags.mockReturnValue({ electronDev: false });
    runtimeFlagMocks.subscribeRuntimeFlags.mockImplementation(
      (handler: (flags: MockRuntimeFlags) => void) => {
        runtimeFlagsHandler = handler;
        return () => {};
      },
    );

    const { installRuntimeErrorReporter } =
      await import("../runtimeErrorReporter");
    const testWindow = getTestWindow();

    installRuntimeErrorReporter();

    expect(testWindow.__IART_RESIZE_OBSERVER_DEBUG_PATCHED__).toBeUndefined();
    expect(testWindow.__IART_RESIZE_OBSERVER_DEBUG_SUBSCRIBED__).toBe(true);
    expect(runtimeFlagMocks.subscribeRuntimeFlags).toHaveBeenCalledTimes(1);

    runtimeFlagMocks.isElectronDev.mockReturnValue(true);
    if (runtimeFlagsHandler !== undefined) {
      runtimeFlagsHandler({ electronDev: true });
    }

    expect(testWindow.__IART_RESIZE_OBSERVER_DEBUG_PATCHED__).toBe(true);
    expect(window.ResizeObserver).not.toBe(resizeObserverStub);

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    });
  });
});

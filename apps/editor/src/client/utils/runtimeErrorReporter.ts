import { cast } from "@/lib/utils";
import { logCanvasDebugSnapshot } from "@/features/canvas/debug/canvasDebug";
import {
  ensureResizeObserverDebugPatchSubscription,
  installResizeObserverDebugPatch,
  readResizeObserverLoopPayload,
} from "./runtimeErrorReporter.resizeObserver";

const GUARD_KEY = "__IART_RUNTIME_ERROR_REPORTER_INSTALLED__";
const CONSOLE_GUARD_KEY = "__IART_CONSOLE_ERROR_PATCHED__";
type RuntimeErrorReporterWindow = Window & {
  [GUARD_KEY]: boolean | undefined;
  [CONSOLE_GUARD_KEY]: boolean | undefined;
  __IART_LAST_UNHANDLED_ERROR__: unknown | undefined;
  electron: unknown | undefined;
};

const extractResizeObserverLoopText = (value: unknown): string | null => {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Error)
      return value.message || value.stack || String(value);
    if (value && typeof value === "object" && "message" in value) {
      const msg = value.message;
      if (typeof msg === "string") return msg;
    }
    return null;
  } catch {
    return null;
  }
};

const looksLikeResizeObserverLoop = (text: string): boolean => {
  if (!text) return false;
  return text.includes(
    "ResizeObserver loop completed with undelivered notifications",
  );
};

const readErrorEventPayload = (event: ErrorEvent): unknown =>
  event.error ?? event.message ?? event;

const readPromiseRejectionPayload = (event: PromiseRejectionEvent): unknown =>
  event.reason ?? event;

const normalizeConsoleArgs = (args: unknown[]): string => {
  try {
    return args
      .map((item) => {
        if (typeof item === "string") return item;
        if (item instanceof Error)
          return item.stack || item.message || String(item);
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(" ");
  } catch {
    return "";
  }
};

const looksLikeReactMaxUpdateDepth = (text: string): boolean => {
  if (!text) return false;
  return (
    text.includes("Minified React error #185") ||
    text.includes("Maximum update depth exceeded") ||
    text.includes("react.dev/errors/185")
  );
};

const isElectronRuntime = (): boolean => {
  if (typeof window === "undefined") return false;
  return Boolean(cast<RuntimeErrorReporterWindow>(window).electron);
};

export const installRuntimeErrorReporter = (): void => {
  if (!isElectronRuntime()) return;
  if (typeof window === "undefined") return;

  // Install early: ResizeObserver loop is usually a symptom, and we want the last observer callback context.
  installResizeObserverDebugPatch();
  ensureResizeObserverDebugPatchSubscription();

  try {
    const desired = 50;
    if (
      typeof Error.stackTraceLimit === "number" &&
      Error.stackTraceLimit < desired
    ) {
      Error.stackTraceLimit = desired;
    }
  } catch {
    // ignore
  }

  const anyWindow = cast<RuntimeErrorReporterWindow>(window);
  if (anyWindow[GUARD_KEY]) return;
  anyWindow[GUARD_KEY] = true;

  try {
    window.addEventListener("error", (event) => {
      const err = readErrorEventPayload(event);
      anyWindow.__IART_LAST_UNHANDLED_ERROR__ = err;
      const text = extractResizeObserverLoopText(err);
      if (text && looksLikeResizeObserverLoop(text)) {
        logCanvasDebugSnapshot("window.error(ResizeObserver loop)", {
          message: text,
          lastResizeObserver: readResizeObserverLoopPayload(),
        });
        return;
      }
      logCanvasDebugSnapshot("window.error", err);
    });
  } catch {
    // ignore
  }

  try {
    window.addEventListener("unhandledrejection", (event) => {
      const err = readPromiseRejectionPayload(event);
      anyWindow.__IART_LAST_UNHANDLED_ERROR__ = err;
      logCanvasDebugSnapshot("window.unhandledrejection", err);
    });
  } catch {
    // ignore
  }

  // React 的一些致命错误会以 console.error 的形式出现（未必触发 window.onerror），这里做兜底。
  if (!anyWindow[CONSOLE_GUARD_KEY]) {
    anyWindow[CONSOLE_GUARD_KEY] = true;
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      original(...args);
      try {
        const text = normalizeConsoleArgs(args);
        if (looksLikeResizeObserverLoop(text)) {
          logCanvasDebugSnapshot("console.error(ResizeObserver loop)", {
            message: text,
            lastResizeObserver: readResizeObserverLoopPayload(),
          });
          return;
        }
        if (looksLikeReactMaxUpdateDepth(text)) {
          const errorArg = args.find((item) => item instanceof Error);
          logCanvasDebugSnapshot(
            "console.error(Maximum update depth)",
            errorArg instanceof Error ? errorArg : text,
          );
        }
      } catch {
        // ignore
      }
    };
  }
};

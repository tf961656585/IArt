import {
  getRuntimeFlags,
  isElectronDev,
  subscribeRuntimeFlags,
} from "./runtimeFlags";
import { cast } from "@/lib/utils";

const RESIZE_OBSERVER_GUARD_KEY = "__IART_RESIZE_OBSERVER_DEBUG_PATCHED__";
const RESIZE_OBSERVER_SUBSCRIBE_GUARD_KEY =
  "__IART_RESIZE_OBSERVER_DEBUG_SUBSCRIBED__";

type ResizeObserverInvocationTarget = {
  targetDebugId: string | undefined;
  debugLabel: string | undefined;
  tag: string;
  id: string | undefined;
  className: string | undefined;
  dataId: string | undefined;
  reactFlowNodeId: string | undefined;
  targetPath: string | undefined;
  contentRect: { width: number; height: number } | undefined;
  deltaSinceLast: { width: number; height: number } | undefined;
};

type ResizeObserverInvocation = {
  ts: number;
  observerId: number;
  observerLabel: string | undefined;
  callbackCount: number;
  recentCallbackCount: number;
  targets: ResizeObserverInvocationTarget[];
  callbackStack: string | undefined;
};

type ResizeObserverObservedTarget = {
  targetDebugId: string;
  debugLabel: string | undefined;
  tag: string;
  id: string | undefined;
  className: string | undefined;
  dataId: string | undefined;
  reactFlowNodeId: string | undefined;
  targetPath: string | undefined;
  observeOptions: string | undefined;
  lastObservedRect: { width: number; height: number } | undefined;
};

type ResizeObserverOperation = {
  ts: number;
  kind: "observe" | "unobserve" | "disconnect";
  observerId: number;
  observerLabel: string | undefined;
  targetDebugId: string | undefined;
  targetPath: string | undefined;
  stack: string | undefined;
};

type ResizeObserverInstanceInfo = {
  id: number;
  createdAt: number;
  createdStack: string | undefined;
  label: string | undefined;
  callbackCount: number;
  lastCallbackAt: number | undefined;
  recentCallbackCount: number;
  observedTargets: ResizeObserverObservedTarget[];
  recentOperations: ResizeObserverOperation[];
};

type ResizeObserverCallbackWithLabel = ResizeObserverCallback & {
  __IART_RO_LABEL: string | undefined;
};

type ResizeObserverDebugState = {
  nextId: number;
  instances: Map<number, ResizeObserverInstanceInfo>;
  recent: ResizeObserverInvocation[];
};

type RuntimeErrorReporterWindow = Window & {
  [RESIZE_OBSERVER_GUARD_KEY]: boolean | undefined;
  [RESIZE_OBSERVER_SUBSCRIBE_GUARD_KEY]: boolean | undefined;
  __IART_RO_DEBUG__: ResizeObserverDebugState | undefined;
};

const trimStack = (
  stack: string | null | undefined,
  maxLines = 18,
): string | undefined => {
  const raw = typeof stack === "string" ? stack.trim() : "";
  if (!raw) return undefined;
  return raw.split("\n").slice(0, maxLines).join("\n");
};

const buildTargetPath = (el: Element): string | undefined => {
  try {
    const parts: string[] = [];
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < 4) {
      const tagName =
        typeof current.tagName === "string" && current.tagName.trim()
          ? current.tagName.toLowerCase()
          : "unknown";
      const idCandidate =
        typeof current.getAttribute === "function"
          ? current.getAttribute("id")
          : null;
      const dataIdCandidate =
        typeof current.getAttribute === "function"
          ? current.getAttribute("data-id")
          : null;
      const classCandidate =
        typeof current.getAttribute === "function"
          ? current.getAttribute("class")
          : null;
      const classToken =
        typeof classCandidate === "string" && classCandidate.trim()
          ? classCandidate.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      const suffix = idCandidate
        ? `#${idCandidate}`
        : dataIdCandidate
          ? `[data-id="${dataIdCandidate}"]`
          : classToken
            ? `.${classToken}`
            : "";
      parts.unshift(`${tagName}${suffix}`);
      current = current.parentElement;
      depth += 1;
    }
    if (parts.length === 0) return undefined;
    return parts.join(" > ");
  } catch {
    return undefined;
  }
};

const readDebugLabel = (el: Element): string | undefined => {
  try {
    if (typeof el.getAttribute !== "function") return undefined;
    const ownLabel = el.getAttribute("data-iart-debug-label");
    if (typeof ownLabel === "string" && ownLabel.trim()) {
      return ownLabel.trim();
    }
    if (typeof (el as HTMLElement).closest !== "function") return undefined;
    const labeledAncestor = (el as HTMLElement).closest(
      "[data-iart-debug-label]",
    ) as HTMLElement | null;
    if (
      labeledAncestor !== null &&
      labeledAncestor !== undefined &&
      typeof labeledAncestor.getAttribute === "function"
    ) {
      const inheritedLabel =
        labeledAncestor.getAttribute("data-iart-debug-label");
      if (typeof inheritedLabel === "string" && inheritedLabel.trim()) {
        return inheritedLabel.trim();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const formatObserveOptions = (
  options: ResizeObserverOptions | undefined,
): string | undefined => {
  if (!options) return undefined;
  const box = options.box;
  return typeof box === "string" && box.trim() ? `box=${box}` : undefined;
};

const buildResizeObserverLoopPayloadFromState = (
  roState: ResizeObserverDebugState | undefined,
): unknown | null => {
  if (!roState) return null;
  const recent = roState.recent.slice(-12);
  const recentObserverIds = new Set(recent.map((item) => item.observerId));
  const instances = Array.from(recentObserverIds)
    .map((id) => roState.instances.get(id))
    .filter(
      (instance): instance is ResizeObserverInstanceInfo =>
        instance !== undefined,
    );
  const observerSummary = instances.map((instance) => ({
    id: instance.id,
    label: instance.label,
    callbackCount: instance.callbackCount,
    lastCallbackAt: instance.lastCallbackAt,
    recentCallbackCount: instance.recentCallbackCount,
    observedTargetCount: instance.observedTargets.length,
    observedTargets: instance.observedTargets,
    recentOperations: instance.recentOperations,
    createdAt: instance.createdAt,
  }));
  return {
    recent,
    instances,
    observerSummary,
  };
};

export const readResizeObserverLoopPayload = (): unknown | null => {
  if (typeof window === "undefined") return null;
  const anyWindow = cast<RuntimeErrorReporterWindow>(window);
  return buildResizeObserverLoopPayloadFromState(anyWindow.__IART_RO_DEBUG__);
};

export const installResizeObserverDebugPatch = (): void => {
  if (!isElectronDev()) return;
  if (typeof window === "undefined") return;

  const anyWindow = cast<RuntimeErrorReporterWindow>(window);
  if (anyWindow[RESIZE_OBSERVER_GUARD_KEY]) return;
  anyWindow[RESIZE_OBSERVER_GUARD_KEY] = true;

  if (typeof ResizeObserver === "undefined") return;

  const OriginalResizeObserver = ResizeObserver;
  const elementDebugIdMap = new WeakMap<Element, string>();
  const lastRectByTargetDebugId = new Map<
    string,
    { width: number; height: number }
  >();
  let nextTargetId = 1;

  const getOrInitState = () => {
    if (!anyWindow.__IART_RO_DEBUG__) {
      anyWindow.__IART_RO_DEBUG__ = {
        nextId: 1,
        instances: new Map(),
        recent: [],
      };
    }
    return anyWindow.__IART_RO_DEBUG__;
  };

  const getOrCreateTargetDebugId = (target: Element): string => {
    const existing = elementDebugIdMap.get(target);
    if (typeof existing === "string" && existing.trim()) return existing;
    const next = `ro-target-${nextTargetId++}`;
    elementDebugIdMap.set(target, next);
    return next;
  };

  const trimOperationHistory = (instance: ResizeObserverInstanceInfo): void => {
    if (instance.recentOperations.length > 12) {
      instance.recentOperations = instance.recentOperations.slice(
        instance.recentOperations.length - 12,
      );
    }
  };

  const recordOperation = (
    observerId: number,
    kind: "observe" | "unobserve" | "disconnect",
    target: Element | undefined,
    options: ResizeObserverOptions | undefined,
  ): void => {
    const state = getOrInitState();
    const instance = state.instances.get(observerId);
    if (!instance) return;
    const targetDebugId =
      target !== undefined ? getOrCreateTargetDebugId(target) : undefined;
    const targetPath =
      target !== undefined ? buildTargetPath(target) : undefined;
    const operation: ResizeObserverOperation = {
      ts: Date.now(),
      kind,
      observerId,
      observerLabel: instance.label,
      targetDebugId,
      targetPath,
      stack: trimStack(new Error(`ResizeObserver ${kind}`).stack),
    };
    instance.recentOperations.push(operation);
    trimOperationHistory(instance);

    if (kind === "observe" && target !== undefined) {
      const reactFlowNodeId = (() => {
        if (typeof (target as HTMLElement).closest !== "function") {
          return undefined;
        }
        const reactFlowNode = (target as HTMLElement).closest(
          ".react-flow__node",
        ) as HTMLElement | null;
        if (
          reactFlowNode !== null &&
          reactFlowNode !== undefined &&
          typeof reactFlowNode.getAttribute === "function"
        ) {
          return reactFlowNode.getAttribute("data-id") ?? undefined;
        }
        return undefined;
      })();
      const snapshot: ResizeObserverObservedTarget = {
        targetDebugId: targetDebugId ?? getOrCreateTargetDebugId(target),
        debugLabel: readDebugLabel(target),
        tag:
          typeof target.tagName === "string" && target.tagName.trim()
            ? target.tagName.toLowerCase()
            : "unknown",
        id:
          typeof target.getAttribute === "function"
            ? (target.getAttribute("id") ?? undefined)
            : undefined,
        className:
          typeof target.getAttribute === "function"
            ? (target.getAttribute("class") ?? undefined)
            : undefined,
        dataId:
          typeof target.getAttribute === "function"
            ? (target.getAttribute("data-id") ?? undefined)
            : undefined,
        reactFlowNodeId,
        targetPath,
        observeOptions: formatObserveOptions(options),
        lastObservedRect: undefined,
      };
      const existingIndex = instance.observedTargets.findIndex(
        (item) => item.targetDebugId === snapshot.targetDebugId,
      );
      if (existingIndex >= 0) {
        instance.observedTargets[existingIndex] = snapshot;
      } else {
        instance.observedTargets.push(snapshot);
      }
      if (instance.observedTargets.length > 16) {
        instance.observedTargets = instance.observedTargets.slice(
          instance.observedTargets.length - 16,
        );
      }
      return;
    }

    if (kind === "unobserve" && targetDebugId) {
      instance.observedTargets = instance.observedTargets.filter(
        (item) => item.targetDebugId !== targetDebugId,
      );
      return;
    }

    if (kind === "disconnect") {
      instance.observedTargets = [];
    }
  };

  const recordInvocation = (
    observerId: number,
    entries: ResizeObserverEntry[],
  ) => {
    const state = getOrInitState();
    const observerInfo = state.instances.get(observerId);
    const observerLabel =
      observerInfo !== undefined ? observerInfo.label : undefined;
    const invocationTs = Date.now();
    if (observerInfo) {
      observerInfo.callbackCount += 1;
      observerInfo.lastCallbackAt = invocationTs;
      const recentOperations = observerInfo.recentOperations.filter(
        (item) => invocationTs - item.ts <= 1000,
      );
      observerInfo.recentOperations = recentOperations;
      observerInfo.recentCallbackCount =
        state.recent.filter(
          (item) =>
            item.observerId === observerId && invocationTs - item.ts <= 1000,
        ).length + 1;
    }
    const targets: ResizeObserverInvocationTarget[] = [];
    for (const entry of entries) {
      const el = entry.target as Element | null;
      if (!el) continue;
      const targetDebugId = getOrCreateTargetDebugId(el);
      const debugLabel = readDebugLabel(el);
      const html = el as HTMLElement;
      const dataId =
        typeof html.getAttribute === "function"
          ? (html.getAttribute("data-id") ?? undefined)
          : undefined;
      const rfNodeEl =
        typeof html.closest === "function"
          ? (html.closest(".react-flow__node") as HTMLElement | null)
          : null;
      const rfNodeId =
        rfNodeEl && typeof rfNodeEl.getAttribute === "function"
          ? (rfNodeEl.getAttribute("data-id") ?? undefined)
          : undefined;
      const elementWithOptionalFields = el as Element & {
        id: unknown | undefined;
        className: unknown | undefined;
      };
      const normalizedId =
        typeof elementWithOptionalFields.id === "string"
          ? elementWithOptionalFields.id
          : undefined;
      const normalizedClassName =
        typeof elementWithOptionalFields.className === "string"
          ? elementWithOptionalFields.className
          : undefined;
      const contentRect = entry.contentRect
        ? {
            width: Math.round(entry.contentRect.width),
            height: Math.round(entry.contentRect.height),
          }
        : undefined;
      const targetPath = buildTargetPath(el);
      const previousRect = lastRectByTargetDebugId.get(targetDebugId);
      const deltaSinceLast =
        previousRect !== undefined && contentRect !== undefined
          ? {
              width: contentRect.width - previousRect.width,
              height: contentRect.height - previousRect.height,
            }
          : undefined;
      if (contentRect !== undefined) {
        lastRectByTargetDebugId.set(targetDebugId, contentRect);
      }
      if (observerInfo) {
        observerInfo.observedTargets = observerInfo.observedTargets.map(
          (item) =>
            item.targetDebugId === targetDebugId
              ? {
                  ...item,
                  lastObservedRect: contentRect,
                  targetPath: targetPath ?? item.targetPath,
                }
              : item,
        );
      }

      targets.push({
        targetDebugId,
        debugLabel,
        tag:
          (el.tagName !== null &&
          el.tagName !== undefined &&
          el.tagName.toLowerCase !== null &&
          el.tagName.toLowerCase !== undefined
            ? el.tagName.toLowerCase()
            : undefined) ?? "unknown",
        id: normalizedId,
        className: normalizedClassName,
        dataId,
        reactFlowNodeId: rfNodeId,
        targetPath,
        contentRect,
        deltaSinceLast,
      });
    }

    const callbackStack = (() => {
      try {
        return trimStack(new Error("ResizeObserver callback").stack);
      } catch {
        return undefined;
      }
    })();

    const invocation: ResizeObserverInvocation = {
      ts: invocationTs,
      observerId,
      observerLabel: observerLabel || undefined,
      callbackCount:
        observerInfo !== undefined ? observerInfo.callbackCount : 1,
      recentCallbackCount:
        observerInfo !== undefined ? observerInfo.recentCallbackCount : 1,
      targets,
      callbackStack: callbackStack || undefined,
    };
    state.recent.push(invocation);
    if (state.recent.length > 30) {
      state.recent = state.recent.slice(state.recent.length - 30);
    }
  };

  class PatchedResizeObserver {
    private _ro: ResizeObserver;
    private _id: number;

    constructor(callback: ResizeObserverCallback) {
      const state = getOrInitState();
      const id = state.nextId++;
      this._id = id;

      const label =
        typeof callback === "function"
          ? (callback as ResizeObserverCallbackWithLabel).__IART_RO_LABEL
          : undefined;

      const createdStack = (() => {
        try {
          return trimStack(new Error("ResizeObserver created").stack);
        } catch {
          return undefined;
        }
      })();
      state.instances.set(id, {
        id,
        createdAt: Date.now(),
        createdStack: createdStack || undefined,
        label: label || undefined,
        callbackCount: 0,
        lastCallbackAt: undefined,
        recentCallbackCount: 0,
        observedTargets: [],
        recentOperations: [],
      });
      if (state.instances.size > 80) {
        const ids = Array.from(state.instances.keys()).sort((a, b) => a - b);
        for (const victim of ids.slice(0, state.instances.size - 80)) {
          state.instances.delete(victim);
        }
      }

      this._ro = new OriginalResizeObserver((entries, obs) => {
        try {
          recordInvocation(id, entries);
        } catch {
          // ignore
        }
        return callback(entries, obs);
      });
    }

    observe(target: Element, options: ResizeObserverOptions | undefined): void {
      try {
        recordOperation(this._id, "observe", target, options);
      } catch {
        // ignore
      }
      this._ro.observe(target, options);
    }

    unobserve(target: Element): void {
      try {
        recordOperation(this._id, "unobserve", target, undefined);
      } catch {
        // ignore
      }
      this._ro.unobserve(target);
    }

    disconnect(): void {
      try {
        recordOperation(this._id, "disconnect", undefined, undefined);
      } catch {
        // ignore
      }
      this._ro.disconnect();
    }
  }

  window.ResizeObserver = PatchedResizeObserver;
};

export const ensureResizeObserverDebugPatchSubscription = (): void => {
  if (typeof window === "undefined") return;
  const anyWindow = cast<RuntimeErrorReporterWindow>(window);
  if (anyWindow[RESIZE_OBSERVER_SUBSCRIBE_GUARD_KEY]) return;
  anyWindow[RESIZE_OBSERVER_SUBSCRIBE_GUARD_KEY] = true;

  if (getRuntimeFlags().electronDev) {
    installResizeObserverDebugPatch();
    return;
  }

  subscribeRuntimeFlags((flags) => {
    if (!flags.electronDev) return;
    installResizeObserverDebugPatch();
  });
};

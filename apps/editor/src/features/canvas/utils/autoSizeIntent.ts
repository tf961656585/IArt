import type { NodeSize } from "../types/node";

export type AutoSizeGuard = { windowStart: number; count: number } | null;

export function computeAutoSizeIntent(params: {
  currentSize: NodeSize | null | undefined;
  desiredSize: NodeSize | null | undefined;
  nowMs: number;
  guard: AutoSizeGuard;
  epsilonPx: number | undefined;
  guardWindowMs: number | undefined;
  maxUpdatesPerWindow: number | undefined;
}): { intent: NodeSize | null; nextGuard: AutoSizeGuard; blocked: boolean } {
  const currentWidth = Math.round(Number((params.currentSize !== null && params.currentSize !== undefined ? params.currentSize.width : undefined)));
  const currentHeight = Math.round(Number((params.currentSize !== null && params.currentSize !== undefined ? params.currentSize.height : undefined)));
  const desiredWidth = Math.round(Number((params.desiredSize !== null && params.desiredSize !== undefined ? params.desiredSize.width : undefined)));
  const desiredHeight = Math.round(Number((params.desiredSize !== null && params.desiredSize !== undefined ? params.desiredSize.height : undefined)));

  if (
    !Number.isFinite(currentWidth) ||
    !Number.isFinite(currentHeight) ||
    currentWidth <= 0 ||
    currentHeight <= 0 ||
    !Number.isFinite(desiredWidth) ||
    !Number.isFinite(desiredHeight) ||
    desiredWidth <= 0 ||
    desiredHeight <= 0
  ) {
    return { intent: null, nextGuard: params.guard, blocked: false };
  }

  const epsilon = Number.isFinite(params.epsilonPx) ? Math.max(0, Number(params.epsilonPx)) : 1;
  if (Math.abs(desiredWidth - currentWidth) <= epsilon && Math.abs(desiredHeight - currentHeight) <= epsilon) {
    return { intent: null, nextGuard: params.guard, blocked: false };
  }

  const now = Number(params.nowMs);
  const guardWindowMs = Number.isFinite(params.guardWindowMs) ? Math.max(0, Number(params.guardWindowMs)) : 1500;
  const maxUpdates = Number.isFinite(params.maxUpdatesPerWindow)
    ? Math.max(1, Math.floor(Number(params.maxUpdatesPerWindow)))
    : 8;

  let nextGuard = params.guard;
  if (!nextGuard || !Number.isFinite(nextGuard.windowStart) || now - nextGuard.windowStart > guardWindowMs) {
    nextGuard = { windowStart: now, count: 0 };
  }

  nextGuard = { windowStart: nextGuard.windowStart, count: nextGuard.count + 1 };
  if (nextGuard.count > maxUpdates) {
    return { intent: null, nextGuard, blocked: true };
  }

  return { intent: { width: desiredWidth, height: desiredHeight }, nextGuard, blocked: false };
}


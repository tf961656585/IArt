import { isElectronDev } from '@/client/utils/runtimeFlags';

type CanvasSelectionTraceState = {
  traceId: string;
  origin: string;
  reason: string;
  startedAt: number;
  lastEventAt: number;
};

export type CanvasSelectionTraceMeta = {
  traceId: string;
  traceOrigin: string;
  traceStep: string;
  traceReasonTag: string;
  traceAgeMs: number;
  selectionSource: string;
};

type TouchCanvasSelectionTraceArgs = {
  step: string;
  origin: string;
  reason: string;
  forceNewTrace: boolean;
  selectionSource: string | undefined;
};

const SELECTION_TRACE_TTL_MS = 1500;

let selectionTraceSeq = 0;
let activeSelectionTrace: CanvasSelectionTraceState | null = null;

const readActiveSelectionTrace = (
  now: number,
): CanvasSelectionTraceState | null => {
  if (activeSelectionTrace === null) return null;
  if (now - activeSelectionTrace.lastEventAt > SELECTION_TRACE_TTL_MS) {
    activeSelectionTrace = null;
    return null;
  }
  return activeSelectionTrace;
};

const createSelectionTrace = (
  origin: string,
  reason: string,
  now: number,
): CanvasSelectionTraceState => {
  selectionTraceSeq += 1;
  const trace: CanvasSelectionTraceState = {
    traceId: `sel-${now}-${selectionTraceSeq}`,
    origin,
    reason,
    startedAt: now,
    lastEventAt: now,
  };
  activeSelectionTrace = trace;
  return trace;
};

export const beginCanvasSelectionTrace = (params: {
  origin: string;
  reason: string;
}): CanvasSelectionTraceMeta => {
  if (!isElectronDev()) {
    return {
      traceId: 'selection-trace-disabled',
      traceOrigin: params.origin,
      traceStep: 'interaction-start',
      traceReasonTag: params.reason,
      traceAgeMs: 0,
      selectionSource: 'user-interaction',
    };
  }

  const now = Date.now();
  const trace = createSelectionTrace(params.origin, params.reason, now);
  return {
    traceId: trace.traceId,
    traceOrigin: trace.origin,
    traceStep: 'interaction-start',
    traceReasonTag: trace.reason,
    traceAgeMs: 0,
    selectionSource: 'user-interaction',
  };
};

export const touchCanvasSelectionTrace = (
  params: TouchCanvasSelectionTraceArgs,
): CanvasSelectionTraceMeta => {
  if (!isElectronDev()) {
    return {
      traceId: 'selection-trace-disabled',
      traceOrigin: params.origin,
      traceStep: params.step,
      traceReasonTag: params.reason,
      traceAgeMs: 0,
      selectionSource: params.selectionSource ?? 'react-flow-or-user-followup',
    };
  }

  const now = Date.now();
  const currentTrace = readActiveSelectionTrace(now);
  const trace =
    params.forceNewTrace || currentTrace === null
      ? createSelectionTrace(params.origin, params.reason, now)
      : currentTrace;
  trace.lastEventAt = now;

  let selectionSource = params.selectionSource;
  if (!selectionSource) {
    selectionSource = 'react-flow-or-user-followup';
  }

  return {
    traceId: trace.traceId,
    traceOrigin: trace.origin,
    traceStep: params.step,
    traceReasonTag: trace.reason,
    traceAgeMs: now - trace.startedAt,
    selectionSource,
  };
};

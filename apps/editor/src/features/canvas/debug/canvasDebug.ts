import { isElectronDev } from '@/client/utils/runtimeFlags';
export {
  beginCanvasSelectionTrace,
  touchCanvasSelectionTrace,
} from './canvasSelectionTraceDebug';

interface CanvasDebugDetail {
  traceId: unknown | undefined;
  traceOrigin: unknown | undefined;
  traceStep: unknown | undefined;
  traceReasonTag: unknown | undefined;
  traceAgeMs: unknown | undefined;
  selectionSource: unknown | undefined;
  commandKind: unknown | undefined;
  previousStoreSelection: unknown | undefined;
  nextStoreSelection: unknown | undefined;
  previousReactFlowSelection: unknown | undefined;
  nextReactFlowSelection: unknown | undefined;
  changedNodeIds: unknown | undefined;
  changedEdgeIds: unknown | undefined;
  changedNodeCount: unknown | undefined;
  changedEdgeCount: unknown | undefined;
  throttleKey: unknown | undefined;
  disableThrottle: unknown | undefined;
  traceScope: unknown | undefined;
  traceNodeKey: unknown | undefined;
  nodeId: unknown | undefined;
  edgeId: unknown | undefined;
  modelNodeId: unknown | undefined;
  resultAreaNodeId: unknown | undefined;
  modelId: unknown | undefined;
  nodeIds: unknown | undefined;
  edgeIds: unknown | undefined;
  annotationIds: unknown | undefined;
  via: unknown | undefined;
  phase: unknown | undefined;
  requestKey: unknown | undefined;
  key: unknown | undefined;
  reasonTag: unknown | undefined;
  blocked: unknown | undefined;
  retryAtMs: unknown | undefined;
  guardCount: unknown | undefined;
  lastAppliedKey: unknown | undefined;
  currentSize: unknown | undefined;
  current: unknown | undefined;
  desiredSize: unknown | undefined;
  desired: unknown | undefined;
  intent: unknown | undefined;
  contentSize: unknown | undefined;
  viewportSize: unknown | undefined;
  rawFormMetrics: unknown | undefined;
  formSize: unknown | undefined;
  visibleParamsSectionSize: unknown | undefined;
  actualNodeSize: unknown | undefined;
  itemCount: unknown | undefined;
  resultAreaItemCount: unknown | undefined;
  collapsed: unknown | undefined;
  chromeReady: unknown | undefined;
  chromeOverhead: unknown | undefined;
  shouldRenderEmbeddedResultArea: unknown | undefined;
  embeddedLayoutKey: unknown | undefined;
  semanticKey: unknown | undefined;
  embeddedSemanticKey: unknown | undefined;
  requestSignature: unknown | undefined;
  action: unknown | undefined;
  changeCount: unknown | undefined;
  changeIds: unknown | undefined;
  candidateCount: unknown | undefined;
  candidateNodeIds: unknown | undefined;
  commitNodeIds: unknown | undefined;
  clearNodeIds: unknown | undefined;
  keepNodeIds: unknown | undefined;
  stableEdgeCount: unknown | undefined;
  renderEdgeCount: unknown | undefined;
  reactFlowEdgeCount: unknown | undefined;
  domEdgeCount: unknown | undefined;
  domEdgePathCount: unknown | undefined;
  domSvgPathCount: unknown | undefined;
  previewCount: unknown | undefined;
  declaredCount: unknown | undefined;
  actualCount: unknown | undefined;
  storeSelection: unknown | undefined;
  reactFlowSelection: unknown | undefined;
  renderSelection: unknown | undefined;
  selectionReason: unknown | undefined;
  targetSummary: unknown | undefined;
}

type CanvasDebugGraphInfo = {
  nodeGraphId: string | null;
  nodeCount: number;
  structureRevision: number;
  positionRevision: number;
  historyIndex: number;
  selectedNodeCount: number;
};

type CanvasDebugExecutionContext = {
  ts: number;
  executionId: string;
  nodeId: string;
  nodeType: string | undefined;
  via: string | undefined;
};

type CanvasDebugSelectionState = {
  nodeIds: string[];
  edgeIds: string[];
  annotationIds: string[];
};

type CanvasDebugUpdateNodeData = {
  ts: number;
  kind: 'updateNodeData';
  nodeId: string;
  nodeType: string | undefined;
  keys: string[];
  noOp: boolean;
  changedKeys: string[] | undefined;
  via: string | undefined;
  stack: string | undefined;
  trace: Error | undefined;
};

type CanvasDebugEventEntry = {
  ts: number;
  kind: 'event';
  reason: string;
  summary: string;
  traceId: string | undefined;
  traceOrigin: string | undefined;
  traceStep: string | undefined;
  traceScope: string | undefined;
  action: string | undefined;
  selectionReason: string | undefined;
  selectionSource: string | undefined;
  commandKind: string | undefined;
  nodeId: string | undefined;
  edgeId: string | undefined;
  storeSelection: CanvasDebugSelectionState | undefined;
  reactFlowSelection: CanvasDebugSelectionState | undefined;
  renderSelection: CanvasDebugSelectionState | undefined;
  targetSummary: string | undefined;
  stack: string | undefined;
  detailText: string | undefined;
};

type CanvasDebugEntry = CanvasDebugUpdateNodeData;

const MAX_ENTRIES = 80;
const MAX_EVENT_ENTRIES = 160;
const MAX_STACK_LINES = 18;
const EVENT_THROTTLE_MS = 300;

let lastGraphInfo: CanvasDebugGraphInfo | null = null;
let lastExecution: CanvasDebugExecutionContext | null = null;
let entries: CanvasDebugEntry[] = [];
let eventEntries: CanvasDebugEventEntry[] = [];
let lastDumpAt = 0;
const lastEventAtByReason: Record<string, number> = {};
let debugEventSeq = 0;
const safeString = (value: unknown): string => {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const readBooleanField = (
  record: CanvasDebugDetail | null,
  key: keyof CanvasDebugDetail,
): boolean => {
  if (record === null) return false;
  return record[key] === true;
};

const trimStack = (stack: string | null | undefined): string | undefined => {
  const raw = typeof stack === 'string' ? stack.trim() : '';
  if (!raw) return undefined;
  const lines = raw.split('\n').slice(0, MAX_STACK_LINES);
  return lines.join('\n');
};

const captureDebugStack = (): string | undefined => {
  try {
    const raw = trimStack(new Error().stack);
    if (!raw) return undefined;
    const lines = raw.split('\n');
    if (lines.length <= 2) return raw;
    return lines.slice(2).join('\n');
  } catch {
    return undefined;
  }
};

const asCanvasDebugDetail = (value: unknown): CanvasDebugDetail | null => {
  if (!value || typeof value !== 'object') return null;
  return value as CanvasDebugDetail;
};

const readStringField = (
  record: CanvasDebugDetail | null,
  key: keyof CanvasDebugDetail,
): string | undefined => {
  if (record === null) return undefined;
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
};

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const next: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    next.push(text);
  }
  return next;
};

const readSelectionState = (
  value: unknown,
): CanvasDebugSelectionState | undefined => {
  const record = asCanvasDebugDetail(value);
  if (record === null) return undefined;
  const nodeIds = readStringArray(record.nodeIds);
  const edgeIds = readStringArray(record.edgeIds);
  const annotationIds = readStringArray(record.annotationIds);
  if (
    nodeIds.length === 0 &&
    edgeIds.length === 0 &&
    annotationIds.length === 0
  ) {
    return undefined;
  }
  return {
    nodeIds,
    edgeIds,
    annotationIds,
  };
};

const toRoundedNumber = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
};

const toSizeToken = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const width = toRoundedNumber((value as { width: unknown | undefined }).width);
  const height = toRoundedNumber((value as { height: unknown | undefined }).height);
  if (width === null || height === null) return null;
  return `${width}x${height}`;
};

const pushSummaryPart = (parts: string[], label: string, value: unknown) => {
  if (value === null || value === undefined) return;
  const text = typeof value === 'string' ? value.trim() : safeString(value);
  if (!text) return;
  parts.push(`${label}=${text}`);
};

const buildEventSummary = (reason: string, detail: unknown | undefined): string => {
  const parts: string[] = [];
  pushSummaryPart(parts, 'event', reason);

  if (detail && typeof detail === 'object') {
    const record = detail as CanvasDebugDetail;
    pushSummaryPart(parts, 'traceId', record.traceId);
    pushSummaryPart(parts, 'traceOrigin', record.traceOrigin);
    pushSummaryPart(parts, 'traceStep', record.traceStep);
    pushSummaryPart(parts, 'traceReason', record.traceReasonTag);
    pushSummaryPart(parts, 'traceAgeMs', record.traceAgeMs);
    pushSummaryPart(parts, 'scope', record.traceScope);
    pushSummaryPart(parts, 'traceNodeKey', record.traceNodeKey);
    pushSummaryPart(parts, 'nodeId', record.nodeId ?? record.modelNodeId);
    pushSummaryPart(parts, 'resultAreaNodeId', record.resultAreaNodeId);
    pushSummaryPart(parts, 'modelId', record.modelId);
    pushSummaryPart(parts, 'via', record.via);
    pushSummaryPart(parts, 'phase', record.phase);
    pushSummaryPart(parts, 'requestKey', record.requestKey ?? record.key);
    pushSummaryPart(parts, 'semanticKey', record.semanticKey);
    pushSummaryPart(parts, 'embeddedSemanticKey', record.embeddedSemanticKey);
    pushSummaryPart(parts, 'requestSignature', record.requestSignature);
    pushSummaryPart(parts, 'action', record.action);
    pushSummaryPart(parts, 'selectionSource', record.selectionSource);
    pushSummaryPart(parts, 'commandKind', record.commandKind);
    pushSummaryPart(parts, 'reasonTag', record.reasonTag);
    pushSummaryPart(parts, 'selectionReason', record.selectionReason);
    pushSummaryPart(parts, 'blocked', record.blocked);
    pushSummaryPart(parts, 'retryAtMs', record.retryAtMs);
    pushSummaryPart(parts, 'guardCount', record.guardCount);
    pushSummaryPart(parts, 'lastAppliedKey', record.lastAppliedKey);
    pushSummaryPart(parts, 'changeCount', record.changeCount);
    pushSummaryPart(parts, 'changeIds', record.changeIds);
    pushSummaryPart(parts, 'candidateCount', record.candidateCount);
    pushSummaryPart(parts, 'candidateNodeIds', record.candidateNodeIds);
    pushSummaryPart(parts, 'commitNodeIds', record.commitNodeIds);
    pushSummaryPart(parts, 'clearNodeIds', record.clearNodeIds);
    pushSummaryPart(parts, 'keepNodeIds', record.keepNodeIds);
    pushSummaryPart(parts, 'stableEdgeCount', record.stableEdgeCount);
    pushSummaryPart(parts, 'renderEdgeCount', record.renderEdgeCount);
    pushSummaryPart(parts, 'reactFlowEdgeCount', record.reactFlowEdgeCount);
    pushSummaryPart(parts, 'domEdgeCount', record.domEdgeCount);
    pushSummaryPart(parts, 'domEdgePathCount', record.domEdgePathCount);
    pushSummaryPart(parts, 'domSvgPathCount', record.domSvgPathCount);
    pushSummaryPart(parts, 'previewCount', record.previewCount);
    pushSummaryPart(parts, 'declaredCount', record.declaredCount);
    pushSummaryPart(parts, 'actualCount', record.actualCount);
    pushSummaryPart(parts, 'storeSelection', record.storeSelection);
    pushSummaryPart(parts, 'previousStoreSelection', record.previousStoreSelection);
    pushSummaryPart(parts, 'nextStoreSelection', record.nextStoreSelection);
    pushSummaryPart(parts, 'reactFlowSelection', record.reactFlowSelection);
    pushSummaryPart(parts, 'previousReactFlowSelection', record.previousReactFlowSelection);
    pushSummaryPart(parts, 'nextReactFlowSelection', record.nextReactFlowSelection);
    pushSummaryPart(parts, 'renderSelection', record.renderSelection);
    pushSummaryPart(parts, 'changedNodeIds', record.changedNodeIds);
    pushSummaryPart(parts, 'changedEdgeIds', record.changedEdgeIds);
    pushSummaryPart(parts, 'changedNodeCount', record.changedNodeCount);
    pushSummaryPart(parts, 'changedEdgeCount', record.changedEdgeCount);
    pushSummaryPart(parts, 'targetSummary', record.targetSummary);

    const rawFormSize = toSizeToken(record.rawFormMetrics);
    const currentSize = toSizeToken(record.currentSize ?? record.current);
    const actualNodeSize = toSizeToken(record.actualNodeSize);
    const desiredSize = toSizeToken(record.desiredSize ?? record.desired);
    const intentSize = toSizeToken(record.intent);
    const contentSize = toSizeToken(record.contentSize);
    const viewportSize = toSizeToken(record.viewportSize);
    const formSize = toSizeToken(record.formSize);
    const visibleParamsSectionSize = toSizeToken(record.visibleParamsSectionSize);

    pushSummaryPart(parts, 'rawForm', rawFormSize);
    pushSummaryPart(parts, 'current', currentSize);
    pushSummaryPart(parts, 'actual', actualNodeSize);
    pushSummaryPart(parts, 'desired', desiredSize);
    pushSummaryPart(parts, 'intent', intentSize);
    pushSummaryPart(parts, 'content', contentSize);
    pushSummaryPart(parts, 'viewport', viewportSize);
    pushSummaryPart(parts, 'form', formSize);
    pushSummaryPart(parts, 'params', visibleParamsSectionSize);
    pushSummaryPart(parts, 'chromeOverhead', record.chromeOverhead);
    pushSummaryPart(parts, 'itemCount', record.itemCount ?? record.resultAreaItemCount);
    pushSummaryPart(parts, 'collapsed', record.collapsed);
    pushSummaryPart(parts, 'chromeReady', record.chromeReady);
    pushSummaryPart(parts, 'shouldRenderEmbeddedResultArea', record.shouldRenderEmbeddedResultArea);
    pushSummaryPart(parts, 'embeddedLayoutKey', record.embeddedLayoutKey);
  }

  return parts.join(' | ');
};

const pushEntry = (entry: CanvasDebugEntry) => {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
};

const pushEventEntry = (entry: CanvasDebugEventEntry) => {
  eventEntries.push(entry);
  if (eventEntries.length > MAX_EVENT_ENTRIES) {
    eventEntries = eventEntries.slice(eventEntries.length - MAX_EVENT_ENTRIES);
  }
};

export const recordCanvasGraphInfo = (info: CanvasDebugGraphInfo) => {
  if (!isElectronDev()) return;
  lastGraphInfo = info;
};

export const recordCanvasExecution = (ctx: CanvasDebugExecutionContext) => {
  if (!isElectronDev()) return;
  lastExecution = ctx;
};

export const recordUpdateNodeData = (payload: {
  nodeId: string;
  nodeType: string | undefined;
  keys: string[];
  noOp: boolean;
  changedKeys: string[] | undefined;
  via: string | undefined;
  stack: string | undefined;
  trace: Error | undefined;
}) => {
  if (!isElectronDev()) return;
  const trace = payload.trace instanceof Error ? payload.trace : undefined;
  const trimmedTraceStack = trace ? trimStack(trace.stack) : undefined;
  const trimmedStack = payload.stack ? trimStack(payload.stack) : undefined;
  const stack = trimmedStack ?? trimmedTraceStack;
  const entry: CanvasDebugUpdateNodeData = {
    ts: Date.now(),
    kind: 'updateNodeData',
    nodeId: payload.nodeId,
    nodeType: payload.nodeType,
    keys: payload.keys,
    noOp: payload.noOp,
    changedKeys: payload.changedKeys,
    via: payload.via,
    stack,
    trace,
  };
  pushEntry(entry);
};

export const getCanvasDebugSnapshot = () => {
  return {
    ts: Date.now(),
    graph: lastGraphInfo,
    lastExecution,
    recent: entries.slice(-MAX_ENTRIES),
    recentEvents: eventEntries.slice(-MAX_EVENT_ENTRIES),
  };
};

export const logCanvasDebugEvent = (reason: string, detail: unknown | undefined) => {
  if (!isElectronDev()) return;
  const key = typeof reason === 'string' ? reason.trim() : '';
  if (!key) return;

  const detailRecord = asCanvasDebugDetail(detail);
  const disableThrottle = readBooleanField(detailRecord, 'disableThrottle');
  const throttleKey =
    readStringField(detailRecord, 'throttleKey') ?? key;
  const now = Date.now();
  if (!disableThrottle) {
    const last = lastEventAtByReason[throttleKey] ?? 0;
    if (now - last < EVENT_THROTTLE_MS) {
      return;
    }
    lastEventAtByReason[throttleKey] = now;
  }

  try {
    const seq = ++debugEventSeq;
    const summary = buildEventSummary(key, detail);
    const targetSummaryValue = detailRecord ? detailRecord.targetSummary : undefined;
    const targetSummary = targetSummaryValue ? safeString(targetSummaryValue) : undefined;
    const detailText = detailRecord ? safeString(detailRecord) : safeString(detail);
    pushEventEntry({
      ts: now,
      kind: 'event',
      reason: key,
      summary,
      traceId: readStringField(detailRecord, 'traceId'),
      traceOrigin: readStringField(detailRecord, 'traceOrigin'),
      traceStep: readStringField(detailRecord, 'traceStep'),
      traceScope: readStringField(detailRecord, 'traceScope'),
      action: readStringField(detailRecord, 'action'),
      selectionReason: readStringField(detailRecord, 'selectionReason'),
      selectionSource: readStringField(detailRecord, 'selectionSource'),
      commandKind: readStringField(detailRecord, 'commandKind'),
      nodeId:
        readStringField(detailRecord, 'nodeId') ??
        readStringField(detailRecord, 'modelNodeId') ??
        readStringField(detailRecord, 'resultAreaNodeId'),
      edgeId: readStringField(detailRecord, 'edgeId'),
      storeSelection: readSelectionState(
        detailRecord ? detailRecord.storeSelection : undefined,
      ),
      reactFlowSelection: readSelectionState(
        detailRecord ? detailRecord.reactFlowSelection : undefined,
      ),
      renderSelection: readSelectionState(
        detailRecord ? detailRecord.renderSelection : undefined,
      ),
      targetSummary,
      stack: captureDebugStack(),
      detailText,
    });
     
    // Use console.log (not console.debug) so it shows up even when DevTools hides "Verbose" logs.
    // This is gated by isElectronDev() + throttled, so noise should remain manageable.
    console.log(`[canvas-debug#${seq}] ${summary}`, detail);
  } catch {
    // ignore
  }
};

export const logCanvasDebugSnapshot = (reason: string, error: unknown | undefined) => {
  if (!isElectronDev()) return;

  const now = Date.now();
  // 避免同一异常风暴导致无限打印
  if (now - lastDumpAt < 800) {
    return;
  }
  lastDumpAt = now;

  const snapshot = getCanvasDebugSnapshot();
  try {
     
    console.groupCollapsed(`[canvas-debug] ${reason}`);
     
    console.log('[canvas-debug] snapshot:', snapshot);
    try {
      const recentWithTrace = snapshot.recent
        .filter((entry) => entry && typeof entry === 'object' && entry.trace instanceof Error)
        .slice(-8) as CanvasDebugEntry[];
      if (recentWithTrace.length) {
         
        console.groupCollapsed('[canvas-debug] recent traces');
        for (const entry of recentWithTrace) {
          if (!entry.trace) continue;
           
          console.log(`[canvas-debug] ${entry.kind}`, entry);
           
          console.error(entry.trace);
        }
         
        console.groupEnd();
      }
    } catch {
      // ignore
    }
    try {
      const recentEvents = snapshot.recentEvents.slice(-10);
      if (recentEvents.length) {
         
        console.groupCollapsed('[canvas-debug] recent events');
        for (const eventEntry of recentEvents) {
           
          console.log('[canvas-debug] event', eventEntry);
          if (eventEntry.stack) {
             
            console.log(eventEntry.stack);
          }
        }
         
        console.groupEnd();
      }
    } catch {
      // ignore
    }
    if (error !== undefined) {
       
      console.error('[canvas-debug] error:', error);
      if (typeof error === 'string') {
         
        console.error('[canvas-debug] error(text):', error);
      } else if (error instanceof Error) {
         
        console.error('[canvas-debug] error(stack):', trimStack(error.stack) ?? error.message);
      } else {
         
        console.error('[canvas-debug] error(brief):', safeString(error));
      }
    }
     
    console.groupEnd();
  } catch {
    // ignore
  }
};

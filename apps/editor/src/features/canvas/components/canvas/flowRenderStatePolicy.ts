import type { FlowCacheState, FlowCacheStrategy } from './flowRenderDecision';

export type FlowCacheStatePolicyInput = {
  previousCacheState: FlowCacheState;
  graphIdChanged: boolean;
  flowComputationRequested: boolean;
  hasCacheForGraph: boolean;
  structureChangedSinceCache: boolean;
};

export const resolveFlowCacheState = (input: FlowCacheStatePolicyInput): FlowCacheState => {
  if (input.graphIdChanged) return 'cold';
  if (!input.hasCacheForGraph) return 'cold';

  if (!input.flowComputationRequested && input.structureChangedSinceCache) {
    return 'stale';
  }

  if (input.previousCacheState === 'stale') {
    return 'stale';
  }

  if (input.previousCacheState === 'cold') {
    return 'cold';
  }

  return 'warm';
};

export const settleFlowCacheStateAfterWrite = (params: {
  currentCacheState: FlowCacheState;
  writeSucceeded: boolean;
}): FlowCacheState => {
  if (params.writeSucceeded) {
    return 'warm';
  }
  return params.currentCacheState;
};

export const shouldUseFlowCacheSnapshot = (params: {
  strategy: FlowCacheStrategy;
  cacheGraphId: string | null;
  graphId: string | null;
}): boolean => {
  return params.strategy === 'cache' && params.cacheGraphId === params.graphId;
};

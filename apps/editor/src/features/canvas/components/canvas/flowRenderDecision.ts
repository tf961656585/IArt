export type FlowCacheState = 'warm' | 'stale' | 'cold';

export type FlowCacheStrategy = 'computed' | 'cache';

export type FlowRenderDecisionInput = {
  isOverview: boolean;
  preparingOverviewExit: boolean;
  cacheState: FlowCacheState;
  graphIdChanged: boolean;
};

export type FlowRenderDecision = {
  flowComputationEnabled: boolean;
  hideFlowLayer: boolean;
  overviewLayerEnabled: boolean;
  flowInteractivityDisabled: boolean;
  flowCacheStrategy: FlowCacheStrategy;
  cacheState: FlowCacheState;
};

const resolveEffectiveCacheState = (input: Pick<FlowRenderDecisionInput, 'cacheState' | 'graphIdChanged'>): FlowCacheState => {
  return input.graphIdChanged ? 'cold' : input.cacheState;
};

export const resolveFlowRenderDecision = (input: FlowRenderDecisionInput): FlowRenderDecision => {
  const cacheState = resolveEffectiveCacheState(input);
  const shouldForceRebuild = input.graphIdChanged || cacheState === 'cold';
  const flowComputationEnabled = shouldForceRebuild || !input.isOverview || input.preparingOverviewExit;
  const hideFlowLayer = input.isOverview && !input.preparingOverviewExit && !shouldForceRebuild;
  const overviewLayerEnabled = hideFlowLayer;
  const flowInteractivityDisabled = input.isOverview || input.graphIdChanged;

  return {
    flowComputationEnabled,
    hideFlowLayer,
    overviewLayerEnabled,
    flowInteractivityDisabled,
    flowCacheStrategy: flowComputationEnabled ? 'computed' : 'cache',
    cacheState,
  };
};

export const isFlowLayerInteractive = (decision: Pick<FlowRenderDecision, 'hideFlowLayer' | 'flowInteractivityDisabled'>): boolean => {
  return !decision.hideFlowLayer && !decision.flowInteractivityDisabled;
};

export const FLOW_HIDDEN_CLASS_NAME = 'iart-canvas--flow-hidden';

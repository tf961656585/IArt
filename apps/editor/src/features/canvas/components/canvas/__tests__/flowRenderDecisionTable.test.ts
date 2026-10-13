import { describe, expect, it } from 'vitest';
import {
  resolveFlowRenderDecision,
  type FlowCacheState,
} from '../flowRenderDecision';

type DecisionRow = {
  input: {
    isOverview: boolean;
    preparingOverviewExit: boolean;
    cacheState: FlowCacheState;
    graphIdChanged: boolean;
  };
  expected: {
    flowComputationEnabled: boolean;
    hideFlowLayer: boolean;
    overviewLayerEnabled: boolean;
    flowInteractivityDisabled: boolean;
    flowCacheStrategy: 'computed' | 'cache';
    cacheState: FlowCacheState;
  };
};

const rows: DecisionRow[] = [
  {
    input: {
      isOverview: false,
      preparingOverviewExit: false,
      cacheState: 'warm',
      graphIdChanged: false,
    },
    expected: {
      flowComputationEnabled: true,
      hideFlowLayer: false,
      overviewLayerEnabled: false,
      flowInteractivityDisabled: false,
      flowCacheStrategy: 'computed',
      cacheState: 'warm',
    },
  },
  {
    input: {
      isOverview: true,
      preparingOverviewExit: false,
      cacheState: 'warm',
      graphIdChanged: false,
    },
    expected: {
      flowComputationEnabled: false,
      hideFlowLayer: true,
      overviewLayerEnabled: true,
      flowInteractivityDisabled: true,
      flowCacheStrategy: 'cache',
      cacheState: 'warm',
    },
  },
  {
    input: {
      isOverview: true,
      preparingOverviewExit: true,
      cacheState: 'warm',
      graphIdChanged: false,
    },
    expected: {
      flowComputationEnabled: true,
      hideFlowLayer: false,
      overviewLayerEnabled: false,
      flowInteractivityDisabled: true,
      flowCacheStrategy: 'computed',
      cacheState: 'warm',
    },
  },
  {
    input: {
      isOverview: true,
      preparingOverviewExit: false,
      cacheState: 'stale',
      graphIdChanged: false,
    },
    expected: {
      flowComputationEnabled: false,
      hideFlowLayer: true,
      overviewLayerEnabled: true,
      flowInteractivityDisabled: true,
      flowCacheStrategy: 'cache',
      cacheState: 'stale',
    },
  },
  {
    input: {
      isOverview: true,
      preparingOverviewExit: false,
      cacheState: 'cold',
      graphIdChanged: false,
    },
    expected: {
      flowComputationEnabled: true,
      hideFlowLayer: false,
      overviewLayerEnabled: false,
      flowInteractivityDisabled: true,
      flowCacheStrategy: 'computed',
      cacheState: 'cold',
    },
  },
  {
    input: {
      isOverview: false,
      preparingOverviewExit: false,
      cacheState: 'warm',
      graphIdChanged: true,
    },
    expected: {
      flowComputationEnabled: true,
      hideFlowLayer: false,
      overviewLayerEnabled: false,
      flowInteractivityDisabled: true,
      flowCacheStrategy: 'computed',
      cacheState: 'cold',
    },
  },
];

describe('flowRenderDecisionTable', () => {
  it.each(rows)('符合真值表契约: %#', ({ input, expected }) => {
    const decision = resolveFlowRenderDecision(input);
    expect(decision).toEqual(expected);
  });
});

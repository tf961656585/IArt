import { describe, expect, it } from 'vitest';
import { resolveFlowRenderDecision } from '../flowRenderDecision';
import {
  resolveFlowCacheState,
  settleFlowCacheStateAfterWrite,
  shouldUseFlowCacheSnapshot,
} from '../flowRenderStatePolicy';

describe('flowCacheConsistency', () => {
  it('冻结窗口仅允许同 graphId 读取 cache', () => {
    expect(
      shouldUseFlowCacheSnapshot({
        strategy: 'cache',
        cacheGraphId: 'g-1',
        graphId: 'g-1',
      })
    ).toBe(true);

    expect(
      shouldUseFlowCacheSnapshot({
        strategy: 'cache',
        cacheGraphId: 'g-1',
        graphId: 'g-2',
      })
    ).toBe(false);
  });

  it('graphId 切换直接进入 cold，不串缓存', () => {
    const cacheState = resolveFlowCacheState({
      previousCacheState: 'warm',
      graphIdChanged: true,
      flowComputationRequested: false,
      hasCacheForGraph: false,
      structureChangedSinceCache: false,
    });

    expect(cacheState).toBe('cold');

    const decision = resolveFlowRenderDecision({
      isOverview: true,
      preparingOverviewExit: false,
      cacheState,
      graphIdChanged: true,
    });

    expect(decision.flowCacheStrategy).toBe('computed');
    expect(decision.hideFlowLayer).toBe(false);
  });

  it('warm -> stale -> warm 迁移闭环', () => {
    const stale = resolveFlowCacheState({
      previousCacheState: 'warm',
      graphIdChanged: false,
      flowComputationRequested: false,
      hasCacheForGraph: true,
      structureChangedSinceCache: true,
    });
    expect(stale).toBe('stale');

    const beforeRebuild = resolveFlowCacheState({
      previousCacheState: stale,
      graphIdChanged: false,
      flowComputationRequested: true,
      hasCacheForGraph: true,
      structureChangedSinceCache: false,
    });
    expect(beforeRebuild).toBe('stale');

    const warm = settleFlowCacheStateAfterWrite({
      currentCacheState: beforeRebuild,
      writeSucceeded: true,
    });
    expect(warm).toBe('warm');
  });

  it('warm -> cold -> warm 迁移闭环（cold fail-fast 回写）', () => {
    const cold = resolveFlowCacheState({
      previousCacheState: 'warm',
      graphIdChanged: false,
      flowComputationRequested: false,
      hasCacheForGraph: false,
      structureChangedSinceCache: false,
    });
    expect(cold).toBe('cold');

    const decision = resolveFlowRenderDecision({
      isOverview: true,
      preparingOverviewExit: false,
      cacheState: cold,
      graphIdChanged: false,
    });
    expect(decision.flowComputationEnabled).toBe(true);
    expect(decision.hideFlowLayer).toBe(false);

    const warm = settleFlowCacheStateAfterWrite({
      currentCacheState: cold,
      writeSucceeded: true,
    });
    expect(warm).toBe('warm');
  });
});

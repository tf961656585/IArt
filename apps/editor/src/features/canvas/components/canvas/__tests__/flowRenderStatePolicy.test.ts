import { describe, expect, it } from 'vitest';
import {
  isFlowLayerInteractive,
  resolveFlowRenderDecision,
} from '../flowRenderDecision';
import { resolveFlowCacheState } from '../flowRenderStatePolicy';

describe('flowRenderStatePolicy', () => {
  it('overview 冻结窗口使用 cache，且层可见性/概览层同步', () => {
    const cacheState = resolveFlowCacheState({
      previousCacheState: 'warm',
      graphIdChanged: false,
      flowComputationRequested: false,
      hasCacheForGraph: true,
      structureChangedSinceCache: false,
    });

    const decision = resolveFlowRenderDecision({
      isOverview: true,
      preparingOverviewExit: false,
      cacheState,
      graphIdChanged: false,
    });

    expect(decision.flowComputationEnabled).toBe(false);
    expect(decision.flowCacheStrategy).toBe('cache');
    expect(decision.hideFlowLayer).toBe(true);
    expect(decision.overviewLayerEnabled).toBe(decision.hideFlowLayer);
  });

  it('overview 准备退出阶段不隐藏 Flow 层，但保持禁交互', () => {
    const decision = resolveFlowRenderDecision({
      isOverview: true,
      preparingOverviewExit: true,
      cacheState: 'warm',
      graphIdChanged: false,
    });

    expect(decision.flowComputationEnabled).toBe(true);
    expect(decision.hideFlowLayer).toBe(false);
    expect(decision.overviewLayerEnabled).toBe(false);
    expect(decision.flowInteractivityDisabled).toBe(true);
    expect(isFlowLayerInteractive(decision)).toBe(false);
  });

  it('cold 必须走 fail-fast：禁止隐藏层并强制重建', () => {
    const decision = resolveFlowRenderDecision({
      isOverview: true,
      preparingOverviewExit: false,
      cacheState: 'cold',
      graphIdChanged: false,
    });

    expect(decision.flowComputationEnabled).toBe(true);
    expect(decision.flowCacheStrategy).toBe('computed');
    expect(decision.hideFlowLayer).toBe(false);
    expect(decision.overviewLayerEnabled).toBe(false);
  });

  it('可交互公式固定为 !hideFlowLayer && !flowInteractivityDisabled', () => {
    const editable = resolveFlowRenderDecision({
      isOverview: false,
      preparingOverviewExit: false,
      cacheState: 'warm',
      graphIdChanged: false,
    });
    const locked = resolveFlowRenderDecision({
      isOverview: true,
      preparingOverviewExit: true,
      cacheState: 'warm',
      graphIdChanged: false,
    });

    expect(isFlowLayerInteractive(editable)).toBe(true);
    expect(isFlowLayerInteractive(locked)).toBe(false);
  });

  it('graphId 切换时强制 computed 且禁交互（不复用旧图缓存）', () => {
    const decision = resolveFlowRenderDecision({
      isOverview: false,
      preparingOverviewExit: false,
      cacheState: 'warm',
      graphIdChanged: true,
    });

    expect(decision.cacheState).toBe('cold');
    expect(decision.flowComputationEnabled).toBe(true);
    expect(decision.flowCacheStrategy).toBe('computed');
    expect(decision.hideFlowLayer).toBe(false);
    expect(decision.overviewLayerEnabled).toBe(false);
    expect(decision.flowInteractivityDisabled).toBe(true);
  });
});

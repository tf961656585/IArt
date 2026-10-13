import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NODE_SIZE,
  isSizeConverged,
  resolveEffectiveSize,
  resolveEffectiveSizeByNodeId,
  resolveNodeTypeDefaultSize,
  type EffectiveSizeSources,
} from '../effectiveSize';
import { cast } from '@/lib/utils';
import type { DesiredSize, GraphNode, GraphNodeType, NodeSize } from '../../types';

/** 构建带 state 的 desired entry（默认 pending）。 */
const desired = (size: NodeSize, state: 'pending' | 'accepted' = 'pending'): DesiredSize => ({
  size,
  state,
  semanticKey: `test-${state}`,
});

const EMPTY_SOURCES: EffectiveSizeSources = {
  measuredByNodeId: undefined,
  desiredByNodeId: undefined,
  derivedByNodeId: undefined,
  defaultByNodeId: undefined,
  layoutModelByNodeId: undefined,
};

const makeSources = (overrides: Partial<EffectiveSizeSources>): EffectiveSizeSources => ({
  measuredByNodeId: overrides.measuredByNodeId,
  desiredByNodeId: overrides.desiredByNodeId,
  derivedByNodeId: overrides.derivedByNodeId,
  defaultByNodeId: overrides.defaultByNodeId,
  layoutModelByNodeId: overrides.layoutModelByNodeId,
});

const makeNode = (id: string, type: GraphNodeType) =>
  cast<GraphNode>({ id, type });

describe('resolveEffectiveSize', () => {
  describe('普通节点优先级链 layoutModel → measured → default（Layout-Model-Driven）', () => {
    it('layoutModel 优先于 measured（核心：Layout-Model-Driven 主路径）', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        layoutModelByNodeId: { n1: { width: 350, height: 250 } },
        measuredByNodeId: { n1: { width: 400, height: 300 } },
        defaultByNodeId: { n1: { width: 220, height: 120 } },
      });
      // Layout Model 主路径优先，即使 measured 存在也取 layoutModel
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 350, height: 250 });
    });

    it('layoutModel 缺失时回退到 measured', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        measuredByNodeId: { n1: { width: 400, height: 300 } },
        defaultByNodeId: { n1: { width: 220, height: 120 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 400, height: 300 });
    });

    it('layoutModel 和 measured 均缺失时回退到 defaultByNodeId', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        defaultByNodeId: { n1: { width: 280, height: 160 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 280, height: 160 });
    });

    it('所有 byNodeId 都缺失时回退到节点类型注册表 defaultSize', () => {
      const node = makeNode('n1', 'videoInput');
      expect(resolveEffectiveSize(node, EMPTY_SOURCES)).toEqual({ width: 240, height: 160 });
    });

    it('所有 byNodeId 都缺失时回退到注册表 defaultSize（非 DEFAULT_NODE_SIZE）', () => {
      const node = makeNode('n1', 'videoInput');
      // videoInput 注册表有 defaultSize（240×160），不落到全局 DEFAULT_NODE_SIZE（220×120）
      expect(resolveEffectiveSize(node, EMPTY_SOURCES)).toEqual(resolveNodeTypeDefaultSize('videoInput'));
    });

    it('所有源都缺失时回退到注册表', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        measuredByNodeId: undefined,
        defaultByNodeId: undefined,
        layoutModelByNodeId: undefined,
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 240, height: 160 });
    });
  });

  describe('desired 不进入主优先级链（runtime 期漂移校准）', () => {
    it('desired(pending) 不再优先于 measured（与旧行为相反，spec：Layout-Model-Driven）', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        measuredByNodeId: { n1: { width: 400, height: 300 } },
        desiredByNodeId: { n1: desired({ width: 350, height: 250 }, 'pending') },
      });
      // 新口径：measured 优先于 desired（desired 不在主链）
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 400, height: 300 });
    });

    it('desired 不影响 layoutModel 主档', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        layoutModelByNodeId: { n1: { width: 350, height: 250 } },
        desiredByNodeId: { n1: desired({ width: 999, height: 999 }, 'pending') },
        measuredByNodeId: { n1: { width: 400, height: 300 } },
      });
      // layoutModel 主档，desired 即便存在也不读取
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 350, height: 250 });
    });

    it('desired 在 layoutModel/measured 均缺失时仍不进入主链（直接回退 default）', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        desiredByNodeId: { n1: desired({ width: 350, height: 250 }, 'pending') },
        defaultByNodeId: { n1: { width: 280, height: 160 } },
      });
      // 新口径：desired 不进入主链，回退 default
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 280, height: 160 });
    });
  });

  describe('组节点 derived 优先', () => {
    it('组节点优先 derived，不进 layoutModel/measured/desired/default 链路', () => {
      const node = makeNode('g1', 'group');
      const sources = makeSources({
        derivedByNodeId: { g1: { width: 500, height: 400 } },
        layoutModelByNodeId: { g1: { width: 480, height: 380 } },
        measuredByNodeId: { g1: { width: 999, height: 999 } },
        desiredByNodeId: { g1: desired({ width: 888, height: 888 }) },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 500, height: 400 });
    });

    it('组节点 derived 缺失时回退到注册表默认值（不进 layoutModel/measured/desired）', () => {
      const node = makeNode('g1', 'group');
      const sources = makeSources({
        layoutModelByNodeId: { g1: { width: 480, height: 380 } },
        measuredByNodeId: { g1: { width: 999, height: 999 } },
        desiredByNodeId: { g1: desired({ width: 888, height: 888 }) },
      });
      const expected = resolveNodeTypeDefaultSize('group');
      expect(resolveEffectiveSize(node, sources)).toEqual(expected);
      // 关键：组节点即便有 layoutModel/measured/desired 也不读取，回退到注册表
      expect(resolveEffectiveSize(node, sources)).not.toEqual({ width: 999, height: 999 });
    });
  });

  describe('非法尺寸归一化', () => {
    it('layoutModel 为 0 或负数时被忽略，回退到 measured', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        layoutModelByNodeId: { n1: { width: 0, height: 120 } },
        measuredByNodeId: { n1: { width: 300, height: 200 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 300, height: 200 });
    });

    it('layoutModel 包含非有限值（NaN/Infinity）时被忽略', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        layoutModelByNodeId: { n1: { width: Number.NaN, height: 120 } },
        measuredByNodeId: { n1: { width: 300, height: 200 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 300, height: 200 });
    });

    it('measured 为 0 或负数时被忽略，回退到 default', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        measuredByNodeId: { n1: { width: 0, height: 120 } },
        defaultByNodeId: { n1: { width: 250, height: 140 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 250, height: 140 });
    });

    it('所有源非法时回退到注册表', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        layoutModelByNodeId: { n1: { width: -10, height: 120 } },
        measuredByNodeId: { n1: { width: 0, height: 0 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 240, height: 160 });
    });
  });

  describe('null/undefined 节点处理', () => {
    it('node 为 null 时返回全局默认尺寸', () => {
      expect(resolveEffectiveSize(null, EMPTY_SOURCES)).toEqual(DEFAULT_NODE_SIZE);
    });

    it('node 为 undefined 时返回全局默认尺寸', () => {
      expect(resolveEffectiveSize(undefined, EMPTY_SOURCES)).toEqual(DEFAULT_NODE_SIZE);
    });
  });

  describe('节点 id 不在 map 中', () => {
    it('layoutModel 存在但不含该节点 id 时回退到 measured', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        layoutModelByNodeId: { otherNode: { width: 350, height: 250 } },
        measuredByNodeId: { n1: { width: 300, height: 200 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 300, height: 200 });
    });

    it('measured map 存在但不含该节点 id 时回退到 default', () => {
      const node = makeNode('n1', 'videoInput');
      const sources = makeSources({
        measuredByNodeId: { otherNode: { width: 400, height: 300 } },
        defaultByNodeId: { n1: { width: 280, height: 160 } },
      });
      expect(resolveEffectiveSize(node, sources)).toEqual({ width: 280, height: 160 });
    });
  });
});

describe('resolveEffectiveSizeByNodeId', () => {
  it('批量解析覆盖全部节点（layoutModel 主档）', () => {
    const nodes = [
      makeNode('n1', 'videoInput'),
      makeNode('n2', 'videoInput'),
      makeNode('g1', 'group'),
    ];
    const sources = makeSources({
      layoutModelByNodeId: { n1: { width: 350, height: 250 } },
      measuredByNodeId: { n1: { width: 400, height: 300 } },
      derivedByNodeId: { g1: { width: 500, height: 400 } },
    });
    const result = resolveEffectiveSizeByNodeId(nodes, sources);
    expect(result['n1']).toEqual({ width: 350, height: 250 }); // layoutModel 主档
    expect(result['n2']).toEqual({ width: 240, height: 160 }); // videoInput 注册表默认
    expect(result['g1']).toEqual({ width: 500, height: 400 }); // 组节点 derived
  });

  it('空节点数组返回空对象', () => {
    const result = resolveEffectiveSizeByNodeId([], EMPTY_SOURCES);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe('isSizeConverged', () => {
  it('宽高差均在 epsilon 内视为收敛', () => {
    const target: NodeSize = { width: 200, height: 120 };
    expect(isSizeConverged({ width: 200, height: 120 }, target)).toBe(true);
    expect(isSizeConverged({ width: 201, height: 121 }, target)).toBe(true);
    expect(isSizeConverged({ width: 199, height: 119 }, target)).toBe(true);
  });

  it('宽高差超过 epsilon 视为未收敛', () => {
    const target: NodeSize = { width: 200, height: 120 };
    expect(isSizeConverged({ width: 202, height: 120 }, target)).toBe(false);
    expect(isSizeConverged({ width: 200, height: 122 }, target)).toBe(false);
  });

  it('measured 为 null/undefined 时视为未收敛', () => {
    const target: NodeSize = { width: 200, height: 120 };
    expect(isSizeConverged(null, target)).toBe(false);
    expect(isSizeConverged(undefined, target)).toBe(false);
  });
});

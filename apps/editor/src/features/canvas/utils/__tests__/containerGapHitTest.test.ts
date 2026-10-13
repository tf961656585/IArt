import { describe, expect, it } from 'vitest';
import { resolveContainerGapHit } from '../containerGapHitTest';
import type { ContainerGapGeometry } from '../containerGapHitTest';

/**
 * 容器内空白（背板空隙）右键命中判定的纯函数回归。
 *
 * 命中规则：点落在容器矩形内（含边界）即命中；重叠时取面积最小者（最内层容器），
 * 面积相等取输入顺序靠前者；退化尺寸不构成命中面；未命中返回 null（真空白属正常路径）。
 */
const geometry = (overrides: Partial<ContainerGapGeometry>): ContainerGapGeometry => ({
  containerNodeId: 'group-1',
  containerKind: 'group',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...overrides,
});

describe('resolveContainerGapHit', () => {
  // @spec: CM-026
  it('点落在单个容器内：命中该容器', () => {
    const hit = resolveContainerGapHit(
      { x: 50, y: 50 },
      [geometry({ containerNodeId: 'group-1' })],
    );

    expect(hit).toEqual({ containerNodeId: 'group-1', containerKind: 'group' });
  });

  it('组内 Agent 容器空隙：两层都包含该点时取最内层（Agent 容器）', () => {
    const hit = resolveContainerGapHit(
      { x: 60, y: 60 },
      [
        geometry({ containerNodeId: 'group-1', containerKind: 'group', x: 0, y: 0, width: 200, height: 200 }),
        geometry({ containerNodeId: 'agent-1', containerKind: 'agentContainer', x: 40, y: 40, width: 100, height: 100 }),
      ],
    );

    expect(hit).toEqual({ containerNodeId: 'agent-1', containerKind: 'agentContainer' });
  });

  it('点在容器之外（真空白）：不命中，返回 null', () => {
    const hit = resolveContainerGapHit(
      { x: 150, y: 50 },
      [geometry({ containerNodeId: 'group-1' })],
    );

    expect(hit).toBeNull();
  });

  it('几何列表为空：不命中', () => {
    expect(resolveContainerGapHit({ x: 10, y: 10 }, [])).toBeNull();
  });

  it('同类容器边界框重叠：面积最小者优先（确定性仲裁，与列表顺序无关）', () => {
    const hit = resolveContainerGapHit(
      { x: 60, y: 60 },
      [
        geometry({ containerNodeId: 'small-later', x: 40, y: 40, width: 100, height: 100 }),
        geometry({ containerNodeId: 'large-earlier', x: 0, y: 0, width: 200, height: 200 }),
      ],
    );

    expect(hit).toEqual({ containerNodeId: 'small-later', containerKind: 'group' });
  });

  it('面积相等时取输入顺序靠前的一个（确定性）', () => {
    const hit = resolveContainerGapHit(
      { x: 50, y: 50 },
      [
        geometry({ containerNodeId: 'first', x: 0, y: 0, width: 100, height: 100 }),
        geometry({ containerNodeId: 'second', x: 0, y: 0, width: 100, height: 100 }),
      ],
    );

    expect(hit).toEqual({ containerNodeId: 'first', containerKind: 'group' });
  });

  it('退化尺寸（宽或高 ≤ 0）不构成命中面', () => {
    const hit = resolveContainerGapHit(
      { x: 0, y: 0 },
      [
        geometry({ containerNodeId: 'zero-width', width: 0 }),
        geometry({ containerNodeId: 'negative-height', height: -5 }),
      ],
    );

    expect(hit).toBeNull();
  });

  it('边界点（右下角）按含边界判定命中', () => {
    const hit = resolveContainerGapHit(
      { x: 100, y: 100 },
      [geometry({ containerNodeId: 'group-1' })],
    );

    expect(hit).toEqual({ containerNodeId: 'group-1', containerKind: 'group' });
  });
});

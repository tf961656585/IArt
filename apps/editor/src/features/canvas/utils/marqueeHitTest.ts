export interface MarqueeRect {
  x1: number; // flow 坐标，左上角 x
  y1: number; // flow 坐标，左上角 y
  x2: number; // flow 坐标，右下角 x
  y2: number; // flow 坐标，右下角 y
}

/**
 * 碰撞检测目标。
 * - kind: 'node' → 节点；框选与节点包围盒相交则命中
 * - kind: 'annotation' → 注释；框选与注释包围盒相交则命中
 *
 * 注释的 position 对自由注释是用户摆放位置，对绑定注释是派生位置（由调用方
 * 经 resolveAnnotationPosition + resolveEffectiveSize 解析后传入）。
 */
export interface MarqueeHitTarget {
  id: string;
  kind: 'node' | 'annotation';
  position: { x: number; y: number }; // 左上角坐标
  width: number | undefined;
  height: number | undefined;
}

export interface MarqueeHitResult {
  nodeIds: string[];
  annotationIds: string[];
}

function rectsIntersect(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

export function marqueeHitTest(
  rect: MarqueeRect,
  targets: MarqueeHitTarget[],
): MarqueeHitResult {
  const nodeIds: string[] = [];
  const annotationIds: string[] = [];

  // 退化选区（面积为 0）不命中任何对象
  if (rect.x1 >= rect.x2 || rect.y1 >= rect.y2) {
    return { nodeIds, annotationIds };
  }

  for (const target of targets) {
    if (target.width === undefined || target.height === undefined) {
      continue;
    }

    const targetRect = {
      x1: target.position.x,
      y1: target.position.y,
      x2: target.position.x + target.width,
      y2: target.position.y + target.height,
    };

    if (rectsIntersect(rect, targetRect)) {
      if (target.kind === 'annotation') {
        annotationIds.push(target.id);
      } else {
        nodeIds.push(target.id);
      }
    }
  }

  return { nodeIds, annotationIds };
}

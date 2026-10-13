import type { GraphNodeType, NodePosition, NodeSize } from '../types';
import { nodeRegistry } from '../nodes/registry';
import { resolveEffectiveSize, DEFAULT_NODE_SIZE } from './effectiveSize';

type ViewportTransform = { x: number; y: number; zoom: number };
type ScreenRect = { width: number; height: number };

export type OverviewMiniCardNode = {
  id: string;
  type: GraphNodeType;
  position: NodePosition;
  selected: boolean;
  registryKey: string | undefined;
};

export type OverviewMiniCardPalette = {
  cardFill: string;
  cardFillAlpha: number;
};

export type OverviewMiniCardStyle = {
  width: number;
  height: number;
  cornerRadius: number;
  borderWidth: number;
  stripeHeight: number;
  cullPadding: number;
};

const DEFAULT_FALLBACK_NODE_COLOR = '#6b7280';

const DEFAULT_MINI_CARD_STYLE: OverviewMiniCardStyle = {
  width: 44,
  height: 18,
  cornerRadius: 4,
  borderWidth: 1,
  stripeHeight: 4,
  cullPadding: 96,
};

const DENSE_MINI_CARD_STYLE: OverviewMiniCardStyle = {
  width: 30,
  height: 14,
  cornerRadius: 3,
  borderWidth: 1,
  stripeHeight: 3,
  cullPadding: 96,
};

const VERY_DENSE_MINI_CARD_STYLE: OverviewMiniCardStyle = {
  width: 22,
  height: 10,
  cornerRadius: 2,
  borderWidth: 0.85,
  stripeHeight: 2,
  cullPadding: 96,
};

const getDefaultNodeSize = (): NodeSize => DEFAULT_NODE_SIZE;

const resolveNodeRegistryKey = (node: OverviewMiniCardNode): string => {
  if (typeof node.registryKey === 'string' && node.registryKey.trim().length > 0) {
    return node.registryKey;
  }
  return node.type;
};

export const resolveOverviewMiniCardPalette = (): OverviewMiniCardPalette => {
  if (typeof window === 'undefined' || typeof getComputedStyle === 'undefined') {
    return { cardFill: '#ffffff', cardFillAlpha: 0.92 };
  }
  const styles = getComputedStyle(document.documentElement);
  const card = styles.getPropertyValue('--card').trim();
  return { cardFill: card || '#ffffff', cardFillAlpha: 0.92 };
};

export const resolveOverviewMiniCardStyle = (nodeCount: number): OverviewMiniCardStyle => {
  if (nodeCount >= 15000) return VERY_DENSE_MINI_CARD_STYLE;
  if (nodeCount >= 5000) return DENSE_MINI_CARD_STYLE;
  return DEFAULT_MINI_CARD_STYLE;
};

const buildWorldCullBounds = (
  viewport: ViewportTransform,
  screen: ScreenRect,
  paddingPx: number
): { minX: number; maxX: number; minY: number; maxY: number } => {
  const zoom = Math.max(0.000001, viewport.zoom);
  const minX = (-paddingPx - viewport.x) / zoom;
  const minY = (-paddingPx - viewport.y) / zoom;
  const maxX = (screen.width + paddingPx - viewport.x) / zoom;
  const maxY = (screen.height + paddingPx - viewport.y) / zoom;
  return { minX, maxX, minY, maxY };
};

const roundRectPath = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
};

export const drawOverviewMiniCards = (
  canvas: HTMLCanvasElement,
  params: {
    nodes: readonly OverviewMiniCardNode[];
    viewport: ViewportTransform;
    screen: ScreenRect;
    palette: OverviewMiniCardPalette;
    style: OverviewMiniCardStyle;
  }
): void => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { nodes, viewport, screen, palette, style } = params;
  const screenWidth = Math.max(0, screen.width);
  const screenHeight = Math.max(0, screen.height);
  if (!screenWidth || !screenHeight) return;

  ctx.clearRect(0, 0, screenWidth, screenHeight);
  if (!nodes.length) return;

  const halfW = style.width / 2;
  const halfH = style.height / 2;
  const padding = style.cullPadding + Math.max(halfW, halfH) + 8;
  const worldCull = buildWorldCullBounds(viewport, screen, padding);
  const defaultSize = getDefaultNodeSize();
  const colorCache = new Map<string, string>();

  ctx.save();
  ctx.lineJoin = 'round';

  // 统一的卡片底色（用 alpha 控制透明度，兼容 oklch 等颜色格式）
  ctx.globalAlpha = palette.cardFillAlpha;
  ctx.fillStyle = palette.cardFill;

  // Draw non-selected first, then selected on top (better focus even in overview).
  const drawPass = (selected: boolean) => {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node) continue;
      const isSelected = node.selected === true;
      if (isSelected !== selected) continue;

      // 概览缩略图层：measured 不可得（节点 DOM 未挂载），传空 measured，
      // 由 resolveEffectiveSize 回退到 defaultByNodeId → 注册表 default → DEFAULT_NODE_SIZE。
      const size = resolveEffectiveSize(node, {
        measuredByNodeId: undefined,
        desiredByNodeId: undefined,
        derivedByNodeId: undefined,
        defaultByNodeId: { [node.id]: defaultSize },
        layoutModelByNodeId: undefined,
      });
      const centerX = node.position.x + size.width / 2;
      const centerY = node.position.y + size.height / 2;
      if (
        centerX < worldCull.minX ||
        centerX > worldCull.maxX ||
        centerY < worldCull.minY ||
        centerY > worldCull.maxY
      ) {
        continue;
      }

      const sx = centerX * viewport.zoom + viewport.x;
      const sy = centerY * viewport.zoom + viewport.y;
      const x = sx - halfW;
      const y = sy - halfH;

      if (x > screenWidth + padding || y > screenHeight + padding || x + style.width < -padding || y + style.height < -padding) {
        continue;
      }

      const key = resolveNodeRegistryKey(node);
      let color = colorCache.get(key);
      if (!color) {
        const definition = nodeRegistry.get(key);
        const definitionColor = definition !== undefined ? definition.color : undefined;
        color =
          typeof definitionColor === 'string' && definitionColor.trim().length > 0
            ? definitionColor.trim()
            : DEFAULT_FALLBACK_NODE_COLOR;
        colorCache.set(key, color);
      }

      // Card background
      roundRectPath(ctx, x, y, style.width, style.height, style.cornerRadius);
      ctx.fill();

      // Accent stripe
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = color;
      roundRectPath(ctx, x, y, style.width, style.stripeHeight, Math.min(style.cornerRadius, style.stripeHeight));
      ctx.fill();

      // Border
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? Math.max(1.25, style.borderWidth * 1.6) : style.borderWidth;
      roundRectPath(ctx, x, y, style.width, style.height, style.cornerRadius);
      ctx.stroke();

      // Restore base fill for next node
      ctx.globalAlpha = palette.cardFillAlpha;
      ctx.fillStyle = palette.cardFill;
    }
  };

  drawPass(false);
  drawPass(true);

  ctx.restore();
};

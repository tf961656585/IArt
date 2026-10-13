/**
 * 持有素材 id 的节点类型全集（spec：画布对象右键菜单.md §7.1 / CM-030）。
 *
 * CLI 画布节点投影（apps/desktop-shell/src/cli/cli-canvas-projection.cts）保持同一口径。
 * 任务节点的 assetId 是占位资产身份（成功投影后回填替换），不属于资产引用口径，不入列；
 * 文本素材节点无媒体资产 id，不入列。
 */
const ASSET_ID_NODE_TYPES: ReadonlySet<string> = new Set([
  'imageInput',
  'videoInput',
  'audioInput',
  'asset',
]);

/**
 * 读取节点承载的素材 id（assetId）；不持有该类身份或 id 为空返回 null。
 * 「复制素材 ID」菜单项的触发条件判据（spec CM-030：空内容素材节点不出现该项）。
 *
 * 入参取结构化窄类型（type + data），GraphNode 直接可传，最小对象也可单测。
 */
export const readNodeAssetId = (
  node: { type: string; data: unknown } | null | undefined,
): string | null => {
  if (node === null || node === undefined || !ASSET_ID_NODE_TYPES.has(node.type)) {
    return null;
  }
  const data = node.data as { assetId?: unknown } | undefined;
  return typeof data?.assetId === 'string' && data.assetId.length > 0 ? data.assetId : null;
};

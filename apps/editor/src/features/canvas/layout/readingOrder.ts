/**
 * 视觉阅读序与重排差异（共享纯函数，无 store / 无 IO）。
 *
 * 单一实现，消费方：
 * - 容器内整理（canvasStore.groupActions.autoLayoutContainer）
 * - 全局整理（canvasStore.layoutActions）
 * - 容器看板排布（layout/containerPack）
 *
 * 口径（spec：docs/runtime/画布自动布局算法.md「排序口径」）：
 * 先按 y 分行，与当前行基准 y 相差不超过 1px 视为同一行；行内按 x 升序；
 * x 相同按调用方传入的数组下标（插入序）兜底，再按 id 字典序保证完全确定。
 * 默认排序是视觉阅读序；显式 --order 仍由 applyLayoutInputOrder 覆盖在模式排序之后。
 */

/** 同一行的 y 容差（px）。与容器看板既有阅读序口径一致。 */
export const READING_ORDER_ROW_TOLERANCE_PX = 1;

export type ReadingOrderNode = {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
};

type IndexedNode<T extends ReadingOrderNode> = {
  readonly node: T;
  readonly insertionIndex: number;
};

/**
 * 按视觉阅读序返回节点副本数组；不修改输入。
 *
 * 行基准取该行第一个节点的 y，而不是前一个节点的 y——避免「每级下移 1px」的链条
 * 被不断并入同一行。
 */
export const orderByReadingPosition = <T extends ReadingOrderNode>(
  nodes: readonly T[],
  options?: { readonly tolerancePx?: number },
): T[] => {
  if (nodes.length <= 1) return [...nodes];
  const tolerance = options?.tolerancePx ?? READING_ORDER_ROW_TOLERANCE_PX;
  const indexed: IndexedNode<T>[] = nodes.map((node, insertionIndex) => ({
    node,
    insertionIndex,
  }));
  indexed.sort((left, right) => {
    if (left.node.position.y !== right.node.position.y) {
      return left.node.position.y - right.node.position.y;
    }
    return left.insertionIndex - right.insertionIndex;
  });

  const rows: IndexedNode<T>[][] = [];
  for (const entry of indexed) {
    const currentRow = rows[rows.length - 1];
    const bandTopY = currentRow?.[0]?.node.position.y;
    if (
      currentRow === undefined ||
      bandTopY === undefined ||
      entry.node.position.y - bandTopY > tolerance
    ) {
      rows.push([entry]);
    } else {
      currentRow.push(entry);
    }
  }

  const ordered: T[] = [];
  for (const row of rows) {
    row.sort((left, right) => {
      if (left.node.position.x !== right.node.position.x) {
        return left.node.position.x - right.node.position.x;
      }
      if (left.insertionIndex !== right.insertionIndex) {
        return left.insertionIndex - right.insertionIndex;
      }
      return left.node.id.localeCompare(right.node.id);
    });
    for (const entry of row) ordered.push(entry.node);
  }
  return ordered;
};

export type OrderChange = {
  readonly nodeId: string;
  readonly fromSlot: number;
  readonly toSlot: number;
};

export type OrderChangeSummary = {
  readonly contentReordered: boolean;
  readonly orderChanges: readonly OrderChange[];
};

/**
 * 比较「原视觉阅读序」与「本次实际占格序」，输出语义差异。
 *
 * 槽位是各自序列中的 0 基下标；只报告两边都存在的节点。content_reordered 为
 * true 表示至少一个节点的阅读位次发生变化——这是「整理会洗牌内容」的机器可读信号。
 */
export const computeOrderChanges = (
  visualOrder: readonly { readonly id: string }[],
  layoutOrder: readonly { readonly id: string }[],
): OrderChangeSummary => {
  const fromSlotById = new Map<string, number>();
  for (let index = 0; index < visualOrder.length; index += 1) {
    const node = visualOrder[index];
    if (node !== undefined) fromSlotById.set(node.id, index);
  }
  const toSlotById = new Map<string, number>();
  for (let index = 0; index < layoutOrder.length; index += 1) {
    const node = layoutOrder[index];
    if (node !== undefined) toSlotById.set(node.id, index);
  }

  const orderChanges: OrderChange[] = [];
  for (const node of layoutOrder) {
    const fromSlot = fromSlotById.get(node.id);
    const toSlot = toSlotById.get(node.id);
    if (fromSlot === undefined || toSlot === undefined) continue;
    if (fromSlot !== toSlot) orderChanges.push({ nodeId: node.id, fromSlot, toSlot });
  }
  return { contentReordered: orderChanges.length > 0, orderChanges };
};

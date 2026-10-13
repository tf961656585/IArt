import type { NodePosition } from './node';

import type { DynamicRecord } from '@/client/utils/typeGuards';

export type NodeCompanionEnsureWhen = 'create' | 'execute';

export type NodeCompanionBinding = {
  type: 'dataField';
  /** Companion 节点 data 中记录 ownerId 的字段名（例如 ResultAreaNodeData.sourceNodeId） */
  ownerNodeIdField: string;
};

export type NodeCompanionPlacement =
  | {
      type: 'derived';
      /**
       * 可选：覆盖 derived 的水平偏移（像素）
       * - fromRightEdge=false：相对 owner.position.x
       * - fromRightEdge=true：相对 owner 右侧边界（owner.position.x + owner display width）
       */
      offsetX: number | undefined;
      /** derived 计算时是否以 owner 右侧边界为锚点（更适合 sidecar/dock） */
      fromRightEdge: boolean | undefined;
      /** derived 计算的 y 方向步进（像素） */
      yStep: number | undefined;
    }
  | {
      type: 'offset';
      dx: number;
      dy: number;
    };

export type NodeCompanionDock =
  | {
      mode: 'locked';
      /** locked 模式下 owner 与 companion 的水平间距（像素） */
      gapX: number | undefined;
      /** locked 模式下 companion 的垂直对齐方式（当前仅支持 top，便于形成 Dock Pair） */
      alignY: 'top' | undefined;
    }
  | {
      mode: 'free';
    };


export type NodeCompanionUI = {
  /** companion 的呈现方式：默认作为独立 node；drawer 表示嵌入到 owner 的抽屉/面板中 */
  presentation: 'node' | 'drawer' | undefined;
};

export type NodeCompanionDeclaration = {
  kind: string;
  /** 对应 nodeRegistry.createNode(key, ...) 的 key */
  nodeKey: string;
  bind: NodeCompanionBinding;
  ensureWhen: NodeCompanionEnsureWhen[];
  dock: NodeCompanionDock | undefined;
  ui: NodeCompanionUI | undefined;
  placement: NodeCompanionPlacement | undefined;
  /** Companion 节点 data 的额外覆写（会与 defaultData 合并） */
  data: DynamicRecord | undefined;
  /** 可选：覆写 placement 的 hint（用于 derived/offset 之外的未来扩展） */
  placementHint: NodePosition | undefined;
};

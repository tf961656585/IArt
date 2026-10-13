/**
 * 画布剪贴板相关类型定义
 */

import type { GraphNode, NodePosition } from './index';

/**
 * 剪贴板数据结构
 */
export interface ClipboardPayload {
  /** 复制时间戳 */
  copiedAt: number;
  /** 源画板 ID（用于检测跨画板粘贴） */
  sourceNodeGraphId: string;
  /** 复制的节点（保留原始 ID，粘贴时重新生成） */
  nodes: GraphNode[];
  /** 原始包围盒中心位置（用于计算粘贴偏移） */
  centerPosition: NodePosition;
}

/**
 * 容器种类（容器内空白右键目标的载体判别）。
 *
 * 与容器节点类型一一对应：组节点（type 'group'）→ 'group'；
 * Agent 容器（type 'agent' 的容器形态）→ 'agentContainer'。
 */
export type ContainerGapKind = 'group' | 'agentContainer';

/**
 * 右键菜单目标类型
 */
export type ContextMenuTarget =
  | { type: 'pane'; position: NodePosition }
  | { type: 'node'; nodeId: string; position: NodePosition }
  | { type: 'selection'; nodeIds: string[]; position: NodePosition }
  | { type: 'annotation'; annotationId: string; position: NodePosition }
  | {
      /** 容器（组 | Agent 容器）内部空白：命中容器背板空隙、未命中任何可点元素 */
      type: 'containerGap';
      /** 命中的容器节点 id（动作显式绑定该 id，不依赖选中态） */
      containerNodeId: string;
      /** 命中的容器种类 */
      containerKind: ContainerGapKind;
      position: NodePosition;
    };

/**
 * 右键菜单状态
 */
export interface ContextMenuState {
  /** 是否显示菜单 */
  open: boolean;
  /** 菜单目标 */
  target: ContextMenuTarget | null;
  /** 屏幕坐标（用于定位菜单） */
  screenPosition: { x: number; y: number };
}

/** 色板行色点（组颜色等换色入口） */
export interface ContextMenuColorSwatch {
  /** 色值（HEX） */
  color: string;
  /** 是否为当前生效值（高亮选中环） */
  active: boolean;
}

/**
 * 菜单行公共字段。
 *
 * 每行的渲染形态由 `kind` 判别（判别联合），行特有字段只出现在对应变体上：
 * 构建时漏写必需字段直接编译报错，不在下游静默读到 undefined。
 */
type ContextMenuRowBase = {
  /** 唯一标识 */
  id: string;
  /** 显示文本 */
  label: string;
};

/** 标准按钮行：可激活并执行单一动作。 */
export type ContextMenuActionItem = ContextMenuRowBase & {
  kind: 'action';
  /** 快捷键提示 */
  shortcut: string | undefined;
  /** 图标 */
  icon: React.ReactNode | undefined;
  /** 是否禁用 */
  disabled: boolean | undefined;
  /** 是否为危险操作（红色） */
  destructive: boolean | undefined;
  /**
   * 无障碍名覆盖（可省）。缺省时无障碍名来自可见 label（按钮内容）；
   * 需要与可见文本不同的无障碍名时显式给出（如 Agent 删除项 aria-label「删除 Agent」，
   * spec：画布对象右键菜单.md §7.2b）。
   */
  ariaLabel?: string | undefined;
  /** 激活回调 */
  action: () => void;
};

/**
 * 色板行：菜单内联控制行（如「组颜色」）。
 *
 * 不渲染标准按钮外壳与快捷键槽，行内色点自身承担焦点与悬停态；
 * 点色点即时生效，菜单在该行上保持打开。
 */
export type ContextMenuSwatchRow = ContextMenuRowBase & {
  kind: 'swatchRow';
  /** 图标 */
  icon: React.ReactNode | undefined;
  /** 色点集合 */
  swatches: ContextMenuColorSwatch[];
  /** 色点选中回调 */
  onSwatchSelect: (color: string) => void;
};

/**
 * 自定义行：菜单内联控制行（如「整理为网格」的网格快速选择行）。
 *
 * 以 `content` 替代标准按钮行渲染，行内控件自身承担焦点与悬停态；
 * 菜单在该行上保持打开，直到用户完成选择或点菜单外关闭。
 */
export type ContextMenuCustomRow = ContextMenuRowBase & {
  kind: 'customRow';
  /** 行内容 */
  content: React.ReactNode;
};

/**
 * 分隔线行：无交互的视觉分隔（容器段与画布段之间的唯一豁免分隔）。
 *
 * 不是可聚焦行：任何基于焦点的导航（Tab / 方向键循环）天然跳过它；
 * 也不允许出现在子菜单内（`ContextMenuSubmenuRow` 不含本变体）。
 */
export type ContextMenuSeparatorItem = {
  /** 唯一标识（React key 用） */
  id: string;
  kind: 'separator';
};

/**
 * 子菜单可承载的行：任何行形态，但不含子菜单触发项。
 *
 * 菜单最多嵌套一层（spec §5.2），该约束由类型承载——第二层子菜单无法被构造出来，
 * 而不是靠运行期判断兜住。
 */
export type ContextMenuSubmenuRow =
  | ContextMenuActionItem
  | ContextMenuSwatchRow
  | ContextMenuCustomRow;

/**
 * 子菜单触发项：本身不承载动作，展开子菜单是其唯一行为。
 *
 * 以方向指示符表达存在下级；`items` 为其子菜单内容。
 */
export type ContextMenuSubmenuTrigger = ContextMenuRowBase & {
  kind: 'submenu';
  /** 图标 */
  icon: React.ReactNode | undefined;
  /** 是否禁用（组内无可整理成员时不可展开） */
  disabled: boolean | undefined;
  /** 子菜单内容 */
  items: ContextMenuSubmenuRow[];
};

/**
 * 菜单项定义
 */
export type ContextMenuItem =
  | ContextMenuActionItem
  | ContextMenuSwatchRow
  | ContextMenuCustomRow
  | ContextMenuSubmenuTrigger
  | ContextMenuSeparatorItem;

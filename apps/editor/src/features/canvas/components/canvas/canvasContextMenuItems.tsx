'use client';

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDownUp,
  CheckSquare,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  Copy,
  Download,
  FolderOpen,
  Group,
  Hash,
  Link2,
  Palette,
  Pencil,
  StickyNote,
  Trash2,
  Ungroup,
  Unlink2,
  UserPlus,
  PackagePlus,
} from 'lucide-react';
import { IconTool } from '@tabler/icons-react';

import type {
  ContextMenuItem,
  ContextMenuSubmenuRow,
  ContextMenuSubmenuTrigger,
  ContextMenuTarget,
} from '../../types/clipboard';
import type { GraphNode, ImageInputNodeData, NodeTaskInfo } from '../../types';
import type { GroupNodeData } from '../../types/node';
import type { AlignmentMode } from '../../layout/alignment';
import { classifyMediaUrl } from '../../../models/shared/mediaResolutionTypes';
import { resolvePackageAreaCandidate } from '@/features/package-area/ops';
import { isAnnotationBound } from './canvasContextMenuAnnotation';
import { ContainerTidyGridPicker } from './ContainerTidyGridPicker';
import { getGroupMembers, isContainerCollapsed, isContainerNode } from '../../services/groupMembership';
import { collectFailedTaskNodeIds } from '../../utils/failedTaskNodes';
import { readNodeAssetId } from '../../utils/nodeAssetId';
import { GROUP_PALETTE_COLORS } from '../../services/groupPalette';
import { topToolGroupsFor, type MediaChromeToolId } from '../chrome/chromeModel';
import { MEDIA_TOOL_ICONS } from '../chrome/mediaToolIcons';
import { resolveChromeSubject } from '../chrome/mediaNodeModel';
import type { useCanvasContextMenuActions } from './useCanvasContextMenuActions';
import { resolveContainerObjectWord } from './useCanvasContextMenuActions';

type CanvasContextMenuActions = ReturnType<typeof useCanvasContextMenuActions>;

/** 危险项判据：仅标准动作行承载 destructive（色板/自定义/子菜单/分隔行无该语义）。 */
const isDestructiveMenuItem = (item: ContextMenuItem): boolean =>
  item.kind === 'action' && item.destructive === true;

/**
 * 合并容器段与画布段（容器内空白菜单的排布规则）：
 * 容器动作段在前、细分隔线、画布动作段在后；危险项（destructive）集中到整个菜单
 * 最末尾相邻排布，各来源内部相对顺序保持稳定。分隔线只出现这一次——两个来源
 * 内部既有的语义分组不再加分隔线。
 */
const mergeContainerGapMenuItems = (
  containerItems: ContextMenuItem[],
  paneItems: ContextMenuItem[],
): ContextMenuItem[] => {
  const containerKept: ContextMenuItem[] = [];
  const containerDestructive: ContextMenuItem[] = [];
  for (const item of containerItems) {
    (isDestructiveMenuItem(item) ? containerDestructive : containerKept).push(item);
  }
  const paneKept: ContextMenuItem[] = [];
  const paneDestructive: ContextMenuItem[] = [];
  for (const item of paneItems) {
    (isDestructiveMenuItem(item) ? paneDestructive : paneKept).push(item);
  }
  return [
    ...containerKept,
    { id: 'containerGapSeparator', kind: 'separator' },
    ...paneKept,
    ...containerDestructive,
    ...paneDestructive,
  ];
};

type BuildCanvasContextMenuItemsArgs = {
  target: ContextMenuTarget | null;
  isBundleImportRunning: boolean | undefined | undefined;
  deleteShortcutLabel: string;
  actions: CanvasContextMenuActions;
  /** 右键菜单的屏幕坐标（用于批量接入面板定位） */
  screenPosition: { x: number; y: number };
  /**
   * 收起子菜单（不关闭主菜单）。
   *
   * 子菜单内的行内控件激活后要立刻收起子菜单，而动作自身的反馈与主菜单关闭
   * 走 actions 内的既有路径（spec：画布对象右键菜单.md CM-020）。
   */
  closeSubmenu: () => void;
};

export function buildCanvasContextMenuItems({
  target,
  isBundleImportRunning,
  deleteShortcutLabel,
  actions,
  screenPosition: _screenPosition,
  closeSubmenu,
}: BuildCanvasContextMenuItemsArgs): ContextMenuItem[] {
  if (!target) return [];

  const {
    nodeGraph,
    selectedNodeIds,
    hasClipboardContent,
    findAnnotationForTarget,
    getNodeMediaUrlForReveal,
    revealFilesUrlWithToast,
    handleOpenTaskArchive,
    handleCopy,
    handleCopyAssetId,
    handlePaste,
    handleImportAndInsert,
    handleCreateAnnotation,
    handleDeleteNodes,
    handleDeleteAgentNode,
    handleDissolveAgentContainer,
    handleSelectAll,
    handleSaveCharacter,
    handleAddAnnotationForNode,
    handleStartBindAnnotation,
    handleUnbindAnnotation,
    handleDeleteAnnotation,
    handleExportSelection,
    handleCreateGroup,
    handleAutoLayoutContainerGrid,
    alignSelection,
    handleUngroupNode,
    handleRenameGroup,
    handleToggleGroupCollapse,
    handleSetGroupColor,
    handleAddToGroup,
    handleRemoveFromGroup,
    handleDeleteGroupWithMembers,
    handleDeleteFailedNodes,
    handleAddToPackageArea,
    handleRunMediaDirectTool,
    handleOpenMediaToolDialog,
    mediaAssets,
    onClose,
  } = actions;

  const hasClipboard = hasClipboardContent();

  const hasExportableSelection = selectedNodeIds.length > 0;
  const exportSelectionDisabled = !nodeGraph || !hasExportableSelection;
  const exportSelectionLabel = !nodeGraph
    ? '导出所选'
    : hasExportableSelection
      ? '导出所选'
      : '导出所选（无可导出内容）';

  const canSaveCharacter = (() => {
    if (target.type !== 'node') return false;
    const node = nodeGraph !== null && nodeGraph !== undefined
      ? nodeGraph.nodes.find((n) => n.id === target.nodeId)
      : undefined;
    if (!node || node.type !== 'imageInput') return false;
    const data = node.data as ImageInputNodeData | undefined;
    return Boolean(data !== null && data !== undefined ? data.imageUrl : undefined);
  })();

  // 单对象菜单的命中节点只查一次：组分支、任务/媒体分支与解散判定共用同一引用。
  const singleTargetNode =
    target.type === 'node' && nodeGraph !== null && nodeGraph !== undefined
      ? nodeGraph.nodes.find((n) => n.id === target.nodeId)
      : undefined;
  // Agent 节点双动作（spec §7.2b / CM-025）：「解散」仅容器形态（有成员）出现的容器组织
  // 动作（纯可逆）；「删除」任意 Agent 节点出现、必须经确认框（级联物理删除会话）。
  const isAgentTarget = singleTargetNode?.type === 'agent';

  // 空白区菜单的画布段（容器内空白菜单与 pane 菜单共用同一构造，不复制菜单项定义）。
  const buildPaneMenuItems = (): ContextMenuItem[] => {
    // 空白区菜单的清理项：数量、可用性与实际删除集合同源（§7.6）
    const failedNodeCount = collectFailedTaskNodeIds(nodeGraph).length;
    return [
      {
        id: 'importInsert',
        kind: 'action',
        label: isBundleImportRunning ? '导入并插入（进行中）' : '导入并插入',
        shortcut: undefined,
        icon: <FolderOpen className="size-4" />,
        disabled: !nodeGraph,
        destructive: undefined,
        action: handleImportAndInsert,
      },
      {
        id: 'paste',
        kind: 'action',
        label: '粘贴',
        shortcut: 'Ctrl+V',
        icon: <ClipboardPaste className="size-4" />,
        disabled: !hasClipboard,
        destructive: undefined,
        action: handlePaste,
      },
      {
        id: 'selectAll',
        kind: 'action',
        label: '全选',
        shortcut: 'Ctrl+A',
        icon: <CheckSquare className="size-4" />,
        disabled: !nodeGraph || nodeGraph.nodes.length === 0,
        destructive: undefined,
        action: handleSelectAll,
      },
      {
        id: 'createAnnotation',
        kind: 'action',
        label: '创建注释',
        shortcut: undefined,
        icon: <StickyNote className="size-4" />,
        disabled: undefined,
        destructive: undefined,
        action: handleCreateAnnotation,
      },
      // 危险动作位于菜单末尾（spec §5.2）：无失败节点时灰置不隐藏，菜单项位置稳定
      {
        id: 'deleteFailedNodes',
        kind: 'action',
        label: failedNodeCount > 0 ? `删除失败节点（${failedNodeCount}）` : '删除失败节点',
        shortcut: undefined,
        icon: <Trash2 className="size-4" />,
        disabled: failedNodeCount === 0,
        destructive: true,
        action: handleDeleteFailedNodes,
      },
    ];
  };

  // 容器标准行为段（组与 Agent 容器同一构造）：对象右键命中容器与容器内空白右键共用，
  // 动作经 actions 按 target 携带的容器 id 显式绑定（容器内空白路径不写选中态）。
  const buildContainerMenuItems = (containerNode: GraphNode): ContextMenuItem[] => {
    const isGroupTarget = containerNode.type === 'group';
    // 成员口径与 store action 一致：getGroupMembers（含 Agent 容器成员、排除组节点）
    const containerMemberCount = nodeGraph
      ? getGroupMembers(nodeGraph, containerNode.id).length
      : 0;
    const containerCollapsed = isContainerCollapsed(containerNode);
    // 对象词唯一判据（与 toast 共用 resolveContainerObjectWord，白名单判据：
    // 组是唯一叫「组」的载体），折叠 label 与整理触发项按载体注入，句式两类容器一致
    const objectWord = resolveContainerObjectWord(containerNode);
    const collapseLabel = containerCollapsed
      ? isGroupTarget ? '展开组' : '展开容器'
      : isGroupTarget ? '折叠组' : '折叠容器';
    const tidyTriggerLabel = `整理${objectWord}`;
    const items: ContextMenuItem[] = [];
    if (isGroupTarget) {
      // spec §7.3 组管理组顺序：重命名组 → 折叠组/展开组 → 组颜色 → 整理本组（子菜单）→ 解组
      items.push({
        id: 'renameGroup',
        kind: 'action',
        label: '重命名组',
        shortcut: undefined,
        icon: <Pencil className="size-4" />,
        disabled: undefined,
        destructive: undefined,
        action: handleRenameGroup,
      });
    }
    items.push({
      id: 'toggleGroupCollapse',
      kind: 'action',
      label: collapseLabel,
      shortcut: undefined,
      icon: containerCollapsed ? (
        <ChevronsUpDown className="size-4" />
      ) : (
        <ChevronsDownUp className="size-4" />
      ),
      disabled: undefined,
      destructive: undefined,
      action: handleToggleGroupCollapse,
    });
    if (isGroupTarget) {
      // 组颜色：色板行（8 色点，当前色高亮选中环）；点色点即时生效，菜单保持打开便于连续试色
      const groupData = containerNode.data as GroupNodeData | undefined;
      const groupColor = groupData?.color;
      items.push({
        id: 'groupColor',
        kind: 'swatchRow',
        label: '组颜色',
        icon: <Palette className="size-4" />,
        swatches: GROUP_PALETTE_COLORS.map((color) => ({
          color,
          active:
            typeof groupColor === 'string' &&
            groupColor.toLowerCase() === color.toLowerCase(),
        })),
        onSwatchSelect: handleSetGroupColor,
      });
    }
    items.push({
      id: 'autoLayoutContainer',
      label: tidyTriggerLabel,
      kind: 'submenu',
      icon: <ArrowDownUp className="size-4" />,
      // 能力门（spec §7.3.1）：可整理成员数为 0 或容器折叠态时灰置且不可展开——
      // 折叠态容器内整理不可执行（需先展开），空容器不产生可整理的网格
      disabled: containerMemberCount === 0 || containerCollapsed,
      // 子菜单只承载整理方式；默认单列整理即网格第 1 列，不再并列保留等价按钮行
      items:
        containerMemberCount > 0
          ? [
              {
                id: 'autoLayoutContainerGrid',
                label: '整理为网格',
                kind: 'customRow',
                content: (
                  <ContainerTidyGridPicker
                    memberCount={containerMemberCount}
                    objectWord={objectWord}
                    onSelect={(columns) => {
                      // 激活任一格即收起子菜单（主菜单由动作的既有反馈路径关闭）
                      closeSubmenu();
                      handleAutoLayoutContainerGrid(columns);
                    }}
                  />
                ),
              },
            ]
          : [],
    });
    if (isGroupTarget) {
      items.push({
        id: 'ungroupNode',
        kind: 'action',
        label: '解组',
        shortcut: undefined,
        icon: <Ungroup className="size-4" />,
        disabled: undefined,
        destructive: undefined,
        action: handleUngroupNode,
      });
      // 删除组及成员：显式连删入口（destructive），与默认 dissolve 删除区分
      // spec §7.3：删除组及全部成员在组无成员时禁用
      items.push({
        id: 'deleteGroupWithMembers',
        kind: 'action',
        label: '删除组及全部成员',
        shortcut: undefined,
        icon: <Trash2 className="size-4" />,
        disabled: containerMemberCount === 0,
        destructive: true,
        action: handleDeleteGroupWithMembers,
      });
    } else if (containerMemberCount > 0) {
      // Agent 容器的「解散」（AG-CT-010，spec §7.2b）：解除容器组织关系的容器标准
      // 行为项——与组「解组」同一位置（整理之后），仅容器形态（有成员）出现；
      // 纯可逆不经删除路径，无快捷键（撤销经编辑域历史兜底）。
      items.push({
        id: 'dissolveAgentContainer',
        kind: 'action',
        label: '解散',
        shortcut: undefined,
        icon: <Ungroup className="size-4" />,
        disabled: undefined,
        destructive: undefined,
        ariaLabel: '解散容器',
        action: handleDissolveAgentContainer,
      });
    }
    return items;
  };

  switch (target.type) {
    case 'pane': {
      return buildPaneMenuItems();
    }

    case 'node':
    case 'selection': {
      // 删除项（spec §7.2b / §5.2）：Agent 目标走删除确认通道（aria-label「删除 Agent」，
      // 危险分组归属菜单末尾）；其余节点保持既有「删除」即时删除（可撤销）。
      const deleteItem: ContextMenuItem = {
        id: 'delete',
        kind: 'action',
        label: '删除',
        shortcut: deleteShortcutLabel,
        icon: <Trash2 className="size-4" />,
        disabled: undefined,
        destructive: true,
        ariaLabel: isAgentTarget ? '删除 Agent' : undefined,
        action: isAgentTarget ? handleDeleteAgentNode : handleDeleteNodes,
      };
      // 复制素材 ID（spec §7.1 / CM-030）：仅单选且节点持有素材 id 时出现（多选不做，
      // 2026-10-07 拍板）；与「复制」相邻（编辑与流转组），位于删除项之前。
      const copyAssetIdItem: ContextMenuItem | null =
        target.type === 'node' && readNodeAssetId(singleTargetNode) !== null
          ? {
              id: 'copyAssetId',
              kind: 'action',
              label: '复制素材 ID',
              shortcut: undefined,
              icon: <Hash className="size-4" />,
              disabled: undefined,
              destructive: undefined,
              ariaLabel: '复制素材 ID',
              action: handleCopyAssetId,
            }
          : null;
      // 「加工」子菜单（spec：docs/editor/媒体工具加工.md「入口表面」/ 画布对象右键菜单.md §7.1）：
      // 只作用于单节点目标的可加工媒体主体——多选不出现（工具只作用单资产），
      // 主体不可访问（资产缺失）也不出现（入口可用性与资产存在性对齐）。
      // 子菜单按 chrome 的同一工具分组（topToolGroupsFor）生成，直接变换点即执行；
      // 弹窗工具只登记打开请求，弹窗渲染与执行归 MediaToolDialogHost（与工具栏同一份）。
      const mediaToolsItem: ContextMenuSubmenuTrigger | null = (() => {
        if (target.type !== 'node') return null;
        const node = singleTargetNode;
        if (node === undefined) return null;
        const subject = resolveChromeSubject(node, mediaAssets);
        if (subject === null || !subject.available) return null;
        const groups = topToolGroupsFor(subject.mediaType);
        if (groups.length === 0) return null;
        const subjectNodeId = node.id;
        const toolItems: ContextMenuSubmenuRow[] = groups.flatMap((group) =>
          group.map((tool): ContextMenuSubmenuRow => {
            const ToolIcon = MEDIA_TOOL_ICONS[tool.icon];
            const toolId: MediaChromeToolId = tool.id;
            const directToolId = tool.kind === 'direct' ? tool.id : null;
            return {
              id: `mediaTool-${tool.id}`,
              kind: 'action',
              label: tool.label,
              shortcut: undefined,
              icon: <ToolIcon size={16} />,
              disabled: undefined,
              destructive: undefined,
              action: () => {
                if (directToolId !== null) {
                  handleRunMediaDirectTool(subjectNodeId, directToolId);
                  return;
                }
                handleOpenMediaToolDialog(subjectNodeId, toolId);
              },
            };
          }),
        );
        return {
          id: 'mediaTools',
          kind: 'submenu',
          label: '加工',
          icon: <IconTool size={16} />,
          disabled: undefined,
          items: toolItems,
        };
      })();
      const items: ContextMenuItem[] = [
        ...(mediaToolsItem !== null ? [mediaToolsItem] : []),
        {
          id: 'exportSelection',
          kind: 'action',
          label: exportSelectionLabel,
          shortcut: undefined,
          icon: <Download className="size-4" />,
          disabled: exportSelectionDisabled,
          destructive: undefined,
          action: () => void handleExportSelection(),
        },
        {
          id: 'copy',
          kind: 'action',
          label: '复制',
          shortcut: 'Ctrl+C',
          icon: <Copy className="size-4" />,
          disabled: undefined,
          destructive: undefined,
          action: handleCopy,
        },
        ...(copyAssetIdItem !== null ? [copyAssetIdItem] : []),
        // Agent 节点的「删除」不在此处入列：作为危险项统一追加到菜单末尾（§5.2），见 case 末尾。
        ...(isAgentTarget ? [] : [deleteItem]),
      ];

      // 添加到打包区：目标含可打包媒体节点（资产/素材，图片视频音频）时出现（spec「右侧工作区与打包区服务」）
      const packageAreaEligible = (() => {
        if (!nodeGraph) return false;
        const targetNodeIds =
          target.type === 'node'
            ? [target.nodeId]
            : target.type === 'selection'
              ? target.nodeIds
              : [];
        return targetNodeIds.some((id) => {
          const node = nodeGraph.nodes.find((n) => n.id === id);
          return node !== undefined && resolvePackageAreaCandidate(node, mediaAssets).ok;
        });
      })();
      if (packageAreaEligible) {
        items.push({
          id: 'addToPackageArea',
          kind: 'action',
          label: target.type === 'selection' ? `加入打包区 · ${target.nodeIds.length} 项` : '加入打包区',
          shortcut: undefined,
          icon: <PackagePlus className="size-4" />,
          disabled: undefined,
          destructive: undefined,
          action: handleAddToPackageArea,
        });
      }

      if (canSaveCharacter) {
        items.push({
          id: 'saveCharacter',
          kind: 'action',
          label: '保存角色',
          shortcut: undefined,
          icon: <UserPlus className="size-4" />,
          disabled: undefined,
          destructive: undefined,
          action: handleSaveCharacter,
        });
      }

      // 添加组：仅多选节点时出现
      if (target.type === 'selection') {
        items.push({
          id: 'createGroup',
          kind: 'action',
          label: '添加组',
          shortcut: undefined,
          icon: <Group className="size-4" />,
          disabled: target.nodeIds.length < 2,
          destructive: undefined,
          action: handleCreateGroup,
        });

        // 多选图片批量接入生成模型（spec：多选图片批量接入生成模型交互.md「交互主链」）
        // 入口只在多选时出现：选中含 ≥1 个 imageInput 时显示，<2 时 disabled 提示需多选。
        // 对齐/分布选中节点：对齐需 ≥2 节点，分布需 ≥3 节点
        const alignmentItems: Array<{ mode: AlignmentMode; label: string; icon: React.ReactNode; minNodes: number }> = [
          { mode: 'left', label: '左对齐', icon: <AlignStartVertical className="size-4" />, minNodes: 2 },
          { mode: 'centerHorizontal', label: '水平居中', icon: <AlignCenterVertical className="size-4" />, minNodes: 2 },
          { mode: 'right', label: '右对齐', icon: <AlignEndVertical className="size-4" />, minNodes: 2 },
          { mode: 'top', label: '顶对齐', icon: <AlignStartHorizontal className="size-4" />, minNodes: 2 },
          { mode: 'centerVertical', label: '垂直居中', icon: <AlignCenterHorizontal className="size-4" />, minNodes: 2 },
          { mode: 'bottom', label: '底对齐', icon: <AlignEndHorizontal className="size-4" />, minNodes: 2 },
          { mode: 'distributeHorizontal', label: '水平分布', icon: <AlignHorizontalDistributeCenter className="size-4" />, minNodes: 3 },
          { mode: 'distributeVertical', label: '垂直分布', icon: <AlignVerticalDistributeCenter className="size-4" />, minNodes: 3 },
        ];
        for (const alignItem of alignmentItems) {
          items.push({
            id: `align-${alignItem.mode}`,
            kind: 'action',
            label: alignItem.label,
            shortcut: undefined,
            icon: alignItem.icon,
            disabled: target.nodeIds.length < alignItem.minNodes,
            destructive: undefined,
            action: () => alignSelection(alignItem.mode),
          });
        }

        // 加入组…/从组中移除：基于选中节点的当前归属判定可用性
        // 加入组：候选含非组节点（自由节点或其他组成员）且图中至少存在一个组
        // 从组中移除：候选含组成员
        const selectionNodes =
          nodeGraph !== null && nodeGraph !== undefined
            ? target.nodeIds
                .map((id) => nodeGraph.nodes.find((n) => n.id === id))
                .filter((n): n is NonNullable<typeof n> => n !== undefined)
            : [];
        const hasGroupInGraph =
          nodeGraph !== null && nodeGraph !== undefined
            ? nodeGraph.nodes.some((n) => n.type === 'group')
            : false;
        const hasAddableNode = selectionNodes.some((n) => n.type !== 'group');
        const hasRemovableMember = selectionNodes.some(
          (n) => n.type !== 'group' && typeof n.groupId === 'string' && n.groupId.length > 0,
        );

        if (hasGroupInGraph && hasAddableNode) {
          items.push({
            id: 'addToGroup',
            kind: 'action',
            label: '加入组…',
            shortcut: undefined,
            icon: <Group className="size-4" />,
            disabled: undefined,
            destructive: undefined,
            action: handleAddToGroup,
          });
        }
        if (hasRemovableMember) {
          items.push({
            id: 'removeFromGroup',
            kind: 'action',
            label: '从组中移除',
            shortcut: undefined,
            icon: <Ungroup className="size-4" />,
            disabled: undefined,
            destructive: undefined,
            action: handleRemoveFromGroup,
          });
        }
      }

      if (target.type === 'node') {
        // 容器标准行为门（组与 Agent 容器同一套，spec：docs/runtime/画布节点组.md）：
        // 折叠、整理走 isContainerNode 判据；组专属项（重命名组、组颜色、解组、
        // 删除组及全部成员）保留 type==='group' 门。构造与容器内空白路径共用。
        const targetNode = singleTargetNode;
        if (targetNode !== null && targetNode !== undefined && isContainerNode(targetNode)) {
          items.push(...buildContainerMenuItems(targetNode));
        }

        items.push({
          id: 'addNodeAnnotation',
          kind: 'action',
          label: findAnnotationForTarget(target.nodeId) ? '选择注释' : '添加注释',
          shortcut: undefined,
          icon: <StickyNote className="size-4" />,
          disabled: undefined,
          destructive: undefined,
          action: handleAddAnnotationForNode,
        });

        const node = singleTargetNode;
        const nodeData =
          node !== null && node !== undefined ? node.data : undefined;
        const taskInfo =
          nodeData !== null &&
          nodeData !== undefined &&
          'taskInfo' in nodeData
            ? (nodeData.taskInfo as NodeTaskInfo | undefined)
            : undefined;
        const taskId =
          taskInfo !== null && taskInfo !== undefined ? taskInfo.taskId : undefined;
        if (taskId) {
          items.push({
            id: 'openTaskArchive',
            kind: 'action',
            label: '打开任务文件夹',
            shortcut: undefined,
            icon: <FolderOpen className="size-4" />,
            disabled: undefined,
            destructive: undefined,
            action: () => void handleOpenTaskArchive(taskId),
          });
        }

        const mediaUrl = node ? getNodeMediaUrlForReveal(node) : null;
        if (mediaUrl !== null && mediaUrl !== undefined && classifyMediaUrl(mediaUrl).capabilities.canRevealFile) {
          items.push({
            id: 'openMediaFile',
            kind: 'action',
            label: '打开文件所在位置',
            shortcut: undefined,
            icon: <FolderOpen className="size-4" />,
            disabled: undefined,
            destructive: undefined,
            action: () => {
              void revealFilesUrlWithToast(mediaUrl, undefined);
              onClose();
            },
          });
        }
      }

      if (isAgentTarget) {
        // 危险项必须位于菜单末尾分组（spec §5.2）：Agent 的「删除」排在注释等非危险项之后
        items.push(deleteItem);
      }

      return items;
    }

    case 'containerGap': {
      // 容器内空白合并菜单：容器段（复用容器对象分支构造，动作绑定命中容器 id）
      // + 分隔线 + 画布段（复用 pane 分支构造），危险项聚到全菜单末尾。
      const containerNode =
        nodeGraph !== null && nodeGraph !== undefined
          ? nodeGraph.nodes.find((n) => n.id === target.containerNodeId)
          : undefined;
      if (containerNode === undefined || !isContainerNode(containerNode)) {
        // 条件跳过必须留痕（AGENTS.md）：菜单构建时容器已不存在（如打开瞬间被撤销），
        // 降级为画布段菜单，不让空菜单弹出。
        console.debug('[canvas:contextMenu] container gap menu degraded to pane: container node not found', {
          containerNodeId: target.containerNodeId,
        });
        return buildPaneMenuItems();
      }
      return mergeContainerGapMenuItems(
        buildContainerMenuItems(containerNode),
        buildPaneMenuItems(),
      );
    }

    case 'annotation': {
      const annotations = nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.annotations : undefined;
      const annotation = (annotations ?? []).find((ann) => ann.id === target.annotationId);
      const binding = annotation !== null && annotation !== undefined ? annotation.binding : undefined;
      const bound = isAnnotationBound(binding);

      return [
        {
          id: 'bindAnnotation',
          kind: 'action',
          label: '绑定到…',
          shortcut: undefined,
          icon: <Link2 className="size-4" />,
          disabled: undefined,
          destructive: undefined,
          action: handleStartBindAnnotation,
        },
        {
          id: 'unbindAnnotation',
          kind: 'action',
          label: '解绑',
          shortcut: undefined,
          icon: <Unlink2 className="size-4" />,
          disabled: !bound,
          destructive: undefined,
          action: handleUnbindAnnotation,
        },
        {
          id: 'deleteAnnotation',
          kind: 'action',
          label: '删除注释',
          shortcut: deleteShortcutLabel,
          icon: <Trash2 className="size-4" />,
          disabled: undefined,
          destructive: true,
          action: handleDeleteAnnotation,
        },
      ];
    }

    default:
      return [];
  }
}

"use client";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { getRuntimeProjectPath } from "@/client/store/runtimeStore";
import { revealFilesUrlWithToast } from "@/client/utils/revealFilesUrlWithToast";
import { revealTaskArchive, writeTextToClipboard } from "@iart/backend-sdk/electron-bridge";
import { buildClipboardPayloadFromSelection } from "../../clipboard/selectionPayload";
import { buildNodeGraphSnippetFromClipboardPayload } from "../../services/snippetTransfer";
import { formatBeijingCompactTimestamp } from "@/shared/utils/time";
import { useCanvasStore } from "../../store/canvasStore";
import { useCharacterUIStore } from "../../store/characterUIStore";
import type { NodeGraph, NodePosition, NodeSize } from "../../types";
import { getNodeMediaUrlForReveal } from "../../utils/nodeMediaUrlRegistry";
import { readNodeAssetId } from "../../utils/nodeAssetId";
import type { ContextMenuTarget } from "../../types/clipboard";
import { addNodesToPackageArea } from "@/features/package-area/ops";
import { collectFailedTaskNodeIds } from "../../utils/failedTaskNodes";
import { isContainerCollapsed } from "../../services/groupMembership";
import type { GraphNode } from "../../types/node";
import { findAnnotationIdForContextMenuTarget } from "./canvasContextMenuAnnotation";
import { useCanvasSelectionBridge } from "./useCanvasSelectionBridge";

/**
 * 容器对象词唯一判据（菜单 label、picker 无障碍名与 toast 共用此单一来源）。
 *
 * 白名单判据：组是唯一叫「组」的载体（`type === 'group'`），其余容器一律「本容器」——
 * 新增第三种容器类型时自动归入「本容器」，不会静默回落「本组」
 *（禁止写成 `type === 'agent'` 黑名单判据：判据随类型清空恒假且不报错）。
 */
export const resolveContainerObjectWord = (
  container: GraphNode | undefined,
): '本组' | '本容器' => (container?.type === 'group' ? '本组' : '本容器');

export type CanvasContextMenuActionArgs = {
  target: ContextMenuTarget | null;
  onRequestBundleExport: ((args: { snippet: NodeGraph; fileBaseName: string }) => void) | undefined;
  onRequestBundleImportInsert: ((args: { file: File; targetPosition: NodePosition | undefined }) => void) | undefined;
  isBundleImportRunning: boolean | undefined;
  /** 节点实测尺寸映射，供容器内整理使用真实尺寸防重叠 */
  measuredSizeByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  /** 容器节点派生尺寸映射（来自投影层 groupDerivedProjection），供整理读取容器真实尺寸 */
  derivedSizeByNodeId: Readonly<Record<string, NodeSize | undefined>> | undefined;
  onClose: () => void;
};

/**
 * 容器动作的显式 target 绑定。
 *
 * 对象右键（type 'node'）沿用 nodeId；容器内空白右键（type 'containerGap'）**不写选中**，
 * 动作直接绑定命中容器 id（containerNodeId）。其余目标（pane/selection/annotation）
 * 不是容器动作的绑定对象，返回 undefined 由调用方跳过。
 */
const resolveContainerActionNodeId = (
  target: ContextMenuTarget,
): string | undefined =>
  target.type === 'node'
    ? target.nodeId
    : target.type === 'containerGap'
      ? target.containerNodeId
      : undefined;
export function useCanvasContextMenuActions({
  target,
  onRequestBundleExport,
  onRequestBundleImportInsert,
  isBundleImportRunning,
  measuredSizeByNodeId,
  derivedSizeByNodeId,
  onClose,
}: CanvasContextMenuActionArgs) {
  const { selectAnnotations, selectEntireCanvas, selectNodes } = useCanvasSelectionBridge();
  const copySelectedNodes = useCanvasStore((state) => state.copySelectedNodes);
  const pasteNodes = useCanvasStore((state) => state.pasteNodes);
  const hasClipboardContent = useCanvasStore(
    (state) => state.hasClipboardContent,
  );
  const removeNodes = useCanvasStore((state) => state.removeNodes);
  const dissolveAgentContainer = useCanvasStore((state) => state.dissolveAgentContainer);
  const requestAgentDeleteConfirm = useCanvasStore((state) => state.requestAgentDeleteConfirm);
  const deleteSelectedElements = useCanvasStore((state) => state.deleteSelectedElements);
  const createGroup = useCanvasStore((state) => state.createGroup);
  const autoLayoutContainer = useCanvasStore((state) => state.autoLayoutContainer);
  const alignSelection = useCanvasStore((state) => state.alignSelection);
  const ungroupNode = useCanvasStore((state) => state.ungroupNode);
  const toggleGroupCollapse = useCanvasStore((state) => state.toggleGroupCollapse);
  const setGroupColor = useCanvasStore((state) => state.setGroupColor);
  const requestGroupRename = useCanvasStore((state) => state.requestGroupRename);
  const addNodesToGroup = useCanvasStore((state) => state.addNodesToGroup);
  const removeNodesFromGroup = useCanvasStore((state) => state.removeNodesFromGroup);
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const projectMediaAssets = useCanvasStore((state) => state.mediaAssets);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const openSaveDialog = useCharacterUIStore((state) => state.openSaveDialog);
  const createAnnotation = useCanvasStore((state) => state.createAnnotation);
  const addAnnotationForNode = useCanvasStore(
    (state) => state.addAnnotationForNode,
  );
  const removeAnnotation = useCanvasStore((state) => state.removeAnnotation);
  const unbindAnnotation = useCanvasStore((state) => state.unbindAnnotation);
  const startAnnotationBinding = useCanvasStore(
    (state) => state.startAnnotationBinding,
  );
  const handleOpenTaskArchive = useCallback(
    async (taskId: string | null | undefined) => {
      if (!taskId) {
        toast.warning("这次任务还没有日志，暂时打不开");
        onClose();
        return;
      }
      const result = await revealTaskArchive(taskId, getRuntimeProjectPath());
      if (result.ok) {
        toast.success("已打开任务文件夹");
        onClose();
        return;
      }
      if (result.reason === "not-found") {
        toast.error("这次任务的日志文件找不到了");
        onClose();
        return;
      }
      if (result.reason === "missing-project-path") {
        toast.error("无法定位项目里的日志文件夹");
        onClose();
        return;
      }
      toast.error("打开任务文件夹失败，请稍后重试");
      onClose();
    },
    [onClose],
  );
  const handleCopy = useCallback(() => {
    copySelectedNodes();
    toast.success(`已复制 ${selectedNodeIds.length} 个节点`);
    onClose();
  }, [copySelectedNodes, selectedNodeIds.length, onClose]);

  // 「复制素材 ID」（spec：画布对象右键菜单.md §7.1 / CM-030）：只读情报动作——把节点
  // assetId 原文写系统剪贴板（复用 clipboard:write-text 通道，边界见「节点内容复制到
  // 系统剪贴板.md」），不写画布剪贴板、不进编辑域历史、不改选中集合。
  const handleCopyAssetId = useCallback(() => {
    if (target === null || target.type !== "node") return;
    const node =
      nodeGraph !== null && nodeGraph !== undefined
        ? nodeGraph.nodes.find((n) => n.id === target.nodeId)
        : undefined;
    const assetId = readNodeAssetId(node);
    if (assetId === null) {
      // 条件跳过必须留痕（AGENTS.md）：菜单渲染帧持有 id、激活时已消失（如素材被替换/撤销）
      console.debug("[canvas:contextMenu] copy asset id skipped: node has no assetId", {
        nodeId: target.nodeId,
      });
      toast.warning("这个节点还没有素材 ID");
      onClose();
      return;
    }
    void writeTextToClipboard(assetId).then((result) => {
      if (result.ok) {
        toast.success("已复制素材 ID");
      } else {
        toast.error("复制没有成功，请重试");
      }
    });
    onClose();
  }, [target, nodeGraph, onClose]);
  const handlePaste = useCallback(() => {
    const pasted =
      !target || target.type !== "pane"
        ? pasteNodes(undefined)
        : pasteNodes(target.position);
    if (pasted.nodeIds.length > 0) {
      selectNodes(pasted.nodeIds, "context-menu-paste");
    }
    toast.success("已粘贴");
    onClose();
  }, [onClose, pasteNodes, selectNodes, target]);
  const formatBundleTimestamp = useCallback((): string => {
    return formatBeijingCompactTimestamp();
  }, []);
  const requestBundleExport = useCallback(
    (snippet: NodeGraph, fileBaseName: string) => {
      if (!onRequestBundleExport) {
        toast.error("现在还不能导出，请稍后重试");
        return;
      }
      onRequestBundleExport({ snippet, fileBaseName });
    },
    [onRequestBundleExport],
  );
  const handleExportSelection = useCallback(() => {
    if (!nodeGraph) {
      toast.error("画布还没准备好，暂时无法导出");
      onClose();
      return;
    }
    try {
      const payload = buildClipboardPayloadFromSelection({
        nodeGraph,
        selectedNodeIds,
      });
      if (!payload || payload.nodes.length === 0) {
        toast.warning("请先选中要导出的节点");
        onClose();
        return;
      }
      const snippet = buildNodeGraphSnippetFromClipboardPayload({
        name: nodeGraph.name,
        payload,
      });
      const fileBaseName = `${nodeGraph.name}-selection-${formatBundleTimestamp()}`;
      onClose();
      requestBundleExport(snippet, fileBaseName);
    } catch (error) {
      console.error("[canvas] 导出选中内容失败", error);
      toast.error("导出失败，请重试。");
      onClose();
    }
  }, [
    nodeGraph,
    selectedNodeIds,
    formatBundleTimestamp,
    onClose,
    requestBundleExport,
  ]);
  const handleImportAndInsert = useCallback(() => {
    if (isBundleImportRunning) {
      toast.info("已有导入任务进行中");
      onClose();
      return;
    }
    const position = target !== null && target !== undefined && target.type === "pane" ? target.position : undefined;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".iarts,.iarts.zip";
    input.onchange = () => {
      const file = (input.files !== null && input.files !== undefined ? input.files[0] : undefined) ?? null;
      input.remove();
      if (!file) {
        onClose();
        return;
      }
      onClose();
      if (onRequestBundleImportInsert !== null && onRequestBundleImportInsert !== undefined) {
        onRequestBundleImportInsert({ file, targetPosition: position });
      }
    };
    input.click();
  }, [isBundleImportRunning, target, onClose, onRequestBundleImportInsert]);
  const findAnnotationForTarget = useCallback(
    (id: string): string | null => {
      return findAnnotationIdForContextMenuTarget(nodeGraph, id);
    },
    [nodeGraph],
  );
  const handleCreateAnnotation = useCallback(() => {
    if (!target || target.type !== "pane") return;
    const created = createAnnotation(target.position);
    if (!created) {
      toast.error("没能创建注释，请重试");
      onClose();
      return;
    }
    selectAnnotations([created.id], "context-menu-create-annotation");
    toast.success("已创建注释");
    onClose();
  }, [target, createAnnotation, onClose, selectAnnotations]);
  const handleAddAnnotationForNode = useCallback(() => {
    if (!target || target.type !== "node") return;
    const existingId = findAnnotationForTarget(target.nodeId);
    if (existingId) {
      selectAnnotations([existingId], "context-menu-select-existing-annotation");
      toast.info("该节点已存在注释");
      onClose();
      return;
    }
    const created = addAnnotationForNode(target.nodeId);
    if (!created) {
      toast.error("没能添加注释，请重试");
    } else {
      selectAnnotations([created.id], "context-menu-add-node-annotation");
    }
    onClose();
  }, [
    target,
    addAnnotationForNode,
    findAnnotationForTarget,
    selectAnnotations,
    onClose,
  ]);
  const handleDeleteAnnotation = useCallback(() => {
    if (!target || target.type !== "annotation") return;
    removeAnnotation(target.annotationId);
    toast.success("已删除注释");
    onClose();
  }, [target, removeAnnotation, onClose]);
  const handleUnbindAnnotation = useCallback(() => {
    if (!target || target.type !== "annotation") return;
    unbindAnnotation(target.annotationId);
    toast.success("已解绑");
    onClose();
  }, [target, unbindAnnotation, onClose]);
  const handleStartBindAnnotation = useCallback(() => {
    if (!target || target.type !== "annotation") return;
    startAnnotationBinding(target.annotationId);
    toast.info("点击要绑定的节点，按 Esc 取消");
    onClose();
  }, [target, startAnnotationBinding, onClose]);
  const handleDeleteNodes = useCallback(() => {
    if (!target) return;
    if (target.type === "node") {
      const targetNode =
        nodeGraph !== null && nodeGraph !== undefined
          ? nodeGraph.nodes.find((n) => n.id === target.nodeId)
          : undefined;
      removeNodes([target.nodeId], undefined);
      toast.success("已删除节点");
      // Agent 目标不经本路径：菜单按 target 类型把 Agent 删除路由到 handleDeleteAgentNode
      //（删除必须经确认框，AG-CT-011）；此处 targetNode 仅保留判空防御。
      if (targetNode === undefined) {
        console.debug("[canvas:contextMenu] delete skipped: target node not found", {
          nodeId: target.nodeId,
        });
      }
    } else if (target.type === "selection") {
      deleteSelectedElements();
    }
    onClose();
  }, [target, nodeGraph, removeNodes, deleteSelectedElements, onClose]);

  // Agent 容器「解散」（AG-CT-010，spec：画布对象右键菜单.md §7.2b）：解除容器组织关系、
  // 成员原位保留、Agent 节点回落单节点形态、会话与消息历史完整保留；纯可逆（单条历史）。
  const handleDissolveAgentContainer = useCallback(() => {
    if (target === null) return;
    const containerNodeId = resolveContainerActionNodeId(target);
    if (containerNodeId === undefined) return;
    dissolveAgentContainer(containerNodeId);
    toast.success("容器已解散，Agent 和生成内容都保留");
    onClose();
  }, [target, dissolveAgentContainer, onClose]);

  // Agent「删除」（AG-CT-011）：任意 Agent 节点可删除，但必须先经确认框——本处理器
  // 只把待删集合写入确认请求通道（先关菜单再开框，与「删除组及全部成员」同模式），
  // 确认后由 AgentDeleteConfirmHost 走 removeNodes 同一删除咽喉（先在途终止再删除）。
  const handleDeleteAgentNode = useCallback(() => {
    if (target === null || target.type !== "node") return;
    onClose();
    requestAgentDeleteConfirm([target.nodeId]);
  }, [target, onClose, requestAgentDeleteConfirm]);
  const handleSelectAll = useCallback(() => {
    selectEntireCanvas("context-menu-select-all");
    onClose();
  }, [onClose, selectEntireCanvas]);
  const handleSaveCharacter = useCallback(() => {
    if (!target || target.type !== "node") return;
    openSaveDialog(target.nodeId);
    onClose();
  }, [target, openSaveDialog, onClose]);
  const handleCreateGroup = useCallback(() => {
    const nodeIds = target !== null && target.type === "selection" ? target.nodeIds : [];
    if (nodeIds.length < 2) {
      toast.warning("请至少选择两个节点");
      onClose();
      return;
    }
    const groupId = createGroup(nodeIds, undefined);
    if (groupId === null) {
      toast.warning("无法创建组：所选节点可能已经是组成员或为组节点");
      onClose();
      return;
    }
    selectNodes([groupId], "context-menu-create-group");
    toast.success("已创建节点组");
    onClose();
  }, [target, createGroup, selectNodes, onClose]);

  // 容器内整理共用实现（组与 Agent 容器同一动作同一反馈）：默认（单列）与网格（按列数）
  // 两个入口只在列数入参上不同，结果反馈与关闭语义必须一致，避免两个入口两套反馈。
  // 对象词按载体注入（组→本组、Agent→本容器），让两类容器上的反馈是同一句式。
  const runContainerAutoLayout = useCallback(
    async (containerId: string, columns: number | undefined) => {
      // 容器内整理作用域是该容器的显式成员，不直接涉及容器节点本身；
      // 但与全局整理保持同一调用口径，避免两个调用方两个口径的残留。
      // 拒绝判因必须读执行时刻的 store 状态而非渲染帧快照：子菜单按展开时刻捕获回调
      //（CanvasContextSubmenu 渲染 request.item），状态漂移后旧回调仍会被激活，
      // 读快照会把拒绝原因判错（如漂移为折叠后仍按旧快照报「还没有成员」）。
      const container = useCanvasStore
        .getState()
        .nodeGraph?.nodes.find((n) => n.id === containerId);
      const objectWord = resolveContainerObjectWord(container);
      const result = await autoLayoutContainer(containerId, {
        measuredSizeByNodeId,
        derivedSizeByNodeId,
        columns,
      });
      if (result === null) {
        // 拒绝必须分因给出路（菜单层双门只在渲染帧挡折叠/空成员，此 toast 承接
        // 菜单开启期间状态漂移的帧间路径）：折叠给「先展开」、空成员给实情，
        // 容器已不存在属防御兜底（无对象可指认，只给重试出路）。
        if (container !== undefined && isContainerCollapsed(container)) {
          toast.warning(`${objectWord}已折叠，先展开再试试`);
        } else if (container !== undefined) {
          toast.warning(`${objectWord}还没有成员，暂不能整理`);
        } else {
          toast.warning("整理没有生效，请重试");
        }
        onClose();
        return;
      }
      if (result.changedCount === 0) {
        // 防御性分支，当前不可达：placeGridFlow 对非空入参无条件产出全量位置
        //（layoutPrimitives.ts「网格摆放」），空成员已被 store 门拒绝（autoLayoutContainer
        // 对 members.length === 0 返回 null）。保留以防御未来算法产出空位置的变更；
        // 文案与全局整理「节点位置已经整齐，不用整理」保持唯一版本句式（仅注入对象词消歧）。
        toast.info(`${objectWord}节点位置已经整齐，不用整理`);
      } else {
        toast.success(`${objectWord}整理完成`);
      }
      onClose();
    },
    [autoLayoutContainer, measuredSizeByNodeId, derivedSizeByNodeId, onClose],
  );

  // 容器内整理的唯一入口是「整理本组 / 整理本容器」子菜单内网格行的某一列；
  // 列数由用户划过位置给出，行数由成员数与列数派生
  //（spec：画布自动布局算法.md「网格摆放」——行数是派生量，不作为入参，避免两个事实源）。
  // 列 1 即默认单列整理，因此不存在独立的「默认整理」入口（spec：画布对象右键菜单.md §7.3.1）。
  const handleAutoLayoutContainerGrid = useCallback(
    (columns: number) => {
      if (target === null) return;
      const containerNodeId = resolveContainerActionNodeId(target);
      if (containerNodeId === undefined) return;
      void runContainerAutoLayout(containerNodeId, columns);
    },
    [target, runContainerAutoLayout],
  );

  const handleUngroupNode = useCallback(() => {
    if (target === null) return;
    const containerNodeId = resolveContainerActionNodeId(target);
    if (containerNodeId === undefined) return;
    ungroupNode(containerNodeId);
    toast.success("已解散组");
    onClose();
  }, [target, ungroupNode, onClose]);

  // 「重命名组」（spec：画布对象右键菜单.md §7.3——焦点进入组名内联编辑）：
  // 走一次性请求通道，GroupNode 订阅到自身 id 时消费并进入编辑态。
  const handleRenameGroup = useCallback(() => {
    if (target === null) return;
    const containerNodeId = resolveContainerActionNodeId(target);
    if (containerNodeId === undefined) return;
    requestGroupRename(containerNodeId);
    onClose();
  }, [target, requestGroupRename, onClose]);

  const handleToggleGroupCollapse = useCallback(() => {
    if (target === null) return;
    const containerNodeId = resolveContainerActionNodeId(target);
    if (containerNodeId === undefined) return;
    toggleGroupCollapse(containerNodeId);
    onClose();
  }, [target, toggleGroupCollapse, onClose]);

  // 换色：点击色点即时生效，不关菜单（便于连续试色）；单条历史可撤销
  const handleSetGroupColor = useCallback(
    (color: string) => {
      if (target === null) return;
      const containerNodeId = resolveContainerActionNodeId(target);
      if (containerNodeId === undefined) return;
      setGroupColor(containerNodeId, color);
    },
    [target, setGroupColor],
  );

  // 「加入组…」popover 的受控请求：open 时携带候选 nodeIds。
  // 选择器选定后调 addNodesToGroup/moveNodesBetweenGroups（视候选是否已在其他组）。
  const [addToGroupRequest, setAddToGroupRequest] = useState<{
    candidateNodeIds: string[];
  } | null>(null);

  const handleAddToGroup = useCallback(() => {
    const nodeIds = target !== null && target.type === "selection" ? target.nodeIds : [];
    if (nodeIds.length === 0) {
      toast.warning("请先选择要加入组的节点");
      onClose();
      return;
    }
    onClose();
    // 关闭右键菜单后弹出 popover（避免层叠冲突）
    setAddToGroupRequest({ candidateNodeIds: nodeIds });
  }, [target, onClose]);

  const handleSelectTargetGroup = useCallback(
    (targetGroupId: string) => {
      if (addToGroupRequest === null) return;
      const candidateNodeIds = addToGroupRequest.candidateNodeIds;
      setAddToGroupRequest(null);
      // 区分加入 vs 跨组迁移：候选中含其他组成员时走 move（覆盖原 groupId）
      // 实现层复用同一 action：moveNodesBetweenGroups 对自由节点等效加入，对组成员等效迁移。
      // 但为避免把已是目标组成员的节点重复写入，仍走 addNodesToGroup 的候选过滤。
      // 简化：直接调 addNodesToGroup，它内部 filterAddCandidates 会排除已是目标组成员的节点；
      // 对属于其他组的成员，addNodesToGroup 同样直接覆盖 groupId（迁移语义）。
      addNodesToGroup(candidateNodeIds, targetGroupId);
      toast.success("已加入组");
    },
    [addToGroupRequest, addNodesToGroup],
  );

  const handleCancelAddToGroup = useCallback(() => {
    setAddToGroupRequest(null);
  }, []);

  const handleRemoveFromGroup = useCallback(() => {
    const nodeIds = target !== null && target.type === "selection" ? target.nodeIds : [];
    if (nodeIds.length === 0) {
      toast.warning("请先选择要从组中移除的节点");
      onClose();
      return;
    }
    removeNodesFromGroup(nodeIds);
    toast.success("已从组中移除");
    onClose();
  }, [target, removeNodesFromGroup, onClose]);

  // 「删除组及全部成员」确认框受控请求（spec：画布对象右键菜单.md §7.3——
  // 显式连删必须弹确认框，列出组成员数量，红色确认按钮；确认后仍可撤销）。
  const [deleteGroupConfirmRequest, setDeleteGroupConfirmRequest] = useState<{
    groupId: string;
    groupName: string;
    memberCount: number;
  } | null>(null);

  const handleDeleteGroupWithMembers = useCallback(() => {
    if (target === null) return;
    const groupId = resolveContainerActionNodeId(target);
    if (groupId === undefined) return;
    const groupNode = nodeGraph?.nodes.find((n) => n.id === groupId);
    if (!groupNode || groupNode.type !== "group") return;
    const memberCount = nodeGraph
      ? nodeGraph.nodes.filter(
          (n) => n.type !== "group" && n.groupId === groupId,
        ).length
      : 0;
    const groupName =
      typeof (groupNode.data as { name?: string | undefined }).name === "string"
        ? (groupNode.data as { name: string }).name
        : "未命名组";
    onClose();
    // 先关右键菜单再开确认框（避免层叠冲突，与「加入组…」popover 同模式）
    setDeleteGroupConfirmRequest({ groupId, groupName, memberCount });
  }, [target, nodeGraph, onClose]);

  const handleConfirmDeleteGroupWithMembers = useCallback(() => {
    if (deleteGroupConfirmRequest === null) return;
    const request = deleteGroupConfirmRequest;
    setDeleteGroupConfirmRequest(null);
    removeNodes([request.groupId], { deleteGroupMembers: true });
    toast.success("已删除组及其全部成员");
  }, [deleteGroupConfirmRequest, removeNodes]);

  const handleCancelDeleteGroupWithMembers = useCallback(() => {
    setDeleteGroupConfirmRequest(null);
  }, []);

  // 「删除失败节点」确认框受控请求（spec：画布对象右键菜单.md §7.6——
  // 空白区菜单的清理动作必须弹确认框并列出将删除的节点数，确认后仍可撤销）。
  // 请求携带请求时刻求得的 nodeIds：确认框弹出的数量与随后实际删除的集合同源，
  // 不在确认时二次收集（避免确认框显示的数量与删除集合脱钩）。
  const [deleteFailedNodesConfirmRequest, setDeleteFailedNodesConfirmRequest] =
    useState<{ nodeIds: string[]; count: number } | null>(null);

  const handleDeleteFailedNodes = useCallback(() => {
    const nodeIds = collectFailedTaskNodeIds(nodeGraph);
    if (nodeIds.length === 0) {
      toast.info("画布上还没有失败的任务");
      onClose();
      return;
    }
    onClose();
    // 先关右键菜单再开确认框（与「删除组及全部成员」同模式，避免层叠冲突）
    setDeleteFailedNodesConfirmRequest({ nodeIds, count: nodeIds.length });
  }, [nodeGraph, onClose]);

  const handleConfirmDeleteFailedNodes = useCallback(() => {
    if (deleteFailedNodesConfirmRequest === null) return;
    const request = deleteFailedNodesConfirmRequest;
    setDeleteFailedNodesConfirmRequest(null);
    removeNodes(request.nodeIds, undefined);
    toast.success(`已删除 ${request.count} 个失败节点，可撤销`);
  }, [deleteFailedNodesConfirmRequest, removeNodes]);

  const handleCancelDeleteFailedNodes = useCallback(() => {
    setDeleteFailedNodesConfirmRequest(null);
  }, []);

  // 添加到打包区（spec「右侧工作区与打包区服务」）：node/selection 两类目标共用，
  // 候选判定与去重反馈收口在 features/package-area/ops。
  const handleAddToPackageArea = useCallback(() => {
    if (!nodeGraph) {
      toast.error("画布还没准备好，暂时无法加入打包区");
      onClose();
      return;
    }
    const targetNodeIds =
      target === null || target === undefined
        ? []
        : target.type === "node"
          ? [target.nodeId]
          : target.type === "selection"
            ? target.nodeIds
            : [];
    const nodes = targetNodeIds
      .map((id) => nodeGraph.nodes.find((node) => node.id === id))
      .filter((node): node is NonNullable<typeof node> => node !== undefined);
    if (nodes.length === 0) {
      onClose();
      return;
    }
    void addNodesToPackageArea(nodes);
    onClose();
  }, [nodeGraph, target, onClose]);

  return {
    nodeGraph,
    selectedNodeIds,
    mediaAssets: projectMediaAssets,
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
    handleAddToPackageArea,
    addToGroupRequest,
    handleSelectTargetGroup,
    handleCancelAddToGroup,
    deleteGroupConfirmRequest,
    handleConfirmDeleteGroupWithMembers,
    handleCancelDeleteGroupWithMembers,
    deleteFailedNodesConfirmRequest,
    handleDeleteFailedNodes,
    handleConfirmDeleteFailedNodes,
    handleCancelDeleteFailedNodes,
    onClose,
  };
}

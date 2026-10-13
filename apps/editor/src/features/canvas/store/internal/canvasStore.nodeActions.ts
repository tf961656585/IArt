import type { GraphNode } from '../../types';
import { nodeRegistry } from '../../nodes/registry';
import { trackCurrentProjectNodeTypeUsage } from '../../storage';
import { requireTrustedResolvedExpandInlineParamsOnStartup } from '@/client/utils/hubCanvasStartupConfig';
import { applyEnsureResultToNodeGraph, ensureNodeCompanions, expandRemovalWithCompanions, expandPositionUpdatesWithCompanions } from '../../services/nodeCompanion/nodeCompanionManager';
import { expandPositionUpdatesWithGroup, expandRemovalWithGroup, getGroupMembers, isContainerNode, canBeMemberOf } from '../../services/groupMembership';
import { computeGroupExpandedPosition } from '../../services/groupGeometry';
import { isCopyableNodeForClipboard } from '../../clipboard/selectionPayload';
import { isAnnotationBinding } from '../../types/annotation';
import { extractTaskIdsFromNodeData, updateTaskIdIndex } from './canvasStore.shared';
import { markNodeDirty, markNodeRemoved, markNodesDirty } from './canvasStore.persistence';
import { ensureNodeGraphMeta, type AddNodeMembership, type CanvasStoreGet, type CanvasStoreSet, type NodeGraphActions } from './canvasStore.core';
import { isElectronDev } from '@/client/utils/runtimeFlags';
import { produceWithPatches } from 'immer';
import { createHistoryEntryFromGraph, savePatchToHistoryState, shouldCreateSnapshotCheckpoint } from './canvasStore.history';
import { applyUpdateNodeDataToState } from './canvasStore.updateNodeData';
import { cleanupSelectionAfterRemoval } from './canvasStore.selectionCleanup';
import { runNodeRemovalPreflight } from './nodeRemovalPreflight';

export const createCanvasNodeActions = (set: CanvasStoreSet, get: CanvasStoreGet): Pick<NodeGraphActions, 'addNode' | 'updateNode' | 'updateNodeData' | 'updateNodeDataBatch' | 'updateNodePosition' | 'updateNodePositionsBatch' | 'removeNode' | 'removeNodes' | 'replaceNode' | 'dissolveAgentContainer' | 'duplicateNode'> => ({
    addNode: (key, position, customData, membership) => {
      const definition = nodeRegistry.get(key);
      const hasExplicitInlineControlsCollapsed = typeof (customData !== null && customData !== undefined ? (customData as { inlineControlsCollapsed: unknown | undefined }).inlineControlsCollapsed : undefined) === 'boolean';
      const nextCustomData =
        (definition !== null && definition !== undefined ? definition.type : undefined) === 'model' && !hasExplicitInlineControlsCollapsed
          ? {
              ...(customData ?? {}),
              inlineControlsCollapsed: !requireTrustedResolvedExpandInlineParamsOnStartup(),
            }
          : customData;

      const node = nodeRegistry.createNode(key, position, nextCustomData);
      if (!node) return null;

      // 创建即入容器（成员关系指定，AG-CT-001 产物自动包含接口）：
      // 目标必须是现存容器节点且符合成员资格矩阵；否则节点照常创建为自由节点并记 debug 留痕。
      if (membership !== undefined) {
        const container = get().nodeGraph?.nodes.find((n) => n.id === membership.groupId);
        if (container !== undefined && isContainerNode(container) && canBeMemberOf(node, container)) {
          node.groupId = container.id;
        } else {
          console.debug('[canvas:addNode] membership rejected，节点按自由节点创建', {
            nodeId: node.id,
            targetContainerId: membership.groupId,
            targetIsContainer: container !== undefined && isContainerNode(container),
          });
        }
      }

      let addedNodeIds: string[] = [];
      set((state) => {
        if (state.nodeGraph) {
          ensureNodeGraphMeta(state.nodeGraph);
          state.nodeGraph.nodes.push(node);

          const companionResult = ensureNodeCompanions(state.nodeGraph, [node], {
            reason: 'create',
            calculateExecutePlacement: () => undefined,
          });
          applyEnsureResultToNodeGraph(state.nodeGraph, companionResult);

          state.nodeGraph.meta.updatedAt = new Date().toISOString();
          markNodeDirty(state, node.id);
          const newNodeIds = [node.id, ...companionResult.nodesToAdd.map(n => n.id)];
          addedNodeIds = newNodeIds;
          for (const nid of newNodeIds) {
            const addedNode = state.nodeGraph.nodes.find((n: GraphNode) => n.id === nid);
            if (addedNode) {
              updateTaskIdIndex(state.taskIdIndex, [], extractTaskIdsFromNodeData(addedNode.data), nid);
            }
          }
          for (const companionNode of companionResult.nodesToAdd) {
            markNodeDirty(state, companionNode.id);
          }
          state.structureRevision += 1;
        }
      });
      if (!get().historyBatchActive) {
        get().saveToHistory();
      }
      // Layout Model 增量重算：节点结构变化（新增）触发（spec：画布启动性能与Layout-Model架构.md
      // 「重新计算的触发条件」节「节点结构变化」）。
      if (addedNodeIds.length > 0) {
        get().recomputeLayoutModelForNodes(addedNodeIds);
      }

      const nodeKey = typeof key === 'string' ? key.trim() : '';
      if (nodeKey) {
        void trackCurrentProjectNodeTypeUsage([nodeKey]);
      }
      return node;
    },

    updateNode: (nodeId, updates) => {
      set((state) => {
        if (state.nodeGraph) {
          ensureNodeGraphMeta(state.nodeGraph);
          const index = state.nodeGraph.nodes.findIndex((n) => n.id === nodeId);
          const existingNode = state.nodeGraph.nodes[index];
          if (existingNode) {
            state.nodeGraph.nodes[index] = { ...existingNode, ...updates };
            state.nodeGraph.meta.updatedAt = new Date().toISOString();
            markNodeDirty(state, nodeId);
            state.structureRevision += 1;
          }
        }
      });
    },

    updateNodeData: (nodeId, data, via) => {
      const debugEnabled = isElectronDev();
      const debugTrace = (() => {
        if (!debugEnabled) return undefined;
        try {
          return new Error();
        } catch {
          return undefined;
        }
      })();
      const viaTag = typeof via === 'string' && via.trim() ? via : undefined;

      set((state) => {
        applyUpdateNodeDataToState(state, nodeId, data, {
          debugEnabled,
          debugTrace,
          viaTag,
        });
      });

      // Layout Model 增量重算：节点内容变化触发（spec：「节点内容变化」slot 增减、form 字段、折叠态）。
      // recomputeLayoutModelForNodes 内部用 semanticKey 跳过无变化节点的写入，no-op 调用成本可控。
      get().recomputeLayoutModelForNodes([nodeId]);
    },

    updateNodeDataBatch: (payload, via) => {
      if (!payload.length) return;
      const debugEnabled = isElectronDev();
      const debugTrace = (() => {
        if (!debugEnabled) return undefined;
        try {
          return new Error();
        } catch {
          return undefined;
        }
      })();
      const viaTag = typeof via === 'string' && via.trim() ? via : undefined;

      const changedNodeIds: string[] = [];
      set((state) => {
        for (const item of payload) {
          applyUpdateNodeDataToState(state, item.id, item.data, {
            debugEnabled,
            debugTrace,
            viaTag,
          });
          changedNodeIds.push(item.id);
        }
      });

      // Layout Model 增量重算：批量节点内容变化触发。
      if (changedNodeIds.length > 0) {
        get().recomputeLayoutModelForNodes(changedNodeIds);
      }
    },

    updateNodePosition: (nodeId, position) => {
      set((state) => {
        if (state.nodeGraph) {
          const node = state.nodeGraph.nodes.find((n) => n.id === nodeId);
          if (node) {
            node.position = position;
            state.positionRevision += 1;
            markNodeDirty(state, nodeId);
            state.nodeGraph.meta.updatedAt = new Date().toISOString();
          }
        }
      });
    },

    updateNodePositionsBatch: (payload) => {
      if (!payload.length) return;
      const currentGraph = get().nodeGraph;
      if (!currentGraph) return;

      const companionExpanded = expandPositionUpdatesWithCompanions(currentGraph, payload);
      const expandedPayload = expandPositionUpdatesWithGroup(currentGraph, companionExpanded);
      const positionMap = new Map(expandedPayload.map((item) => [item.id, item.position]));

      const [nextNodes, patches, inversePatches] = produceWithPatches(currentGraph.nodes, (draftNodes) => {
        for (const node of draftNodes) {
          const nextPos = positionMap.get(node.id);
          if (nextPos) {
            if (node.position.x === nextPos.x && node.position.y === nextPos.y) continue;
            node.position = nextPos;
          }
        }

        // 成员位移后，重算受影响展开态容器（组 | Agent 容器）的 position，
        // 保持 store 容器 position 与成员包围盒一致。
        // 否则下次拖容器时 expandPositionUpdatesWithGroup 基于过期 store position 算位移，导致成员错位。
        // position 只依赖成员 position（不依赖 size），用共享算法 owner 保证与投影层 derived 一致。
        // 两层传播（组 > Agent 容器 > 叶）下，两类容器都会因成员位移进入重算集合。
        const movedMemberContainerIds = new Set<string>();
        for (const node of draftNodes) {
          if (node.type === 'group') continue;
          if (!positionMap.has(node.id)) continue;
          if (typeof node.groupId !== 'string' || node.groupId.length === 0) continue;
          movedMemberContainerIds.add(node.groupId);
        }
        if (movedMemberContainerIds.size > 0) {
          // 按容器 id 收集成员当前 position（位移已应用）
          const membersByContainerId = new Map<string, Array<{ position: { x: number; y: number }; size: null }>>();
          for (const node of draftNodes) {
            if (node.type === 'group') continue;
            if (typeof node.groupId !== 'string' || node.groupId.length === 0) continue;
            if (!movedMemberContainerIds.has(node.groupId)) continue;
            const list = membersByContainerId.get(node.groupId);
            if (list) {
              list.push({ position: node.position, size: null });
            } else {
              membersByContainerId.set(node.groupId, [{ position: node.position, size: null }]);
            }
          }
          for (const node of draftNodes) {
            if (!isContainerNode(node)) continue;
            if (!movedMemberContainerIds.has(node.id)) continue;
            const containerData = node.data as { collapsed: boolean | undefined };
            // 折叠态 position 不随成员变化（成员已隐藏，无包围盒可派生）
            if (containerData.collapsed === true) continue;
            const members = membersByContainerId.get(node.id);
            if (!members || members.length === 0) continue;
            const derivedPosition = computeGroupExpandedPosition(members);
            if (derivedPosition === null) continue;
            if (node.position.x === derivedPosition.x && node.position.y === derivedPosition.y) continue;
            node.position = derivedPosition;
          }
        }
      });

      if (patches.length === 0) return;

      const touchedNodeIds: string[] = [];
      const changedIndexSet = new Set<number>();
      for (const patch of patches) {
        const seg = patch.path[0];
        if (typeof seg === 'number') changedIndexSet.add(seg);
      }
      for (const idx of changedIndexSet) {
        const node = idx < nextNodes.length ? nextNodes[idx] : undefined;
        if (node) touchedNodeIds.push(node.id);
      }

      const usePatchEntry = !shouldCreateSnapshotCheckpoint(get());
      set((state) => {
        if (!state.nodeGraph) return;
        state.nodeGraph.nodes = nextNodes as GraphNode[];
        markNodesDirty(state, touchedNodeIds);
        state.positionRevision += 1;
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        if (usePatchEntry) {
          savePatchToHistoryState(state, patches, inversePatches, 'position-batch');
        }
      });
      if (!usePatchEntry) {
        get().saveToHistory();
      }
    },

    // 声明尺寸是 UI 会话态，不应触发 graph dirty/meta 更新时间或保存链路。
    // 删除前置钩子只在 removeNodes 咽喉调用一次：本方法委托它，不重复触发。
    removeNode: (nodeId, options) => {
      get().removeNodes([nodeId], options);
    },

    removeNodes: (nodeIds, options) => {
      const deleteGroupMembers = options !== undefined && options.deleteGroupMembers;
      // 删除咽喉的无环前置钩子（同步，先于展开 companion / 解散组 / 改图）：
      // 「删除 Agent 节点 → 先在途终止再删除」由注册方（features/agent）在此落实。
      // removeNode 委托本方法，所以选中态工具栏 / 键盘 / 右键菜单 / ReactFlow / 组解散
      // 五条入口全部经这一处，不存在绕过咽喉的删除路径。
      runNodeRemovalPreflight(nodeIds);
      // 展开会带出请求集之外的节点（组连删成员、companion 连带）：对扩展新增的节点补跑
      // 一次钩子，保证被连带删除的 Agent 节点同样「先在途终止再删除」。
      // 展开是纯函数且不改图，补跑仍在任何图数据变更之前。
      const preflightGraph = get().nodeGraph;
      if (preflightGraph) {
        const requestedIdSet = new Set(nodeIds);
        const expansionAddedIds = expandRemovalWithGroup(
          preflightGraph,
          expandRemovalWithCompanions(preflightGraph, nodeIds),
          { deleteGroupMembers },
        ).filter((nodeId) => !requestedIdSet.has(nodeId));
        if (expansionAddedIds.length > 0) {
          runNodeRemovalPreflight(expansionAddedIds);
        }
      }
      // 删除 Agent（AG-CT-011）判据：请求删除集（非级联扩展）直接命中 Agent 节点。
      // 组连删经扩展带入的 Agent 容器不算——组连删流有自身确认且确认后仍可撤销
      //（spec：画布对象右键菜单.md §7.3），其既有历史行为不动（本批不裁）。
      const directAgentDelete = (() => {
        const graph = get().nodeGraph;
        if (!graph) return false;
        for (const id of nodeIds) {
          const node = graph.nodes.find((n) => n.id === id);
          if (node && node.type === 'agent') return true;
        }
        return false;
      })();
      let dissolvedContainerIds: string[] = [];
      set((state) => {
        const nodeGraph = state.nodeGraph;
        if (nodeGraph) {
          const companionExpandedIds = expandRemovalWithCompanions(nodeGraph, nodeIds);
          const expandedNodeIds = expandRemovalWithGroup(nodeGraph, companionExpandedIds, {
            deleteGroupMembers,
          });
          const nodeIdSet = new Set(expandedNodeIds);
          for (const nodeId of expandedNodeIds) {
            if (state.ui.desiredSizeByNodeId[nodeId]) {
              delete state.ui.desiredSizeByNodeId[nodeId];
            }
            // Layout Model 同步清理：被删除节点的 layoutModelByNodeId 条目也清空。
            if (state.ui.layoutModelByNodeId[nodeId]) {
              delete state.ui.layoutModelByNodeId[nodeId];
            }
          }

          for (const nodeId of expandedNodeIds) {
            const node = nodeGraph.nodes.find((n: GraphNode) => n.id === nodeId);
            if (node) {
              updateTaskIdIndex(state.taskIdIndex, extractTaskIdsFromNodeData(node.data), [], nodeId);
            }
          }

          // 解散（删除咽喉范式，AG-CN-005 / AG-CN-007）：删除集中每个容器节点（组 | Agent 容器），
          // 指向它的、自身不在删除集内的成员，在节点删除的同一存储写入路径内解除 groupId
          //（成员保留为自由节点，避免悬空引用；不依赖外键级联）。
          // Agent 容器连删恒不适用：即便 deleteGroupMembers=true 经组连删把 Agent 容器一并删除，
          // 其成员也不在删除集内（expandRemovalWithGroup 不对 Agent 容器展开），照常走解散保留。
          // 必须在 nodes filter 之前完成，否则成员节点已被过滤掉（连删）或容器节点已删除后无法回查。
          {
            const removedContainerIds = new Set<string>();
            for (const id of expandedNodeIds) {
              const node = nodeGraph.nodes.find((n: GraphNode) => n.id === id);
              if (node && isContainerNode(node)) {
                removedContainerIds.add(id);
              }
            }
            if (removedContainerIds.size > 0) {
              const dissolvedMemberIds: string[] = [];
              for (const node of nodeGraph.nodes) {
                if (typeof node.groupId !== "string" || node.groupId.length === 0) continue;
                if (!removedContainerIds.has(node.groupId)) continue;
                // 成员本身也在删除集（组连删场景）：随删除一并消失，无需解除
                if (nodeIdSet.has(node.id)) continue;
                node.groupId = undefined;
                dissolvedMemberIds.push(node.id);
              }
              if (dissolvedMemberIds.length > 0) {
                markNodesDirty(state, dissolvedMemberIds);
              }
              // 记录被删除的容器节点 id（含解散场景），用于 set 回调外的 Layout Model 重算。
              dissolvedContainerIds = [...removedContainerIds];
            }
          }

          // 画板模式：任何节点都可以批量删除
          nodeGraph.nodes = nodeGraph.nodes.filter((n) => !nodeIdSet.has(n.id));
          // 收集级联删除的注释 ID
          let removedAnnotationIds: string[] = [];
          if (Array.isArray(nodeGraph.annotations) && nodeGraph.annotations.length > 0) {
            const beforeAnnotationIds = new Set(nodeGraph.annotations.map((ann) => ann.id));
            nodeGraph.annotations = nodeGraph.annotations.filter((ann) => {
              const binding = ann.binding;
              if (!isAnnotationBinding(binding)) return true;
              if (binding.type === 'node' && nodeIdSet.has(binding.nodeId)) return false;
              return true;
            });
            const afterAnnotationIdSet = new Set(nodeGraph.annotations.map((ann) => ann.id));
            removedAnnotationIds = [...beforeAnnotationIds].filter((id) => !afterAnnotationIdSet.has(id));
          }

          // 统一选中清理
          cleanupSelectionAfterRemoval(state, {
            removedNodeIds: expandedNodeIds,
            removedAnnotationIds,
          });

          nodeGraph.meta.updatedAt = new Date().toISOString();
          for (const nodeId of nodeIdSet) {
            markNodeRemoved(state, nodeId);
          }
          state.structureRevision += 1;
        }
      });
      if (directAgentDelete) {
        // 删除 Agent（AG-CT-011）：不提供撤销兜底。历史栈是全图快照栈——仅跳过入栈不够：
        // 此前条目的快照仍含被删 Agent，撤销会复活出会话已被物理清除的悬空节点
        //（AG-CN 禁止项：禁止删除节点时保留悬空会话数据）。
        // 故以删除后状态重建唯一基线条目并清空此前历史，撤销不可达（硬切）。
        const graphAfterDelete = get().nodeGraph;
        if (graphAfterDelete) {
          const entry = createHistoryEntryFromGraph(graphAfterDelete);
          set((state) => {
            state.history = [entry];
            state.historyIndex = 0;
            state.deferredHistoryBaseline = null;
          });
        }
      } else if (!get().historyBatchActive) {
        get().saveToHistory();
      }
      // Layout Model 增量重算：节点结构变化（删除/解散）触发受影响容器重算。
      // 被删除节点的 layoutModelByNodeId 条目已在 set 回调内清理。
      // 解散场景：被解散的容器节点已不在图内，但成员 groupId 改变的剩余容器需要重算派生尺寸。
      // 简单起见这里触发全图重算（spec L344 实现层裁定）。
      if (dissolvedContainerIds.length > 0) {
        get().recomputeLayoutModelFull();
      }
    },

    // 原位替换节点（AG-CN-017 替换继任保持成员身份；docs/editor/画布注释.md「替换继任」）。
    // 构造性保证：预检整体拒绝（画布零改动）、membership 继承/覆盖走 addNode 通道、
    // 全部继任建成功才删 source（不存在「源已删、新未建」）、自开自关历史批一次替换一条历史。
    replaceNode: (sourceId, creations, membershipOverride) => {
      const graph = get().nodeGraph;
      if (!graph) {
        console.debug('[canvas:replaceNode] rejected: nodeGraph not loaded', { sourceId });
        return [];
      }
      const source = graph.nodes.find((n) => n.id === sourceId);
      if (!source) {
        console.debug('[canvas:replaceNode] rejected: source node not found', { sourceId });
        return [];
      }
      // 容器节点（组 | Agent 容器）不是可被继任替换的成员节点：整体拒绝。
      if (isContainerNode(source)) {
        console.debug('[canvas:replaceNode] rejected: source is a container node', {
          sourceId,
          sourceType: source.type,
        });
        return [];
      }
      if (creations.length === 0) {
        console.debug('[canvas:replaceNode] rejected: empty creations', { sourceId });
        return [];
      }
      for (const creation of creations) {
        if (nodeRegistry.get(creation.key) === undefined) {
          console.debug('[canvas:replaceNode] rejected: unknown node key', {
            sourceId,
            unknownKey: creation.key,
          });
          return [];
        }
      }

      // membership 判定：override 优先；否则继承 source 的容器归属（undefined → 自由节点）。
      // 每个继任节点都经 addNode 的 membership 通道创建（canBeMemberOf 校验 + 降级留痕），
      // 不裸写 groupId。
      const membership: AddNodeMembership | undefined =
        membershipOverride ??
        (typeof source.groupId === 'string' && source.groupId.length > 0
          ? { groupId: source.groupId }
          : undefined);

      // 自开自关历史批（createGroup / dissolveAgentContainer 同款模式）：
      // 一次替换 = 单条全图快照，undo 一步回到替换前、redo 一步恢复。
      const preActive = get().historyBatchActive;
      set((state) => {
        state.historyBatchActive = true;
      });

      const createdNodes: GraphNode[] = [];
      for (const creation of creations) {
        const node = get().addNode(creation.key, creation.position, creation.data, membership);
        if (node) createdNodes.push(node);
      }

      if (createdNodes.length === creations.length && createdNodes.length > 0) {
        // 绑定注释改绑首个继任节点（替换继任语义，不适用级联删除；注释位置由被绑对象
        // 派生自动跟随）。复用 updateAnnotation 的注释变更机制（变化守卫 + markGraphDirty
        // + structureRevision；historyBatchActive 下不落独立历史，并入替换那条）。
        const firstCreatedId = createdNodes[0]?.id;
        const nextGraph = get().nodeGraph;
        const boundAnnotationIds =
          nextGraph && Array.isArray(nextGraph.annotations)
            ? nextGraph.annotations
                .filter((ann) => {
                  const binding = ann.binding;
                  return (
                    isAnnotationBinding(binding) &&
                    binding.type === 'node' &&
                    binding.nodeId === sourceId
                  );
                })
                .map((ann) => ann.id)
            : [];
        if (firstCreatedId !== undefined) {
          for (const annotationId of boundAnnotationIds) {
            get().updateAnnotation(annotationId, { binding: { type: 'node', nodeId: firstCreatedId } });
          }
          if (boundAnnotationIds.length > 0) {
            console.debug('[canvas:replaceNode] bound annotations rebound to first successor', {
              sourceId,
              successorId: firstCreatedId,
              annotationCount: boundAnnotationIds.length,
            });
          }
        }
        // 最后移除 source（继任已在、注释已改绑；不连删组员）。
        get().removeNodes([sourceId], { deleteGroupMembers: false });
      } else {
        // 防御性分支（预检已挡，理论上不可达）：保留已建节点与 source，禁止出现
        //「源已删、新未建」状态。
        console.debug('[canvas:replaceNode] partial creation failure: source kept', {
          sourceId,
          createdCount: createdNodes.length,
          requestedCount: creations.length,
        });
      }

      if (!preActive) {
        set((state) => {
          state.historyBatchActive = false;
        });
        get().saveToHistory();
      }

      return createdNodes;
    },

    // 解散 Agent 容器（AG-CT-010）：纯「退出容器形态」，与删除是两个独立动作。
    // 实现为一次成员关系变更事务：全部成员 groupId 清空（原位保留）+ 不删 Agent 节点
    //（随成员清空回落单节点形态 240×64，容器形态由成员数派生）+ 不触碰会话
    //（不走删除咽喉前置钩子，不触发会话清理、不终止在途）。
    // 历史沿用成员关系变更条目形态（addNodesToGroup/removeNodesFromGroup 同款
    // historyBatchActive 合批模式）：外层未开批则自开自关、末尾单次 saveToHistory，
    // 一次解散一条历史，undo 整体恢复成员关系与成员位置。
    dissolveAgentContainer: (nodeId) => {
      const { nodeGraph } = get();
      if (!nodeGraph) {
        console.debug('[canvas:dissolveAgentContainer] skipped: nodeGraph not loaded', { nodeId });
        return false;
      }
      const container = nodeGraph.nodes.find((n) => n.id === nodeId);
      if (!container || container.type !== 'agent') {
        console.debug('[canvas:dissolveAgentContainer] skipped: target is not an agent node', {
          nodeId,
          targetType: container?.type,
        });
        return false;
      }
      // 解散仅对容器形态（有成员）可用：无成员已呈单节点形态、无组织关系可解除
      const members = getGroupMembers(nodeGraph, nodeId);
      if (members.length === 0) {
        console.debug('[canvas:dissolveAgentContainer] skipped: agent node has no members (single-node form)', {
          nodeId,
        });
        return false;
      }
      const memberIds = members.map((m) => m.id);

      const preActive = get().historyBatchActive;
      set((state) => {
        state.historyBatchActive = true;
      });

      set((state) => {
        if (!state.nodeGraph) return;
        // 成员 groupId 清空（复用删除咽喉的解散清成员逻辑形态，但不删任何节点）
        for (const node of state.nodeGraph.nodes) {
          if (!memberIds.includes(node.id)) continue;
          node.groupId = undefined;
        }
        markNodesDirty(state, memberIds);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        state.structureRevision += 1;
      });

      if (!preActive) {
        set((state) => {
          state.historyBatchActive = false;
        });
        get().saveToHistory();
      }
      // 派生尺寸重算：Agent 节点随成员清空由容器形态回落单节点形态（240×64），
      // 全量重算与 removeNodes 的解散分支同口径（含折叠态等派生状态的失效）。
      get().recomputeLayoutModelFull();
      return true;
    },

    duplicateNode: (nodeId) => {
      const { nodeGraph } = get();
      if (!nodeGraph) return null;

      const sourceNode = nodeGraph.nodes.find((n) => n.id === nodeId);
      if (!sourceNode) {
        return null;
      }
      // 组节点不可复制（copyable=false）；组只能通过多选右键创建，duplicate 会产生无成员的空组。
      // 其余按注册表声明裁决：任务/Agent 节点同声明 copyable=false（唯一投影 / 会话 1:1）。
      if (sourceNode.type === 'group' || !isCopyableNodeForClipboard(sourceNode)) {
        return null;
      }

      const clonedData = sourceNode.data;

      const newNode: GraphNode = {
        ...sourceNode,
        id: `node_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        position: {
          x: sourceNode.position.x + 50,
          y: sourceNode.position.y + 50,
        },
        data: clonedData,
      };

      set((state) => {
        if (state.nodeGraph) {
          state.nodeGraph.nodes.push(newNode);

          const companionResult = ensureNodeCompanions(state.nodeGraph, [newNode], {
            reason: 'create',
            calculateExecutePlacement: () => undefined,
          });
          applyEnsureResultToNodeGraph(state.nodeGraph, companionResult);

          state.nodeGraph.meta.updatedAt = new Date().toISOString();
          markNodeDirty(state, newNode.id);
          const duplicatedNodeIds = [newNode.id, ...companionResult.nodesToAdd.map(n => n.id)];
          for (const nid of duplicatedNodeIds) {
            const addedNode = state.nodeGraph.nodes.find((n: GraphNode) => n.id === nid);
            if (addedNode) {
              updateTaskIdIndex(state.taskIdIndex, [], extractTaskIdsFromNodeData(addedNode.data), nid);
            }
          }
          for (const companionNode of companionResult.nodesToAdd) {
            markNodeDirty(state, companionNode.id);
          }
          state.structureRevision += 1;
        }
      });
      get().saveToHistory();

      if (typeof newNode.type === 'string' && newNode.type.trim()) {
        void trackCurrentProjectNodeTypeUsage([newNode.type.trim()]);
      }
      return newNode;
    },
});

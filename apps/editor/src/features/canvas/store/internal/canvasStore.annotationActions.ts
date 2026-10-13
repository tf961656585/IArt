import type { CanvasAnnotation } from '../../types';
import { DEFAULT_ANNOTATION_SIZE, DEFAULT_ANNOTATION_STYLE, generateAnnotationId, isAnnotationBinding, type AnnotationBinding } from '../../types/annotation';
import { clampAnnotationSize, resolveAnnotationPosition } from '../../utils/annotationLayout';
import { markGraphDirty } from './canvasStore.persistence';
import { ensureNodeGraphMeta, type CanvasStoreGet, type CanvasStoreSet, type NodeGraphActions } from './canvasStore.core';
import { cleanupSelectionAfterRemoval } from './canvasStore.selectionCleanup';

const isSameBinding = (a: AnnotationBinding, b: AnnotationBinding): boolean => {
  if (!isAnnotationBinding(a) || !isAnnotationBinding(b)) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'node' && b.type === 'node') return a.nodeId === b.nodeId;
  return true; // 两者都是 free
};

export const createCanvasAnnotationActions = (set: CanvasStoreSet, get: CanvasStoreGet): Pick<NodeGraphActions, 'createAnnotation' | 'addAnnotationForNode' | 'insertAnnotationsBatch' | 'updateAnnotation' | 'updateAnnotationContent' | 'updateAnnotationPosition' | 'updateAnnotationSize' | 'removeAnnotation' | 'unbindAnnotation' | 'startAnnotationBinding' | 'cancelAnnotationBinding' | 'bindAnnotation'> => ({
    createAnnotation: (position) => {
      const snapshot = get().nodeGraph;
      if (!snapshot) return null;

      const annotation: CanvasAnnotation = {
        id: generateAnnotationId(),
        content: '',
        position,
        size: { ...DEFAULT_ANNOTATION_SIZE },
        binding: { type: 'free' },
        style: { ...DEFAULT_ANNOTATION_STYLE },
      };

      set((state) => {
        if (!state.nodeGraph) return;
        ensureNodeGraphMeta(state.nodeGraph);
        if (!Array.isArray(state.nodeGraph.annotations)) {
          state.nodeGraph.annotations = [];
        }
        state.nodeGraph.annotations.push(annotation);

        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
      });

      get().saveToHistory();
      // 创建即进入编辑态：editingAnnotationId 属 UI 会话态，不入历史
      get().setEditingAnnotation(annotation.id);
      return annotation;
    },

    addAnnotationForNode: (nodeId) => {
      const snapshot = get().nodeGraph;
      if (!snapshot) return null;
      const node = snapshot.nodes.find((n) => n.id === nodeId);
      if (!node) return null;

      const existing = (snapshot.annotations ?? []).find((ann) => {
        const binding = ann.binding;
        return isAnnotationBinding(binding) && binding.type === 'node' && binding.nodeId === nodeId;
      });
      if (existing) {
        return existing;
      }

      const draft: CanvasAnnotation = {
        id: generateAnnotationId(),
        content: '',
        position: { x: node.position.x, y: node.position.y },
        size: { ...DEFAULT_ANNOTATION_SIZE },
        binding: { type: 'node', nodeId },
        style: { ...DEFAULT_ANNOTATION_STYLE },
      };
      const computed = resolveAnnotationPosition(draft, {
        nodes: snapshot.nodes,
        sizeSources: undefined,
      });
      draft.position = computed;

      set((state) => {
        if (!state.nodeGraph) return;
        ensureNodeGraphMeta(state.nodeGraph);
        if (!Array.isArray(state.nodeGraph.annotations)) {
          state.nodeGraph.annotations = [];
        }
        state.nodeGraph.annotations.push(draft);

        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
      });
      get().saveToHistory();
      // 创建即进入编辑态
      get().setEditingAnnotation(draft.id);
      return draft;
    },

    insertAnnotationsBatch: (annotations, options) => {
      if (annotations.length === 0) return [];
      const offset = options.offset;
      const offsetIsDefined = offset !== undefined;
      // 每条注释生成新 id，避免与画布已有注释冲突；位置按 offset 偏移
      const prepared: CanvasAnnotation[] = annotations.map((ann) => ({
        id: generateAnnotationId(),
        content: ann.content,
        position: offsetIsDefined
          ? { x: ann.position.x + offset.x, y: ann.position.y + offset.y }
          : { x: ann.position.x, y: ann.position.y },
        size: { ...ann.size },
        binding: { ...ann.binding } as AnnotationBinding,
        style: { ...ann.style },
      }));

      set((state) => {
        if (!state.nodeGraph) return;
        ensureNodeGraphMeta(state.nodeGraph);
        if (!Array.isArray(state.nodeGraph.annotations)) {
          state.nodeGraph.annotations = [];
        }
        for (const ann of prepared) {
          state.nodeGraph.annotations.push(ann);
        }
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
      });
      if (options.saveHistory) {
        get().saveToHistory();
      }
      return prepared;
    },

    updateAnnotation: (annotationId, updates) => {
      let shouldSaveHistory = false;
      set((state) => {
        if (!state.nodeGraph || !Array.isArray(state.nodeGraph.annotations)) return;
        const annotation = state.nodeGraph.annotations.find((ann) => ann.id === annotationId);
        if (!annotation) return;

        // 变化守卫：与 updateNodeData 一致，只在有实际变化时落历史
        if (updates.content !== undefined && annotation.content !== updates.content) {
          annotation.content = updates.content;
          shouldSaveHistory = true;
        }
        if (updates.position && (annotation.position.x !== updates.position.x || annotation.position.y !== updates.position.y)) {
          annotation.position = updates.position;
          shouldSaveHistory = true;
        }
        if (updates.size) {
          const clamped = clampAnnotationSize(updates.size);
          if (annotation.size.width !== clamped.width || annotation.size.height !== clamped.height) {
            annotation.size = clamped;
            shouldSaveHistory = true;
          }
        }
        if (updates.binding) {
          const newBinding = updates.binding as AnnotationBinding;
          if (!isSameBinding(annotation.binding, newBinding)) {
            annotation.binding = newBinding;
            shouldSaveHistory = true;
          }
        }
        if (updates.style) {
          const merged = { ...annotation.style, ...updates.style };
          if (
            annotation.style.color !== merged.color ||
            annotation.style.fontSize !== merged.fontSize
          ) {
            annotation.style = merged;
            shouldSaveHistory = true;
          }
        }

        if (!shouldSaveHistory) return;
        ensureNodeGraphMeta(state.nodeGraph);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
      });
      if (shouldSaveHistory && !get().historyBatchActive) {
        get().saveToHistory();
      }
    },

    updateAnnotationContent: (annotationId, content) => {
      set((state) => {
        if (!state.nodeGraph || !Array.isArray(state.nodeGraph.annotations)) return;
        const annotation = state.nodeGraph.annotations.find((ann) => ann.id === annotationId);
        if (!annotation) return;
        annotation.content = content;
        ensureNodeGraphMeta(state.nodeGraph);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
      });
    },

    updateAnnotationPosition: (annotationId, position) => {
      set((state) => {
        if (!state.nodeGraph || !Array.isArray(state.nodeGraph.annotations)) return;
        const annotation = state.nodeGraph.annotations.find((ann) => ann.id === annotationId);
        if (!annotation) return;
        annotation.position = position;
        ensureNodeGraphMeta(state.nodeGraph);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.positionRevision += 1;
      });
    },

    updateAnnotationSize: (annotationId, size) => {
      set((state) => {
        if (!state.nodeGraph || !Array.isArray(state.nodeGraph.annotations)) return;
        const annotation = state.nodeGraph.annotations.find((ann) => ann.id === annotationId);
        if (!annotation) return;
        annotation.size = clampAnnotationSize(size);
        ensureNodeGraphMeta(state.nodeGraph);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.positionRevision += 1;
      });
    },

    removeAnnotation: (annotationId) => {
      set((state) => {
        if (!state.nodeGraph || !Array.isArray(state.nodeGraph.annotations)) return;
        state.nodeGraph.annotations = state.nodeGraph.annotations.filter((ann) => ann.id !== annotationId);

        // 统一选中清理
        cleanupSelectionAfterRemoval(state, {
          removedNodeIds: [],
          removedAnnotationIds: [annotationId],
        });

        ensureNodeGraphMeta(state.nodeGraph);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
      });
      if (!get().historyBatchActive) {
        get().saveToHistory();
      }
    },

    unbindAnnotation: (annotationId) => {
      const snapshot = get().nodeGraph;
      if (!snapshot || !Array.isArray(snapshot.annotations)) return;
      const ann = snapshot.annotations.find((a) => a.id === annotationId);
      if (!ann) return;
      if (!ann.binding || ann.binding.type === 'free') return;

      const resolved = resolveAnnotationPosition(ann, {
        nodes: snapshot.nodes,
        sizeSources: undefined,
      });

      set((state) => {
        if (!state.nodeGraph || !Array.isArray(state.nodeGraph.annotations)) return;
        const target = state.nodeGraph.annotations.find((a) => a.id === annotationId);
        if (!target) return;
        target.binding = { type: 'free' };
        target.position = resolved;
        ensureNodeGraphMeta(state.nodeGraph);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
        state.positionRevision += 1;
      });
      get().saveToHistory();
    },

    startAnnotationBinding: (annotationId) => {
      set((state) => {
        state.pendingAnnotationBinding = { annotationId };
      });
    },

    cancelAnnotationBinding: () => {
      set((state) => {
        state.pendingAnnotationBinding = null;
      });
    },

    bindAnnotation: (annotationId, binding) => {
      const snapshot = get().nodeGraph;
      if (!snapshot || !Array.isArray(snapshot.annotations)) return false;
      const ann = snapshot.annotations.find((a) => a.id === annotationId);
      if (!ann) return false;

      if (binding.type !== 'free') {
        const conflict = (snapshot.annotations ?? []).some((other) => {
          if (other.id === annotationId) return false;
          const b = other.binding;
          if (!isAnnotationBinding(b)) return false;
          if (binding.type === 'node') return b.type === 'node' && b.nodeId === binding.nodeId;
          return false;
        });
        if (conflict) {
          return false;
        }
      }

      set((state) => {
        if (!state.nodeGraph || !Array.isArray(state.nodeGraph.annotations)) return;
        const target = state.nodeGraph.annotations.find((a) => a.id === annotationId);
        if (!target) return;
        target.binding = binding;
        state.pendingAnnotationBinding = null;
        ensureNodeGraphMeta(state.nodeGraph);
        state.nodeGraph.meta.updatedAt = new Date().toISOString();
        markGraphDirty(state);
        state.structureRevision += 1;
      });
      get().saveToHistory();
      return true;
    },
});

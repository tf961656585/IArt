import { enableMapSet, enablePatches } from 'immer';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

import { createInitialCanvasState, type CanvasStore } from './internal/canvasStore.core';
import { createCanvasLoadActions } from './internal/canvasStore.loadActions';
import { createCanvasNodeActions } from './internal/canvasStore.nodeActions';
import { createCanvasNodeSizeActions } from './internal/canvasStore.nodeSizeActions';
import { createCanvasAnnotationActions } from './internal/canvasStore.annotationActions';
import { createCanvasSelectionViewActions } from './internal/canvasStore.selectionViewActions';
import { createCanvasViewportActions } from './internal/canvasStore.viewportActions';
import { createCanvasCanvasSettingsActions } from './internal/canvasStore.canvasSettingsActions';
import { createCanvasInteractionStateActions } from './internal/canvasStore.interactionStateActions';
import { createCanvasLayoutActions } from './internal/canvasStore.layoutActions';
import { createCanvasAlignmentActions } from './internal/canvasStore.alignmentActions';
import { createCanvasHistoryPersistenceActions } from './internal/canvasStore.historyPersistenceActions';
import { createCanvasClipboardActions } from './internal/canvasStore.clipboardActions';
import { createCanvasDeleteActions } from './internal/canvasStore.deleteActions';
import { createCanvasGroupActions } from './internal/canvasStore.groupActions';
import { createCanvasLayoutModelActions } from './internal/canvasStore.layoutModelActions';

// canvas store 依赖两个 immer 插件，必须在首次使用 draft 前全局启用：
// - MapSet：store state 持有 Map（taskIdIndex 等），
//   immer 处理含 Map 的 draft 需要该插件，否则报
//   "The plugin for 'MapSet' has not been loaded"。
// - Patches：历史栈增量条目使用 produceWithPatches / applyPatches，
//   否则报 "The plugin for 'Patches' has not been loaded"。
// 两者均全局幂等，由本入口统一声明，消除对其他模块加载顺序的隐式依赖。
enableMapSet();
enablePatches();

export type { CanvasStore } from './internal/canvasStore.core';
export {
  buildProjectDelta,
  markFullGraphDirty,
  markGraphDirty,
  markNodeDirty,
  markNodeRemoved,
  markViewportDirty,
} from './internal/canvasStore.persistence';

export const useCanvasStore = create<CanvasStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      ...createInitialCanvasState(),
      ...createCanvasLoadActions(set, get),
      ...createCanvasNodeActions(set, get),
      ...createCanvasNodeSizeActions(set, get),
      ...createCanvasAnnotationActions(set, get),
      ...createCanvasSelectionViewActions(set, get),
      ...createCanvasViewportActions(set, get),
      ...createCanvasCanvasSettingsActions(set, get),
      ...createCanvasInteractionStateActions(set, get),
      ...createCanvasLayoutActions(set, get),
      ...createCanvasAlignmentActions(set, get),
      ...createCanvasClipboardActions(set, get),
      ...createCanvasDeleteActions(set, get),
      ...createCanvasGroupActions(set, get),
      ...createCanvasLayoutModelActions(set, get),
      ...createCanvasHistoryPersistenceActions(set, get),
    }))
  )
);

export const __setMockCanvasState = (nextState: Partial<CanvasStore>) => {
  useCanvasStore.setState(nextState);
};

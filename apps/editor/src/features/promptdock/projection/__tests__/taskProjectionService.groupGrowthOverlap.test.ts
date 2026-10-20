// @spec: FTB-012, AL-GC-003
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  PromptDockBatchSubmitResponse,
  RuntimeMediaAssetView,
  RuntimeTaskOutputView,
  RuntimeTaskView,
  TaskStateNotification,
} from '@iart/contracts';
import { TaskStateNotificationSchema } from '@iart/contracts';

import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { getGroupMembers } from '@/features/canvas/services/groupMembership';
import {
  applyTaskStateChanged,
  createBirthGroup,
  createTaskProjectionsForAcceptance,
} from '@/features/promptdock/projection/taskProjectionService';
import { createNodeGraph } from '@/features/canvas/types/nodeGraph';
import type { GraphNode } from '@/features/canvas/types/node';
import { createTestNodeGraphParams } from '@/features/canvas/components/__tests__/fixtures/canvasTestBuilders';
import { buildGroupDerivedSize } from '@/features/canvas/components/canvas/groupDerivedSize';
import { buildCanvasSizeSources } from '@/features/canvas/utils/nodeOccupancy';
import { rectsIntersect } from '@/features/canvas/utils/taskNodePlacement';

/**
 * 容器级防重叠（长大容器整体让位）接缝测试：
 * 两个空组各连续 3 批入组（真实链路：受理 → 投影创建 → 终态通知 → finalizeBatch 容器内整理）。
 * 容器内整理让派生矩形长大并与相邻容器相交时，finalizeBatch 必须整组让位；
 * 让位后两框不相交，且组内成员网格布局保持（整组统一 delta，相对位置不变）。
 */

const GRAPH_ID = 'graph-group-growth-overlap';

const resetStore = (): void => {
  useCanvasStore.setState((state) => {
    state.nodeGraph = null;
    state.mediaAssets = {};
    state.selectedNodeIds = [];
    state.selectedAnnotationIds = [];
    state.editingAnnotationId = null;
    state.history = [];
    state.historyIndex = -1;
    state.historyBatchActive = false;
    state.deferredHistoryBaseline = null;
    state.hasUnsavedChanges = false;
    state.ui.canvasContainerSize = null;
    state.ui.lastMeasuredSizeByNodeId = {};
    state.ui.layoutModelByNodeId = {};
  });
};

const setupGraph = (): void => {
  const graph = createNodeGraph(createTestNodeGraphParams('group-growth-overlap'));
  graph.id = GRAPH_ID;
  graph.viewport = { x: 0, y: 0, zoom: 1 };
  useCanvasStore.setState((state) => {
    state.nodeGraph = graph;
    state.mediaAssets = {};
    state.ui.canvasContainerSize = { width: 1440, height: 900 };
  });
};

const requireGraph = (): ReturnType<typeof createNodeGraph> => {
  const graph = useCanvasStore.getState().nodeGraph;
  if (!graph) throw new Error('nodeGraph 为空');
  return graph;
};

const mediaAssetView = (assetId: string): RuntimeMediaAssetView => ({
  assetId,
  mediaType: 'image',
  original: {
    url: `local-media://project-a/images/${assetId}.png`,
    sourceFileName: null,
    projectRef: 'project-a',
    fileKey: `images/${assetId}.png`,
    sourceUrl: `https://remote.example/${assetId}.png`,
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: `local-media://project-a/thumbs/${assetId}.png`,
    mimeType: 'image/png',
    width: 200,
    height: 150,
    status: 'ready',
    generatedAt: 1,
    error: null,
  },
  lifecycle: { createdAt: 1, updatedAt: 1 },
});

const outputRow = (taskId: string, assetId: string): RuntimeTaskOutputView => ({
  outputId: `out-${assetId}`,
  taskId,
  mediaType: 'image',
  assetId,
  textValue: null,
  sortOrder: 0,
});

const acceptanceResponseFor = (
  batchId: string,
  taskIds: ReadonlyArray<string>,
): PromptDockBatchSubmitResponse => ({
  batch_id: batchId,
  intent_snapshot: {
    batch_id: batchId,
    model_id: 'model-a',
    model_version: '1.0.0',
    prompt: '一只猫',
    params: {},
    task_count: taskIds.length,
    task_ids: [...taskIds],
    created_at: '2026-10-15T00:00:00.000Z',
  },
  tasks: taskIds.map((taskId, index) => ({ task_id: taskId, task_index: index })),
});

const succeededNotification = (params: {
  batchId: string;
  taskId: string;
  assetId: string;
}): TaskStateNotification => {
  const task: RuntimeTaskView = {
    taskId: params.taskId,
    status: 'succeeded',
    projectPath: '/proj',
    batchId: params.batchId,
    metadata: { modelId: 'model-a' },
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    type: 'task:state-changed',
    projectPath: '/proj',
    task,
    outputs: [outputRow(params.taskId, params.assetId)],
    mediaAssets: [mediaAssetView(params.assetId)],
  };
};

const flushAsyncFinalize = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

let taskSequence = 0;
const nextTaskIds = (prefix: string, count: number): string[] => {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    taskSequence += 1;
    ids.push(`${prefix}-task-${taskSequence}`);
  }
  return ids;
};

let batchSequence = 0;
/** 一批 3 个任务入组并全部成功终态，等待 finalizeBatch 异步收口。 */
const runBatchIntoGroup = async (groupId: string, prefix: string): Promise<void> => {
  batchSequence += 1;
  const batchId = `group-growth-batch-${batchSequence}`;
  const taskIds = nextTaskIds(prefix, 3);
  const accepted = createTaskProjectionsForAcceptance({
    nodeGraphId: GRAPH_ID,
    response: acceptanceResponseFor(batchId, taskIds),
    modelId: 'model-a',
    referenceAssetIds: [],
    selectCreatedNodes: false,
    birthGroupId: groupId,
  });
  if (!accepted.ok) throw new Error(`受理失败：${accepted.reason}`);

  for (const taskId of taskIds) {
    const notification = succeededNotification({
      batchId,
      taskId,
      assetId: `asset-${taskId}`,
    });
    TaskStateNotificationSchema.parse(notification);
    applyTaskStateChanged(notification);
  }
  await flushAsyncFinalize();
};

const derivedEntry = (
  nodes: ReadonlyArray<GraphNode>,
  id: string,
): { position: { x: number; y: number }; size: { width: number; height: number } } => {
  const sizeSources = buildCanvasSizeSources(useCanvasStore.getState());
  const entry = buildGroupDerivedSize({ nodes, sizeSources }).byGroupId[id];
  if (!entry) throw new Error(`容器派生 entry 缺失：${id}`);
  return entry;
};

const entryRect = (entry: {
  position: { x: number; y: number };
  size: { width: number; height: number };
}) => ({ x: entry.position.x, y: entry.position.y, width: entry.size.width, height: entry.size.height });

/** 整理口径网格保持：9 个成员按 3 列 x 3 行分布，行内 x 递增。 */
const expectGridLayout = (members: ReadonlyArray<GraphNode>): void => {
  const sorted = [...members].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
  );
  const rows: GraphNode[][] = [];
  for (const member of sorted) {
    const currentRow = rows[rows.length - 1];
    const first = currentRow?.[0];
    if (currentRow !== undefined && first !== undefined && Math.abs(first.position.y - member.position.y) < 1) {
      currentRow.push(member);
    } else {
      rows.push([member]);
    }
  }
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row).toHaveLength(3);
    for (let index = 1; index < row.length; index += 1) {
      const previous = row[index - 1];
      const current = row[index];
      if (!previous || !current) throw new Error('row member missing');
      expect(current.position.x).toBeGreaterThan(previous.position.x);
    }
  }
};

beforeEach(() => {
  resetStore();
  setupGraph();
});

describe('批次收口：长大容器的容器级防重叠', () => {
  it('两个空组各连续 3 批入组后互不相交，组内成员网格布局保持', async () => {
    const groupA = createBirthGroup('A');
    const groupB = createBirthGroup('B');
    if (groupA === null || groupB === null) throw new Error('出生组建组失败');

    // 交替入组，覆盖两个方向的长大（A 长大挤 B / B 长大挤 A）
    for (let round = 0; round < 3; round += 1) {
      await runBatchIntoGroup(groupA, `a${round + 1}`);
      await runBatchIntoGroup(groupB, `b${round + 1}`);
    }

    const graph = requireGraph();
    const rectA = entryRect(derivedEntry(graph.nodes, groupA));
    const rectB = entryRect(derivedEntry(graph.nodes, groupB));
    expect(rectsIntersect(rectA, rectB)).toBe(false);

    const membersA = getGroupMembers(graph, groupA);
    const membersB = getGroupMembers(graph, groupB);
    expect(membersA).toHaveLength(9);
    expect(membersB).toHaveLength(9);
    expectGridLayout(membersA);
    expectGridLayout(membersB);

    // 让位是整组位移：成员仍留在原容器，且成员包围盒完整落在派生矩形内
    for (const member of [...membersA, ...membersB]) {
      expect(member.groupId === groupA || member.groupId === groupB).toBe(true);
    }
    for (const [rect, members] of [
      [rectA, membersA],
      [rectB, membersB],
    ] as const) {
      for (const member of members) {
        expect(member.position.x).toBeGreaterThanOrEqual(rect.x);
        expect(member.position.y).toBeGreaterThanOrEqual(rect.y);
      }
    }
  });
});

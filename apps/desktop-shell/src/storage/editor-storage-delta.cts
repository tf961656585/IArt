/**
 * Editor Storage Service — Delta 队列与 Flush
 *
 * 简化自 Backend project-storage-sqlite.cts 的 delta 队列逻辑。
 * 关键差异：
 *   - 不做 resultArea 深层校验，静默剥离 taskInfo（决策 4）
 *   - 不调用 normalizeProjectDocument / buildProjectDocument
 *   - 不调用 rewriteProjectFilesUrls
 */

import type { ProjectSaveDelta } from '@iart/contracts';
import type { SqliteDatabase } from './sqlite-loader.cjs';

// ── Registry sync hook (set by service to avoid circular deps) ──

let _syncRegistryOnFlush: ((db: SqliteDatabase, projectPath: string) => void) | null = null;

const setFlushRegistrySync = (fn: (db: SqliteDatabase, projectPath: string) => void): void => {
  _syncRegistryOnFlush = fn;
};

// ── Types ──

interface DeltaQueueState {
  processing: boolean;
  lastError: Error | null;
  currentPromise: Promise<void> | null;
}

interface PendingDeltaRow {
  seq: number;
  delta: ProjectSaveDelta;
  createdAt: number;
}

interface PendingDeltaState {
  hasPendingWrite: boolean;
  pendingChangeCount: number;
  mergedDelta: ProjectSaveDelta | null;
}

type DeltaEntity = { id: string } & object;

// ── Queue state management ──

const queueStateByDb = new Map<SqliteDatabase, DeltaQueueState>();

const getQueueState = (db: SqliteDatabase): DeltaQueueState => {
  const existing = queueStateByDb.get(db);
  if (existing) return existing;
  const next: DeltaQueueState = { processing: false, lastError: null, currentPromise: null };
  queueStateByDb.set(db, next);
  return next;
};

// ── Delta helpers ──

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const withCanonicalGraphId = (graph: unknown, nodeGraphId: string): unknown => {
  const record = asDeltaRecord(graph);
  if (!record) return graph;
  return {
    ...record,
    id: nodeGraphId,
  };
};

type DeltaRecord = object & {
  id: unknown | undefined;
  data: unknown | undefined;
  taskInfo: unknown | undefined;
};

const asDeltaRecord = (value: unknown): DeltaRecord | null =>
  typeof value === 'object' && value !== null ? (value as DeltaRecord) : null;

const asEntity = (value: unknown): DeltaEntity | null => {
  const record = asDeltaRecord(value);
  if (!record) return null;
  const id = normalizeString(record.id);
  if (!id) return null;
  return { ...record, id };
};

const stripTaskInfo = (node: unknown): unknown => {
  const entity = asDeltaRecord(node);
  if (!entity) return node;
  const data = asDeltaRecord(entity.data);
  if (!data || !('taskInfo' in data)) return node;
  const { taskInfo: _taskInfo, ...restData } = data;
  return { ...entity, data: restData };
};

// ── Merge deltas ──

const mergeDeltas = (deltas: ProjectSaveDelta[]): ProjectSaveDelta => {
  const merged = {
    nodeGraphId: '' as string,
    fullReplace: false,
    graph: undefined as ProjectSaveDelta['graph'] | undefined,
    nodes: { upsert: new Map<string, unknown>(), remove: new Set<string>() },
  };

  for (const delta of deltas) {
    if (!delta) continue;

    if (typeof delta.nodeGraphId === 'string' && delta.nodeGraphId.trim()) {
      merged.nodeGraphId = delta.nodeGraphId.trim();
    }
    if (delta.graph && typeof delta.graph === 'object') {
      merged.graph = delta.graph;
    }
    if (delta.fullReplace) {
      merged.fullReplace = true;
    }

    {
      const nodes = delta.nodes;
      if (nodes !== undefined && nodes !== null) {
        const remove = nodes.remove;
        if (remove !== undefined && Array.isArray(remove)) {
          for (const nodeId of remove) {
            const id = normalizeString(nodeId);
            if (!id) continue;
            merged.nodes.remove.add(id);
            merged.nodes.upsert.delete(id);
          }
        }
        const upsert = nodes.upsert;
        if (upsert !== undefined && Array.isArray(upsert)) {
          for (const node of upsert) {
            const entity = asEntity(node);
            if (!entity) continue;
            merged.nodes.upsert.set(entity.id, stripTaskInfo(entity));
            merged.nodes.remove.delete(entity.id);
          }
        }
      }
    }
  }

  return {
    nodeGraphId: merged.nodeGraphId,
    fullReplace: merged.fullReplace,
    graph: merged.graph,
    nodes: {
      upsert: Array.from(merged.nodes.upsert.values()),
      remove: Array.from(merged.nodes.remove.values()),
    },
  };
};

const hasMergedDeltaChanges = (delta: ProjectSaveDelta | null): boolean => {
  if (!delta) return false;
  if (delta.graph || delta.fullReplace) return true;
  const nodes = delta.nodes;
  if (nodes !== undefined && nodes !== null) {
    if (nodes.upsert !== undefined && Array.isArray(nodes.upsert) && nodes.upsert.length > 0) return true;
    if (nodes.remove !== undefined && Array.isArray(nodes.remove) && nodes.remove.length > 0) return true;
  }
  return false;
};

// ── Apply merged delta to DB tables ──

const readNodeIds = (db: SqliteDatabase): string[] =>
  (db.prepare('SELECT id FROM nodes').all() as { id: string }[]).map((row) => row.id);

/**
 * 应用合并后的 delta。
 *
 * agent 域节点清理（节点删除的唯一咽喉）：本函数是节点行的全部删除路径所在处，
 * 因此 agent 域的清理也收在这里，且与节点删除在同一事务内（flush 的 db.transaction）。
 * 单个节点的完整清理顺序（`purgeAgentDataForNode`）：
 *   1. 先取该节点的会话 id 集合（删会话行后就查不到了）。
 *   2. 删该节点的留痕：按 `nodeId` 命中受理后写入的留痕，按第 1 步的会话 id 命中
 *      **受理前写入、nodeId 为 null 的留痕**——留痕表刻意不建指向 agent_sessions 的外键
 *      （首条留痕必须先于会话创建落库），故无法靠级联，必须两条路径都删。
 *   3. 删会话行；其消息 / 工具调用由 agent_sessions 上的 ON DELETE CASCADE 外键级联删除
 *      （生产连接已 `PRAGMA foreign_keys = ON`，见 editor-storage-service-impl.cts）。
 * 会话表刻意不建指向 nodes(id) 的外键：节点写入与会话创建是两条异步通道，
 * 外键会在顺序竞态下拒绝合法写入。
 *
 * 两条删除路径：
 * - 逐删路径：`nodes.remove` 中的每个 nodeId 走一次完整清理。
 * - 全量替换路径：`clearNodes` 会清掉全部节点，但被重新 upsert 的节点应当保留会话与留痕
 *   （全量替换常来自「整图重存」，节点身份未变），故先记下清空前的节点 id，
 *   upsert 完成后只清理「未再出现」的节点——按存活差集清理，不整表清空。
 */
const applyDeltaToTables = (db: SqliteDatabase, delta: ProjectSaveDelta): void => {
  const now = Date.now();

  const insertGraph = db.prepare(
    'INSERT OR REPLACE INTO graph (id, payloadJson, updatedAt) VALUES (?, ?, ?)',
  );
  const insertNode = db.prepare(
    'INSERT OR REPLACE INTO nodes (id, payloadJson, updatedAt) VALUES (?, ?, ?)',
  );
  const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');
  const clearNodes = db.prepare('DELETE FROM nodes');
  const selectAgentSessionIdsByNodeId = db.prepare(
    'SELECT agentSessionId FROM agent_sessions WHERE nodeId = ?',
  );
  const deleteAgentSessionsByNodeId = db.prepare('DELETE FROM agent_sessions WHERE nodeId = ?');
  const deleteAgentSendRecordsByNodeId = db.prepare('DELETE FROM agent_send_records WHERE nodeId = ?');
  const deleteAgentSendRecordsBySessionId = db.prepare(
    'DELETE FROM agent_send_records WHERE agentSessionId = ?',
  );

  const purgeAgentDataForNode = (nodeId: string): void => {
    const sessionIds = (
      selectAgentSessionIdsByNodeId.all(nodeId) as { agentSessionId: string }[]
    ).map((row) => row.agentSessionId);

    deleteAgentSendRecordsByNodeId.run(nodeId);
    for (const agentSessionId of sessionIds) {
      deleteAgentSendRecordsBySessionId.run(agentSessionId);
    }
    deleteAgentSessionsByNodeId.run(nodeId);
  };

  const graphId = normalizeString(delta.nodeGraphId);
  if (!graphId) {
    throw new Error('PROJECT_SAVE_DELTA_NODE_GRAPH_ID_MISSING');
  }

  if (delta.graph && graphId) {
    insertGraph.run(
      graphId,
      JSON.stringify(withCanonicalGraphId(delta.graph, graphId)),
      now,
    );
    db.prepare('DELETE FROM graph WHERE id <> ?').run(graphId);
  }

  const nodeIdsBeforeFullReplace = delta.fullReplace ? readNodeIds(db) : [];
  if (delta.fullReplace) {
    clearNodes.run();
  }

  const upsertedNodeIds = new Set<string>();
  {
    const nodes = delta.nodes;
    if (nodes !== undefined && nodes !== null) {
      const upsert = nodes.upsert;
      if (upsert !== undefined && Array.isArray(upsert)) {
        for (const node of upsert) {
          const entity = asEntity(node);
          if (!entity) continue;
          insertNode.run(entity.id, JSON.stringify(stripTaskInfo(entity)), now);
          upsertedNodeIds.add(entity.id);
        }
      }
      const remove = nodes.remove;
      if (remove !== undefined && Array.isArray(remove)) {
        for (const nodeId of remove) {
          const id = normalizeString(nodeId);
          if (!id) continue;
          deleteNode.run(id);
          purgeAgentDataForNode(id);
        }
      }
    }
  }

  if (delta.fullReplace) {
    for (const nodeId of nodeIdsBeforeFullReplace) {
      if (upsertedNodeIds.has(nodeId)) continue;
      purgeAgentDataForNode(nodeId);
    }
  }
};

// ── Public API ──

const enqueueDelta = (db: SqliteDatabase, delta: ProjectSaveDelta): void => {
  db.prepare('INSERT INTO project_pending_deltas (payloadJson, createdAt) VALUES (?, ?)').run(
    JSON.stringify(delta),
    Date.now(),
  );
};

const readPendingDeltaRows = (db: SqliteDatabase): PendingDeltaRow[] =>
  db
    .prepare('SELECT seq, payloadJson, createdAt FROM project_pending_deltas ORDER BY seq ASC')
    .all()
    .map((row) => {
      const pendingRow = row as { seq: unknown | undefined; payloadJson: unknown | undefined; createdAt: unknown | undefined };
      try {
        const payloadJson = typeof pendingRow.payloadJson === 'string' ? pendingRow.payloadJson : '';
        const delta = JSON.parse(payloadJson) as unknown;
        if (!delta || typeof delta !== 'object') return null;
        return {
          seq: Number(pendingRow.seq),
          delta: delta as ProjectSaveDelta,
          createdAt: Number(pendingRow.createdAt),
        };
      } catch {
        return null;
      }
    })
    .filter((row): row is PendingDeltaRow => row !== null);

const getPendingState = (db: SqliteDatabase): PendingDeltaState => {
  const rows = readPendingDeltaRows(db);
  const deltas = rows.map((r) => r.delta);
  const merged = deltas.length > 0 ? mergeDeltas(deltas) : null;
  const hasChanges = hasMergedDeltaChanges(merged);
  return {
    hasPendingWrite: hasChanges,
    pendingChangeCount: rows.length,
    mergedDelta: merged,
  };
};

const clearPendingDeltas = (db: SqliteDatabase): void => {
  db.prepare('DELETE FROM project_pending_deltas').run();
};

const flush = async (db: SqliteDatabase, projectPath: string | undefined): Promise<void> => {
  const state = getQueueState(db);

  if (state.processing) {
    await state.currentPromise;
    if (state.lastError) throw state.lastError;
    return;
  }

  state.processing = true;
  const promise = (async () => {
    try {
      const pendingState = getPendingState(db);

      const run = db.transaction(() => {
        if (pendingState.mergedDelta && hasMergedDeltaChanges(pendingState.mergedDelta)) {
          applyDeltaToTables(db, pendingState.mergedDelta);
        }
        clearPendingDeltas(db);
      });
      run();

      try {
        db.pragma('wal_checkpoint(PASSIVE)', undefined);
      } catch {
        // ignore
      }
      state.lastError = null;

      // 事务外同步注册表 savedAt
      if (projectPath && _syncRegistryOnFlush) {
        try {
          _syncRegistryOnFlush(db, projectPath);
        } catch {
          // 注册表写入失败不阻塞主数据持久化
        }
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error : new Error(String(error));
      throw state.lastError;
    } finally {
      state.processing = false;
      state.currentPromise = null;
    }
  })();

  state.currentPromise = promise;
  await promise;
};

const discardPending = (db: SqliteDatabase): void => {
  const state = getQueueState(db);
  if (state.processing) {
    throw new Error('pending_node_changes_flushing');
  }
  clearPendingDeltas(db);
  state.lastError = null;
};

export {
  enqueueDelta,
  flush,
  discardPending,
  getPendingState,
  readPendingDeltaRows,
  mergeDeltas,
  setFlushRegistrySync,
};
export type { PendingDeltaState };

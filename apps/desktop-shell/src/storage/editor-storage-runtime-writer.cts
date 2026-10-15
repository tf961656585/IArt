import type {
  RuntimeTransactionPayload,
  TaskEventPayload,
  RuntimeTransactionResult,
} from '@iart/contracts';
import type { SqliteDatabase } from './sqlite-loader.cjs';

type TaskItem = NonNullable<RuntimeTransactionPayload['tasks']>[number];
type MediaAssetItem = NonNullable<RuntimeTransactionPayload['mediaAssets']>[number];
type BatchItem = NonNullable<RuntimeTransactionPayload['batches']>[number];

const runTaskUpsert = (db: SqliteDatabase, task: TaskItem) => {
  db.prepare(
    `INSERT OR REPLACE INTO tasks (
      taskId,
      status,
      projectPath,
      sourceNodeId,
      targetNodeId,
      batchId,
      requestJson,
      metadataJson,
      remoteRequestId,
      progressPercent,
      progressMessage,
      progressPhase,
      errorMessage,
      errorCode,
      failureJson,
      createdAt,
      updatedAt,
      startedAt,
      finishedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.taskId,
    task.status,
    task.projectPath,
    task.sourceNodeId ?? null,
    task.targetNodeId ?? null,
    task.batchId ?? null,
    task.requestJson ?? null,
    task.metadataJson ?? null,
    task.remoteRequestId ?? null,
    task.progressPercent ?? null,
    task.progressMessage ?? null,
    task.progressPhase ?? null,
    task.errorMessage ?? null,
    task.errorCode ?? null,
    task.failureJson ?? null,
    task.createdAt,
    task.updatedAt,
    task.startedAt ?? null,
    task.finishedAt ?? null,
  );
};

const replaceTaskOutputs = (db: SqliteDatabase, taskOutputs: NonNullable<RuntimeTransactionPayload['taskOutputs']>): void => {
  const taskIds = [...new Set(taskOutputs.map((output) => output.taskId))];

  for (const taskId of taskIds) {
    db.prepare('DELETE FROM task_outputs WHERE taskId = ?').run(taskId);
  }

  for (const output of taskOutputs) {
    db.prepare(
      `INSERT INTO task_outputs (
        outputId,
        taskId,
        assetId,
        mediaType,
        textValue,
        sortOrder
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      output.outputId,
      output.taskId,
      output.assetId ?? null,
      output.mediaType,
      output.textValue ?? null,
      output.sortOrder ?? null,
    );
  }
};

const runMediaAssetUpsert = (db: SqliteDatabase, asset: MediaAssetItem) => {
  db.prepare(
    `INSERT OR REPLACE INTO media_assets (
      assetId,
      mediaType,
      payloadJson,
      createdAt,
      updatedAt
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    asset.assetId,
    asset.mediaType,
    asset.payloadJson,
    asset.createdAt ?? null,
    asset.updatedAt ?? null,
  );
};

const runBatchInsert = (db: SqliteDatabase, batch: BatchItem) => {
  db.prepare(
    `INSERT INTO batches (
      batchId,
      payloadJson,
      clientRequestId,
      createdAt,
      updatedAt
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(batchId)
    DO UPDATE SET
      payloadJson = COALESCE(NULLIF(excluded.payloadJson, ''), batches.payloadJson),
      clientRequestId = COALESCE(batches.clientRequestId, excluded.clientRequestId),
      createdAt = COALESCE(batches.createdAt, excluded.createdAt),
      updatedAt = COALESCE(excluded.updatedAt, batches.updatedAt)`,
  ).run(
    batch.batchId,
    batch.payloadJson,
    batch.clientRequestId ?? null,
    batch.createdAt ?? null,
    batch.updatedAt ?? null,
  );
};

export const executeRuntimeTransaction = (
  db: SqliteDatabase,
  payload: RuntimeTransactionPayload,
): RuntimeTransactionResult => {
  const { tasks, taskOutputs, mediaAssets, batches, transactionId } = payload;

  const transaction = db.transaction(() => {
    if (tasks !== undefined && tasks.length > 0) {
      for (const task of tasks) {
        runTaskUpsert(db, task);
      }
    }

    if (mediaAssets !== undefined && mediaAssets.length > 0) {
      for (const asset of mediaAssets) {
        runMediaAssetUpsert(db, asset);
      }
    }

    if (taskOutputs !== undefined && taskOutputs.length > 0) {
      replaceTaskOutputs(db, taskOutputs);
    }

    if (batches !== undefined && batches.length > 0) {
      for (const batch of batches) {
        runBatchInsert(db, batch);
      }
    }
  });

  try {
    const needRefill = false;
    transaction();
    return {
      type: 'runtime:transaction-result',
      transactionId,
      success: true,
      needRefill,
    };
  } catch (error: unknown) {
    return {
      type: 'runtime:transaction-result',
      transactionId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const writeTaskEvent = (
  db: SqliteDatabase,
  payload: TaskEventPayload,
): RuntimeTransactionResult => {
  const { event, transactionId } = payload;

  try {
    db.prepare(
      `INSERT INTO task_events (
        taskId,
        eventType,
        payload,
        createdAt
      ) VALUES (?, ?, ?, ?)`,
    ).run(event.taskId, event.eventType, JSON.stringify(event.payload), event.createdAt);

    return {
      type: 'runtime:transaction-result',
      transactionId,
      success: true,
    };
  } catch (error: unknown) {
    return {
      type: 'runtime:transaction-result',
      transactionId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const deleteTaskWithOutputs = (db: SqliteDatabase, taskId: string): void => {
  db.prepare('DELETE FROM task_outputs WHERE taskId = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE taskId = ?').run(taskId);
};

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  RuntimeMediaAssetRow,
  RuntimeTaskOutputRow,
  RuntimeTaskRow,
} from '@iart/contracts';
import snapshotBuilderModule from '../runtime-snapshot-builder.cts';

const { buildTaskStateSnapshotPayload } = snapshotBuilderModule;

const isTaskFinalStatus = (status: string) => status === 'succeeded' || status === 'failed';
const normalizeTaskStatus = (status: unknown) =>
  typeof status === 'string' ? status.trim().toLowerCase() : '';

void test('runtime snapshot builder: 只包含非终态任务并保留 outputs/mediaAssets map', () => {
  const runningTask: RuntimeTaskRow = {
    taskId: 'task-running',
    status: 'polling',
    projectPath: '/tmp/project.iarts',
    createdAt: 1,
    updatedAt: 2,
  };
  const succeededTask: RuntimeTaskRow = {
    taskId: 'task-done',
    status: 'succeeded',
    projectPath: '/tmp/project.iarts',
    createdAt: 1,
    updatedAt: 2,
  };
  const output: RuntimeTaskOutputRow = {
    outputId: 'output-running',
    taskId: 'task-running',
    mediaType: 'image',
    assetId: 'asset-running',
    textValue: null,
    sortOrder: 0,
  };
  const mediaAsset: RuntimeMediaAssetRow = {
    assetId: 'asset-running',
    mediaType: 'image',
    payloadJson: '{"original":{"url":"/files/out.png"}}',
    createdAt: 1,
    updatedAt: 2,
  };

  const snapshot = buildTaskStateSnapshotPayload({
    projectPath: '/tmp/project.iarts',
    tasks: [runningTask, succeededTask],
    taskOutputsByTaskId: {
      'task-running': [output],
      'task-done': [],
    },
    mediaAssetsByTaskId: {
      'task-running': [mediaAsset],
      'task-done': [],
    },
    normalizeTaskStatus,
    isTaskFinalStatus,
  });

  assert.equal(snapshot?.type, 'task:state-snapshot');
  assert.deepEqual(snapshot?.tasks.map((task) => task.taskId), ['task-running']);
  assert.deepEqual(snapshot?.taskOutputsByTaskId['task-running'], [output]);
  assert.deepEqual(snapshot?.mediaAssetsByTaskId['task-running'], [mediaAsset]);
  assert.equal(snapshot?.taskOutputsByTaskId['task-done'], undefined);
});

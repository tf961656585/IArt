import { describe, expect, it } from 'vitest';

import {
  ReadTasksPayloadSchema,
  RuntimeMediaAssetViewSchema,
  RuntimeTaskRowSchema,
} from '../src/runtime-transaction';
import { runtimeTaskRowToView } from '../src/runtime-hydrated-projector';
import {
  StorageReadAllTasksResultSchema,
  StorageReadMediaAssetsByTaskResultSchema,
  StorageReadTaskOutputsResultSchema,
} from '../src/editor-storage-contract';
import {
  TaskStateNotificationSchema,
} from '../src/task-notification';

const runtimeTask = {
  taskId: 'task-1',
  status: 'generating',
  projectPath: '/tmp/runtime-contract.iartproj',
  sourceNodeId: 'source-1',
  targetNodeId: 'target-1',
  request: null,
  metadata: { executionId: 'exec-1' },
  failure: null,
  createdAt: 1,
  updatedAt: 2,
};

const taskOutput = {
  outputId: 'output-1',
  taskId: 'task-1',
  mediaType: 'image',
  assetId: 'asset-1',
  textValue: null,
  sortOrder: 0,
};

const mediaAsset = {
  assetId: 'asset-1',
  mediaType: 'image',
  original: {
    url: 'local-media://project-a/asset-1.png',
    projectRef: 'project-a',
    fileKey: 'asset-1.png',
  },
  thumbnail: {
    url: null,
    status: 'missing',
  },
  lifecycle: {
    createdAt: 1,
    updatedAt: 2,
  },
};

describe('runtime contract boundary schemas', () => {
  it('parses valid task notifications and rejects non-contract task states', () => {
    const valid = TaskStateNotificationSchema.safeParse({
      type: 'task:state-changed',
      projectPath: '/tmp/runtime-contract.iartproj',
      task: runtimeTask,
      outputs: [taskOutput],
      mediaAssets: [mediaAsset],
    });
    expect(valid.success).toBe(true);

    const invalid = TaskStateNotificationSchema.safeParse({
      type: 'task:state-changed',
      projectPath: '/tmp/runtime-contract.iartproj',
      task: { ...runtimeTask, status: 'pending' },
      outputs: [taskOutput],
      mediaAssets: [mediaAsset],
    });
    expect(invalid.success).toBe(false);
  });

  it('rejects runtime read payload status outside the unified generation status contract', () => {
    for (const status of ['polling', 'cancelled']) {
      expect(
        ReadTasksPayloadSchema.safeParse({
          type: 'runtime:read-tasks',
          projectPath: '/tmp/runtime-contract.iartproj',
          transactionId: 'tx-read-tasks',
          status,
        }).success,
      ).toBe(true);
    }

    // 'pending' 不在现役状态集合；'canceled' 是被裁断的旧拼写（唯一拼写为 cancelled）。
    for (const status of ['pending', 'canceled', 'unknown-status']) {
      expect(
        ReadTasksPayloadSchema.safeParse({
          type: 'runtime:read-tasks',
          projectPath: '/tmp/runtime-contract.iartproj',
          transactionId: 'tx-read-tasks',
          status,
        }).success,
      ).toBe(false);
    }
  });

  it('parses storage read projections with hydrated runtime view schemas', () => {
    expect(StorageReadAllTasksResultSchema.parse({ tasks: [runtimeTask] }).tasks[0]?.taskId).toBe('task-1');
    expect(StorageReadTaskOutputsResultSchema.parse({ outputs: [taskOutput] }).outputs[0]?.outputId).toBe('output-1');
    expect(
      StorageReadMediaAssetsByTaskResultSchema.parse({ mediaAssets: [mediaAsset] }).mediaAssets[0]?.assetId,
    ).toBe('asset-1');

    // 'cancelled' 是现役取消终态（唯一拼写）；旧拼写 'canceled' 必须拒绝。
    expect(
      StorageReadAllTasksResultSchema.parse({
        tasks: [{ ...runtimeTask, status: 'cancelled' }],
      }).tasks[0]?.status,
    ).toBe('cancelled');
    expect(() =>
      StorageReadAllTasksResultSchema.parse({
        tasks: [{ ...runtimeTask, status: 'canceled' }],
      }),
    ).toThrow();
  });

  it('parses hydrated structured task failure and rejects row failureJson in UI contracts', () => {
    const failure = {
      code: 'PUBLIC_ERROR_SEXUAL',
      message: '内容安全策略拦截',
      userMessage: '内容安全策略拦截',
      backendMessage: 'check status failed: {...}',
      retryable: false,
      details: { failureReasons: ['NCII'] },
    };

    expect(
      TaskStateNotificationSchema.parse({
        type: 'task:state-changed',
        projectPath: '/tmp/runtime-contract.iartproj',
        task: { ...runtimeTask, status: 'failed', failure },
        outputs: [],
        mediaAssets: [],
      }).task.failure?.code,
    ).toBe('PUBLIC_ERROR_SEXUAL');

    expect(
      TaskStateNotificationSchema.safeParse({
        type: 'task:state-changed',
        projectPath: '/tmp/runtime-contract.iartproj',
        task: { ...runtimeTask, status: 'failed', failureJson: JSON.stringify(failure) },
        outputs: [],
        mediaAssets: [],
      }).success,
    ).toBe(false);
  });

  it('rejects row JSON fields in notification and storage read result contracts', () => {
    expect(
      TaskStateNotificationSchema.safeParse({
        type: 'task:state-changed',
        projectPath: '/tmp/runtime-contract.iartproj',
        task: { ...runtimeTask, metadataJson: '{}' },
        outputs: [taskOutput],
        mediaAssets: [mediaAsset],
      }).success,
    ).toBe(false);

    expect(
      StorageReadMediaAssetsByTaskResultSchema.safeParse({
        mediaAssets: [
          {
            assetId: 'asset-1',
            mediaType: 'image',
            payloadJson: JSON.stringify({ original: { url: '/files/asset-1.png' } }),
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects media asset original.url with legacy path form', () => {
    const legacyPathAsset = {
      assetId: 'asset-legacy',
      mediaType: 'image',
      original: {
        url: '/project-media/prj_x/foo.png',
        projectRef: 'prj_x',
        fileKey: 'foo.png',
      },
      thumbnail: {
        url: null,
        status: 'missing',
      },
      lifecycle: {
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const result = RuntimeMediaAssetViewSchema.safeParse(legacyPathAsset);
    expect(result.success).toBe(false);
    if (!result.success) {
      const urlIssues = result.error.issues.filter(
        (issue) => issue.message === 'URL must start with local-media:// scheme',
      );
      expect(urlIssues.length).toBeGreaterThan(0);
    }
  });

  it('rejects media asset original.url with http scheme', () => {
    const httpAsset = {
      assetId: 'asset-http',
      mediaType: 'image',
      original: {
        url: 'http://example.com/foo.png',
        projectRef: 'prj_x',
        fileKey: 'foo.png',
      },
      thumbnail: {
        url: null,
        status: 'missing',
      },
      lifecycle: {
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const result = RuntimeMediaAssetViewSchema.safeParse(httpAsset);
    expect(result.success).toBe(false);
    if (!result.success) {
      const urlIssues = result.error.issues.filter(
        (issue) => issue.message === 'URL must start with local-media:// scheme',
      );
      expect(urlIssues.length).toBeGreaterThan(0);
    }
  });

  it('accepts media asset original.url with local-media:// scheme', () => {
    const validAsset = {
      assetId: 'asset-valid',
      mediaType: 'image',
      original: {
        url: 'local-media://prj_x/foo.png',
        projectRef: 'prj_x',
        fileKey: 'foo.png',
      },
      thumbnail: {
        url: null,
        status: 'missing',
      },
      lifecycle: {
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const result = RuntimeMediaAssetViewSchema.safeParse(validAsset);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.original.url).toBe('local-media://prj_x/foo.png');
    }
  });

  it('rejects runtime task row carrying legacy requestBodyJson field', () => {
    const baseRow = {
      taskId: 'task-row-1',
      status: 'generating',
      projectPath: '/tmp/runtime-contract.iartproj',
      requestJson: JSON.stringify({ prompt: 'hello' }),
      metadataJson: null,
      createdAt: 1,
      updatedAt: 2,
    };

    expect(RuntimeTaskRowSchema.safeParse(baseRow).success).toBe(true);

    expect(
      RuntimeTaskRowSchema.safeParse({
        ...baseRow,
        requestBodyJson: JSON.stringify({ prompt: 'full-request-body' }),
      }).success,
    ).toBe(false);
  });

  it('hydrates runtime task request from requestJson only, ignoring any legacy full request body', () => {
    const summaryRequest = { prompt: 'summary', fileKey: 'abc.png', assetId: 'asset-1' };
    const view = runtimeTaskRowToView({
      taskId: 'task-hydrate-1',
      status: 'succeeded',
      projectPath: '/tmp/runtime-contract.iartproj',
      requestJson: JSON.stringify(summaryRequest),
      metadataJson: JSON.stringify({ plan: 'until-x' }),
      createdAt: 1,
      updatedAt: 2,
    });

    expect(view).not.toBeNull();
    expect(view?.request).toEqual(summaryRequest);
  });
});

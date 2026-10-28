import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRuntimeTaskRow,
  buildRuntimeTaskView,
  normalizeRuntimeTaskFailure,
} from '../task-payload-builder.cts';

void describe('task-payload-builder failure normalization', () => {
  void it('extracts structured failure from third-party JSON embedded in error text', () => {
    const rawText =
      'check status failed: {"code":"PUBLIC_ERROR_SEXUAL","failureReasons":["NCII"],"mediaMetadata":{"prompt":"long json"}} task_execution_failed';
    const failure = normalizeRuntimeTaskFailure({ message: rawText });

    assert.equal(failure?.code, 'PUBLIC_ERROR_SEXUAL');
    assert.equal(failure?.message, '内容安全策略拦截');
    assert.equal(failure?.userMessage, '内容安全策略拦截');
    assert.equal(failure?.backendMessage, rawText);
    assert.deepEqual(failure?.details, {
      code: 'PUBLIC_ERROR_SEXUAL',
      failureReasons: ['NCII'],
      mediaMetadata: { prompt: 'long json' },
    });
  });

  void it('only writes failureJson when the task record has real error input', () => {
    const okRow = buildRuntimeTaskRow({
      id: 'task-ok',
      status: 'polling',
      projectPath: '/tmp/demo.iartproj',
    });
    assert.equal(okRow.failureJson, null);

    const failedRow = buildRuntimeTaskRow({
      id: 'task-failed',
      status: 'failed',
      projectPath: '/tmp/demo.iartproj',
      error: { code: 'runtime_failed', message: '远端失败' },
    });
    assert.match(failedRow.failureJson ?? '', /runtime_failed/);
  });

  void it('summarizes requestJson and metadataJson without leaking base64 or full submit_request', () => {
    const row = buildRuntimeTaskRow({
      id: 'task-summary',
      status: 'submitting',
      projectPath: '/tmp/demo.iartproj',
      request: {
        url: 'https://example.com/generate',
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'multipart/form-data',
        },
        body: {
          __formData: {
            fields: [
              {
                name: 'file',
                filename: 'demo.png',
                contentType: 'image/png',
                dataBase64: 'a'.repeat(2048),
                value: 'a'.repeat(2048),
              },
            ],
          },
        },
      },
      metadata: {
        projectPath: '/tmp/demo.iartproj',
        taskExecutionPlan: {
          submit_request: {
            url: 'https://example.com/generate',
            method: 'POST',
            body: {
              dataBase64: 'b'.repeat(4096),
            },
          },
        },
      },
    });

    assert.ok(row.requestJson);
    assert.ok(row.metadataJson);
    assert.equal(row.requestJson?.includes('secret-token'), false);
    assert.equal(row.requestJson?.includes('hasDataBase64'), true);
    assert.equal(row.requestJson?.includes('a'.repeat(256)), false);
    assert.equal(row.metadataJson?.includes('"submit_request_summary"'), true);
    assert.equal(row.metadataJson?.includes('b'.repeat(256)), false);

    // 完整请求体不再进入正式 task row；只保留摘要化的 requestJson / metadataJson。
    assert.equal('requestBodyJson' in row, false);
  });

  void it('summarizes media file parts with wire values and source identity', () => {
    const row = buildRuntimeTaskRow({
      id: 'task-media-summary',
      status: 'succeeded',
      projectPath: '/tmp/demo.iartproj',
      request: {
        url: 'https://example.com/v1/videos',
        method: 'POST',
        headers: {},
        body: {
          __formData: {
            fields: [
              { name: 'model', value: 'example-model' },
              { name: 'prompt', value: '一只猫' },
            ],
            files: [
              {
                // 出网值：multipart part 上的两个标签（发送链只读这两个）。
                name: 'reference_image',
                filename: 'file',
                contentType: 'application/octet-stream',
                // 审计值：来源身份与真实媒体类型（发送链不读）。
                sourceFilename: 'media.png',
                mimeType: 'image/png',
                assetId: 'asset-1',
                slotId: 'reference_image',
                dataBase64: 'c'.repeat(1024),
              },
              {
                name: 'reference_image',
                filename: 'file',
                contentType: 'application/octet-stream',
                sourceFilename: 'media.png',
                mimeType: 'image/png',
                assetId: 'asset-2',
                slotId: 'reference_image',
                dataBase64: 'd'.repeat(512),
              },
            ],
          },
        },
      },
    });

    assert.ok(row.requestJson);
    const summary = JSON.parse(row.requestJson) as {
      body: {
        __formData: {
          fieldCount: number;
          fileCount: number;
          fields: unknown[];
          files: Array<Record<string, unknown>>;
        };
      };
    };
    const formData = summary.body.__formData;
    // 文本字段数与媒体文件数分开：只有 fields 的摘要会让「实际出网带了几张图」不可见。
    assert.equal(formData.fieldCount, 2);
    assert.equal(formData.fileCount, 2);
    assert.equal(formData.files.length, 2);
    const first = formData.files[0];
    assert.ok(first);
    assert.equal(first['name'], 'reference_image');
    assert.equal(first['filename'], 'file');
    assert.equal(first['contentType'], 'application/octet-stream');
    assert.equal(first['sourceFilename'], 'media.png');
    assert.equal(first['mimeType'], 'image/png');
    assert.equal(first['assetId'], 'asset-1');
    assert.equal(first['slotId'], 'reference_image');
    assert.deepEqual(first['dataBase64'], { kind: 'omitted_base64', size: 1024 });
    // base64 内容本身不进摘要。
    assert.equal(row.requestJson?.includes('c'.repeat(256)), false);
  });

  void it('projects startedAt/finishedAt into the task row and defaults to null (not undefined)', () => {
    const withTimes = buildRuntimeTaskRow({
      id: 'task-times',
      status: 'succeeded',
      projectPath: '/tmp/demo.iartproj',
      createdAt: 1000,
      updatedAt: 4000,
      startedAt: 1500,
      finishedAt: 3000,
    });
    assert.equal(withTimes.startedAt, 1500);
    assert.equal(withTimes.finishedAt, 3000);

    // 旧记录/未开始任务无执行时刻：输出 null 而非 undefined（契约不漂移），
    // createdAt（受理时刻）/updatedAt（最后回写时刻）不互替执行时刻。
    const withoutTimes = buildRuntimeTaskRow({
      id: 'task-no-times',
      status: 'submitting',
      projectPath: '/tmp/demo.iartproj',
      createdAt: 1000,
      updatedAt: 2000,
    });
    assert.equal(withoutTimes.startedAt, null);
    assert.equal(withoutTimes.finishedAt, null);
    assert.equal('startedAt' in withoutTimes, true);
    assert.equal('finishedAt' in withoutTimes, true);
  });

  void it('normalizes progressPhase to null in failed and cancelled task views', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const view = buildRuntimeTaskView({
        id: `task-${status}-view`,
        status,
        projectPath: '/tmp/demo.iartproj',
        progress: { phase: 'requesting', percent: 37 },
        error: { code: 'task_execution_failed', message: 'boom' },
      });
      assert.equal(view.progressPhase, null, `${status} 视图不得残留 progressPhase`);
      assert.equal(view.progressPercent, 37, '其余 progress 字段应保留');
    }
  });

  void it('keeps progressPhase for non-terminal statuses', () => {
    const row = buildRuntimeTaskRow({
      id: 'task-submitting-phase',
      status: 'submitting',
      projectPath: '/tmp/demo.iartproj',
      progress: { phase: 'requesting' },
    });
    assert.equal(row.progressPhase, 'requesting');
  });

  void it('keeps the legal succeeded completed phase', () => {
    const view = buildRuntimeTaskView({
      id: 'task-succeeded-view',
      status: 'succeeded',
      projectPath: '/tmp/demo.iartproj',
      progress: { phase: 'completed', percent: 100 },
    });
    assert.equal(view.progressPhase, 'completed');
  });
});

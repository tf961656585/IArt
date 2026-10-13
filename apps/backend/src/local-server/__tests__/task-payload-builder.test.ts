import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRuntimeTaskRow,
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
});

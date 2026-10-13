import { describe, expect, it } from 'vitest';

import { resolveTaskFailurePresentation } from '../taskFailurePresentation';
import type { NodeTaskInfo } from '../../types/node';

const createFailedTaskInfo = (overrides: Partial<NodeTaskInfo>): NodeTaskInfo => ({
  taskId: 'task-default',
  remoteRequestId: undefined,
  taskIndex: undefined,
  modelId: 'seedance',
  status: 'failed',
  progress: null,
  createdAt: 1,
  updatedAt: 2,
  error: undefined,
  failure: null,
  batchId: undefined,
  ...overrides,
});

describe('resolveTaskFailurePresentation', () => {
  it('turns structured safety failure into short UI summary and keeps raw detail for diagnostics', () => {
    const rawText =
      'check status failed: {"code":"PUBLIC_ERROR_SEXUAL","failureReasons":["NCII"],"mediaMetadata":{"prompt":"long json"}} task_execution_failed';

    const presentation = resolveTaskFailurePresentation({
      taskInfo: createFailedTaskInfo({
        taskId: 'task-1',
        modelId: 'seedance',
        failure: {
          code: 'PUBLIC_ERROR_SEXUAL',
          message: '内容安全策略拦截',
          backendMessage: rawText,
          details: {
            failureReasons: ['NCII'],
            mediaMetadata: { prompt: 'long json' },
          },
        },
      }),
      backendMessage: undefined,
      fallback: undefined,
    });

    expect(presentation?.summary).toBe('内容安全策略拦截');
    expect(presentation?.code).toBe('PUBLIC_ERROR_SEXUAL');
    expect(presentation?.reasonTags).toEqual(['NCII']);
    expect(presentation?.backendMessage).toBe(rawText);
    expect(presentation?.copyText).toContain(rawText);
  });

  it('copies remote API failure details from the unified RuntimeTaskFailure projection', () => {
    const presentation = resolveTaskFailurePresentation({
      taskInfo: createFailedTaskInfo({
        taskId: 'task-remote-error',
        modelId: 'gpt-image-2',
        failure: {
          code: 'moderation_blocked',
          message: 'Your request was rejected by the safety system...',
          backendMessage: 'HTTP 429\nYour request was rejected by the safety system...',
          details: {
            httpStatus: 429,
            remote: {
              code: 'moderation_blocked',
              type: 'image_generation_user_error',
              message: 'Your request was rejected by the safety system...',
            },
          },
        },
      }),
      backendMessage: undefined,
      fallback: undefined,
    });

    // code=moderation_blocked 为厂商明确语义码，httpStatus 查表让位于 message 链，
    // 429 是内容审核拒绝时借用的状态码，不得被误判为限流。
    expect(presentation?.summary).toBe('Your request was rejected by the safety system...');
    expect(presentation?.code).toBe('moderation_blocked');
    expect(presentation?.copyText).toContain('错误码: moderation_blocked');
    expect(presentation?.copyText).toContain('HTTP 429');
    expect(presentation?.copyText).toContain('"httpStatus": 429');
    expect(presentation?.copyText).toContain('"type": "image_generation_user_error"');
  });

  // Action 1c：按 failure.details.httpStatus 查 i18n（451/409/422/429/5xx），
  // 不依赖 message 子串；默认语言 zh-CN 下断言 i18n 本地化文案。
  it('maps details.httpStatus 451 to the localized region/legal summary', () => {
    const presentation = resolveTaskFailurePresentation({
      taskInfo: createFailedTaskInfo({
        taskId: 'task-http-451',
        failure: {
          code: 'task_execution_failed',
          message: 'HTTP 451',
          details: { httpStatus: 451 },
        },
      }),
      backendMessage: undefined,
      fallback: undefined,
    });

    expect(presentation?.summary).toMatch(/地区|法律/);
  });

  it('maps any 5xx details.httpStatus to the shared 5xx localized summary', () => {
    const presentation = resolveTaskFailurePresentation({
      taskInfo: createFailedTaskInfo({
        taskId: 'task-http-503',
        failure: {
          code: 'task_execution_failed',
          message: 'HTTP 503',
          details: { httpStatus: 503 },
        },
      }),
      backendMessage: undefined,
      fallback: undefined,
    });

    expect(presentation?.summary).toMatch(/远端服务|暂时不可用/);
  });

  it('does not treat a normal 200 failure as an httpStatus-mapped summary', () => {
    // 回归保护：200 既不在精确表也不在 5xx 区间，必须回退到原有 message 链。
    const presentation = resolveTaskFailurePresentation({
      taskInfo: createFailedTaskInfo({
        taskId: 'task-http-200',
        failure: {
          code: 'task_execution_failed',
          message: '模型服务返回了空响应',
          details: { httpStatus: 200 },
        },
      }),
      backendMessage: undefined,
      fallback: undefined,
    });

    expect(presentation?.summary).not.toMatch(/地区|法律|限流|暂时不可用/);
    expect(presentation?.summary).toBe('模型服务返回了空响应');
  });

  it('keeps original substring branches when details.httpStatus is absent', () => {
    // 回归保护：details 存在但无 httpStatus 时，message 链原样透传为摘要。
    const presentation = resolveTaskFailurePresentation({
      taskInfo: createFailedTaskInfo({
        taskId: 'task-no-http-status',
        failure: {
          code: 'task_execution_failed',
          message: '模型返回内容为空',
          details: { foo: 'bar' },
        },
      }),
      backendMessage: undefined,
      fallback: undefined,
    });

    expect(presentation?.summary).toBe('模型返回内容为空');
  });

  it('yields to the message chain for vendor semantic codes even with mapped httpStatus', () => {
    // 回归保护（厂商借壳状态码）：内容审核拒绝 code=moderation_blocked 复用 429 时，
    // httpStatus 查表必须让位（语义码优先），不得把内容安全拒绝误判为限流。
    const presentation = resolveTaskFailurePresentation({
      taskInfo: createFailedTaskInfo({
        taskId: 'task-moderation-yields',
        failure: {
          code: 'moderation_blocked',
          message: 'Your request was rejected by the safety system...',
          details: { httpStatus: 429 },
        },
      }),
      backendMessage: undefined,
      fallback: undefined,
    });

    expect(presentation?.summary).not.toMatch(/限流/);
    expect(presentation?.summary).toBe('Your request was rejected by the safety system...');
  });
});

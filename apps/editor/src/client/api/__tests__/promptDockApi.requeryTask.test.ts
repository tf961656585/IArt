// @spec: FTB-013
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { request } from '@/client/api/transport';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';

import { requeryTask } from '../promptDockApi';

/**
 * `requeryTask` HTTP 边界（spec：docs/editor/失败任务重新查询-design.md §4.1）。
 *
 * - 命令形态：POST /api/tasks/:id/requery?projectPath=（路径参数与项目路径都 encode）；
 * - 2xx 响应经共享契约 TaskRequeryAcceptedSchema.parse；
 * - 非 2xx 由 transport 抛 ApiError（body.code 供 UI 映射文案），client 不吞错；
 * - 本地前置条件缺失（taskId / projectPath）直接报错，不发请求。
 */

vi.mock('@/client/api/transport', () => ({
  request: vi.fn(),
}));

vi.mock('@/client/store/runtimeStore', () => ({
  getRuntimeProjectPath: vi.fn(() => '/tmp/demo project'),
}));

const requestMock = vi.mocked(request);
const getRuntimeProjectPathMock = vi.mocked(getRuntimeProjectPath);

const acceptedBody = {
  accepted: true as const,
  taskId: 'task-1',
  status: 'polling' as const,
  requestedAt: '2026-10-28T00:00:00.000Z',
};

beforeEach(() => {
  requestMock.mockReset();
  getRuntimeProjectPathMock.mockReset();
  getRuntimeProjectPathMock.mockReturnValue('/tmp/demo project');
});

describe('requeryTask', () => {
  it('POST /api/tasks/:id/requery?projectPath= 并 parse 受理回执', async () => {
    requestMock.mockResolvedValue(acceptedBody);

    await expect(requeryTask('task-1')).resolves.toEqual(acceptedBody);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({
      method: 'POST',
      endpoint: `/api/tasks/task-1/requery?projectPath=${encodeURIComponent('/tmp/demo project')}`,
      responseType: 'json',
    });
  });

  it('taskId 与 projectPath 都做 URL encode', async () => {
    requestMock.mockResolvedValue(acceptedBody);

    await requeryTask(' task/1 ');

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: `/api/tasks/${encodeURIComponent('task/1')}/requery?projectPath=${encodeURIComponent('/tmp/demo project')}`,
      }),
    );
  });

  it('非 2xx 的 ApiError 原样抛给调用方（body.code 留给 UI 映射）', async () => {
    const apiError = {
      message: 'HTTP 409',
      status: 409,
      body: { code: 'requery_ineligible', message: '这个任务不能重新查询。' },
    };
    requestMock.mockRejectedValue(apiError);

    await expect(requeryTask('task-1')).rejects.toBe(apiError);
  });

  it('2xx 但响应不合契约 → parse 报错，不把契约外形状放进下游', async () => {
    requestMock.mockResolvedValue({ accepted: true, taskId: 'task-1', status: 'failed' });

    await expect(requeryTask('task-1')).rejects.toThrow();
  });

  it('缺少 projectPath 时不发请求并报错', async () => {
    getRuntimeProjectPathMock.mockReturnValue(null);

    await expect(requeryTask('task-1')).rejects.toThrow(/projectPath/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('空 taskId 时不发请求并报错', async () => {
    await expect(requeryTask('   ')).rejects.toThrow(/taskId/);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

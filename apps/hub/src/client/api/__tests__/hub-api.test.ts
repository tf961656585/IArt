import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';

import { createHubApiClient } from '../hub-api';
import { createHubHttpClient } from '../../adapters/http-client';

describe('hub api task runtime boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses /api/tasks response with the shared runtime status schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            total: 1,
            limit: 50,
            offset: 0,
            tasks: [
              {
                taskId: 'task-1',
                id: 'task-1',
                projectPath: '/tmp/hub-task.iartproj',
                nodeGraphId: null,
                sourceNodeId: null,
                targetNodeId: null,
                executionId: null,
                modelId: null,
                remoteRequestId: null,
                status: 'pending',
                createdAt: 1,
                updatedAt: 2,
                errorMessage: null,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const api = createHubApiClient(createHubHttpClient('http://localhost:4877', undefined));

    await expect(
      api.loadTasks(
        {
          projectPath: '/tmp/hub-task.iartproj',
          status: undefined,
          limit: undefined,
          offset: undefined,
        },
        undefined,
      ),
    ).rejects.toThrow();
  });

  it('adds local write token only for non-GET hub requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit | undefined) => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const api = createHubApiClient(createHubHttpClient('http://localhost:4877', 'a'.repeat(32)));

    await api.savePromptPreset({ id: undefined, name: 'preset', content: 'prompt' });
    await api.deletePromptPreset('preset-id');
    await api.loadPromptPresets();

    const createHeaders = (fetchMock.mock.calls[0] ? fetchMock.mock.calls[0][1] : undefined)?.headers as Record<string, string>;
    expect(createHeaders[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBe('a'.repeat(32));

    const deleteHeaders = (fetchMock.mock.calls[1] ? fetchMock.mock.calls[1][1] : undefined)?.headers as Record<string, string>;
    expect(deleteHeaders[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBe('a'.repeat(32));

    const getHeaders = (fetchMock.mock.calls[2] ? fetchMock.mock.calls[2][1] : undefined)?.headers as Record<string, string> | undefined;
    expect(getHeaders == null ? undefined : getHeaders[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBeUndefined();
  });
});

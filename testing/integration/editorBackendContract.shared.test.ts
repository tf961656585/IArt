import { describe, expect, it } from 'vitest';

import {
  EDITOR_BACKEND_ACTION_CLASS,
  EDITOR_BACKEND_ACTION_NAME,
  EDITOR_BACKEND_ASYNC_EVENT,
  EDITOR_BACKEND_IDENTITY_OWNER,
  EDITOR_BACKEND_MEDIA_CONTRACT,
  EDITOR_BACKEND_PROJECT_SCOPE,
  EDITOR_BACKEND_RUNTIME_BOUNDARY,
  buildEditorLocalizedMediaDescriptor,
  normalizeEditorBackendBusinessSubmit,
} from '@iart/contracts/editor-backend-contract';

describe('editor-backend shared contract', () => {
  it('冻结 action envelope、owner 约束和 async 词表', () => {
    const submit = normalizeEditorBackendBusinessSubmit({
      actionId: 'action-1',
      actionName: 'workers_proxy.announcement',
      actionClass: EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
      projectPath: '/tmp/demo.iartproj',
      nodeGraphId: 'graph-1',
      payload: { hello: 'world' },
      requestedAt: '2026-03-19T01:00:00.000Z',
    });

    expect(submit).toEqual({
      type: 'editor_backend_business_submit',
      actionId: 'action-1',
      actionName: 'workers_proxy.announcement',
      actionClass: 'business_sync',
      projectPath: '/tmp/demo.iartproj',
      nodeGraphId: 'graph-1',
      payload: { hello: 'world' },
      requestedAt: '2026-03-19T01:00:00.000Z',
    });

    expect(EDITOR_BACKEND_ASYNC_EVENT).toEqual({
      ACK: 'ack',
      SNAPSHOT: 'snapshot',
      DELTA: 'delta',
      FINAL: 'final',
      ERROR: 'error',
      CANCELLED: 'cancelled',
    });
    expect(EDITOR_BACKEND_IDENTITY_OWNER.taskId).toBe('backend_assigned_on_ack');
    expect(EDITOR_BACKEND_RUNTIME_BOUNDARY.bootstrap.projectPath).toBe('infra_runtime');
    expect(EDITOR_BACKEND_RUNTIME_BOUNDARY.bootstrap.localApiBase).toBe('infra_runtime');
    expect(EDITOR_BACKEND_RUNTIME_BOUNDARY.session.open).toBe('business_sync');
    expect(EDITOR_BACKEND_RUNTIME_BOUNDARY.session.heartbeat).toBe('business_sync');
    expect(EDITOR_BACKEND_RUNTIME_BOUNDARY.editor.flush).toBe('infra_runtime');
    expect(EDITOR_BACKEND_RUNTIME_BOUNDARY.editor.close).toBe('infra_runtime');
    expect(EDITOR_BACKEND_PROJECT_SCOPE.WORKSPACE).toBe('__editor_workspace__');
    expect(EDITOR_BACKEND_ACTION_NAME.WORKERS_PROXY_ANNOUNCEMENT).toBe('workers_proxy.announcement');
  });

  it('冻结媒体本地化不变量为 backend owner + /files/...', () => {
    const media = buildEditorLocalizedMediaDescriptor({
      url: '/files/media/demo.png',
      originalUrl: 'https://example.com/demo.png',
      mediaType: 'image',
    });

    expect(media.localized).toBe(true);
    expect(media.owner).toBe('backend');
    expect(media.url).toBe('/files/media/demo.png');
    expect(EDITOR_BACKEND_MEDIA_CONTRACT.localizedUrlPrefix).toBe('/files/');
    expect(EDITOR_BACKEND_MEDIA_CONTRACT.displayRequiresLocalizedFile).toBe(true);
  });
});

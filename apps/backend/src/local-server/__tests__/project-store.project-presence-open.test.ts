import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeProjectSession,
  createProjectFolder,
  getOpenedProjectPaths,
  openProjectSessionPresence,
  prepareProjectSession,
  resolveProjectSessionAttach,
} from '../project-store.cts';

const createTempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

type CreatedProject = Exclude<ReturnType<typeof createProjectFolder>, null | undefined | { error: unknown }>;

const requireCreatedProject = (value: ReturnType<typeof createProjectFolder>): CreatedProject => {
  if (!value || 'error' in value) {
    throw new Error('project_creation_failed');
  }
  return value;
};

/**
 * session 逻辑为纯内存状态机，不依赖 desktop storage IPC adapter。
 * 直接经 createProjectFolder（纯目录创建）+ prepareProjectSession（纯内存）建立会话，
 * 避免 initializeEmptyProject/prepareProjectForEditor 依赖 backend 独立进程
 * 不可用的 storage adapter。
 */
const prepareSessionForProject = (tempDir: string, projectName: string) => {
  const created = createProjectFolder(tempDir, projectName);
  const project = requireCreatedProject(created);
  // session 存在性校验要求目录是合法项目（manifest.json 存在），
  // 仅目录结构不足以满足 isValidProjectFolder。
  fs.writeFileSync(
    path.join(project.projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: projectName }),
    'utf-8',
  );
  // resolveProjectSessionAttach 要求 preparedProject 非空；构造最小 ProjectRecord。
  const preparedProject = {
    name: projectName,
    path: project.projectPath,
    nodeGraphId: 'nodegraph-test',
    nodeGraph: { id: 'nodegraph-test', name: projectName, nodes: [], settings: {} },
    mediaAssets: {},
    savedAt: 0,
    hasUnsavedChanges: false,
    createdAt: 0,
  };
  const editorOpenTarget = prepareProjectSession(project.projectPath, {
    preparedProject,
  });
  assert.ok(editorOpenTarget, 'session should be prepared');
  return { project, editorOpenTarget };
};

void test('session.open attach: 会话无效时直接返回 token 校验失败', () => {
  const tempDir = createTempDir('project-presence-open-invalid-session-');

  try {
    const { project } = prepareSessionForProject(tempDir, 'demo-invalid-session');

    const result = resolveProjectSessionAttach(
      project.projectPath,
      'wrong-session-token',
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'token_mismatch');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('session.open attach: 会话有效时返回 preflight 已准备的项目快照', () => {
  const tempDir = createTempDir('project-presence-open-valid-session-');

  try {
    const { project, editorOpenTarget } = prepareSessionForProject(tempDir, 'demo-valid-session');
    const sessionToken = editorOpenTarget.sessionToken;

    const result = resolveProjectSessionAttach(
      project.projectPath,
      sessionToken,
    );

    assert.equal(result.ok, true);
    assert.equal(result.result.sessionToken, sessionToken);
    assert.equal(result.result.project.path, project.projectPath);

    const retry = resolveProjectSessionAttach(
      project.projectPath,
      sessionToken,
    );
    assert.equal(retry.ok, true);
    assert.equal(retry.result.sessionToken, sessionToken);
    assert.equal(retry.result.project.path, project.projectPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('presence.open/close: 同 token 可推进 opened 并可从 attached/opened 回收', () => {
  const tempDir = createTempDir('project-presence-open-close-idempotent-');

  try {
    const { project, editorOpenTarget } = prepareSessionForProject(tempDir, 'demo-presence-open-close');
    const sessionToken = editorOpenTarget.sessionToken;

    const attached = resolveProjectSessionAttach(
      project.projectPath,
      sessionToken,
    );
    assert.equal(attached.ok, true);

    const opened = openProjectSessionPresence(project.projectPath, sessionToken);
    assert.equal(opened.ok, true);
    assert.equal(opened.transitioned, true);
    assert.deepEqual(getOpenedProjectPaths(), [project.projectPath]);

    const reopened = openProjectSessionPresence(project.projectPath, sessionToken);
    assert.equal(reopened.ok, true);
    assert.equal(reopened.transitioned, false);
    assert.deepEqual(getOpenedProjectPaths(), [project.projectPath]);

    const closed = closeProjectSession(project.projectPath, sessionToken);
    assert.equal(closed, true);
    assert.deepEqual(getOpenedProjectPaths(), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

void test('session.open attach: 不同 token 不能重入同一项目会话', () => {
  const tempDir = createTempDir('project-presence-open-token-exclusive-');

  try {
    const { project, editorOpenTarget } = prepareSessionForProject(tempDir, 'demo-token-exclusive');
    const sessionToken = editorOpenTarget.sessionToken;

    const attached = resolveProjectSessionAttach(
      project.projectPath,
      sessionToken,
    );
    assert.equal(attached.ok, true);

    const otherToken = `${sessionToken}-other`;
    const retryWithOtherToken = resolveProjectSessionAttach(
      project.projectPath,
      otherToken,
    );
    assert.equal(retryWithOtherToken.ok, false);
    assert.equal(retryWithOtherToken.reason, 'token_mismatch');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

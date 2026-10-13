// @vitest-environment node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, it } from 'vitest';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const storageServiceEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-service.cjs`;
const recentProjectsEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-recent-projects.cjs`;

type RecentProjectRecord = {
  nodeGraphId: string;
  name: string;
  path: string;
  createdAt: number;
  savedAt: number;
  lastOpenedAt: number;
};

type StorageServiceModule = {
  addRecentProject: (project: RecentProjectRecord) => void;
  closeAll: () => void;
  deleteProject: (params: { projectPath: string }) => void;
  listProjects: () => Array<{ path: string }>;
};

type RecentProjectsModule = {
  readRecentProjects: () => Array<{ path: string }>;
};

const loadStorageModules = () => ({
  service: requireDesktop(storageServiceEntry) as StorageServiceModule,
  recentProjects: requireDesktop(recentProjectsEntry) as RecentProjectsModule,
});

const withIsolatedHome = async (
  service: StorageServiceModule,
  fn: (paths: { homeDir: string; projectsDir: string }) => Promise<void> | void,
): Promise<void> => {
  const previousHome = process.env['HOME'];
  const previousUserProfile = process.env['USERPROFILE'];
  const previousNodeEnv = process.env['NODE_ENV'];
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-storage-delete-home-'));
  const projectsDir = path.join(homeDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  process.env['HOME'] = homeDir;
  process.env['USERPROFILE'] = homeDir;
  process.env['NODE_ENV'] = 'development';

  try {
    await fn({ homeDir, projectsDir });
  } finally {
    service.closeAll();
    if (previousHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env['USERPROFILE'];
    } else {
      process.env['USERPROFILE'] = previousUserProfile;
    }
    if (previousNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = previousNodeEnv;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
};

describe('editor storage project delete', () => {
  beforeAll(() => {
    if (!existsSync(storageServiceEntry) || !existsSync(recentProjectsEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  it('deleteProject 只移除项目列表记录，不删除磁盘项目目录', async () => {
    const { service, recentProjects } = loadStorageModules();
    await withIsolatedHome(service, ({ projectsDir }) => {
      const projectPath = path.join(projectsDir, 'KeepOnDisk.iartproj');
      fs.mkdirSync(projectPath, { recursive: true });
      fs.writeFileSync(path.join(projectPath, 'project.sqlite'), '');
      const markerPath = path.join(projectPath, 'marker.txt');
      fs.writeFileSync(markerPath, 'project data must remain on disk');
      service.addRecentProject({
        nodeGraphId: 'graph_keep_on_disk',
        name: 'KeepOnDisk.iartproj',
        path: projectPath,
        createdAt: 1,
        savedAt: 2,
        lastOpenedAt: 3,
      });

      assert.equal(fs.existsSync(projectPath), true, 'project directory should exist before delete');
      assert.equal(recentProjects.readRecentProjects().some((project) => project.path === projectPath), true);

      service.deleteProject({ projectPath });

      assert.equal(fs.existsSync(projectPath), true, 'project directory must remain after deleteProject');
      assert.equal(fs.existsSync(path.join(projectPath, 'project.sqlite')), true, 'project sqlite must remain');
      assert.equal(fs.readFileSync(markerPath, 'utf-8'), 'project data must remain on disk');
      assert.equal(recentProjects.readRecentProjects().some((project) => project.path === projectPath), false);
      assert.equal(service.listProjects().some((project) => project.path === projectPath), false);
    });
  });
});

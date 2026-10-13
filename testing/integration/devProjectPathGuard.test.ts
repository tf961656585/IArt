// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const createdDirs: string[] = [];

const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-project-path-guard-'));
  createdDirs.push(dir);
  return dir;
};

const hasProjectSqliteFiles = (dir: string) =>
  fs.readdirSync(dir).some((name) => name === 'project.sqlite' || name.startsWith('project.sqlite-'));

describe('dev projectPath guard', () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Storage 不把空白 projectPath 解析成当前工作目录并建库', () => {
    const tempDir = makeTempDir();
    const script = `
      import { getDb, getDbForExistingProject } from '${path
        .join(process.cwd(), 'apps/desktop-shell/src/storage/editor-storage-service-impl.cts')
        .replace(/\\/g, '\\\\')}';
      process.chdir(${JSON.stringify(tempDir)});
      const assertThrows = (value) => {
        let threw = false;
        try { getDb(value); } catch (error) { threw = String(error?.message || error).includes('INVALID_PROJECT_PATH'); }
        if (!threw) throw new Error('getDb accepted invalid projectPath');
      };
      assertThrows('');
      assertThrows('   ');
      if (getDbForExistingProject('') !== null) throw new Error('empty path accepted');
      if (getDbForExistingProject('   ') !== null) throw new Error('blank path accepted');
      if (getDbForExistingProject(undefined) !== null) throw new Error('undefined path accepted');
      if (getDbForExistingProject(${JSON.stringify(tempDir)}) !== null) throw new Error('directory without manifest accepted');
    `;
    execFileSync('pnpm', ['exec', 'tsx', '-e', script], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    expect(hasProjectSqliteFiles(tempDir)).toBe(false);
  });

  it('Backend 恢复链路不保留空 projectPath 读任务入口', () => {
    // 守卫已收口到 task-engine-runtime.cts（resumeIncompletePollingTasks 所在模块）。
    const taskEngineRuntime = fs.readFileSync(
      path.join(process.cwd(), 'apps/backend/src/local-server/task-engine-runtime.cts'),
      'utf8',
    );
    const taskEngine = fs.readFileSync(
      path.join(process.cwd(), 'apps/backend/src/local-server/task-engine.cts'),
      'utf8',
    );
    const taskExecutor = fs.readFileSync(
      path.join(process.cwd(), 'apps/backend/src/local-server/task-executor.cts'),
      'utf8',
    );
    const backendMain = fs.readFileSync(path.join(process.cwd(), 'apps/backend/src/main.cts'), 'utf8');

    expect(taskEngine).not.toContain("sendReadTasks({ projectPath: ''");
    expect(taskEngine).not.toContain("projectPath: resolvedProjectPath || ''");
    expect(taskEngineRuntime).toContain('if (!resolvedProjectPath) return { started: 0, failed: 0 }');
    expect(taskExecutor).toContain('if (!projectPath) return { started: 0 }');
    expect(backendMain).not.toContain("sendReadTasks({ projectPath: ''");
  });
});

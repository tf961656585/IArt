import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { collectDesktopE2EReportState } from './desktop-electron-e2e-report.mjs';

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const electronBinary = require('electron');

const fail = (message, extra = '') => {
  console.error(`[desktop-electron-e2e] ${message}`);
  if (extra) {
    console.error(extra);
  }
  process.exit(1);
};

const waitFor = async (check, timeoutMs, intervalMs = 100) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-electron-e2e-'));
// e2e 项目落在系统临时目录（os.tmpdir），macOS 会定期清理 3 天未访问的文件；
// 运行结束后必须自清理，防止残留 demo 项目被当作真实项目打开后媒体丢失。
process.on('exit', () => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不影响退出码
  }
});
const reportPath = path.join(tempRoot, 'desktop-e2e-report.jsonl');
const projectPath = path.join(tempRoot, 'demo.iartproj');
const e2eTimeoutMs = 45000;
const fixtureScriptPath = path.join(tempRoot, 'create-project-fixture.cjs');
fs.writeFileSync(
  fixtureScriptPath,
  [
    `const storageService = require(${JSON.stringify(path.join(repoRoot, 'apps', 'desktop-shell', 'dist', 'storage', 'editor-storage-service.cjs'))});`,
    `storageService.createProject({ parentDir: ${JSON.stringify(tempRoot)}, name: 'demo.iartproj', nodeGraph: undefined, mediaAssets: undefined });`,
    'storageService.closeAll();',
  ].join('\n'),
  'utf8',
);
const fixtureResult = spawnSync(electronBinary, [fixtureScriptPath], {
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'pipe',
});
if (fixtureResult.status !== 0) {
  fail(
    'failed to create project fixture',
    `stdout:\n${String(fixtureResult.stdout)}\n\nstderr:\n${String(fixtureResult.stderr)}`,
  );
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
env.IART_E2E_REPORT_PATH = reportPath;
env.IART_E2E_OPEN_EDITOR_PROJECT_PATH = projectPath;
env.IART_E2E_AUTO_EXIT = '1';
env.IART_E2E_TIMEOUT_MS = String(e2eTimeoutMs);

const child = spawn(electronBinary, [repoRoot], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (chunk) => {
  stdout += String(chunk);
});

child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const cleanup = () => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
};

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

try {
  const reportState = await waitFor(() => {
    const state = collectDesktopE2EReportState(reportPath);
    if (state.bootstrapError) return state;
    if (child.exitCode !== null) return state;
    if (state.rendererReady && state.missingEvents.length === 0) return state;
    return null;
  }, e2eTimeoutMs);
  const { entries, missingEvents, rendererReady, bootstrapError } = reportState;

  if (child.exitCode !== null && child.exitCode !== 0) {
    fail(
      `electron exited with code ${child.exitCode ?? 'null'}`,
      `stdout:\n${stdout}\n\nstderr:\n${stderr}\n\nreport:\n${JSON.stringify(entries, null, 2)}`,
    );
  }

  if (bootstrapError) {
    fail(
      'renderer reported bootstrap error',
      `stdout:\n${stdout}\n\nstderr:\n${stderr}\n\nreport:\n${JSON.stringify(entries, null, 2)}`,
    );
  }

  if (missingEvents.length > 0) {
    fail(
      `missing required event: ${missingEvents.join(', ')}`,
      `stdout:\n${stdout}\n\nstderr:\n${stderr}\n\nreport:\n${JSON.stringify(entries, null, 2)}`,
    );
  }

  if (rendererReady?.detail?.projectPath !== projectPath) {
    fail(
      'renderer bootstrap projectPath mismatch',
      `expected: ${projectPath}\nactual: ${String(rendererReady?.detail?.projectPath || '')}`,
    );
  }

  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(rendererReady?.detail?.backendBaseUrl || ''))) {
    fail(
      'renderer bootstrap backendBaseUrl is invalid',
      `actual: ${String(rendererReady?.detail?.backendBaseUrl || '')}`,
    );
  }

  if (!/^desktop:/.test(String(rendererReady?.detail?.sessionToken || ''))) {
    fail(
      'renderer bootstrap sessionToken is invalid',
      `actual: ${String(rendererReady?.detail?.sessionToken || '')}`,
    );
  }

  console.log('[desktop-electron-e2e] ok real Electron host chain bootstrap');
} catch (error) {
  const { entries } = collectDesktopE2EReportState(reportPath);
  fail(
    error instanceof Error ? error.message : 'unknown failure',
    `stdout:\n${stdout}\n\nstderr:\n${stderr}\n\nreport:\n${JSON.stringify(entries, null, 2)}`,
  );
} finally {
  cleanup();
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

void test('runtime env loader: 候选 .env 路径按 execDir -> cwd -> repoRoot -> resourcesDir 排序且会去重', async (t) => {
  const { resolveRuntimeEnvFileCandidates } = await import('../runtime-env-loader.cts');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-env-candidates-'));
  const execDir = path.join(tempDir, 'exec');
  const cwdDir = path.join(tempDir, 'cwd');
  const repoRoot = path.join(tempDir, 'repo');
  const resourcesDir = path.join(tempDir, 'resources');
  fs.mkdirSync(execDir, { recursive: true });
  fs.mkdirSync(cwdDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  const previousExplicitEnvFile = process.env['IART_ENV_FILE'];
  delete process.env['IART_ENV_FILE'];

  t.after(() => {
    restoreEnv('IART_ENV_FILE', previousExplicitEnvFile);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const candidates = resolveRuntimeEnvFileCandidates({
    execDir,
    cwd: cwdDir,
    repoRoot,
    packagedAppRoot: undefined,
    resourcesDir,
  });

  assert.deepEqual(candidates, [
    path.join(execDir, '.env'),
    path.join(cwdDir, '.env'),
    path.join(repoRoot, '.env'),
    path.join(resourcesDir, '.env'),
  ]);
});

void test('runtime env loader: 会从首个存在的 .env 注入缺失变量且不覆盖已有 process.env', async (t) => {
  const { loadRuntimeEnv } = await import('../runtime-env-loader.cts');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-env-load-'));
  const execDir = path.join(tempDir, 'exec');
  const repoRoot = path.join(tempDir, 'repo');
  fs.mkdirSync(execDir, { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });

  const preservedKey = 'IART_RUNTIME_ENV_LOADER_PRESERVE_TEST';
  const injectedKey = 'IART_RUNTIME_ENV_LOADER_INJECT_TEST';
  const previousPreserved = process.env[preservedKey];
  const previousInjected = process.env[injectedKey];
  const previousExplicitEnvFile = process.env['IART_ENV_FILE'];

  fs.writeFileSync(path.join(execDir, '.env'), `${preservedKey}=from_exec\n${injectedKey}=from_exec\n`, 'utf8');
  fs.writeFileSync(path.join(repoRoot, '.env'), `${injectedKey}=from_repo\n`, 'utf8');
  process.env[preservedKey] = 'from_process';
  delete process.env[injectedKey];
  delete process.env['IART_ENV_FILE'];

  t.after(() => {
    restoreEnv(preservedKey, previousPreserved);
    restoreEnv(injectedKey, previousInjected);
    restoreEnv('IART_ENV_FILE', previousExplicitEnvFile);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const result = loadRuntimeEnv({
    execDir,
    cwd: path.join(tempDir, 'missing-cwd'),
    repoRoot,
    packagedAppRoot: undefined,
    resourcesDir: undefined,
  });

  assert.equal(process.env[preservedKey], 'from_process');
  assert.equal(process.env[injectedKey], 'from_exec');
  assert.deepEqual(result.loadedFiles, [
    path.join(execDir, '.env'),
    path.join(repoRoot, '.env'),
  ]);
});

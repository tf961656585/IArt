import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const scripts = {
  timeout: path.join(ROOT, 'tooling/scripts/guard-no-internal-timeout.mjs'),
  ipc: path.join(ROOT, 'tooling/scripts/guard-ipc-contract-parse.mjs'),
  ownership: path.join(ROOT, 'tooling/scripts/guard-contract-ownership.mjs'),
  jsonLeak: path.join(ROOT, 'tooling/scripts/guard-no-runtime-json-leak.mjs'),
  jsonClone: path.join(ROOT, 'tooling/scripts/guard-no-json-clone.mjs'),
  localMediaUrlResolution: path.join(ROOT, 'tooling/scripts/guard-local-media-url-resolution.mjs'),
  desktopRuntimeDeps: path.join(ROOT, 'tooling/scripts/guard-desktop-runtime-deps.mjs'),
};

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const createFixture = (policy) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-guards-'));
  const policyPath = 'policy.json';
  writeFile(path.join(root, policyPath), JSON.stringify(policy, null, 2));
  return { root, policyPath };
};

const runGate = (script, root, policyPath) =>
  spawnSync(process.execPath, [script, '--root', root, '--policy', policyPath], {
    cwd: root,
    encoding: 'utf8',
  });

const runDesktopRuntimeDepsGate = (root) =>
  spawnSync(process.execPath, [scripts.desktopRuntimeDeps, root], {
    cwd: root,
    encoding: 'utf8',
  });

test('no-internal-timeout rejects internal timeout abort and allows UI debounce boundary', () => {
  const fixture = createFixture({
    zones: ['src/internal'],
    boundaryZones: ['src/internal/ui/**', '**/*.test.ts'],
    timeoutNames: ['timeout', 'timeoutMs', '*TimeoutMs', 'withTimeout'],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  writeFile(
    path.join(fixture.root, 'src/internal/api.ts'),
    `
export const request = async (url: string, timeoutMs = 1000) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal });
};
`,
  );
  writeFile(
    path.join(fixture.root, 'src/internal/ui/debounce.ts'),
    `
export const debounce = (callback: () => void) => {
  window.setTimeout(callback, 120);
};
`,
  );

  const failed = runGate(scripts.timeout, fixture.root, fixture.policyPath);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /internal\/no-timeout-abort/);
});

test('no-internal-timeout allows explicit timeoutMs config in internal communication', () => {
  const fixture = createFixture({
    zones: ['packages/chat-adapter/src'],
    boundaryZones: ['**/*.test.ts'],
    timeoutNames: ['timeout', 'timeoutMs', '*TimeoutMs', 'withTimeout'],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  writeFile(
    path.join(fixture.root, 'packages/chat-adapter/src/good.ts'),
    `
export const createClient = () => ({
  timeoutMs: 60_000,
});
`,
  );

  const passed = runGate(scripts.timeout, fixture.root, fixture.policyPath);
  assert.equal(passed.status, 0, passed.stderr);
});

test('ipc-contract-parse rejects IPC assertions but allows schema parse', () => {
  const fixture = createFixture({
    zones: ['src'],
    boundaryZones: ['**/*.test.ts'],
    allowAssertedTypeSuffixes: ['View', 'Projection', 'Input', 'Row', 'Raw', 'Payload'],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  writeFile(
    path.join(fixture.root, 'src/bad.ts'),
    `
const api = window.electron;
type SaveProjectResponse = { ok: boolean };
export const bad = async () => {
  const result = await api.saveProject();
  return result as SaveProjectResponse;
};
`,
  );

  let result = runGate(scripts.ipc, fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ipc\/no-contract-assertion/);

  fs.rmSync(path.join(fixture.root, 'src/bad.ts'));
  writeFile(
    path.join(fixture.root, 'src/good.ts'),
    `
const api = window.electron;
const SaveProjectResponseSchema = { parse: (value: unknown) => value };
export const good = async () => {
  return SaveProjectResponseSchema.parse(await api.saveProject());
};
`,
  );

  result = runGate(scripts.ipc, fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});

test('contract-ownership rejects duplicated shared contracts and allows local projections', () => {
  const fixture = createFixture({
    zones: ['src'],
    boundaryZones: ['**/*.test.ts'],
    forbiddenLocalDeclarations: ['*RuntimeTransaction*', '*TaskStateNotification*', '*StorageRead*Result'],
    allowedLocalSuffixes: ['View', 'Projection', 'Input', 'Row', 'Raw', 'Payload'],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  writeFile(
    path.join(fixture.root, 'src/contracts.ts'),
    `
interface TaskStateNotification {
  taskId: string;
}
interface TaskStateNotificationView {
  label: string;
}
`,
  );

  const failed = runGate(scripts.ownership, fixture.root, fixture.policyPath);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /contract\/owner-is-packages-contracts/);

  fs.rmSync(path.join(fixture.root, 'src/contracts.ts'));
  writeFile(
    path.join(fixture.root, 'src/projection.ts'),
    `
interface TaskStateNotificationView {
  label: string;
}
`,
  );

  const passed = runGate(scripts.ownership, fixture.root, fixture.policyPath);
  assert.equal(passed.status, 0, passed.stderr);
});

test('no-runtime-json-leak rejects row JSON fields in hydrated consumer zones', () => {
  const fixture = createFixture({
    zones: ['src'],
    boundaryZones: ['src/storage/**'],
    forbiddenNames: ['metadataJson', 'requestJson', 'payloadJson'],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  writeFile(
    path.join(fixture.root, 'src/bad.ts'),
    `
export const bad = (task: { metadataJson?: string }) => task.metadataJson;
`,
  );

  const failed = runGate(scripts.jsonLeak, fixture.root, fixture.policyPath);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /runtime\/no-json-row-field-leak/);

  fs.rmSync(path.join(fixture.root, 'src/bad.ts'));
  writeFile(
    path.join(fixture.root, 'src/good.ts'),
    `
export const good = (task: { metadata?: object }) => task.metadata;
`,
  );
  const passed = runGate(scripts.jsonLeak, fixture.root, fixture.policyPath);
  assert.equal(passed.status, 0, passed.stderr);
});

test('no-json-clone rejects JSON parse stringify clone', () => {
  const fixture = createFixture({
    zones: ['src'],
    boundaryZones: [],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  writeFile(
    path.join(fixture.root, 'src/bad.ts'),
    `
export const bad = (value: unknown) => JSON.parse(JSON.stringify(value));
`,
  );

  const failed = runGate(scripts.jsonClone, fixture.root, fixture.policyPath);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /runtime\/no-json-parse-stringify-clone/);

  fs.rmSync(path.join(fixture.root, 'src/bad.ts'));
  writeFile(
    path.join(fixture.root, 'src/good.ts'),
    `
export const good = (value: { id: string }) => ({ id: value.id });
`,
  );
  const passed = runGate(scripts.jsonClone, fixture.root, fixture.policyPath);
  assert.equal(passed.status, 0, passed.stderr);
});

test('desktop-runtime-deps rejects missing owner and packaged root dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-runtime-deps-'));
  writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: {}, devDependencies: { ws: '^8.0.0' } }, null, 2),
  );
  writeFile(
    path.join(root, 'apps/backend/package.json'),
    JSON.stringify({ name: '@iart/backend', dependencies: {}, devDependencies: { ws: '^8.0.0' } }, null, 2),
  );
  writeFile(
    path.join(root, 'apps/desktop-shell/package.json'),
    JSON.stringify({ name: '@iart/desktop-shell', dependencies: {} }, null, 2),
  );
  writeFile(
    path.join(root, 'apps/backend/src/server.cts'),
    `
import { WebSocketServer } from 'ws';
export const server = new WebSocketServer({ noServer: true });
`,
  );

  const failed = runDesktopRuntimeDepsGate(root);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Backend imports "ws"/);
  assert.match(failed.stderr, /apps\/backend\/package\.json devDependencies/);
  assert.match(failed.stderr, /root package\.json devDependencies/);

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { ws: '^8.0.0' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, 'apps/backend/package.json'),
    JSON.stringify({ name: '@iart/backend', dependencies: { ws: '^8.0.0' } }, null, 2),
  );

  const passed = runDesktopRuntimeDepsGate(root);
  assert.equal(passed.status, 0, passed.stderr);
});

test('desktop-runtime-deps follows createRequire aliases and allows desktop electron host imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-runtime-deps-'));
  writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { electron: '^1.0.0', sharp: '^1.0.0' } }, null, 2),
  );
  writeFile(
    path.join(root, 'apps/backend/package.json'),
    JSON.stringify({ name: '@iart/backend', dependencies: {} }, null, 2),
  );
  writeFile(
    path.join(root, 'apps/mcp-gateway/package.json'),
    JSON.stringify({ name: '@iart/mcp-gateway', dependencies: {} }, null, 2),
  );
  writeFile(
    path.join(root, 'apps/desktop-shell/package.json'),
    JSON.stringify({ name: '@iart/desktop-shell', dependencies: {} }, null, 2),
  );
  writeFile(
    path.join(root, 'apps/backend/src/image.cts'),
    `
import { createRequire } from 'node:module';
const load = createRequire(__filename);
export const sharp = load('sharp');
`,
  );
  writeFile(
    path.join(root, 'apps/desktop-shell/src/main.cts'),
    `
import { app } from 'electron';
export const name = app.name;
`,
  );

  const failed = runDesktopRuntimeDepsGate(root);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Backend imports "sharp"/);
  assert.match(failed.stderr, /missing apps\/backend\/package\.json dependencies\.sharp/);
  assert.doesNotMatch(failed.stderr, /Desktop Shell imports "electron"/);
});

test('local-media-url-resolution detects inline parsing and scope predicate, allows compliant usage', () => {
  const fixture = createFixture({
    zones: ['src/stable'],
    boundaryZones: ['src/stable/__tests__/**'],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  // 违规文件：内联 slice 解析 + 内联 scope 谓词组合
  writeFile(
    path.join(fixture.root, 'src/stable/violation.ts'),
    `
const url = 'local-media://spid_abc/x.png';
const rest = url.slice('local-media://'.length);
const isScope = (x: string) => isProjectRef(x) || x === '__global__';
`,
  );

  const failed = runGate(scripts.localMediaUrlResolution, fixture.root, fixture.policyPath);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /no-inline-local-media-parsing/);
  assert.match(failed.stderr, /no-inline-scope-predicate/);
});

test('local-media-url-resolution allows compliant code (extractMediaFileKey + isLocalMediaScope)', () => {
  const fixture = createFixture({
    zones: ['src/stable'],
    boundaryZones: ['src/stable/__tests__/**'],
    fileExtensions: ['.ts'],
    ignorePaths: [],
  });

  writeFile(
    path.join(fixture.root, 'src/stable/compliant.ts'),
    `
import { extractMediaFileKey, isLocalMediaScope } from '@iart/utils/media-file-key';
const url = 'local-media://spid_abc/x.png';
const key = extractMediaFileKey(url);
const ok = isLocalMediaScope('spid_abc');
const isLocal = url.startsWith('local-media://');
`,
  );

  const passed = runGate(scripts.localMediaUrlResolution, fixture.root, fixture.policyPath);
  assert.equal(passed.status, 0, passed.stderr);
});

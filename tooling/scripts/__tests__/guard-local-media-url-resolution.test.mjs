import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-local-media-url-resolution.mjs');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-media-url-resolution-'));
  const policyPath = 'policy.json';
  writeFile(
    path.join(root, policyPath),
    JSON.stringify(
      {
        zones: ['src/stable'],
        boundaryZones: ['src/stable/__tests__/**'],
        fileExtensions: ['.ts', '.tsx', '.cts'],
        ignorePaths: [],
      },
      null,
      2,
    ),
  );
  return { root, policyPath };
};

const runGate = (root, policyPath) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, '--policy', policyPath], {
    cwd: root,
    encoding: 'utf8',
  });

test('detects inline scope predicate combination: isProjectRef(x) || x === __global__', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/violation.ts'),
    `
import { isProjectRef } from '@iart/utils/project-ref';
const check = (x: string) => isProjectRef(x) || x === '__global__';
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const issues = result.stderr.match(/no-inline-scope-predicate/g) ?? [];
  assert.equal(issues.length, 1, `Expected 1 scope-predicate issue, got ${issues.length}\n${result.stderr}`);
});

test('detects inline scope predicate combination with isStableProjectId first (any order)', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/violation.ts'),
    `
import { isStableProjectId } from '@iart/utils/stable-project-id';
import { isProjectRef } from '@iart/utils/project-ref';
const check = (x: string) => isStableProjectId(x) || isProjectRef(x) || x === '__global__';
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const issues = result.stderr.match(/no-inline-scope-predicate/g) ?? [];
  assert.equal(issues.length, 1, `Expected 1 scope-predicate issue (any order), got ${issues.length}\n${result.stderr}`);
});

test('detects inline local-media URL parsing via .slice on string literal', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/violation.ts'),
    `
const url = 'local-media://spid_abc/x.png';
const rest = url.slice('local-media://'.length);
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const issues = result.stderr.match(/no-inline-local-media-parsing/g) ?? [];
  assert.equal(issues.length, 1, `Expected 1 parsing issue, got ${issues.length}\n${result.stderr}`);
});

test('detects inline local-media URL parsing via .split on LOCAL_MEDIA_SCHEME constant', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/violation.ts'),
    `
const LOCAL_MEDIA_SCHEME = 'local-media://';
const url = 'local-media://spid_abc/x.png';
const parts = url.split(LOCAL_MEDIA_SCHEME);
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const issues = result.stderr.match(/no-inline-local-media-parsing/g) ?? [];
  assert.equal(issues.length, 1, `Expected 1 parsing issue (LOCAL_MEDIA_SCHEME), got ${issues.length}\n${result.stderr}`);
});

test('allows compliant usage: extractMediaFileKey + isLocalMediaScope', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/compliant.ts'),
    `
import { extractMediaFileKey, isLocalMediaScope } from '@iart/utils/media-file-key';
const url = 'local-media://spid_abc/x.png';
const key = extractMediaFileKey(url);
const ok = isLocalMediaScope('spid_abc');
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});

test('allows startsWith scheme check (check-only, not parsing)', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/check.ts'),
    `
const url = 'local-media://spid_abc/x.png';
const isLocal = url.startsWith('local-media://');
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});

test('allows single isProjectRef usage (not a scope-identification combination)', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/single.ts'),
    `
import { isProjectRef } from '@iart/utils/project-ref';
const isV1 = (x: string) => isProjectRef(x);
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});

test('boundary zone (tests) allows any pattern', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/__tests__/free.ts'),
    `
const url = 'local-media://spid_abc/x.png';
const rest = url.slice('local-media://'.length);
const check = (x: string) => isProjectRef(x) || x === '__global__';
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});

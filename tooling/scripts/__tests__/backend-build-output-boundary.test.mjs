import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptsDir = path.join(repoRoot, 'tooling', 'scripts');
const forbiddenBackendBuildPath = ['apps', 'backend', 'dist'].join('/');

const listScriptEntrypoints = () =>
  fs.readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:mjs|cjs|js|ts)$/.test(entry.name))
    .map((entry) => path.join(scriptsDir, entry.name));

test('tooling script entrypoints do not depend on backend build internals directly', () => {
  for (const scriptPath of listScriptEntrypoints()) {
    const source = fs.readFileSync(scriptPath, 'utf-8');
    assert.doesNotMatch(
      source,
      new RegExp(forbiddenBackendBuildPath.replaceAll('/', '\\/')),
      path.relative(repoRoot, scriptPath),
    );
  }
});

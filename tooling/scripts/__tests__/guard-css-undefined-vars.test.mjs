import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-css-undefined-vars.mjs');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGate = (root, policyPath) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, '--policy', policyPath], {
    cwd: root,
    encoding: 'utf8',
  });

const createFixture = ({ runtimeInjectedVars } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'css-undefined-vars-'));
  const policyPath = 'policy.json';
  const policy = {
    zones: ['src'],
    boundaryZones: ['**/__tests__/**'],
    fileExtensions: ['.css', '.html'],
    ignorePaths: ['node_modules/**', '**/dist/**', '**/out/**'],
  };
  if (runtimeInjectedVars) policy.runtimeInjectedVars = runtimeInjectedVars;
  writeFile(path.join(root, policyPath), JSON.stringify(policy, null, 2));
  return { root, policyPath };
};

test('通过：:root 定义的变量被引用，退出码 0', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `:root {\n  --brand: #1f2430;\n}\n.btn { color: var(--brand); }\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('通过：已定义变量带冗余 fallback 不报错', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `:root {\n  --accent: #2563eb;\n}\n.x { background: var(--accent, #ccc); }\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('通过：变量定义在非 :root 选择器（组件局部变量），引用合法', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `.form-grid {\n  --gap: 12px;\n  gap: var(--gap);\n}\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('通过：HTML 内联 <style> 中定义与引用一致，退出码 0', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/index.html'),
    `<html><head><style>\n:root { --bg: #fff; }\nbody { background: var(--bg); }\n</style></head></html>`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('通过：注释里的 --name: 不被当作定义', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `:root { --real: #000; }\n/* --panel-bg: should not count as definition */\n.x { color: var(--real); }\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('拦截：CSS 中引用从未定义的变量，退出码 1 且命中规则 id', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `:root { --brand: #000; }\n.x { background: var(--panel-bg, rgba(0,0,0,0.03)); }\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /css\/undefined-var/);
  assert.match(result.stderr, /--panel-bg/);
});

test('拦截：HTML 内联 <style> 中引用未定义变量（带 fallback 仍报错）', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/index.html'),
    `<html><head><style>\n.x { background: var(--card-bg, #ffffff); }\n</style></head></html>`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /css\/undefined-var/);
  assert.match(result.stderr, /--card-bg/);
});

test('拦截：仅引用未定义变量，无任何定义', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `.x { color: var(--undef); }\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /css\/undefined-var/);
});

test('拦截：注释内伪定义不能掩盖真实未定义引用', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `/* --panel-bg: fake definition in comment */\n.x { background: var(--panel-bg); }\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--panel-bg/);
});

test('通过：runtimeInjectedVars 白名单变量在 CSS 中仅消费不报错', () => {
  const fixture = createFixture({ runtimeInjectedVars: ['marquee-shift', 'marquee-duration'] });
  writeFile(
    path.join(fixture.root, 'src/a.css'),
    `.track {\n  animation: marquee var(--marquee-duration, 6s) linear infinite;\n  transform: translateX(var(--marquee-shift, 0px));\n}\n`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('通过：多个 <style> 块各自闭合判定', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/index.html'),
    `<html><head><style>:root { --a: #000; }</style>
<style>.x { color: var(--a); }</style></head></html>`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  // 两个 style 块在同一文件内，--a 在第一块定义、第二块引用，单文件闭合判定应通过
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

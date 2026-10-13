import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const packageJsonPath = path.join(repoRoot, 'package.json');
const buildDesktopStaticPath = path.join(repoRoot, 'tooling', 'build', 'build-desktop-static.mjs');
const buildEditorStaticPath = path.join(repoRoot, 'tooling', 'build', 'build-editor-static.mjs');
const desktopDevDebugPath = path.join(repoRoot, 'tooling', 'dev', 'desktop-dev-debug.mjs');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const buildDesktopStaticSource = fs.readFileSync(buildDesktopStaticPath, 'utf8');
const buildEditorStaticSource = fs.readFileSync(buildEditorStaticPath, 'utf8');
const desktopDevDebugSource = fs.readFileSync(desktopDevDebugPath, 'utf8');

test('desktop:dev:latest 与默认桌面开发入口同口径', () => {
  const scripts = packageJson.scripts ?? {};

  assert.equal(scripts['build:desktop-static'], 'node ./tooling/build/build-desktop-static.mjs');
  assert.equal(scripts['desktop:dev:latest'], 'pnpm desktop:dev');
  assert.equal(scripts['desktop:dev'], 'pnpm check:preflight && pnpm desktop:run-built');
  assert.equal(scripts['desktop:dev:fast'], 'pnpm build:desktop-runtime && pnpm desktop:run-built');
});

test('桌面静态组合构建覆盖 shared 前置、Hub 与 Editor', () => {
  const contractsIndex = buildDesktopStaticSource.indexOf('"@iart/contracts"');
  const domainIndex = buildDesktopStaticSource.indexOf('"@iart/domain"');
  const backendSdkIndex = buildDesktopStaticSource.indexOf('"@iart/backend-sdk"');
  const hubIndex = buildDesktopStaticSource.indexOf('./tooling/build/build-hub-static.mjs');
  const editorIndex = buildDesktopStaticSource.indexOf('./tooling/build/build-editor-static.mjs');

  assert.equal(contractsIndex >= 0, true, '缺少 contracts 前置构建');
  assert.equal(domainIndex > contractsIndex, true, 'domain 前置构建顺序错误');
  assert.equal(backendSdkIndex > domainIndex, true, 'backend-sdk 前置构建顺序错误');
  assert.equal(hubIndex > backendSdkIndex, true, 'Hub 静态构建必须在 shared 前置之后');
  assert.equal(editorIndex > hubIndex, true, 'Editor 静态构建必须在 Hub 之后');
  assert.match(buildDesktopStaticSource, /IART_SKIP_WORKSPACE_PREREQS:\s*"1"/);
});

test('Editor 静态构建在组合入口下允许跳过重复 shared 前置', () => {
  assert.match(buildEditorStaticSource, /IART_SKIP_WORKSPACE_PREREQS/);
  assert.match(buildEditorStaticSource, /if \(shouldBuildWorkspacePrereqs\)/);
});

test('desktop:dev:debug 默认先构建本轮桌面运行产物', () => {
  const buildRuntimeIndex = desktopDevDebugSource.indexOf("runPnpmSync(['build:desktop-runtime'])");
  const verifyShellIndex = desktopDevDebugSource.indexOf("verifyPathExists('desktop shell entry'");
  const noBuildIndex = desktopDevDebugSource.indexOf("hasFlag('--no-build')");

  assert.equal(buildRuntimeIndex >= 0, true, 'debug 入口必须构建本轮桌面运行产物');
  assert.equal(verifyShellIndex > buildRuntimeIndex, true, 'debug 入口不得先读取旧 dist 再构建');
  assert.equal(noBuildIndex >= 0, true, 'debug 入口必须只通过显式 --no-build 跳过构建');
});

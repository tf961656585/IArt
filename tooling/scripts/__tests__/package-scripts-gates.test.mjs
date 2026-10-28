import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const eslintConfigPath = path.join(repoRoot, 'eslint.config.mjs');
const diagnoseGatesPath = path.join(repoRoot, 'tooling', 'scripts', 'diagnose-gates.mjs');
const diagnosePreflightPath = path.join(repoRoot, 'tooling', 'scripts', 'diagnose-preflight.mjs');
const verifyDesktopSmokePath = path.join(repoRoot, 'tooling', 'scripts', 'verify-desktop-smoke.mjs');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const eslintConfigSource = fs.readFileSync(eslintConfigPath, 'utf8');
const verifyDesktopSmokeSource = fs.readFileSync(verifyDesktopSmokePath, 'utf8');
const scripts = packageJson.scripts ?? {};

const assertCommandsInOrder = (script, commands) => {
  let previousIndex = -1;

  for (const command of commands) {
    const index = script.indexOf(command);
    assert.notEqual(index, -1, `缺少命令: ${command}`);
    assert.equal(index > previousIndex, true, `命令顺序错误: ${command}`);
    previousIndex = index;
  }
};

const writePnpmStub = ({ tempDir, callsPath, failingCommand }) => {
  const stubScriptPath = path.join(tempDir, 'pnpm-stub.cjs');
  const stubScript = `const fs = require('node:fs');
const callsPath = ${JSON.stringify(callsPath)};
const failingCommand = ${JSON.stringify(failingCommand)};
const command = process.argv.slice(2).join(' ');
fs.appendFileSync(callsPath, command + '\\n');
process.exit(command === failingCommand ? 1 : 0);
`;
  fs.writeFileSync(stubScriptPath, stubScript);
  fs.writeFileSync(
    path.join(tempDir, 'pnpm'),
    `#!/usr/bin/env node\nrequire(${JSON.stringify(stubScriptPath)});\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(tempDir, 'pnpm.cmd'),
    `@echo off\r\nnode "%~dp0pnpm-stub.cjs" %*\r\n`,
  );
};

test('workspace 类型检查覆盖 Editor', () => {
  assert.match(
    scripts['typecheck:workspaces'],
    /tsc -p apps\/editor\/tsconfig\.json --pretty --noEmit/,
  );
});

test('typecheck 明确转发 workspace 类型检查', () => {
  assert.equal(scripts.typecheck, 'pnpm typecheck:workspaces');
});

test('类型与边界门禁链路保持唯一顺序', () => {
  assert.equal(
    scripts['build:typecheck-deps'],
    'pnpm build:packages && pnpm --filter @iart/backend build && pnpm --filter @iart/desktop-shell build',
  );

  assert.equal(
    scripts['check:types-and-boundaries'],
    'pnpm build:typecheck-deps && pnpm typecheck:workspaces && pnpm lint && pnpm guard:stable-business-types && pnpm guard:canvas-selection-ownership && pnpm guard:dialog-sizing && pnpm guard:media-fit-contain && pnpm guard:elevation-z && pnpm guard:escape-stack && pnpm guard:css-undefined-vars && pnpm guard:css-size-tokens && pnpm guard:button-standard && pnpm guard:form-control-colors && pnpm guard:spec-test-linkage',
  );

  assertCommandsInOrder(scripts['check:types-and-boundaries'], [
    'pnpm build:typecheck-deps',
    'pnpm typecheck:workspaces',
    'pnpm lint',
    'pnpm guard:stable-business-types',
    'pnpm guard:canvas-selection-ownership',
    'pnpm guard:dialog-sizing',
    'pnpm guard:media-fit-contain',
    'pnpm guard:elevation-z',
    'pnpm guard:escape-stack',
    'pnpm guard:css-undefined-vars',
    'pnpm guard:css-size-tokens',
    'pnpm guard:button-standard',
    'pnpm guard:form-control-colors',
    'pnpm guard:spec-test-linkage',
  ]);
});

test('关键入口不重复内联静态硬门禁子步骤', () => {
  assert.doesNotMatch(scripts.prebuild, /check:types-and-boundaries|typecheck:workspaces|pnpm lint|guard:stable-business-types|guard:canvas-selection-ownership|guard:dialog-sizing|guard:media-fit-contain|guard:elevation-z|guard:escape-stack|guard:css-undefined-vars|guard:css-size-tokens|guard:button-standard|guard:form-control-colors|guard:spec-test-linkage/);
  assert.equal(scripts.build, 'pnpm check:preflight');
  assert.equal(scripts['desktop:dev:latest'], 'pnpm desktop:dev');
  assert.doesNotMatch(scripts.build, /typecheck:workspaces|pnpm lint|guard:stable-business-types|guard:canvas-selection-ownership|guard:dialog-sizing|guard:media-fit-contain|guard:elevation-z|guard:escape-stack|guard:css-undefined-vars|guard:css-size-tokens|guard:button-standard|guard:form-control-colors|guard:spec-test-linkage|diagnose:gates|diagnose:preflight/);
  assert.doesNotMatch(scripts['desktop:dev:latest'], /typecheck:workspaces|pnpm lint|guard:stable-business-types|guard:canvas-selection-ownership|guard:dialog-sizing|guard:media-fit-contain|guard:elevation-z|guard:escape-stack|guard:css-undefined-vars|guard:css-size-tokens|guard:button-standard|guard:form-control-colors|guard:spec-test-linkage|diagnose:gates|diagnose:preflight/);
});

test('预飞硬门禁入口覆盖运行构建发布风险', () => {
  assertCommandsInOrder(scripts['check:preflight'], [
    'pnpm check:types-and-boundaries',
    'pnpm test:scripts',
    'pnpm guard:no-internal-timeout',
    'pnpm guard:ipc-contract-parse',
    'pnpm guard:contract-ownership',
    'pnpm guard:no-runtime-json-leak',
    'pnpm guard:no-json-clone',
    'pnpm guard:local-media-url-resolution',
    'pnpm guard:desktop-runtime-deps',
    'pnpm ensure:desktop-deps',
    'pnpm build:desktop-runtime',
    'pnpm guard:public-relay-capabilities',
    'pnpm verify:desktop-smoke',
  ]);

  // 模型能力包不再是模型来源（spec 03 PC-15）：构建链不再打包任何模型资产目录。
  assert.equal(
    scripts['build:desktop-runtime'],
    'pnpm --filter @iart/backend build && pnpm --filter @iart/desktop-shell build && pnpm build:desktop-static',
  );
  assert.equal(scripts['build:model-asset-packages'], undefined);
  assert.equal(scripts['guard:no-internal-timeout'], 'node ./tooling/scripts/guard-no-internal-timeout.mjs');
  assert.equal(scripts['guard:ipc-contract-parse'], 'node ./tooling/scripts/guard-ipc-contract-parse.mjs');
  assert.equal(scripts['guard:contract-ownership'], 'node ./tooling/scripts/guard-contract-ownership.mjs');
  assert.equal(scripts['guard:public-relay-capabilities'], 'node --import tsx ./tooling/scripts/guard-public-relay-capabilities.mjs');
  assert.equal(scripts['guard:no-runtime-json-leak'], 'node ./tooling/scripts/guard-no-runtime-json-leak.mjs');
  assert.equal(scripts['guard:no-json-clone'], 'node ./tooling/scripts/guard-no-json-clone.mjs');
  assert.equal(scripts['guard:local-media-url-resolution'], 'node ./tooling/scripts/guard-local-media-url-resolution.mjs');
  assert.equal(scripts['guard:desktop-runtime-deps'], 'node ./tooling/scripts/guard-desktop-runtime-deps.mjs');
  assert.equal(scripts['guard:canvas-selection-ownership'], 'node ./tooling/scripts/guard-canvas-selection-ownership.mjs');
  assert.equal(scripts['guard:dialog-sizing'], 'node ./tooling/scripts/guard-dialog-sizing.mjs');
  assert.equal(scripts['guard:media-fit-contain'], 'node ./tooling/scripts/guard-media-fit-contain.mjs');
  assert.equal(scripts['guard:elevation-z'], 'node ./tooling/scripts/guard-elevation-z.mjs');
  assert.equal(scripts['guard:escape-stack'], 'node ./tooling/scripts/guard-escape-stack.mjs');
  assert.equal(scripts['guard:css-undefined-vars'], 'node ./tooling/scripts/guard-css-undefined-vars.mjs');
  assert.equal(scripts['guard:button-standard'], 'node ./tooling/scripts/guard-button-standard.mjs');
  assert.equal(scripts['guard:form-control-colors'], 'node ./tooling/scripts/guard-form-control-colors.mjs');
  assert.equal(scripts['guard:spec-test-linkage'], 'node ./tooling/scripts/guard-spec-test-linkage.mjs');
  assert.equal(scripts['ensure:desktop-deps'], 'node ./tooling/dev/ensure-desktop-deps.mjs');
});

test('默认 dev build pack dist 显式依赖预飞硬门禁', () => {
  assert.equal(scripts.build, 'pnpm check:preflight');
  assert.match(scripts['desktop:dev'], /^pnpm check:preflight && pnpm desktop:run-built$/);
  assert.equal(scripts['desktop:dev:latest'], 'pnpm desktop:dev');
  assert.equal(scripts['desktop:run-built'], 'pnpm ensure:desktop-deps && electron ./apps/desktop-shell/dist/main.cjs');
  assert.equal(scripts['desktop:dev:fast'], 'pnpm build:desktop-runtime && pnpm desktop:run-built');

  for (const name of [
    'desktop:pack',
    'desktop:dist:win:x64',
    'desktop:dist:mac',
    'desktop:dist:mac:zip',
    'desktop:dist:mac:arm64',
    'desktop:dist:mac:x64',
  ]) {
    assert.match(scripts[name], /^pnpm check:preflight && /, `${name} must start with check:preflight`);
    assert.doesNotMatch(scripts[name].replace('pnpm check:preflight', ''), /pnpm build( |$)|diagnose:preflight/);
  }
  assert.equal(scripts['desktop:dist'], 'pnpm desktop:dist:win:x64');
  assert.equal(typeof scripts['desktop:dist:mac:x64'], 'string');
});

test('打包入口在 electron-builder 后验证 packaged native runtime', () => {
  assert.equal(
    scripts['verify:packaged-native-runtimes'],
    'node ./tooling/scripts/verify-packaged-native-runtimes.mjs',
  );
  assert.equal(scripts['clean:desktop-artifacts'], 'node ./tooling/scripts/clean-desktop-artifacts.mjs');

  for (const name of [
    'desktop:pack',
    'desktop:dist:win:x64',
    'desktop:dist:mac',
    'desktop:dist:mac:zip',
    'desktop:dist:mac:arm64',
    'desktop:dist:mac:x64',
  ]) {
    assertCommandsInOrder(scripts[name], [
      'pnpm clean:desktop-artifacts',
      'electron-builder',
      'pnpm verify:packaged-native-runtimes',
    ]);
  }
});

test('asarUnpack 显式覆盖 packaged native media runtime', () => {
  const asarUnpack = packageJson.build?.asarUnpack ?? [];
  assert.equal(Array.isArray(asarUnpack), true, 'build.asarUnpack 必须是数组');
  assert.equal(asarUnpack.includes('**/node_modules/ffmpeg-static/**'), true, '缺少 ffmpeg-static 解包规则');
  assert.equal(
    asarUnpack.includes('**/apps/backend/native-modules/better-sqlite3/**'),
    true,
    '缺少 better-sqlite3 isolated runtime 解包规则',
  );
  assert.equal(asarUnpack.includes('**/node_modules/sharp/**'), true, '缺少 sharp 主包解包规则');
  assert.equal(
    asarUnpack.includes('**/node_modules/@img/sharp-*/**'),
    true,
    '缺少 sharp platform binding 包解包规则',
  );
  assert.equal(
    asarUnpack.includes('**/node_modules/@img/sharp-libvips-*/**'),
    true,
    '缺少 sharp libvips 包解包规则',
  );
  assert.equal(asarUnpack.includes('**/node_modules/koffi/**'), true, '缺少 koffi 主包解包规则');
  assert.equal(
    asarUnpack.includes('**/node_modules/@koromix/koffi-*/**'),
    true,
    '缺少 koffi 平台预编译包解包规则',
  );
});

test('packaged native runtime 显式携带 nested node_modules 闭包', () => {
  const extraResources = packageJson.build?.extraResources ?? [];
  assert.equal(Array.isArray(extraResources), true, 'build.extraResources 必须是数组');
  const nativeRuntimeNodeModules = extraResources.find(
    (entry) =>
      entry?.from === 'apps/backend/native-modules/better-sqlite3/electron/node_modules' &&
      entry?.to === 'app.asar.unpacked/apps/backend/native-modules/better-sqlite3/electron/node_modules',
  );
  assert.equal(Boolean(nativeRuntimeNodeModules), true, '缺少 better-sqlite3 electron runtime node_modules 复制规则');
});

// CLI-036：from 为单文件、to 为不带尾斜杠的名字时，electron-builder 把 to 当目标文件名
// （0.6.8 实锤：入口被拷成名为 cli 的无扩展名文件，CLI 全功能 MODULE_NOT_FOUND）。
// to 必须写目标完整路径 cli/cli-node-entry.cjs；产物面校验由 verify:packaged-native-runtimes 承载。
test('extraResources 的 CLI 入口条目必须以完整目标路径落盘（CLI-036）', () => {
  const extraResources = packageJson.build?.extraResources ?? [];
  const cliEntry = extraResources.find((entry) => entry?.from === 'apps/desktop-shell/dist/cli/cli-node-entry.cjs');
  assert.equal(Boolean(cliEntry), true, '缺少 CLI 入口脚本 extraResources 复制规则');
  assert.equal(
    cliEntry?.to,
    'cli/cli-node-entry.cjs',
    'CLI 入口 extraResources 的 to 必须是完整目标路径 cli/cli-node-entry.cjs（裸目录名会被当作目标文件名造成资源错位）',
  );
});

test('诊断入口不替代硬门禁主链', () => {
  assert.equal(scripts['diagnose:gates'], 'node ./tooling/scripts/diagnose-gates.mjs');
  assert.equal(
    scripts['check:types-and-boundaries'],
    'pnpm build:typecheck-deps && pnpm typecheck:workspaces && pnpm lint && pnpm guard:stable-business-types && pnpm guard:canvas-selection-ownership && pnpm guard:dialog-sizing && pnpm guard:media-fit-contain && pnpm guard:elevation-z && pnpm guard:escape-stack && pnpm guard:css-undefined-vars && pnpm guard:css-size-tokens && pnpm guard:button-standard && pnpm guard:form-control-colors && pnpm guard:spec-test-linkage',
  );
  assert.doesNotMatch(scripts.build, /diagnose:gates/);
  assert.doesNotMatch(scripts['desktop:dev:latest'], /diagnose:gates/);
  assert.doesNotMatch(scripts['check:preflight'], /diagnose:gates|diagnose:preflight/);
  assert.equal(scripts['diagnose:preflight'], 'node ./tooling/scripts/diagnose-preflight.mjs');
  assert.equal(fs.existsSync(diagnoseGatesPath), true);
  assert.equal(fs.existsSync(diagnosePreflightPath), true);
});

test('诊断入口失败后继续运行后续门禁并最终失败', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-gates-'));
  const callsPath = path.join(tempDir, 'pnpm-calls.txt');
  writePnpmStub({ tempDir, callsPath, failingCommand: 'build:typecheck-deps' });

  const result = spawnSync(process.execPath, [diagnoseGatesPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(callsPath, 'utf8').trim().split('\n'), [
    'build:typecheck-deps',
    'typecheck:workspaces',
    'lint',
    'guard:stable-business-types',
    'guard:canvas-selection-ownership',
    'guard:dialog-sizing',
    'guard:media-fit-contain',
    'guard:elevation-z',
    'guard:escape-stack',
    'guard:css-undefined-vars',
    'guard:css-size-tokens',
    'guard:button-standard',
    'guard:form-control-colors',
    'guard:spec-test-linkage',
  ]);
  assert.match(result.stdout, /未运行项：无/);
});

test('预飞诊断入口失败后继续运行后续门禁并最终失败', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-preflight-'));
  const callsPath = path.join(tempDir, 'pnpm-calls.txt');
  writePnpmStub({ tempDir, callsPath, failingCommand: 'guard:no-internal-timeout' });

  const result = spawnSync(process.execPath, [diagnosePreflightPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readFileSync(callsPath, 'utf8').trim().split('\n'), [
    'check:types-and-boundaries',
    'test:scripts',
    'guard:no-internal-timeout',
    'guard:ipc-contract-parse',
    'guard:contract-ownership',
    'guard:no-runtime-json-leak',
    'guard:no-json-clone',
    'guard:local-media-url-resolution',
    'guard:desktop-runtime-deps',
    'ensure:desktop-deps',
    'build:desktop-runtime',
    'guard:public-relay-capabilities',
    'verify:desktop-smoke',
  ]);
  assert.match(result.stdout, /首个失败项：guard:no-internal-timeout/);
  assert.match(result.stdout, /未运行项：无/);
  assert.match(result.stdout, /可单独复现：pnpm guard:no-internal-timeout/);
});

test('lint 保持零 warning 容忍', () => {
  assert.match(scripts.lint, /node --max-old-space-size=6144 \.\/node_modules\/eslint\/bin\/eslint\.js \./);
  assert.match(scripts.lint, /--max-warnings=0/);
  assert.match(scripts.lint, /pnpm guard:jsx-aschild-children/);
  assert.match(scripts.lint, /pnpm guard:code-file-lines/);
  assert.equal(scripts['guard:jsx-aschild-children'], 'node ./tooling/scripts/guard-jsx-aschild-children.mjs');
  assert.equal(scripts['guard:code-file-lines'], 'node ./tooling/scripts/guard-code-file-lines.mjs');
  assert.match(eslintConfigSource, /"max-lines":\s*\[\s*"error"/);
  assert.match(eslintConfigSource, /max:\s*1000/);
});

test('Backend 构建使用构建专用 tsconfig', () => {
  const backendPackageJsonPath = path.join(repoRoot, 'apps', 'backend', 'package.json');
  const backendPackageJson = JSON.parse(fs.readFileSync(backendPackageJsonPath, 'utf8'));

  assert.match(backendPackageJson.scripts.build, /tsc -p tsconfig\.build\.json/);
});

test('桌面运行产物构建先清理旧 dist', () => {
  const packagePaths = [
    path.join(repoRoot, 'apps', 'backend', 'package.json'),
    path.join(repoRoot, 'apps', 'desktop-shell', 'package.json'),
    path.join(repoRoot, 'packages', 'contracts', 'package.json'),
    path.join(repoRoot, 'packages', 'domain', 'package.json'),
    path.join(repoRoot, 'packages', 'model-asset-runtime', 'package.json'),
    path.join(repoRoot, 'packages', 'utils', 'package.json'),
    path.join(repoRoot, 'packages', 'backend-sdk', 'package.json'),
  ];

  for (const packagePath of packagePaths) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert.match(
      pkg.scripts.build,
      /node \.\.\/\.\.\/tooling\/build\/clean-dist\.mjs dist && /,
      `${packagePath} build must clean dist before emitting`,
    );
  }
});

test('ESLint type-aware 配置不使用 default project 兜底', () => {
  assert.match(eslintConfigSource, /projectService:\s*true/);
  assert.doesNotMatch(eslintConfigSource, /allowDefaultProject/);
});

test('ESLint 忽略静态构建产物', () => {
  assert.match(eslintConfigSource, /"apps\/editor\/dist-static\/\*\*"/);
  assert.match(eslintConfigSource, /"apps\/hub\/dist-static\/\*\*"/);
});

test('ESLint 禁止 ts-nocheck 并声明 Next workspace root', () => {
  assert.match(eslintConfigSource, /"ts-nocheck":\s*true/);
  assert.match(eslintConfigSource, /rootDir:\s*\["apps\/editor\/",\s*"apps\/hub\/"\]/);
});

test('desktop smoke 通过共享 pnpm runner 执行 Vitest', () => {
  assert.match(verifyDesktopSmokeSource, /resolvePnpmCommand/);
  assert.match(verifyDesktopSmokeSource, /shell: shouldUseShellOnWindows\(pnpmCommand\)/);
  assert.doesNotMatch(verifyDesktopSmokeSource, /pnpm\.cmd/);
  assert.doesNotMatch(verifyDesktopSmokeSource, /spawnSync\(\s*['"]pnpm['"]/);
});

test('desktop smoke 阻断 Desktop Shell .js 运行产物', () => {
  assert.match(verifyDesktopSmokeSource, /desktopShellDistDir/);
  assert.match(verifyDesktopSmokeSource, /filePath\.endsWith\('\.js'\)/);
  assert.match(verifyDesktopSmokeSource, /app\.asar inherits root package\.json type=module/);
});

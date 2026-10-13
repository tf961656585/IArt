import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-css-size-tokens.mjs');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGate = (root, policyPath) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, '--policy', policyPath], {
    cwd: root,
    encoding: 'utf8',
  });

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'css-size-tokens-'));
  const policyPath = 'policy.json';
  const policy = {
    zones: ['src'],
    boundaryZones: [],
    fileExtensions: ['.ts', '.tsx'],
    ignorePaths: ['node_modules/**', '**/dist/**', '**/out/**'],
    allowedPatterns: [
      {
        pattern: '^text-\\[10px\\]$',
        note: '弹层内装饰文字，Editor dock-布局规范 R7 弹层豁免先例',
      },
      {
        pattern: 'grid-(?:cols|rows)-\\[.*minmax\\(',
        note: '响应式网格模板，非百分比栏比',
      },
    ],
  };
  writeFile(path.join(root, policyPath), JSON.stringify(policy, null, 2));
  return { root, policyPath };
};

test('拦截并转绿：className 数值型尺寸任意值先红（退出码 1 + 行号 + 汇总行），修正后转绿', () => {
  const fixture = createFixture();
  const target = path.join(fixture.root, 'src/features/Preview.tsx');
  writeFile(
    target,
    `export const Bar = () => (
  <div className="text-[11px] w-[240px] min-h-[420px] p-[13px]">
    <span className="rounded-[4px]">x</span>
  </div>
);
`,
  );

  const red = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(red.status, 0, `Expected exit 1, got ${red.status}\n${red.stderr}`);
  assert.match(red.stderr, /css-size-token/);
  assert.match(red.stderr, /text-\[11px\]/);
  assert.match(red.stderr, /w-\[240px\]/);
  assert.match(red.stderr, /min-h-\[420px\]/);
  assert.match(red.stderr, /p-\[13px\]/);
  assert.match(red.stderr, /rounded-\[4px\]/);
  assert.match(red.stderr, /src\/features\/Preview\.tsx:2:/);
  assert.match(red.stderr, /guard:css-size-tokens failed: 发现 5 处尺寸类任意值/);

  // 修正夹具（改用阶梯档名/令牌）→ 转绿
  writeFile(
    target,
    `export const Bar = () => (
  <div className="text-2xs w-60 min-h-96 p-3">
    <span className="rounded">x</span>
  </div>
);
`,
  );
  const green = runGate(fixture.root, fixture.policyPath);
  assert.equal(green.status, 0, `Expected exit 0, got ${green.status}\n${green.stderr}`);
});

test('拦截：leading/tracking 数值与 grid 百分比栏比，退出码 1', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/features/Typography.tsx'),
    `export const Foo = () => (
  <div className="leading-[1.5] tracking-[0.02em]">
    <span className="grid grid-cols-[33.33%] grid-rows-[50%]" />
  </div>
);
`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /leading-\[1\.5\]/);
  assert.match(result.stderr, /tracking-\[0\.02em\]/);
  assert.match(result.stderr, /grid-cols-\[33\.33%\]/);
  assert.match(result.stderr, /grid-rows-\[50%\]/);
  assert.match(result.stderr, /guard:css-size-tokens failed: 发现 4 处尺寸类任意值/);
});

test('放行：-[var(--...)] 令牌形式与非数值内容，退出码 0', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/features/Tokens.tsx'),
    `export const Foo = () => (
  <div className="text-[var(--font-size-sm)] w-[var(--panel-width)]">
    <span className="rounded-[var(--radius-md)] text-[#ff0000]">x</span>
    <span className="h-[calc(100%-40px)] p-[length:var(--pad)]" />
  </div>
);
`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('白名单：text-[10px] 与 grid minmax 模板放行并输出 [allow] 提示', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/features/Preview.tsx'),
    `export const Bar = () => (
  <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
    <span className="absolute px-1 font-mono text-[10px]">x</span>
  </div>
);
`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stdout, /\[allow\]/);
  assert.match(result.stdout, /text-\[10px\]/);
  assert.match(result.stdout, /grid-cols-\[repeat\(auto-fill,minmax\(16rem,1fr\)\)\]/);
});

test('注释剥离：块注释（含 JSX {/* */}）与行注释中的尺寸类不报', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/features/Commented.tsx'),
    `// legacy: text-[11px] 已退役
/* w-[10px] 旧写法留存于历史注释 */
export const Foo = () => (
  <div>
    {/* 主从分栏（min-h-[420px] 已退役），不设滚动容器 */}
    <span className="text-xs">x</span>
  </div>
);
`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

test('放行：无 className 的普通代码与 URL 字符串不误报', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/features/Plain.ts'),
    `const url = "https://example.com/assets";
const width = 240;
export const label = "尺寸必须消费令牌";
`,
  );
  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}\n${result.stderr}`);
});

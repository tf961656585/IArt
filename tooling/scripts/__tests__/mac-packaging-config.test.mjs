import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

test('mac 打包脚本入口存在且命名符合约定', () => {
  const scripts = packageJson.scripts ?? {};
  assert.equal(typeof scripts['generate:mac-icon'], 'string');
  assert.equal(typeof scripts['desktop:dist:mac'], 'string');
  assert.equal(typeof scripts['desktop:dist:mac:zip'], 'string');
  assert.equal(typeof scripts['desktop:dist:mac:arm64'], 'string');
  assert.equal(typeof scripts['desktop:dist:mac:x64'], 'string');
  assert.match(scripts['desktop:dist:mac:x64'], /--x64/);

  assert.match(scripts['generate:mac-icon'], /generate-mac-icon\.mjs/);
  assert.match(scripts['desktop:dist:mac'], /generate:mac-icon/);
  assert.match(scripts['desktop:dist:mac:zip'], /--mac zip/);
  assert.doesNotMatch(scripts['desktop:dist:mac'], /--x64/);
  assert.doesNotMatch(scripts['desktop:dist:mac:zip'], /--x64/);
  assert.match(scripts['desktop:dist:mac:arm64'], /-c\.mac\.identity=null/);
});

test('build.mac 目标同时包含 dmg 与 zip', () => {
  const macConfig = packageJson.build?.mac ?? {};
  const target = macConfig.target;
  assert.equal(Array.isArray(target), true, 'build.mac.target 必须是数组');
  assert.equal(target.includes('zip'), true, 'build.mac.target 缺少 zip');
  assert.equal(target.includes('dmg'), true, 'build.mac.target 缺少 dmg');
});

test('build.mac.icon 指向 desktop-shell resources 图标', () => {
  const macConfig = packageJson.build?.mac ?? {};
  assert.equal(macConfig.icon, 'apps/desktop-shell/resources/icons/icon.icns');
});

test('build.electronDownload 配置 npmmirror 镜像', () => {
  const electronDownload = packageJson.build?.electronDownload ?? {};
  assert.equal(electronDownload.mirror, 'https://npmmirror.com/mirrors/electron/');
});

test('build.dmg 配置包含背景、窗口与安装位置信息', () => {
  const dmgConfig = packageJson.build?.dmg ?? {};
  assert.equal(dmgConfig.background, 'apps/desktop-shell/resources/dmg/dmg-background.png');

  assert.deepEqual(dmgConfig.window, {
    width: 760,
    height: 540,
  });

  assert.equal(Array.isArray(dmgConfig.contents), true, 'build.dmg.contents 必须是数组');
  const appItem = dmgConfig.contents.find((item) => item?.x === 220 && item?.y === 380);
  assert.equal(Boolean(appItem), true, 'build.dmg.contents 缺少 App 坐标项 (220,380)');

  const applicationsLink = dmgConfig.contents.find(
    (item) => item?.x === 540 && item?.y === 380 && item?.type === 'link' && item?.path === '/Applications',
  );
  assert.equal(Boolean(applicationsLink), true, 'build.dmg.contents 缺少 Applications link 项 (540,380)');
});

test('DMG 背景文件存在且非空', () => {
  const backgroundPath = path.join(repoRoot, 'apps', 'desktop-shell', 'resources', 'dmg', 'dmg-background.png');
  assert.equal(fs.existsSync(backgroundPath), true, '缺少 apps/desktop-shell/resources/dmg/dmg-background.png');
  const stat = fs.statSync(backgroundPath);
  assert.equal(stat.size > 0, true, 'apps/desktop-shell/resources/dmg/dmg-background.png 文件为空');
});

test('mac icns 图标文件存在且非空', () => {
  const iconPath = path.join(repoRoot, 'apps', 'desktop-shell', 'resources', 'icons', 'icon.icns');
  assert.equal(fs.existsSync(iconPath), true, '缺少 apps/desktop-shell/resources/icons/icon.icns');
  const stat = fs.statSync(iconPath);
  assert.equal(stat.size > 0, true, 'apps/desktop-shell/resources/icons/icon.icns 文件为空');
});

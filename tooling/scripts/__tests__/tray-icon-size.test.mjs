import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const readPngSize = (filePath) => {
  const buffer = fs.readFileSync(filePath);
  const pngMagic = '89504e470d0a1a0a';
  assert.equal(buffer.subarray(0, 8).toString('hex'), pngMagic, `${filePath} 不是有效 PNG 文件`);

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
};

test('mac tray 图标资源存在且尺寸符合预期', () => {
  const tray1x = path.join(repoRoot, 'apps', 'desktop-shell', 'resources', 'icons', 'tray-icon.png');
  const tray2x = path.join(repoRoot, 'apps', 'desktop-shell', 'resources', 'icons', 'tray-icon@2x.png');

  assert.equal(fs.existsSync(tray1x), true, '缺少 tray-icon.png');
  assert.equal(fs.existsSync(tray2x), true, '缺少 tray-icon@2x.png');

  assert.deepEqual(readPngSize(tray1x), { width: 16, height: 16 });
  assert.deepEqual(readPngSize(tray2x), { width: 32, height: 32 });
});

test('createTray 在 mac 使用小图标并保留回退缩放', () => {
  const windowsFilePath = path.join(repoRoot, 'apps', 'desktop-shell', 'src', 'desktop-shell-windows.cts');
  const source = fs.readFileSync(windowsFilePath, 'utf8');

  assert.match(source, /tray-icon\.png/);
  assert.match(source, /nativeImage\.createFromPath\(iconPath\)/);
  assert.match(source, /image\.resize\(\{ width: 16, height: 16 \}\)/);
});

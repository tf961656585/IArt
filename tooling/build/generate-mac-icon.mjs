#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const iconsDir = path.join(repoRoot, 'apps', 'desktop-shell', 'resources', 'icons');
const sourceIcon = path.join(iconsDir, 'icon-512.png');
const outputIcon = path.join(iconsDir, 'icon.icns');

const iconsetSpecs = [
  { file: 'icon_16x16.png', size: 16 },
  { file: 'icon_16x16@2x.png', size: 32 },
  { file: 'icon_32x32.png', size: 32 },
  { file: 'icon_32x32@2x.png', size: 64 },
  { file: 'icon_128x128.png', size: 128 },
  { file: 'icon_128x128@2x.png', size: 256 },
  { file: 'icon_256x256.png', size: 256 },
  { file: 'icon_256x256@2x.png', size: 512 },
  { file: 'icon_512x512.png', size: 512 },
  { file: 'icon_512x512@2x.png', size: 1024 },
];

const run = (command, args, label) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (result.error) {
    throw new Error(`${label} 失败: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${label} 失败，退出码 ${result.status}${details ? `\n${details}` : ''}`);
  }
};

const assertFile = (filePath, errorMessage) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(errorMessage);
  }
};

const ensureMacOnly = () => {
  if (process.platform === 'darwin') return;
  throw new Error(
    [
      'generate:mac-icon 仅支持在 macOS 上运行。',
      '请在 macOS 构建机执行该命令，或手动提供 apps/desktop-shell/resources/icons/icon.icns。',
    ].join('\n'),
  );
};

const ensureDependencies = () => {
  run('xcrun', ['-f', 'sips'], '检查 sips');
  run('xcrun', ['-f', 'iconutil'], '检查 iconutil');
};

const generateIcns = () => {
  assertFile(sourceIcon, `缺少源图标: ${sourceIcon}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iartstudio-iconset-'));
  const iconsetDir = path.join(tempRoot, 'icon.iconset');
  fs.mkdirSync(iconsetDir);

  try {
    for (const spec of iconsetSpecs) {
      const outputPng = path.join(iconsetDir, spec.file);
      run(
        'sips',
        ['-z', String(spec.size), String(spec.size), sourceIcon, '--out', outputPng],
        `生成 ${spec.file}`,
      );
    }

    run('iconutil', ['-c', 'icns', iconsetDir, '-o', outputIcon], '生成 icon.icns');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assertFile(outputIcon, `未生成目标图标: ${outputIcon}`);
  const stat = fs.statSync(outputIcon);
  if (stat.size <= 0) {
    throw new Error(`生成的 icon.icns 文件为空: ${outputIcon}`);
  }
};

export const runGenerateMacIcon = () => {
  ensureMacOnly();
  ensureDependencies();
  generateIcns();
  console.log(`[generate-mac-icon] 已生成: ${outputIcon}`);
};

const isDirectExecution = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  try {
    runGenerateMacIcon();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[generate-mac-icon] ${message}`);
    process.exit(1);
  }
}

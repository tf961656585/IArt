import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const electronDir = path.join(repoRoot, 'node_modules', 'electron');

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const getElectronExecutablePath = () => {
  const pathFile = path.join(electronDir, 'path.txt');
  const executableRel = readText(pathFile)?.trim();
  if (!executableRel) return null;
  return path.join(electronDir, 'dist', executableRel);
};

const isElectronInstalled = () => {
  const executablePath = getElectronExecutablePath();
  if (!executablePath) return false;
  return fs.existsSync(executablePath);
};

const run = () => {
  if (!fs.existsSync(electronDir)) {
    console.error('[ensure-electron] 未找到依赖：node_modules/electron');
    console.error('[ensure-electron] 请先执行：pnpm install');
    process.exit(1);
  }

  if (isElectronInstalled()) return;

  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.error('[ensure-electron] Electron 二进制缺失，但检测到 ELECTRON_SKIP_BINARY_DOWNLOAD 已设置。');
    console.error('[ensure-electron] 请取消该环境变量后重试（或仅在 CI 中设置）。');
    process.exit(1);
  }

  const installScript = path.join(electronDir, 'install.js');
  if (!fs.existsSync(installScript)) {
    console.error('[ensure-electron] 未找到 electron 安装脚本：node_modules/electron/install.js');
    process.exit(1);
  }

  console.log('[ensure-electron] Electron 二进制缺失，开始执行安装脚本（首次会下载较大文件）...');
  // 默认走 npmmirror 镜像（团队网络下 GitHub 直连是已知脆弱点）；已被显式设置则不覆盖。
  const installEnv = { ...process.env };
  if (!installEnv.ELECTRON_MIRROR) {
    installEnv.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
  }
  console.log(`[ensure-electron] 使用镜像: ${installEnv.ELECTRON_MIRROR}`);
  const result = spawnSync(process.execPath, [installScript], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: installEnv,
  });
  if (result.status !== 0) {
    console.error(`[ensure-electron] 安装失败（exit=${result.status ?? 'null'}）。`);
    console.error('[ensure-electron] 默认已使用 npmmirror 镜像；如需其它镜像可显式设置 ELECTRON_MIRROR 覆盖。');
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }

  if (!isElectronInstalled()) {
    console.error('[ensure-electron] 已执行安装脚本，但仍未检测到 Electron 可执行文件。');
    console.error('[ensure-electron] 请检查网络/代理，或删除 node_modules/electron 后重新安装。');
    process.exit(1);
  }
};

run();

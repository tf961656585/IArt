#!/usr/bin/env node
/**
 * 后端测试的原生模块前置：保证 `better-sqlite3` 与当前 Node 的 ABI 匹配。
 *
 * 为什么需要它：本仓只有一份 `node_modules/better-sqlite3`，它按「最后一次 rebuild 时的
 * 运行时」编译（Node 测试用 Node ABI、桌面运行用 Electron ABI，切换由 `pnpm abi:*` /
 * `pnpm ensure:desktop-deps` 完成）。切换 Node 主版本后这一步不会自动发生，后端测试会以
 * `NODE_MODULE_VERSION 137 … requires 141`（或反向）报红——红因是环境不是用例，但报错里
 * 没有「先重建」的下一步。`pnpm test` / `test:integration` 里的 `abi:node -- --verify`
 * 已经覆盖了前端套件，`test:backend` 此前没有，本模块补上这一段，判据只有一条：
 * 能在当前 Node 上真实打开一个内存库。
 *
 * 行为：健康时只做一次约百毫秒的探测，不做任何重建（不拖慢日常跑用例）；ABI 错配时调用
 * `tooling/scripts/switch-abi.mjs node --verify` 重建并复验；缺依赖或其它错误原样上报，
 * 不吞错、不加默认值。
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const abiScriptPath = path.join(scriptDir, 'switch-abi.mjs');
const probeSource = "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();";

/** 把探测失败的原因归类；只有 ABI 错配才值得自动重建，其余错误必须原样暴露。 */
export function classifyProbeFailure(stderr) {
  const text = String(stderr ?? '');
  if (/NODE_MODULE_VERSION|was compiled against a different Node/i.test(text)) {
    return 'abi-mismatch';
  }
  if (/Cannot find module 'better-sqlite3'/i.test(text)) {
    return 'missing-module';
  }
  return 'other';
}

export function probeBetterSqlite({ execPath = process.execPath, cwd = repoRoot } = {}) {
  const result = spawnSync(execPath, ['-e', probeSource], { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: result.stderr ?? '',
  };
}

const rebuildForNode = () => {
  console.log('[ensure-sqlite] better-sqlite3 与当前 Node 的 ABI 不一致，正在按当前 Node 重建…');
  const result = spawnSync(process.execPath, [abiScriptPath, 'node', '--verify'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  return result.status === 0;
};

export function ensureBetterSqlite(options = {}) {
  const probe = probeBetterSqlite(options);
  if (probe.ok) return { state: 'ok', rebuilt: false };

  const failure = classifyProbeFailure(probe.stderr);

  if (failure === 'missing-module') {
    console.error(
      [
        '✖ 后端测试需要 better-sqlite3，但当前工作区里没有安装：',
        '  先跑 pnpm install（或确认 node_modules 完整）再重试。',
      ].join('\n'),
    );
    return { state: 'missing-module', rebuilt: false };
  }

  if (failure !== 'abi-mismatch') {
    console.error(probe.stderr.trim());
    return { state: 'other-error', rebuilt: false };
  }

  if (!rebuildForNode()) {
    return { state: 'rebuild-failed', rebuilt: false };
  }

  const retry = probeBetterSqlite(options);
  if (!retry.ok) {
    console.error(retry.stderr.trim());
    return { state: 'still-broken', rebuilt: true };
  }

  console.log('[ensure-sqlite] ok better-sqlite3 已按当前 Node 重建');
  return { state: 'ok', rebuilt: true };
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  const result = ensureBetterSqlite();
  if (result.state !== 'ok') {
    process.exitCode = 1;
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 阶段状态机：断点续跑的唯一状态承载。
// 状态文件 .cache/desktop-release-state/<version>-<platform>.json（gitignore 内，不入库），
// 记录工作区指纹（commitSha + dirtyHash）与各 stage 的 done 记录（含耗时与产物证据）。
// 同指纹重跑自动跳过已完成 stage；指纹不一致由 assertWorkspaceBinding 拒绝，
// 只能 bump 版本或 --force 作废重来（--force 只重置进度，不跳过任何门禁）。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

export const statePath = ({ version, platform }) =>
  path.join(repoRoot, '.cache', 'desktop-release-state', `${version}-${platform}.json`);

const defaultGitRunner = (args) => {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout || '' : '';
};

// 工作区指纹：commitSha + dirtyHash。
// dirtyHash = sha1(git status --porcelain=v1 + git diff HEAD --binary)；干净工作区为空串。
// 已知盲区：untracked 文件只贡献文件名，内容变化不改变哈希（见计划风险节）。
export const workspaceFingerprint = ({ runner = defaultGitRunner } = {}) => {
  const commitSha = runner(['rev-parse', 'HEAD']).trim();
  const statusOutput = runner(['status', '--porcelain=v1']);
  const diffOutput = runner(['diff', 'HEAD', '--binary']);
  const dirtyContent = `${statusOutput}${diffOutput}`;
  const dirtyHash = dirtyContent
    ? crypto.createHash('sha1').update(dirtyContent).digest('hex')
    : '';
  return { commitSha, dirtyHash };
};

export const loadState = (filePath) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.stages && typeof parsed.stages === 'object') {
      return parsed;
    }
  } catch {
    // 状态文件缺失或损坏时按无进度处理。
  }
  return null;
};

export const saveState = (filePath, state) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
};

// 版本-commit 绑定守卫：已有进度的工作区指纹与当前不一致时拒绝继续。
// 防同版本号下混传两个 commit 的产物。脏工作区可以发布，只是指纹随内容变化。
export const assertWorkspaceBinding = (state, fingerprint) => {
  if (!state || !state.fingerprint) return;
  const recorded = state.fingerprint;
  if (recorded.commitSha === fingerprint.commitSha && recorded.dirtyHash === fingerprint.dirtyHash) {
    return;
  }
  const dirtyNote = fingerprint.dirtyHash ? '（含未提交改动）' : '';
  throw new Error(
    `版本 ${state.version} 已有基于 ${recorded.commitSha} 的发布进度，` +
      `当前工作区为 ${fingerprint.commitSha}${dirtyNote}。` +
      '请 bump 版本，或以 `--force` 作废既有进度重新开始' +
      '（`--force` 只重置进度，不跳过任何门禁）。',
  );
};

const toIso = (ms) => new Date(ms).toISOString();

// stage runner：isDone(state) → 跳过并打印；否则计时执行 run()，成功后写入
// { status:'done', startedAt, finishedAt, durationMs, ...run 返回的元数据 } 并立即落盘
// （每个 stage 后立即 persist，崩溃不丢进度）。isDone 缺省时按状态记录判定。
export const runStage = async (
  state,
  name,
  { isDone, run, persist = () => {}, now = () => Date.now(), log = console.log } = {},
) => {
  const done = typeof isDone === 'function'
    ? isDone(state)
    : state.stages?.[name]?.status === 'done';
  if (done) {
    log(`⏭ [stage ${name}] 已完成，跳过。`);
    return { skipped: true };
  }

  log(`▶ [stage ${name}] 开始`);
  const startedAt = now();
  const result = await run();
  const finishedAt = now();
  state.stages[name] = {
    status: 'done',
    startedAt: toIso(startedAt),
    finishedAt: toIso(finishedAt),
    durationMs: finishedAt - startedAt,
    ...(result && typeof result === 'object' ? result : {}),
  };
  persist();
  log(`✓ [stage ${name}] 完成（${((finishedAt - startedAt) / 1000).toFixed(1)}s）`);
  return { skipped: false };
};

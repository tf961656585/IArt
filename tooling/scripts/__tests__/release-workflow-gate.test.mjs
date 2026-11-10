import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml');
const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));

const jobRunCommands = (jobName) =>
  (workflow.jobs?.[jobName]?.steps ?? [])
    .map((step) => step.run ?? '')
    .join('\n');

// 2026-11-07 拍板：发布流水线必须有门禁。这条测试是「别再退回到只靠人记得」的机械防线。
test('发布流水线有发布前门禁：静态硬门禁 + 后端测试', () => {
  const job = workflow.jobs?.gate;
  assert.ok(job, 'release.yml 缺少 gate job');
  assert.equal(job['runs-on'], 'ubuntu-latest');

  const commands = jobRunCommands('gate');
  assert.match(commands, /pnpm check:types-and-boundaries/);
  assert.match(commands, /pnpm test:backend/);
});

test('门禁先于任何草稿写操作：prepare-release 依赖 gate', () => {
  const needs = workflow.jobs?.['prepare-release']?.needs;
  const normalized = Array.isArray(needs) ? needs : [needs];
  assert.ok(
    normalized.includes('gate'),
    'prepare-release 必须 needs: gate——否则门禁失败时草稿已经建出来了',
  );

  for (const buildJob of ['release-mac', 'release-win', 'release-linux']) {
    const buildNeeds = workflow.jobs?.[buildJob]?.needs;
    const normalizedBuildNeeds = Array.isArray(buildNeeds) ? buildNeeds : [buildNeeds];
    assert.ok(
      normalizedBuildNeeds.includes('prepare-release'),
      `${buildJob} 必须 needs: prepare-release，才能间接依赖 gate`,
    );
  }
});

// CI 是公开快照（不含 docs/），且 runner 无显示设备：
// - 预飞链含真实 Electron smoke 与桌面依赖准备，不能在 CI 里跑；
// - 测试↔spec 关联检查靠 guard 自身打印「不适用」，不得被当成通过。
test('发布门禁只跑快照内可用的检查，不接预飞与 Electron smoke', () => {
  const commands = jobRunCommands('gate');
  assert.doesNotMatch(commands, /check:preflight|check:delivery|verify:desktop-smoke/);
  assert.doesNotMatch(commands, /\bdocs\//);
});

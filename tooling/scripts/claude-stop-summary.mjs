#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const gitStatus = () => {
  try {
    return {
      ok: true,
      text: execFileSync('git', ['status', '--short'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    };
  } catch {
    return { ok: false, text: '' };
  }
};

const changedPath = (line) => {
  const rawPath = line.slice(3).trim();
  const renameSeparator = ' -> ';
  const renameIndex = rawPath.indexOf(renameSeparator);

  if (renameIndex === -1) {
    return rawPath;
  }

  return rawPath.slice(renameIndex + renameSeparator.length);
};

const lines = [
  'Claude Stop 摘要',
  `仓库: ${repoRoot}`,
  `门禁 spec: ${existsSync(path.join(repoRoot, 'docs', 'harness', 'gates.md')) ? 'docs/harness/gates.md' : '未找到'}`,
  '交付前门禁: pnpm check:types-and-boundaries',
];

const status = gitStatus();

if (!status.ok) {
  lines.push('Git: 状态不可用');
} else if (status.text.length === 0) {
  lines.push('Git: 无未提交变更');
} else {
  const paths = status.text.split('\n').map(changedPath);
  lines.push(`Git: ${paths.length} 个未提交条目`);

  if (paths.some((changedFilePath) => changedFilePath === 'CLAUDE.md' || changedFilePath === 'AGENTS.md' || changedFilePath.startsWith('docs/'))) {
    lines.push('文档变更: 确认已按 docs/agent-map.yaml 路由到稳定 spec');
  }

  if (paths.some((changedFilePath) => changedFilePath.includes('schema') || changedFilePath.includes('DDL') || changedFilePath.endsWith('.sql'))) {
    lines.push('Schema 变更: 需要确认 SQL 列名与读写同步点');
  }

  if (paths.some((changedFilePath) => changedFilePath.startsWith('.claude/'))) {
    lines.push('Claude 配置变更: 确认 hook 轻量且不承担硬门禁');
  }
}

process.stdout.write(`${JSON.stringify({ systemMessage: lines.join('\n') })}\n`);

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldUseShellOnWindows } from '../lib/pnpm-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const outputTailLines = 80;

const gates = [
  {
    name: 'check:types-and-boundaries',
    command: ['pnpm', 'check:types-and-boundaries'],
    cascade: '静态硬门禁失败会让后续预飞结果只能作为参考，需先收口类型、lint、边界或稳定业务类型红灯。',
  },
  {
    name: 'test:scripts',
    command: ['pnpm', 'test:scripts'],
    cascade: '脚本口径测试失败说明 package scripts、诊断入口或专项守卫入口可能漂移。',
  },
  {
    name: 'guard:no-internal-timeout',
    command: ['pnpm', 'guard:no-internal-timeout'],
    cascade: '内部 timeout 守卫失败说明运行链路可能误杀长时生成任务。',
  },
  {
    name: 'guard:ipc-contract-parse',
    command: ['pnpm', 'guard:ipc-contract-parse'],
    cascade: 'IPC parse 守卫失败说明跨进程边界可能绕过 packages/contracts 可执行契约。',
  },
  {
    name: 'guard:contract-ownership',
    command: ['pnpm', 'guard:contract-ownership'],
    cascade: '契约归属守卫失败说明共享 DTO 或状态集合可能出现本地重复事实源。',
  },
  {
    name: 'guard:no-runtime-json-leak',
    command: ['pnpm', 'guard:no-runtime-json-leak'],
    cascade: '运行时 JSON 泄漏守卫失败说明 Row 内部 *Json 字段可能重新进入通知、storage read 或 Renderer/Hub 消费层。',
  },
  {
    name: 'guard:no-json-clone',
    command: ['pnpm', 'guard:no-json-clone'],
    cascade: 'JSON clone 守卫失败说明运行时对象可能继续通过 stringify/parse 往返复制，需收口到明确 JSON copier 或 projector。',
  },
  {
    name: 'guard:local-media-url-resolution',
    command: ['pnpm', 'guard:local-media-url-resolution'],
    cascade: 'local-media URL 解析守卫失败说明解析端可能出现内联 slice/split/indexOf 解析或内联 scope 识别谓词组合，需收口到 @iart/utils/media-file-key 的 parseLocalMediaUrl/isLocalMediaScope。',
  },
  {
    name: 'guard:desktop-runtime-deps',
    command: ['pnpm', 'guard:desktop-runtime-deps'],
    cascade: '桌面运行时依赖闭包守卫失败说明 dev/workspace 可解析的依赖可能不会进入 packaged app。',
  },
  {
    name: 'ensure:desktop-deps',
    command: ['pnpm', 'ensure:desktop-deps'],
    cascade: '桌面依赖准备失败会导致真实 Electron e2e、Electron ABI 原生模块或后续打包无法启动。',
  },
  {
    name: 'build:desktop-runtime',
    command: ['pnpm', 'build:desktop-runtime'],
    cascade: '桌面运行产物构建失败会导致 smoke 与 Electron e2e 缺少有效产物。',
  },
  {
    name: 'guard:public-relay-capabilities',
    command: ['pnpm', 'guard:public-relay-capabilities'],
    cascade: 'Public relay 能力守卫失败说明本轮生成的官方模型包需要的 public relay targetType 没有进入 Backend 产品默认能力注册表；若 build:desktop-runtime 已失败，该红灯可能是模型包目录缺失的级联结果。',
  },
  {
    name: 'verify:desktop-smoke',
    command: ['pnpm', 'verify:desktop-smoke'],
    cascade: '桌面 smoke 失败说明静态入口、Desktop shell bootstrap、集成测试或真实 Electron e2e 未放行。',
  },
];

const formatCommand = (command) => command.join(' ');

const tailOutput = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';

  const lines = text.split(/\r?\n/);
  return lines.slice(-outputTailLines).join('\n');
};

const runGate = (gate) => {
  const [command, ...args] = gate.command;
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
    shell: shouldUseShellOnWindows(command),
  });

  const durationMs = Date.now() - startedAt;
  const status = typeof result.status === 'number' ? result.status : 1;
  const passed = !result.error && status === 0;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

  return {
    ...gate,
    durationMs,
    passed,
    status,
    error: result.error,
    outputTail: tailOutput(output),
  };
};

const printSection = (title) => {
  console.log(`\n## ${title}`);
};

const printOverview = (results) => {
  printSection('总览');
  for (const result of results) {
    const mark = result.passed ? 'PASS' : 'FAIL';
    console.log(`- ${mark} ${result.name} (${result.durationMs}ms): ${formatCommand(result.command)}`);
  }
};

const printFailures = (results) => {
  const failures = results.filter((result) => !result.passed);
  printSection('失败分组');

  if (failures.length === 0) {
    console.log('- 无失败项。');
    return;
  }

  for (const failure of failures) {
    console.log(`\n### ${failure.name}`);
    console.log(`- command: ${formatCommand(failure.command)}`);
    console.log(`- exit: ${failure.status}`);
    if (failure.error) {
      console.log(`- error: ${failure.error.message}`);
    }
    if (failure.outputTail) {
      console.log(`- output tail (last ${outputTailLines} lines):`);
      console.log(failure.outputTail);
    } else {
      console.log('- output tail: <empty>');
    }
  }
};

const printCascadeNotes = (results) => {
  printSection('级联说明');
  const firstFailureIndex = results.findIndex((result) => !result.passed);

  if (firstFailureIndex === -1) {
    console.log('- 所有子门禁通过，无级联红灯。');
    return;
  }

  const rootFailure = results[firstFailureIndex];
  console.log(`- 首个失败项：${rootFailure.name}。后续失败可能包含级联影响，仍需按输出逐项确认。`);

  for (const result of results.slice(firstFailureIndex)) {
    console.log(`- ${result.name}: ${result.cascade}`);
  }

  console.log('- 未运行项：无。本诊断入口会在失败后继续执行剩余子门禁。');
};

const printNextStep = (results) => {
  printSection('建议下一步');
  const firstFailure = results.find((result) => !result.passed);
  if (!firstFailure) {
    console.log('- 可继续运行 pnpm check:preflight 作为预飞硬门禁放行结论。');
    return;
  }
  console.log(`- 优先修复首个失败项：${firstFailure.name}。`);
  console.log(`- 可单独复现：${formatCommand(firstFailure.command)}`);
};

console.log('# 预飞门禁诊断报告');
console.log('诊断入口用于定位红灯，不替代 check:preflight 的预飞硬门禁放行结论。');

const results = gates.map((gate) => {
  console.log(`\n[diagnose:preflight] running ${gate.name}: ${formatCommand(gate.command)}`);
  const result = runGate(gate);
  console.log(`[diagnose:preflight] ${result.passed ? 'passed' : 'failed'} ${gate.name} (${result.durationMs}ms)`);
  return result;
});

printOverview(results);
printFailures(results);
printCascadeNotes(results);
printNextStep(results);

process.exitCode = results.some((result) => !result.passed) ? 1 : 0;

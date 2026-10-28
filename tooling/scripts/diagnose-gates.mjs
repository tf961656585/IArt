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
    name: 'build:typecheck-deps',
    command: ['pnpm', 'build:typecheck-deps'],
    cascade: '类型依赖构建失败会导致 workspace 类型检查读取不到最新声明产物。',
  },
  {
    name: 'typecheck:workspaces',
    command: ['pnpm', 'typecheck:workspaces'],
    cascade: '类型检查失败会使 lint 的 type-aware 结果只能作为后续参考。',
  },
  {
    name: 'lint',
    command: ['pnpm', 'lint'],
    cascade: 'lint 失败通常独立于稳定业务类型守卫，但可能与同一类型建模问题同源。',
  },
  {
    name: 'guard:stable-business-types',
    command: ['pnpm', 'guard:stable-business-types'],
    cascade: '稳定业务类型守卫失败说明内部主链存在动态字典口径。',
  },
  {
    name: 'guard:canvas-selection-ownership',
    command: ['pnpm', 'guard:canvas-selection-ownership'],
    cascade: 'Canvas selection ownership 守卫失败说明旧 store selection action、legacy selected 字段或 selectedSlotIds 又回流到了正式 steady-state 边界。',
  },
  {
    name: 'guard:dialog-sizing',
    command: ['pnpm', 'guard:dialog-sizing'],
    cascade: '弹窗尺寸守卫失败说明业务弹窗仍通过 DialogContent className 书写宽高、溢出或滚动类，未收敛到 form/size props 与 DialogBody variant。',
  },
  {
    name: 'guard:media-fit-contain',
    command: ['pnpm', 'guard:media-fit-contain'],
    cascade: '媒体裁切守卫失败说明媒体元素仍用百分比 max-height 包在 auto 高度 wrapper（inline-block）里，高度约束失效导致图片被裁切、观察不可达，应改用 MediaStageFitBox。',
  },
  {
    name: 'guard:elevation-z',
    command: ['pnpm', 'guard:elevation-z'],
    cascade: '海拔层级守卫失败说明浮层仍书写数字 z-index 散值，未收敛到 z-dock/z-modal 等语义令牌（packages/ui/src/elevation.css）。',
  },
  {
    name: 'guard:escape-stack',
    command: ['pnpm', 'guard:escape-stack'],
    cascade: '浮层 Esc 栈守卫失败说明业务面仍在自行判定/处理 Escape 键，未收敛到 OverlayEscapeDispatcher 与 useOverlayLayer 入栈（packages/ui/src/overlay-stack）。',
  },
  {
    name: 'guard:css-undefined-vars',
    command: ['pnpm', 'guard:css-undefined-vars'],
    cascade: 'CSS 未定义变量守卫失败说明原生 CSS（含 HTML 内联 <style>）中存在 var(--name) 引用了文件内从未声明的自定义属性。',
  },
  {
    name: 'guard:css-size-tokens',
    command: ['pnpm', 'guard:css-size-tokens'],
    cascade: 'Hub 尺寸令牌守卫失败说明 apps/hub/src 的 className 仍裸写尺寸类任意值，未收敛到 visual-design §7.1 字号阶梯档名或 CSS 变量令牌。',
  },
  {
    name: 'guard:button-standard',
    command: ['pnpm', 'guard:button-standard'],
    cascade: '按钮样式标准守卫失败说明 Button 几何覆写、原生按钮、variant/size 枚举或 Editor 私有按钮类出现白名单外残留，未收敛到 docs/ui-button-standard.md §7/§8/§9 口径。',
  },
  {
    name: 'guard:form-control-colors',
    command: ['pnpm', 'guard:form-control-colors'],
    cascade: '表单控件颜色守卫失败说明共享控件未钉死 text-foreground、标签容器把 text-muted-foreground 继承给控件，或占位色/占位文案偏离 docs/ui-form-control-standard.md FC-01..FC-03。',
  },
  {
    name: 'guard:spec-test-linkage',
    command: ['pnpm', 'guard:spec-test-linkage'],
    cascade: '测试↔spec 关联守卫失败说明 @spec 标注指向已废弃/已退役/不存在的验收 ID（旧行为测试滞留信号），或验收 ID 在多份 Active 产物重复定义。',
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

  const skipped = results.filter((result) => result.status === null);
  if (skipped.length === 0) {
    console.log('- 未运行项：无。本诊断入口会在失败后继续执行剩余子门禁。');
  }
};

console.log('# 门禁诊断报告');
console.log('诊断入口用于定位红灯，不替代 check:types-and-boundaries 的硬门禁放行结论。');

const results = gates.map((gate) => {
  console.log(`\n[diagnose:gates] running ${gate.name}: ${formatCommand(gate.command)}`);
  const result = runGate(gate);
  console.log(`[diagnose:gates] ${result.passed ? 'passed' : 'failed'} ${gate.name} (${result.durationMs}ms)`);
  return result;
});

printOverview(results);
printFailures(results);
printCascadeNotes(results);

process.exitCode = results.some((result) => !result.passed) ? 1 : 0;

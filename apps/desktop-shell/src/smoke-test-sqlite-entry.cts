/**
 * Electron 独立冒烟测试入口
 *
 * 运行方式：
 *   pnpm --filter @iart/desktop-shell build
 *   electron ./apps/desktop-shell/dist/smoke-test-sqlite-entry.cjs
 *
 * 测试完成后自动退出，exit code 0=通过，1=失败。
 */
import { app } from 'electron';
import { runSqliteSmokeTest } from './smoke-test-sqlite.cjs';

void app.whenReady().then(async () => {
  console.log('\n========== better-sqlite3 Main Process Smoke Test ==========\n');

  const result = await runSqliteSmokeTest();

  for (const step of result.steps) {
    const icon = step.passed ? '✅' : '❌';
    console.log(`${icon} [${step.durationMs.toFixed(1)}ms] ${step.name}`);
    console.log(`   ${step.detail}\n`);
  }

  if (result.passed) {
    console.log('========== ALL PASSED ==========\n');
  } else {
    console.log(`========== FAILED: ${result.error} ==========\n`);
  }

  app.exit(result.passed ? 0 : 1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  app.exit(1);
});

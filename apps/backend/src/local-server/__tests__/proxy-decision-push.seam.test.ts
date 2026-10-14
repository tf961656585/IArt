import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// @spec: PROXY-001, PROXY-004

import {
  ProxyDecisionNotificationSchema,
} from '@iart/contracts';

import {
  getConfigFilePath,
  resetBackendConfigForTest,
  updateBackendConfig,
} from '../config-store.cts';
import { rebuildFetchDispatcher } from '../fetch-dispatcher.cts';

/**
 * 代理决策推送接缝测试（spec docs/runtime/远端请求执行治理原则.md「代理治理」）。
 *
 * 验收 PROXY-001 / PROXY-004：backend 真实链路（config-store 写入 → fetch-dispatcher
 * 重建 → backend-ipc-sender 发送）首尾真实跑通，只在最外层挡掉 fork IPC 传输
 * （stub process.send 捕获消息），并断言消息可被 contracts schema parse。
 * system 档依赖真实 OS 检测（外部子进程），不在单测覆盖面内，由派生纯函数单测
 * （fetch-dispatcher.test.ts）与 dev 真机点验覆盖。
 */

type CapturedMessage = { type?: unknown };

const stubProcessSend = (t: test.TestContext): { captured: unknown[] } => {
  const captured: unknown[] = [];
  const originalSend = (process as { send?: unknown }).send;
  Object.defineProperty(process, 'send', {
    value: (message: unknown): void => {
      captured.push(message);
    },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (originalSend === undefined) {
      delete (process as { send?: unknown }).send;
    } else {
      Object.defineProperty(process, 'send', {
        value: originalSend,
        configurable: true,
        writable: true,
      });
    }
  });
  return { captured };
};

const useTempStorageRoot = (t: test.TestContext): string => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-proxy-seam-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = tempDir;
  t.after(() => {
    if (previousRoot == null) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    // 恢复模块级内存配置（避免污染同文件后续用例）
    updateBackendConfig({ proxyMode: 'system', proxyUrl: '' });
  });
  resetBackendConfigForTest();
  return tempDir;
};

const findDecisionNotification = (captured: unknown[]): unknown =>
  captured.find(
    (message): message is CapturedMessage =>
      typeof message === 'object' && message !== null && (message as CapturedMessage).type === 'proxy:decision-changed',
  );

void test('PROXY-001 seam: manual 档变更推送 proxy:decision-changed 且消息过 contracts schema', async (t) => {
  useTempStorageRoot(t);
  const { captured } = stubProcessSend(t);

  assert.equal(fs.existsSync(getConfigFilePath()), false, '前置：临时存储根无 backend.json');

  updateBackendConfig({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890' });
  await rebuildFetchDispatcher('seam-test');

  const notification = findDecisionNotification(captured);
  assert.ok(notification, '期望捕获 proxy:decision-changed 通知（真实链路：config-store → dispatcher 重建 → sender）');
  const parsed = ProxyDecisionNotificationSchema.safeParse(notification);
  assert.equal(parsed.success, true, `通知必须过 ProxyDecisionNotificationSchema：${parsed.success ? '' : parsed.error.message}`);
  if (parsed.success) {
    assert.deepEqual(parsed.data.decision, { mode: 'manual', proxyUrl: 'http://127.0.0.1:7890/' });
  }
});

void test('PROXY-004 seam: 决策未变化不重复推送', async (t) => {
  useTempStorageRoot(t);
  const { captured } = stubProcessSend(t);

  updateBackendConfig({ proxyMode: 'direct' });
  await rebuildFetchDispatcher('seam-test-first');
  const firstCount = captured.length;
  assert.ok(
    findDecisionNotification(captured),
    '首次重建应推送 direct 决策（lastPushed 为空）',
  );

  await rebuildFetchDispatcher('seam-test-again');
  assert.equal(captured.length, firstCount, '决策未变化时第二次重建不得再推送');
});

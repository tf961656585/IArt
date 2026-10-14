import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIRECT_FETCH_DISPATCHER,
  buildDecisionFromResolution,
  resolveManualProxy,
  resolveSystemProxy,
  type ProxyConfigView,
} from '../fetch-dispatcher.cts';
import type { DetectedSystemProxy } from '../system-proxy-detect.cts';

/**
 * fetch-dispatcher.cts 纯选择逻辑单测（不起真实网络、不等异步重建）：
 * manual/system 两档 resolution 构建与降级（留痕路径）。
 * 端到端 dispatcher 生效性由 dev 版人工验证（Hub 保存 → backend 日志 rebuilt）。
 */

const MANUAL_CONFIG: ProxyConfigView = {
  proxyMode: 'manual',
  proxyUrl: 'http://127.0.0.1:7890',
};

const detected = (partial: Partial<DetectedSystemProxy>): DetectedSystemProxy => ({
  httpProxy: '',
  httpsProxy: '',
  noProxy: [],
  unsupported: null,
  ...partial,
});

void test('resolveManualProxy: valid proxyUrl maps to both schemes with loopback noProxy', () => {
  const resolution = resolveManualProxy(MANUAL_CONFIG);
  assert.ok(resolution);
  assert.equal(resolution.httpProxy, 'http://127.0.0.1:7890');
  assert.equal(resolution.httpsProxy, 'http://127.0.0.1:7890');
  assert.ok(resolution.noProxy.includes('127.0.0.1'));
  assert.ok(resolution.noProxy.includes('localhost'));
});

void test('resolveManualProxy: missing proxyUrl returns null (fallback direct)', () => {
  assert.equal(resolveManualProxy({ proxyMode: 'manual', proxyUrl: '' }), null);
});

void test('resolveSystemProxy: detected proxy becomes resolution with exceptions merged into noProxy', () => {
  const resolution = resolveSystemProxy(
    detected({
      httpProxy: 'http://corp-proxy:3128',
      httpsProxy: 'http://corp-proxy:3128',
      noProxy: ['internal.example.com'],
    }),
  );
  assert.ok(resolution);
  assert.equal(resolution.httpProxy, 'http://corp-proxy:3128');
  assert.ok(resolution.noProxy.includes('internal.example.com'));
  assert.ok(resolution.noProxy.includes('127.0.0.1'));
});

void test('resolveSystemProxy: single-side detection fills the other side', () => {
  const resolution = resolveSystemProxy(detected({ httpsProxy: 'http://127.0.0.1:7890' }));
  assert.ok(resolution);
  assert.equal(resolution.httpProxy, 'http://127.0.0.1:7890');
  assert.equal(resolution.httpsProxy, 'http://127.0.0.1:7890');
});

void test('resolveSystemProxy: PAC / auto-detect / empty detection all return null (fallback direct)', () => {
  assert.equal(resolveSystemProxy(detected({ unsupported: 'pac' })), null);
  assert.equal(resolveSystemProxy(detected({ unsupported: 'auto-detect' })), null);
  assert.equal(resolveSystemProxy(detected({})), null);
});

void test('DIRECT_FETCH_DISPATCHER is the shared no-timeout direct agent', () => {
  assert.ok(DIRECT_FETCH_DISPATCHER);
  assert.equal(typeof DIRECT_FETCH_DISPATCHER.dispatch, 'function');
});

void test('buildDecisionFromResolution: direct 档恒为直连决策', () => {
  assert.deepEqual(
    buildDecisionFromResolution({ proxyMode: 'direct', proxyUrl: '' }, null),
    { mode: 'direct' },
  );
  assert.deepEqual(
    buildDecisionFromResolution(
      { proxyMode: 'direct', proxyUrl: '' },
      { httpProxy: 'http://x:1', httpsProxy: 'http://x:1', noProxy: '' },
    ),
    { mode: 'direct' },
  );
});

void test('buildDecisionFromResolution: system 档携带检测快照（检出/未检出）', () => {
  assert.deepEqual(
    buildDecisionFromResolution(
      { proxyMode: 'system', proxyUrl: '' },
      { httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890', noProxy: '127.0.0.1' },
    ),
    { mode: 'system', resolved: { kind: 'proxy', proxyUrl: 'http://127.0.0.1:7890' } },
  );
  assert.deepEqual(
    buildDecisionFromResolution({ proxyMode: 'system', proxyUrl: '' }, null),
    { mode: 'system', resolved: { kind: 'none' } },
  );
});

void test('buildDecisionFromResolution: manual 档携带归一化 URL（快照语义的 source 为 manual）', () => {
  assert.deepEqual(
    buildDecisionFromResolution(MANUAL_CONFIG, resolveManualProxy(MANUAL_CONFIG)),
    { mode: 'manual', proxyUrl: 'http://127.0.0.1:7890' },
  );
});

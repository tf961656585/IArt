import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getConfigFilePath,
  getBackendConfig,
  normalizeBackendConfig,
  normalizeProxyMode,
  normalizeProxyUrl,
  pickBackendConfigUpdate,
  updateBackendConfig,
  validateProxyConfigUpdate,
} from '../config-store.cts';

/**
 * 网络代理配置的归一化 / 白名单 / 校验单测。
 * - normalizeProxyMode/normalizeProxyUrl：输入边界（枚举、非法协议、空串）。
 * - normalizeBackendConfig：manual+空 URL 回落 system、非 manual 清 URL、缺省字段=system（老配置零迁移）。
 * - pickBackendConfigUpdate：proxyMode/proxyUrl 进白名单才会被持久化层接收。
 * - validateProxyConfigUpdate：显式 manual 无合法 URL、显式非法 URL 均被拒。
 */

void test('normalizeProxyMode: only enum values accepted, otherwise default system', () => {
  assert.equal(normalizeProxyMode('direct'), 'direct');
  assert.equal(normalizeProxyMode('MANUAL '), 'manual');
  assert.equal(normalizeProxyMode('socks'), 'system');
  assert.equal(normalizeProxyMode(undefined), 'system');
  assert.equal(normalizeProxyMode(42), 'system');
});

void test('normalizeProxyUrl: http/https only, normalized; anything else becomes empty', () => {
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('https://user:pass@proxy.example.com:443'), 'https://user:pass@proxy.example.com/');
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:7890'), '');
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), '');
  assert.equal(normalizeProxyUrl('   '), '');
  assert.equal(normalizeProxyUrl(null), '');
});

void test('normalizeBackendConfig: defaults proxy to system (zero-migration for existing configs)', () => {
  const config = normalizeBackendConfig({ logLevel: 'debug' });
  assert.equal(config.proxyMode, 'system');
  assert.equal(config.proxyUrl, '');
});

void test('normalizeBackendConfig: manual without valid URL falls back to system; non-manual clears URL', () => {
  const manualNoUrl = normalizeBackendConfig({ proxyMode: 'manual', proxyUrl: '' });
  assert.equal(manualNoUrl.proxyMode, 'system');
  assert.equal(manualNoUrl.proxyUrl, '');

  const manualWithUrl = normalizeBackendConfig({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(manualWithUrl.proxyMode, 'manual');
  assert.equal(manualWithUrl.proxyUrl, 'http://127.0.0.1:7890/');

  const directWithUrl = normalizeBackendConfig({ proxyMode: 'direct', proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(directWithUrl.proxyMode, 'direct');
  assert.equal(directWithUrl.proxyUrl, '');
});

void test('pickBackendConfigUpdate: proxy fields enter whitelist, unknown fields stay out', () => {
  const update = pickBackendConfigUpdate({
    proxyMode: 'manual',
    proxyUrl: 'http://127.0.0.1:7890',
    evilField: 'x',
  });
  assert.equal(update.proxyMode, 'manual');
  assert.equal(update.proxyUrl, 'http://127.0.0.1:7890');
  assert.equal('evilField' in update, false);

  const noProxy = pickBackendConfigUpdate({ maxBatchTasks: 5 });
  assert.equal('proxyMode' in noProxy, false);
  assert.equal('proxyUrl' in noProxy, false);
});

void test('validateProxyConfigUpdate: rejects explicit manual without URL and invalid non-empty URL', () => {
  const current = normalizeBackendConfig();
  // 默认配置无 URL：仅切 manual（不带 proxyUrl）被拒
  assert.equal(
    validateProxyConfigUpdate({ proxyMode: 'manual' }, current),
    'manual proxy requires a valid proxy URL (http:// or https://)',
  );
  assert.equal(
    validateProxyConfigUpdate({ proxyMode: 'manual', proxyUrl: '' }, current),
    'manual proxy requires a valid proxy URL (http:// or https://)',
  );
  assert.equal(
    validateProxyConfigUpdate({ proxyMode: 'manual', proxyUrl: 'socks5://x:1' }, current),
    'manual proxy requires a valid proxy URL (http:// or https://)',
  );
  // 已有 manual URL 时仅切换保留模式：合法
  const currentManual = normalizeBackendConfig({ proxyMode: 'manual', proxyUrl: 'http://h:1' });
  assert.equal(validateProxyConfigUpdate({ proxyMode: 'manual' }, currentManual), null);
  // 显式提供非法 proxyUrl（非 manual 切换场景）也被拒，避免静默清掉已有 manual 配置
  assert.equal(
    validateProxyConfigUpdate({ proxyUrl: 'not a url' }, currentManual),
    'proxy URL must be a valid http:// or https:// address',
  );
  // 空串 proxyUrl = 清除意图（Hub 切 system/direct 时携带），合法
  assert.equal(validateProxyConfigUpdate({ proxyMode: 'system', proxyUrl: '' }, currentManual), null);
});

void test('updateBackendConfig: proxy fields round-trip through persisted backend.json', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-proxy-config-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = tempDir;
  t.after(() => {
    if (previousRoot == null) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    // 恢复模块级内存配置（避免污染同进程其他用例）
    updateBackendConfig({ proxyMode: 'system', proxyUrl: '' });
  });

  const next = updateBackendConfig({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890' });
  assert.equal(next.proxyMode, 'manual');
  assert.equal(next.proxyUrl, 'http://127.0.0.1:7890/');

  const persisted = JSON.parse(fs.readFileSync(getConfigFilePath(), 'utf-8')) as {
    proxyMode: unknown;
    proxyUrl: unknown;
  };
  assert.equal(persisted.proxyMode, 'manual');
  assert.equal(persisted.proxyUrl, 'http://127.0.0.1:7890/');

  assert.equal(getBackendConfig().proxyMode, 'manual');
});

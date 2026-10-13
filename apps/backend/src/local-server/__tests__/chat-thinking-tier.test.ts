import assert from 'node:assert/strict';
import test from 'node:test';

import { __test_only__ as engineTestOnly } from '../chat-streaming-engine.cts';

/**
 * 思考档位的请求侧收敛（spec 37「思考档位」）。
 *
 * 口径：未选择按 `off`（不发档位字段）；选了该模型未启用的档位时按未选择处理并留痕，
 * **不得静默提升**为更高档位、也不得换成另一个档位。
 */

const { resolveThinkingTier } = engineTestOnly;

void test('思考档位收敛：未选择按不思考（不产生档位字段）', () => {
  assert.equal(resolveThinkingTier([], undefined), undefined);
  assert.equal(resolveThinkingTier(['low', 'high'], undefined), undefined);
  assert.equal(resolveThinkingTier(['low', 'high'], ''), undefined);
  assert.equal(resolveThinkingTier(['low', 'high'], '   '), undefined);
});

void test('思考档位收敛：已启用的档位原样生效', () => {
  assert.equal(resolveThinkingTier(['low', 'high'], 'high'), 'high');
  assert.equal(resolveThinkingTier(['ultra'], 'ultra'), 'ultra');
});

void test('思考档位收敛：未启用的档位按不思考处理，不换成别的档位', () => {
  assert.equal(resolveThinkingTier(['low'], 'high'), undefined);
  assert.equal(resolveThinkingTier([], 'high'), undefined);
  // 该模型启用了 low，但用户选的是未启用的 high——回落是不思考，不是 low
  assert.equal(resolveThinkingTier(['low'], 'high'), undefined);
});

// ---------------------------------------------------------------------------
// 创建时档位一次落库 → 执行链读取点（spec 37 v4.0.0：档位随自建对话模型记录走）
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConnection, setConnectionCredential, clearCacheForTest as clearConnectionCache } from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import { addCustomChatModel, clearCacheForTest as clearCustomModelCache } from '../provider-connection/custom-chat-model-store.cts';
import { setActiveDeployment, clearCacheForTest as clearActiveRouteCache } from '../provider-connection/active-route-store.cts';
import { clearCacheForTest as clearTierCache } from '../provider-connection/thinking-tier-store.cts';

void test('思考档位：创建时随记录落库的档位直接进入执行链收敛（无需二次 PUT）', async (t) => {
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tier-create-'));
  process.env['IART_STORAGE_ROOT'] = tempRoot;
  clearConnectionCache();
  clearActiveRouteCache();
  clearCustomModelCache();
  clearTierCache();
  t.after(() => {
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    clearConnectionCache();
    clearActiveRouteCache();
    clearCustomModelCache();
    clearTierCache();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const connection = createConnection({
    display_name: 'chat-tier-create',
    base_url: 'https://tier-create.example.invalid/v1',
  });
  const credential = await setCredentialForConnection(connection.connection_id, 'sk-tier-create-key');
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);

  // 创建请求体携带档位：一次落库（spec 37 v4.0.0）；协议随记录必填（协议归属模型级）
  const created = addCustomChatModel({
    model_id: 'tier-at-create',
    connection_id: connection.connection_id,
    protocol_adapter_id: 'openai-responses-v1',
    enabled_thinking_tiers: ['low', 'high'],
    default_thinking_tier: 'high',
  });
  assert.equal(created.ok, true, 'record with tiers should be created');
  assert.equal(setActiveDeployment('tier-at-create', created.model.record_id), created.model.record_id);

  // 执行链档位收敛直接读记录：请求 low 原样生效、未启用档位回落不思考
  const lowConfig = await engineTestOnly.resolveChatModelConfig('tier-at-create', 'low');
  assert.equal(lowConfig.thinkingTier, 'low');
  assert.equal((await engineTestOnly.resolveChatModelConfig('tier-at-create', 'ultra')).thinkingTier, undefined);
});

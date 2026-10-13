import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PUBLIC_RELAY_ERROR_CODE, PUBLIC_RELAY_TARGET_TYPE } from '@iart/contracts';
import { HUB_LOCAL_WRITE_TOKEN_ENV, HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import { resetBackendConfigForTest } from '../config-store.cts';
import { resolvePublicRelayEndpoint } from '../public-relay-capability.cts';

// ============================================================================
// 公共中转端点「用户自带」接缝测试（docs/runtime/public-relay-capability.md）。
//
// 主链：真实 system-routes 的 PUT/GET /api/config → 真实 config-store 归一化与
//   backend.json 持久化（隔离存储根）→ 真实 resolvePublicRelayEndpoint 消费配置。
// 两侧真实实现，只挡真实网络（存储根指向临时目录，不出网）。
//
// 语义基准（2026-10-12 拍板）：产品不再内置公共中转默认端点——端点一律用户自带
// （设置页 / backend.json / env 三路配置），空串 = 未配置。未配置时消费端得到
// TARGET_ENDPOINT_MISSING 结构化失败，不得回落任何内置默认。
// ============================================================================

const HUB_WRITE_TOKEN = 'c'.repeat(32);

const CLOUDFLARE_ENV = 'IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT';
const SELF_HOSTED_ENV = 'IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT';

type JsonValue = Record<string, unknown>;

const withTempEnv = (t: test.TestContext) => {
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousCloudflare = process.env[CLOUDFLARE_ENV];
  const previousSelfHosted = process.env[SELF_HOSTED_ENV];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-relay-config-seam-'));
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempDir;
  delete process.env[CLOUDFLARE_ENV];
  delete process.env[SELF_HOSTED_ENV];
  // config-store 是模块级单例（import 时按当时存储根加载过一次）；指向临时根后
  // 重跑真实 loadBackendConfig，得到等价「全新安装」的起点。
  resetBackendConfigForTest();
  t.after(() => {
    if (previousToken == null) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot == null) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousCloudflare == null) delete process.env[CLOUDFLARE_ENV];
    else process.env[CLOUDFLARE_ENV] = previousCloudflare;
    if (previousSelfHosted == null) delete process.env[SELF_HOSTED_ENV];
    else process.env[SELF_HOSTED_ENV] = previousSelfHosted;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
};

const startServer = async () => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address == null || typeof address == 'string') {
    throw new Error('relay_config_seam_server_address_unavailable');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const withServer = async (t: test.TestContext) => {
  const started = await startServer();
  t.after(() => new Promise<void>((resolve, reject) => {
    started.server.close((error) => (error ? reject(error) : resolve()));
  }));
  return started.baseUrl;
};

const headers = () => ({
  'content-type': 'application/json',
  [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
});

const readPersisted = (tempDir: string): JsonValue =>
  JSON.parse(fs.readFileSync(path.join(tempDir, 'config', 'backend.json'), 'utf-8')) as JsonValue;

void test('接缝：未配置（无 env 无持久化）时两个中转类型均为 TARGET_ENDPOINT_MISSING，GET config 镜像如实返回空串', async (t) => {
  withTempEnv(t);
  const baseUrl = await withServer(t);

  const response = await fetch(`${baseUrl}/api/config`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as JsonValue;
  const config = payload['config'] as JsonValue;
  const relayTargets = config['publicRelayTargets'] as JsonValue;
  assert.equal(
    (relayTargets[PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL] as JsonValue)['endpoint'],
    '',
  );
  assert.equal(
    (relayTargets[PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL] as JsonValue)['endpoint'],
    '',
  );

  const cloudflare = resolvePublicRelayEndpoint(PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL);
  const selfHosted = resolvePublicRelayEndpoint(PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL);
  assert.equal(cloudflare.ok, false);
  if (!cloudflare.ok) {
    assert.equal(cloudflare.code, PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_MISSING);
  }
  assert.equal(selfHosted.ok, false);
  if (!selfHosted.ok) {
    assert.equal(selfHosted.code, PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_MISSING);
  }
});

void test('接缝：PUT 写入用户自带端点（一类型配置、一类型清空）→ 持久化 → GET 回读一致 → resolve 分别 ok/MISSING', async (t) => {
  const tempDir = withTempEnv(t);
  const baseUrl = await withServer(t);

  const putResponse = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      publicRelayTargets: {
        [PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL]: {
          endpoint: 'https://relay.example.com/upload',
        },
        [PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL]: { endpoint: '' },
      },
    }),
  });
  assert.equal(putResponse.status, 200);

  // 持久化验证：backend.json 如实记录用户自带端点与显式清空
  const persisted = readPersisted(tempDir);
  const persistedTargets = persisted['publicRelayTargets'] as JsonValue;
  assert.equal(
    (persistedTargets[PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL] as JsonValue)['endpoint'],
    'https://relay.example.com/upload',
  );
  assert.equal(
    (persistedTargets[PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL] as JsonValue)['endpoint'],
    '',
  );

  // GET 回读一致（镜像语义）
  const getResponse = await fetch(`${baseUrl}/api/config`);
  const getPayload = (await getResponse.json()) as JsonValue;
  const config = getPayload['config'] as JsonValue;
  const relayTargets = config['publicRelayTargets'] as JsonValue;
  assert.equal(
    (relayTargets[PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL] as JsonValue)['endpoint'],
    'https://relay.example.com/upload',
  );
  assert.equal(
    (relayTargets[PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL] as JsonValue)['endpoint'],
    '',
  );

  // 消费端：配置了的类型解析为用户端点；显式清空的类型报「未配置」
  const cloudflare = resolvePublicRelayEndpoint(PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL);
  assert.equal(cloudflare.ok, true);
  if (cloudflare.ok) {
    assert.equal(cloudflare.endpoint, 'https://relay.example.com/upload');
  }
  const selfHosted = resolvePublicRelayEndpoint(PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL);
  assert.equal(selfHosted.ok, false);
  if (!selfHosted.ok) {
    assert.equal(selfHosted.code, PUBLIC_RELAY_ERROR_CODE.TARGET_ENDPOINT_MISSING);
  }
});

void test('接缝：PUT 非法端点（非 http/https）→ 400 拒绝且不持久化', async (t) => {
  const tempDir = withTempEnv(t);
  const baseUrl = await withServer(t);

  const response = await fetch(`${baseUrl}/api/config`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({
      publicRelayTargets: {
        [PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL]: { endpoint: 'ftp://relay.example.com' },
        [PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL]: { endpoint: '' },
      },
    }),
  });
  assert.equal(response.status, 400);
  const payload = (await response.json()) as JsonValue;
  assert.match(String(payload['message']), /publicRelayTargets/i);

  // 拒绝后不得落盘（临时存储根内不产生含非法端点的配置）
  assert.equal(fs.existsSync(path.join(tempDir, 'config', 'backend.json')), false);
});

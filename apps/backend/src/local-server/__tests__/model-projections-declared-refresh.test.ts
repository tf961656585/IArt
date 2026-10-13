import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HUB_LOCAL_WRITE_TOKEN_ENV,
  HUB_LOCAL_WRITE_TOKEN_HEADER,
} from '@iart/contracts';
import {
  MODEL_ASSET_NODE_PROJECTIONS_ROUTE,
  ModelAssetNodeProjectionResponseSchema,
} from '@iart/contracts/model-asset-contract';
import { createRequestHandler } from '../router.cts';
import { createModelProjectionSnapshotCatalog } from '../model-package-catalog.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  createConnection,
  clearCacheForTest as clearConnectionCache,
  setConnectionCredential,
} from '../provider-connection/connection-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';

/**
 * node-projections 投影快照的失效与单飞重建（生成模型自建声明试点 §3.6 的 Editor 节点投影面）。
 *
 * 使命：`GET /api/model-assets/node-projections` 不再消费启动期装配一次的静态快照——
 * ① 启动态声明为空 → 写入一条声明 → 下一次请求即含该模型的投影与本地化束（不重启）；
 * ② 删除声明 → 下一次请求不再含；
 * ③ 同一次失效的并发请求只重建一次（消费同一份快照）。
 * 快照机制本身（首读装配 + 多次失效合并一次重建）由 holder 级测试用 onRebuild 计数钉死。
 */

const HUB_WRITE_TOKEN = 'h'.repeat(32);
const DECLARED_MODEL_ID = 'projection-refresh-image';
const DECLARED_PACKAGE_ID = 'declared-openai-image-v1';
const CONNECTION_BASE_URL = 'https://projection-refresh.example.invalid/v1';
const CREDENTIAL_VALUE = 'sk-projection-refresh-key';

const setupIsolatedEnv = (t: test.TestContext): void => {
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const previousPackagesDir = process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
  const previousRelayEndpoint = process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-refresh-storage-'));
  // 空模型包目录：目录投影里唯一的生成模型就是被测声明，断言不受在役包漂移影响。
  const packagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-refresh-packages-'));
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = packagesDir;
  process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = 'https://relay.example.invalid/upload';
  clearCustomGenerationModelCache();
  clearConnectionCache();
  t.after(() => {
    if (previousToken === undefined) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    if (previousPackagesDir === undefined) delete process.env['IART_MODEL_ASSET_PACKAGES_DIR'];
    else process.env['IART_MODEL_ASSET_PACKAGES_DIR'] = previousPackagesDir;
    if (previousRelayEndpoint === undefined) delete process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'];
    else process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'] = previousRelayEndpoint;
    clearCustomGenerationModelCache();
    clearConnectionCache();
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.rmSync(packagesDir, { recursive: true, force: true });
  });
};

/** 建 openai-image-v1 连接 + 凭证（单记录口径：声明必须归属一条同族连接）。 */
const seedGenerationConnection = async (): Promise<string> => {
  const connection = createConnection({
    display_name: 'projection-refresh-provider',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  return connection.connection_id;
};

const startServer = async (t: test.TestContext): Promise<string> => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('projection_refresh_test_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const writeHeaders = (): Record<string, string> => ({
  'content-type': 'application/json',
  [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
});

const declareModel = async (baseUrl: string, modelId: string, connectionId?: string): Promise<Response> =>
  fetch(`${baseUrl}/api/custom-generation-models`, {
    method: 'POST',
    headers: writeHeaders(),
    body: JSON.stringify({
      model_id: modelId,
      connection_id: connectionId ?? (await seedGenerationConnection()),
      family_adapter_id: 'openai-image-v1',
    }),
  });

const getNodeProjections = async (baseUrl: string) =>
  ModelAssetNodeProjectionResponseSchema.parse(
    await (await fetch(`${baseUrl}${MODEL_ASSET_NODE_PROJECTIONS_ROUTE}`)).json(),
  );

void test('声明写入落盘后，下一次投影请求即含该模型的投影与本地化束（不重启）', async (t) => {
  setupIsolatedEnv(t);
  const baseUrl = await startServer(t);

  // 启动态声明为空：首个投影请求装配的快照不含声明模型。
  const before = await getNodeProjections(baseUrl);
  assert.ok(
    !before.projections.some((projection) => projection.model_id === DECLARED_MODEL_ID),
    '声明为空时投影不得含声明模型',
  );

  const added = await declareModel(baseUrl, DECLARED_MODEL_ID);
  assert.equal(added.status, 200);

  const after = await getNodeProjections(baseUrl);
  const projection = after.projections.find((item) => item.model_id === DECLARED_MODEL_ID);
  assert.ok(projection, '声明写入后下一次投影请求必须含该模型的投影');
  assert.equal(projection.package_id, DECLARED_PACKAGE_ID);
  const bundle = after.localization_bundles.find((item) => item.package_id === DECLARED_PACKAGE_ID);
  assert.ok(bundle, '声明写入后下一次投影请求必须含该模型的本地化束');
  assert.equal(bundle.namespace, `model-asset/${DECLARED_PACKAGE_ID}`);
  assert.ok(
    Object.keys(bundle.resources['zh-CN']).length > 0 && Object.keys(bundle.resources.en).length > 0,
    '本地化束必须承载真实译文，Editor 侧不得回退到未翻译的命名空间键',
  );
});

void test('删除声明后，下一次投影请求不再包含该模型', async (t) => {
  setupIsolatedEnv(t);
  const baseUrl = await startServer(t);

  assert.equal((await declareModel(baseUrl, DECLARED_MODEL_ID)).status, 200);
  const withModel = await getNodeProjections(baseUrl);
  assert.ok(
    withModel.projections.some((projection) => projection.model_id === DECLARED_MODEL_ID),
    '前置：声明模型已进入投影',
  );

  const removal = await fetch(`${baseUrl}/api/custom-generation-models/${DECLARED_MODEL_ID}`, {
    method: 'DELETE',
    headers: writeHeaders(),
  });
  assert.equal(removal.status, 200);

  const after = await getNodeProjections(baseUrl);
  assert.ok(
    !after.projections.some((projection) => projection.model_id === DECLARED_MODEL_ID),
    '删除声明后投影不得再含该模型',
  );
  assert.ok(
    !after.localization_bundles.some((bundle) => bundle.package_id === DECLARED_PACKAGE_ID),
    '删除声明后本地化束不得再含该模型',
  );
});

void test('同一次失效的并发投影请求只重建一次（消费同一份快照）', async (t) => {
  setupIsolatedEnv(t);
  const baseUrl = await startServer(t);

  assert.equal((await declareModel(baseUrl, 'projection-refresh-image-a')).status, 200);
  const before = await getNodeProjections(baseUrl);

  assert.equal((await declareModel(baseUrl, 'projection-refresh-image-b')).status, 200);
  const [first, second] = await Promise.all([
    getNodeProjections(baseUrl),
    getNodeProjections(baseUrl),
  ]);
  assert.ok(
    first.projections.some((projection) => projection.model_id === 'projection-refresh-image-b')
      && second.projections.some((projection) => projection.model_id === 'projection-refresh-image-b'),
    '并发请求都必须看到新声明的模型',
  );
  assert.equal(first.loaded_at, second.loaded_at, '并发请求必须消费同一份单飞重建快照');
  assert.notEqual(first.loaded_at, before.loaded_at, '声明变更后必须发生一次重建');
});

void test('快照 holder：首读装配一次，多次失效合并一次重建，未失效不重建', async (t) => {
  setupIsolatedEnv(t);

  let rebuilds = 0;
  const snapshot = createModelProjectionSnapshotCatalog(
    { baseDir: undefined },
    { onRebuild: () => {
      rebuilds += 1;
    } },
  );
  assert.equal(rebuilds, 0, '创建快照不装配（不急切读声明 store）');

  void snapshot.catalog.projections;
  assert.equal(rebuilds, 1, '首个属性读取装配一次');

  snapshot.invalidate();
  snapshot.invalidate();
  void snapshot.catalog.localization_bundles;
  assert.equal(rebuilds, 2, '多次失效合并为一次重建');

  void snapshot.catalog.loaded_at;
  void snapshot.catalog.diagnostics;
  assert.equal(rebuilds, 2, '未失效的后续读取不重建');

  // 重建产物是声明 inclusive 的：store 直连写入一条记录 → 失效 → 快照含该模型。
  const declared = addCustomGenerationModel({
    model_id: DECLARED_MODEL_ID,
    connection_id: await seedGenerationConnection(),
    family_adapter_id: 'openai-image-v1',
  });
  assert.ok(declared.ok, 'store 直连应能声明自建生成模型');
  snapshot.invalidate();
  assert.ok(
    snapshot.catalog.projections.some((projection) => projection.model_id === DECLARED_MODEL_ID),
    '失效后重建的快照必须并入新声明',
  );
});

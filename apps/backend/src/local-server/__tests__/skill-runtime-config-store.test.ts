import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SkillRuntimeConfigSchema } from '@iart/contracts';

import {
  createConnection,
  setConnectionCredential,
  clearCacheForTest as clearConnectionCache,
} from '../provider-connection/connection-store.cts';
import {
  addCustomGenerationModel,
  clearCacheForTest as clearCustomGenerationModelCache,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  setActiveDeployment,
  clearCacheForTest as clearActiveRouteCache,
} from '../provider-connection/active-route-store.cts';
import { setCredentialForConnection } from '../provider-connection/credential-store.cts';
import {
  writeSkillRuntimeConfig,
  buildSkillRuntimeConfig,
  createSkillRuntimeConfigRefresher,
  __test_only__,
} from '../skill-runtime/skill-runtime-config-store.cts';

/**
 * skill 运行时配置的来源是「gpt-image-2 的 active 接入目标」——与任务主链同一套凭证链
 * （ExecutionSnapshot → CredentialLease）。因此本测试不再用全局密钥槽位准备数据，
 * 而是建一个真实的「服务商连接 + 凭证 + 模型记录 + active 路由」。
 */

const SKILL_MODEL_ID = 'gpt-image-2';
const CONNECTION_BASE_URL = 'https://byok.example.com/v1';
const CREDENTIAL_VALUE = 'sk-byok-skill-key';
const CONFIG_FILENAME = __test_only__.GPT_IMAGE_CONFIG_FILENAME;

type RuntimeConfigJson = {
  gatewayBaseUrl: string;
  proxyBaseUrl: string;
  candidates: Array<{ modelId: string; tierKey: string | null; apiKey: string }>;
  modelId: string;
  updatedAt: string;
};

const resetStores = (): void => {
  clearConnectionCache();
  clearCustomGenerationModelCache();
  clearActiveRouteCache();
};

/** 每个测试用独立临时根目录隔离 skill 配置目录与 provider 连接存储。 */
const withIsolatedRoots = (t: test.TestContext): { skillDir: string } => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-runtime-test-'));
  const skillDir = path.join(tempRoot, 'skills-runtime');
  const previousSkillDir = process.env['IART_SKILL_RUNTIME_DIR'];
  const previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_SKILL_RUNTIME_DIR'] = skillDir;
  process.env['IART_STORAGE_ROOT'] = path.join(tempRoot, 'storage');
  resetStores();
  t.after(() => {
    if (previousSkillDir === undefined) {
      delete process.env['IART_SKILL_RUNTIME_DIR'];
    } else {
      process.env['IART_SKILL_RUNTIME_DIR'] = previousSkillDir;
    }
    if (previousStorageRoot === undefined) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousStorageRoot;
    }
    resetStores();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  });
  return { skillDir };
};

/**
 * 建 enabled 连接 + 凭证 + 该模型的用户记录，并设为 active。
 *
 * 2026-10-19 起模型只有用户记录一种载体（spec 03 §6.1 / PC-14）：记录本身即接入目标
 * （`record_id`），不再有独立的接入对象可建。断言保护的行为不变——skill 运行时配置的端点与
 * 密钥来自该模型的 active 接入目标。
 */
const seedActiveModelRecord = async (): Promise<void> => {
  const connection = createConnection({
    display_name: 'byok-test',
    base_url: CONNECTION_BASE_URL,
  });
  const credential = await setCredentialForConnection(connection.connection_id, CREDENTIAL_VALUE);
  assert.ok(credential, 'credential should be stored');
  setConnectionCredential(connection.connection_id, credential.credentialRef, credential.version, true);
  const record = addCustomGenerationModel({
    model_id: SKILL_MODEL_ID,
    connection_id: connection.connection_id,
    remote_model_id: SKILL_MODEL_ID,
    family_adapter_id: 'openai-image-v1',
  });
  assert.equal(record.ok, true, 'generation model record should be created');
  if (!record.ok) return;
  const active = setActiveDeployment(SKILL_MODEL_ID, record.model.record_id);
  assert.equal(active, record.model.record_id, 'active access target should be set');
};

void test('skill-runtime-config-store: 无 active 接入目标时返回 null 且不写文件', async (t) => {
  const { skillDir } = withIsolatedRoots(t);

  assert.equal(await buildSkillRuntimeConfig(39000), null);
  await writeSkillRuntimeConfig(39000);
  assert.equal(fs.existsSync(path.join(skillDir, CONFIG_FILENAME)), false);
});

void test('skill-runtime-config-store: 端点与密钥来自 gpt-image-2 的服务商连接', async (t) => {
  const { skillDir } = withIsolatedRoots(t);
  await seedActiveModelRecord();

  await writeSkillRuntimeConfig(39000);

  const configPath = path.join(skillDir, CONFIG_FILENAME);
  assert.equal(fs.existsSync(configPath), true);
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as RuntimeConfigJson;
  assert.equal(SkillRuntimeConfigSchema.safeParse(parsed).success, true);
  // 端点不再写死任何网关，取服务商连接的 base_url
  assert.equal(parsed.gatewayBaseUrl, CONNECTION_BASE_URL);
  assert.equal(parsed.proxyBaseUrl, 'http://127.0.0.1:39000');
  assert.equal(parsed.modelId, SKILL_MODEL_ID);
  assert.equal(typeof parsed.updatedAt, 'string');
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0]?.modelId, SKILL_MODEL_ID);
  assert.equal(parsed.candidates[0]?.tierKey, null);
  assert.equal(parsed.candidates[0]?.apiKey, CREDENTIAL_VALUE);
  // 0600 文件保护（apiKey 为明文）
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

void test('skill-runtime-config-store: refresher 在目标不可解析时不抛出', async (t) => {
  withIsolatedRoots(t);

  const refresh = createSkillRuntimeConfigRefresher(() => 39002);
  assert.doesNotThrow(() => refresh());
  // 刷新是异步的；等待其 settle，确保失败不会变成未处理的 rejection
  await new Promise((resolve) => setTimeout(resolve, 50));
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HUB_LOCAL_WRITE_TOKEN_ENV, HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';
import { createRequestHandler } from '../router.cts';

/**
 * 默认模型配置项（spec docs/agent/06「agent 形态的输入面」、docs/hub/hub-information-architecture.md §7.4）。
 *
 * 两个形态的默认模型是**同层同构**的两项（`config.agentDefaultModelId` / `config.generationDefaultModelId`）：
 * **只改其中一个**也必须是合法更新（「取消默认」就只发这一个字段）；空串归一成 null（没设默认）；
 * 写入体里没带的字段保留旧值——补全逻辑在 Hub 侧，后端按字段有无处理。两者互不串写：
 * 只改生成默认模型时，Agent 默认模型必须一动不动（反之亦然）。
 */

const HUB_WRITE_TOKEN = 'c'.repeat(32);

type JsonValue = Record<string, unknown>;

const startServer = async () => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('agent_default_model_route_server_address_unavailable');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const withIsolatedEnv = (t: test.TestContext) => {
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-agent-default-model-'));
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempDir;
  t.after(() => {
    if (previousToken == null) delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    else process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    if (previousRoot == null) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
};

const withServer = async (t: test.TestContext) => {
  const started = await startServer();
  t.after(() => new Promise<void>((resolve, reject) => {
    started.server.close((error) => (error ? reject(error) : resolve()));
  }));
  return started.baseUrl;
};

const headers = (): Record<string, string> => ({
  'content-type': 'application/json',
  [HUB_LOCAL_WRITE_TOKEN_HEADER]: HUB_WRITE_TOKEN,
});

const readConfig = async (baseUrl: string): Promise<JsonValue> =>
  (await (await fetch(`${baseUrl}/api/config`)).json()) as JsonValue;

const resolvedOf = (payload: JsonValue): JsonValue => payload['resolved'] as JsonValue;

const putConfig = async (baseUrl: string, body: JsonValue): Promise<JsonValue> =>
  (await (
    await fetch(`${baseUrl}/api/config`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) })
  ).json()) as JsonValue;

void test('Agent 默认模型：可单独写入、可清空，未带的字段保留旧值', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await withServer(t);

  assert.equal(resolvedOf(await readConfig(baseUrl))['agentDefaultModelId'], null, '没设默认时是 null');

  const set = await putConfig(baseUrl, { agentDefaultModelId: 'my-llm' });
  assert.equal(resolvedOf(set)['agentDefaultModelId'], 'my-llm');

  // 只改它的每一次更新都合法（不需要为了「有字段可改」而顺带改别的配置）
  const cleared = await putConfig(baseUrl, { agentDefaultModelId: null });
  assert.equal(resolvedOf(cleared)['agentDefaultModelId'], null);

  // 空串与空白归一成 null，不会留下一个空模型名
  assert.equal(resolvedOf(await putConfig(baseUrl, { agentDefaultModelId: '' }))['agentDefaultModelId'], null);
  assert.equal(resolvedOf(await putConfig(baseUrl, { agentDefaultModelId: '   ' }))['agentDefaultModelId'], null);

  // 写入以后，别的配置不动：先设一次批量数，再只改默认模型，批量数应保留
  await putConfig(baseUrl, { maxBatchTasks: 12, agentDefaultModelId: 'my-llm' });
  const after = await putConfig(baseUrl, { agentDefaultModelId: 'other-llm' });
  assert.equal(resolvedOf(after)['maxBatchTasks'], 12, '未带的字段保留旧值');
  assert.equal(resolvedOf(after)['agentDefaultModelId'], 'other-llm');
});

void test('生成默认模型：可单独写入、可清空，且不动 Agent 默认模型', async (t) => {
  withIsolatedEnv(t);
  const baseUrl = await withServer(t);

  assert.equal(resolvedOf(await readConfig(baseUrl))['generationDefaultModelId'], null, '没设默认时是 null');

  // 白名单漏收的话这里是静默失败：PUT 返回 200，值却停在 null
  const set = await putConfig(baseUrl, { generationDefaultModelId: 'gpt-image-2' });
  assert.equal(resolvedOf(set)['generationDefaultModelId'], 'gpt-image-2');

  // 只改它的每一次更新都合法（「取消默认」就只发这一个字段）
  assert.equal(resolvedOf(await putConfig(baseUrl, { generationDefaultModelId: null }))['generationDefaultModelId'], null);

  // 空串与空白归一成 null，不会留下一个空模型名
  assert.equal(resolvedOf(await putConfig(baseUrl, { generationDefaultModelId: '' }))['generationDefaultModelId'], null);
  assert.equal(resolvedOf(await putConfig(baseUrl, { generationDefaultModelId: '   ' }))['generationDefaultModelId'], null);

  // 两个默认模型互不串写：先各设一个，再分别只改其中一个
  await putConfig(baseUrl, { agentDefaultModelId: 'my-llm', generationDefaultModelId: 'gpt-image-2' });
  const afterGeneration = await putConfig(baseUrl, { generationDefaultModelId: 'other-image' });
  assert.equal(resolvedOf(afterGeneration)['generationDefaultModelId'], 'other-image');
  assert.equal(resolvedOf(afterGeneration)['agentDefaultModelId'], 'my-llm', '改生成默认不该动 Agent 默认');

  const afterAgent = await putConfig(baseUrl, { agentDefaultModelId: 'other-llm' });
  assert.equal(resolvedOf(afterAgent)['agentDefaultModelId'], 'other-llm');
  assert.equal(resolvedOf(afterAgent)['generationDefaultModelId'], 'other-image', '改 Agent 默认不该动生成默认');
});

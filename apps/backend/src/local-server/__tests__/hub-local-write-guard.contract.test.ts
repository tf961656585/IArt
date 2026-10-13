import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HUB_LOCAL_WRITE_TOKEN_ENV, HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';
import { createRequestHandler } from '../router.cts';
import {
  createPromptPreset as createDesktopPromptPreset,
  listPromptPresets as listDesktopPromptPresets,
  setPresetsFilePath,
} from '../../../../desktop-shell/src/storage/editor-storage-prompt-presets.cts';

const HUB_WRITE_TOKEN = 'a'.repeat(32);

type JsonValue = Record<string, unknown>;

const startServer = async () => {
  const server = http.createServer(createRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('hub_local_write_guard_server_address_unavailable');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const withHubWriteEnv = (t: test.TestContext) => {
  const previousToken = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
  const previousStorageRoot = process.env['IART_STORAGE_ROOT'];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-hub-local-write-guard-'));
  process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
  process.env['IART_STORAGE_ROOT'] = tempDir;
  t.after(() => {
    if (previousToken == null) {
      delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    } else {
      process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousToken;
    }
    if (previousStorageRoot == null) {
      delete process.env['IART_STORAGE_ROOT'];
    } else {
      process.env['IART_STORAGE_ROOT'] = previousStorageRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
};

const withServer = async (t: test.TestContext) => {
  const started = await startServer();
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      started.server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return started.baseUrl;
};

const parseJson = async (response: Response): Promise<JsonValue> => {
  return response.json() as Promise<JsonValue>;
};

const buildHeaders = (
  token: string | undefined,
  extras: Record<string, string> | undefined = undefined,
) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(extras ?? {}),
  };
  if (typeof token === 'string') {
    headers[HUB_LOCAL_WRITE_TOKEN_HEADER] = token;
  }
  return headers;
};

const resolvePromptPresetsFilePath = (): string => {
  const storageRoot = process.env['IART_STORAGE_ROOT'];
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw new Error('iart_storage_root_missing_for_prompt_presets_test');
  }
  return path.join(storageRoot, 'config', 'prompt-presets.json');
};

void test('hub local write guard: prompt-presets write without token returns 403', async (t) => {
  withHubWriteEnv(t);
  const baseUrl = await withServer(t);

  const response = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'POST',
    headers: buildHeaders(undefined),
    body: JSON.stringify({ name: 'preset', content: 'prompt' }),
  });

  assert.equal(response.status, 403);
  const payload = await parseJson(response);
  assert.equal(payload['code'], 'origin_not_allowed');
});

void test('hub local write guard: prompt-presets write with correct token executes real CRUD', async (t) => {
  withHubWriteEnv(t);
  const baseUrl = await withServer(t);

  const createResponse = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'POST',
    headers: buildHeaders(HUB_WRITE_TOKEN),
    body: JSON.stringify({ name: 'preset', content: 'prompt' }),
  });

  assert.equal(createResponse.status, 200);
  const createPayload = await parseJson(createResponse);
  assert.equal(createPayload['success'], true);
  const createdPreset = createPayload['preset'] as JsonValue;
  const presetId = String(createdPreset['id'] || '');
  assert.equal(Boolean(presetId), true);

  const loadResponse = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'GET',
  });
  assert.equal(loadResponse.status, 200);
  const loadPayload = await parseJson(loadResponse);
  const presets = Array.isArray(loadPayload['presets']) ? loadPayload['presets'] : [];
  assert.equal(presets.length, 1);

  const updateResponse = await fetch(`${baseUrl}/api/prompt-presets/${encodeURIComponent(presetId)}`, {
    method: 'PUT',
    headers: buildHeaders(HUB_WRITE_TOKEN),
    body: JSON.stringify({ name: 'preset-updated', content: 'prompt-updated' }),
  });
  assert.equal(updateResponse.status, 200);
  const updatePayload = await parseJson(updateResponse);
  assert.equal(updatePayload['success'], true);

  const deleteResponse = await fetch(`${baseUrl}/api/prompt-presets/${encodeURIComponent(presetId)}`, {
    method: 'DELETE',
    headers: buildHeaders(HUB_WRITE_TOKEN),
  });
  assert.equal(deleteResponse.status, 200);
  const deletePayload = await parseJson(deleteResponse);
  assert.equal(deletePayload['success'], true);
});

void test('hub local write guard: prompt-presets get does not require token', async (t) => {
  withHubWriteEnv(t);
  const baseUrl = await withServer(t);

  const response = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'GET',
  });

  assert.equal(response.status, 200);
  const payload = await parseJson(response);
  assert.equal(payload['success'], true);
  assert.deepEqual(payload['presets'], []);
});

void test('hub local write guard: prompt-presets put without token returns 403', async (t) => {
  withHubWriteEnv(t);
  const baseUrl = await withServer(t);

  const createResponse = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'POST',
    headers: buildHeaders(HUB_WRITE_TOKEN),
    body: JSON.stringify({ name: 'preset', content: 'prompt' }),
  });
  const createPayload = await parseJson(createResponse);
  const presetId = String(((createPayload['preset'] as JsonValue)['id']) || '');

  const response = await fetch(`${baseUrl}/api/prompt-presets/${encodeURIComponent(presetId)}`, {
    method: 'PUT',
    headers: buildHeaders(undefined),
    body: JSON.stringify({ name: 'blocked', content: 'blocked' }),
  });

  assert.equal(response.status, 403);
  const payload = await parseJson(response);
  assert.equal(payload['code'], 'origin_not_allowed');
});

void test('hub local write guard: prompt-presets delete without token returns 403', async (t) => {
  withHubWriteEnv(t);
  const baseUrl = await withServer(t);

  const createResponse = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'POST',
    headers: buildHeaders(HUB_WRITE_TOKEN),
    body: JSON.stringify({ name: 'preset', content: 'prompt' }),
  });
  const createPayload = await parseJson(createResponse);
  const presetId = String(((createPayload['preset'] as JsonValue)['id']) || '');

  const response = await fetch(`${baseUrl}/api/prompt-presets/${encodeURIComponent(presetId)}`, {
    method: 'DELETE',
    headers: buildHeaders(undefined),
  });

  assert.equal(response.status, 403);
  const payload = await parseJson(response);
  assert.equal(payload['code'], 'origin_not_allowed');
});

void test('prompt-presets shared storage: backend http write is visible to desktop shell storage', async (t) => {
  withHubWriteEnv(t);
  const baseUrl = await withServer(t);
  setPresetsFilePath(resolvePromptPresetsFilePath());

  const createResponse = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'POST',
    headers: buildHeaders(HUB_WRITE_TOKEN),
    body: JSON.stringify({ name: 'backend-preset', content: 'backend-content' }),
  });

  assert.equal(createResponse.status, 200);
  const presets = listDesktopPromptPresets();
  assert.equal(presets.length, 1);
  const firstPreset = presets[0];
  if (firstPreset === undefined) {
    throw new Error('desktop_prompt_preset_missing_after_backend_write');
  }
  assert.equal(firstPreset.name, 'backend-preset');
  assert.equal(firstPreset.content, 'backend-content');
});

void test('prompt-presets shared storage: desktop shell storage write is visible to backend http get', async (t) => {
  withHubWriteEnv(t);
  const baseUrl = await withServer(t);
  setPresetsFilePath(resolvePromptPresetsFilePath());

  const preset = createDesktopPromptPreset({ name: 'desktop-preset', content: 'desktop-content' });
  assert.notEqual(preset, null);

  const response = await fetch(`${baseUrl}/api/prompt-presets`, {
    method: 'GET',
  });

  assert.equal(response.status, 200);
  const payload = await parseJson(response);
  assert.equal(payload['success'], true);
  const presets = Array.isArray(payload['presets']) ? payload['presets'] : [];
  assert.equal(presets.length, 1);
  const firstPreset = presets[0] as JsonValue;
  assert.equal(firstPreset['name'], 'desktop-preset');
  assert.equal(firstPreset['content'], 'desktop-content');
});

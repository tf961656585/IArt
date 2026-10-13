import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=';

const CLOUDFLARE_ENV = 'IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT';
const SELF_HOSTED_ENV = 'IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT';

const createProjectFolder = (rootDir: string) => {
  const projectPath = path.join(rootDir, 'demo.iartproj');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'manifest.json'),
    JSON.stringify({ version: 1, name: 'router-media-upload' }, null, 2),
    'utf-8',
  );
  return projectPath;
};

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('router_media_upload_server_address_unavailable');
  }
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: http.Server) => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const restoreEnv = (name: string, previous: string | undefined) => {
  if (previous == null) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
};

const createUploadForm = (projectPath: string, targetType: string) => {
  const form = new FormData();
  form.append('projectPath', projectPath);
  form.append('mode', 'public_relay');
  form.append('targetType', targetType);
  form.append(
    'file',
    new Blob([Buffer.from(PNG_1X1_BASE64, 'base64')], { type: 'image/png' }),
    'relay.png',
  );
  return form;
};

type UploadResponsePayload = {
  url?: unknown;
  code?: unknown;
};

const readUploadResponsePayload = async (response: Response): Promise<UploadResponsePayload> => {
  const payload: unknown = await response.json();
  return payload && typeof payload === 'object' ? payload as UploadResponsePayload : {};
};

const requireStringField = (value: unknown, fieldName: string) => {
  if (typeof value !== 'string') {
    throw new Error(`missing_${fieldName}`);
  }
  return value;
};

void test('router: /api/upload 在 public_relay 时会按 targetType 命中不同 backend relay 端点', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-media-upload-'));
  const projectPath = createProjectFolder(tempDir);
  const previousCloudflareEndpoint = process.env[CLOUDFLARE_ENV];
  const previousSelfHostedEndpoint = process.env[SELF_HOSTED_ENV];
  const receivedPaths: string[] = [];

  const cloudflareRelayServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/cloudflare-upload') {
      res.writeHead(404).end();
      return;
    }
    receivedPaths.push('cloudflare');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, url: 'https://cloudflare.example.com/formal-image.png' }));
  });
  const selfHostedRelayServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/self-hosted-upload') {
      res.writeHead(404).end();
      return;
    }
    receivedPaths.push('self_hosted');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, url: 'https://self-hosted.example.com/formal-image.png' }));
  });
  const cloudflareBaseUrl = await listen(cloudflareRelayServer);
  const selfHostedBaseUrl = await listen(selfHostedRelayServer);
  process.env[CLOUDFLARE_ENV] = `${cloudflareBaseUrl}/cloudflare-upload`;
  process.env[SELF_HOSTED_ENV] = `${selfHostedBaseUrl}/self-hosted-upload`;

  const { createRequestHandler } = await import('../router.cts');
  const appServer = http.createServer(createRequestHandler());
  const appBaseUrl = await listen(appServer);

  t.after(async () => {
    await closeServer(appServer);
    await closeServer(cloudflareRelayServer);
    await closeServer(selfHostedRelayServer);
    restoreEnv(CLOUDFLARE_ENV, previousCloudflareEndpoint);
    restoreEnv(SELF_HOSTED_ENV, previousSelfHostedEndpoint);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const cloudflareResponse = await fetch(`${appBaseUrl}/api/upload`, {
    method: 'POST',
    body: createUploadForm(projectPath, 'cloudflare_image_public_url'),
  });
  assert.equal(cloudflareResponse.status, 200);
  const cloudflarePayload = await readUploadResponsePayload(cloudflareResponse);
  assert.equal(cloudflarePayload.url, 'https://cloudflare.example.com/formal-image.png');

  const selfHostedResponse = await fetch(`${appBaseUrl}/api/upload`, {
    method: 'POST',
    body: createUploadForm(projectPath, 'self_hosted_image_public_url'),
  });
  assert.equal(selfHostedResponse.status, 200);
  const selfHostedPayload = await readUploadResponsePayload(selfHostedResponse);
  assert.equal(selfHostedPayload.url, 'https://self-hosted.example.com/formal-image.png');

  const localForm = new FormData();
  localForm.append('projectPath', projectPath);
  localForm.append(
    'file',
    new Blob([Buffer.from(PNG_1X1_BASE64, 'base64')], { type: 'image/png' }),
    'local.png',
  );
  const localResponse = await fetch(`${appBaseUrl}/api/upload`, {
    method: 'POST',
    body: localForm,
  });
  assert.equal(localResponse.status, 200);
  const localPayload = await readUploadResponsePayload(localResponse);
  // 本地上传现在产 local-media:// 完整 URL（scope 形态），不再拼 baseUrl + /files/ 路径
  assert.match(requireStringField(localPayload.url, 'url'), /^local-media:\/\/prj_[a-f0-9]{32}\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(receivedPaths, ['cloudflare', 'self_hosted']);
});

void test('router: /api/upload 的 public_relay targetType 对应端点不可用时返回 registry 错误且不回退', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-media-upload-missing-endpoint-'));
  const projectPath = createProjectFolder(tempDir);
  const previousCloudflareEndpoint = process.env[CLOUDFLARE_ENV];
  const previousSelfHostedEndpoint = process.env[SELF_HOSTED_ENV];
  process.env[CLOUDFLARE_ENV] = 'not-a-url';
  process.env[SELF_HOSTED_ENV] = 'http://127.0.0.1:9/self-hosted-upload';

  const { createRequestHandler } = await import('../router.cts');
  const server = http.createServer(createRequestHandler());
  const baseUrl = await listen(server);

  t.after(async () => {
    await closeServer(server);
    restoreEnv(CLOUDFLARE_ENV, previousCloudflareEndpoint);
    restoreEnv(SELF_HOSTED_ENV, previousSelfHostedEndpoint);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const cloudflareMissingResponse = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: createUploadForm(projectPath, 'cloudflare_image_public_url'),
  });
  assert.equal(cloudflareMissingResponse.status, 400);
  const cloudflareMissingPayload = await readUploadResponsePayload(cloudflareMissingResponse);
  assert.equal(cloudflareMissingPayload.code, 'public_relay_target_endpoint_invalid');

  process.env[CLOUDFLARE_ENV] = 'http://127.0.0.1:9/cloudflare-upload';
  process.env[SELF_HOSTED_ENV] = 'not-a-url';
  const selfHostedMissingResponse = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: createUploadForm(projectPath, 'self_hosted_image_public_url'),
  });
  assert.equal(selfHostedMissingResponse.status, 400);
  const selfHostedMissingPayload = await readUploadResponsePayload(selfHostedMissingResponse);
  assert.equal(selfHostedMissingPayload.code, 'public_relay_target_endpoint_invalid');
});

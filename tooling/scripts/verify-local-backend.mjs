import { readPreferredBackendPort } from '../backend-build-output-api.mjs';

const args = process.argv.slice(2);
const pickArg = (name) => {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const value = args[idx + 1];
  return value && !value.startsWith('--') ? value : '';
};

const baseArg = pickArg('--base');
const portArg = pickArg('--port');
const mediaUrlArg = pickArg('--media-url');

const buildBaseFromPort = (value) => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return `http://127.0.0.1:${parsed}`;
};

const readPreferredPort = () => {
  try {
    return readPreferredBackendPort();
  } catch {
    return null;
  }
};

let baseUrl = baseArg || buildBaseFromPort(portArg) || buildBaseFromPort(process.env.IART_BACKEND_PORT);
if (!baseUrl) {
  const preferred = readPreferredPort();
  baseUrl = buildBaseFromPort(preferred);
}

if (!baseUrl) {
  console.error('[verify] No local backend base URL detected.');
  console.error('Start backend with IART_BACKEND_PORT=39000 or pass --base / --port.');
  process.exit(1);
}

const fetchJson = async (url, options) => {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { res, body: json };
};

const assertStatus = (label, res, expected) => {
  if (res.status !== expected) {
    console.error(`[verify] ${label} failed (status ${res.status}, expected ${expected})`);
    return false;
  }
  console.log(`[verify] ${label} ok (${res.status})`);
  return true;
};

const run = async () => {
  let failed = false;
  console.log(`[verify] base=${baseUrl}`);

  const health = await fetchJson(`${baseUrl}/health`);
  assertStatus('health', health.res, 200);

  const config = await fetchJson(`${baseUrl}/api/config`);
  assertStatus('config', config.res, 200);

  const diag = await fetchJson(`${baseUrl}/api/diagnostics`);
  assertStatus('diagnostics', diag.res, 200);

  const diagBundle = await fetch(`${baseUrl}/api/diagnostics/bundle`);
  assertStatus('diagnostics bundle', diagBundle, 200);

  const badOrigin = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://example.com' },
  });
  assertStatus('origin allowed', badOrigin, 200);

  // NOTE: /api/projects/create 路由已移除（项目创建走 IPC），上传验证步骤已跳过
  // 如需恢复上传测试，需通过 IPC 先创建项目再验证上传端点

  if (mediaUrlArg) {
    const testUrl = mediaUrlArg.trim();
    const mediaResp = await fetchJson(
      `${baseUrl}/api/media-proxy?format=base64&url=${encodeURIComponent(testUrl)}`
    );
    if (mediaResp.res.status === 403) {
      console.error('[verify] media proxy blocked (unexpected after allow-all change)', mediaResp.body);
      process.exitCode = 1;
    } else {
      console.log(`[verify] media proxy responded (${mediaResp.res.status})`);
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error('[verify] failed', error);
  process.exit(1);
});

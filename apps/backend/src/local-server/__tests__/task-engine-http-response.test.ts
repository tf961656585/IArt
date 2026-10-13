import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * buildResponsePayload 单元测试。
 *
 * 覆盖核心修复点：第三方网关/中转会把 JSON 响应包成 text/plain 返回，
 * 旧逻辑只按 Content-Type 判定是否 JSON.parse，导致这类响应被当成纯文本存进 response.body，
 * 下游 output_mapping_rules 路径解析器在字符串上无法命中字段，触发 result_output_mapping_missed 误判。
 *
 * 修复后：不论 Content-Type 是否为 JSON，对「看起来像 JSON」的文本（以 { 或 [ 开头）都兜底尝试 parse。
 */

type BuildResponsePayloadParams = {
  response: Response;
  contentType: string;
  receivedBytes: number;
  responseHeaders: Headers;
  attempt: number;
  inlineChunks: Buffer[];
};

type BuildResponsePayload = (params: BuildResponsePayloadParams) => {
  status: number;
  ok: boolean;
  contentType: string;
  size: number;
  headers: Headers;
  receivedAt: string;
  attempt: number;
  body: unknown;
  bodyType: string | null;
  file: Record<string, unknown> | null;
};

const loadBuildResponsePayload = async (): Promise<BuildResponsePayload> => {
  const imported = await import('../task-engine-http-response.cts');
  const record = imported as { buildResponsePayload?: unknown };
  if (typeof record.buildResponsePayload !== 'function') {
    throw new Error('buildResponsePayload export missing');
  }
  return record.buildResponsePayload as BuildResponsePayload;
};

const buildParams = (overrides: Partial<BuildResponsePayloadParams>): BuildResponsePayloadParams => {
  const text = overrides.inlineChunks?.[0]?.toString('utf-8') ?? '';
  return {
    response: new Response(text),
    contentType: 'text/plain; charset=utf-8',
    receivedBytes: 0,
    responseHeaders: new Headers(),
    attempt: 1,
    inlineChunks: [],
    ...overrides,
  };
};

void test('buildResponsePayload: text/plain 包裹的 JSON 应被 parse 为 json', async () => {
  const buildResponsePayload = await loadBuildResponsePayload();
  // 复刻 2026-07-21 真实失败案例：gemini 文生图经第三方中转，Content-Type=text/plain，body 实为 JSON。
  const jsonBody = '{"candidates":[{"content":{"role":"model","parts":[{"inlineData":{"mimeType":"image/jpeg","data":"/9j/4AAQ"}}]}}]}';
  const payload = buildResponsePayload(buildParams({
    contentType: 'text/plain; charset=utf-8',
    receivedBytes: Buffer.byteLength(jsonBody, 'utf-8'),
    inlineChunks: [Buffer.from(jsonBody, 'utf-8')],
  }));
  assert.equal(payload.bodyType, 'json');
  assert.equal(typeof payload.body, 'object');
  assert.notEqual(payload.body, null);
  const body = payload.body as { candidates: Array<{ content: { role: string } }> };
  const firstCandidate = body.candidates[0];
  assert.ok(firstCandidate, 'candidates[0] should exist');
  assert.equal(firstCandidate.content.role, 'model');
});

void test('buildResponsePayload: application/json 走原契约路径仍 parse 成功', async () => {
  const buildResponsePayload = await loadBuildResponsePayload();
  const jsonBody = '{"ok":true}';
  const payload = buildResponsePayload(buildParams({
    contentType: 'application/json; charset=utf-8',
    receivedBytes: Buffer.byteLength(jsonBody, 'utf-8'),
    inlineChunks: [Buffer.from(jsonBody, 'utf-8')],
  }));
  assert.equal(payload.bodyType, 'json');
  assert.deepEqual(payload.body, { ok: true });
});

void test('buildResponsePayload: 真正的纯文本（不以 { 或 [ 开头）保持 text 不被误 parse', async () => {
  const buildResponsePayload = await loadBuildResponsePayload();
  const plainText = 'Task queued. Track progress via polling.';
  const payload = buildResponsePayload(buildParams({
    contentType: 'text/plain; charset=utf-8',
    receivedBytes: Buffer.byteLength(plainText, 'utf-8'),
    inlineChunks: [Buffer.from(plainText, 'utf-8')],
  }));
  assert.equal(payload.bodyType, 'text');
  assert.equal(payload.body, plainText);
});

void test('buildResponsePayload: 截断的 JSON 文本（以 { 开头但解析失败）回退为 text', async () => {
  const buildResponsePayload = await loadBuildResponsePayload();
  // 以 { 开头会触发 looksLikeJsonText，但 JSON.parse 失败应回退为 text，不抛错。
  const truncated = '{"candidates":[{"content":{"parts":[{"inlineData":';
  const payload = buildResponsePayload(buildParams({
    contentType: 'text/plain; charset=utf-8',
    receivedBytes: Buffer.byteLength(truncated, 'utf-8'),
    inlineChunks: [Buffer.from(truncated, 'utf-8')],
  }));
  assert.equal(payload.bodyType, 'text');
  assert.equal(payload.body, truncated);
  // file 字段恒为 null：响应统一走 inline，无独立文件产物（历史落盘分支已移除）。
  assert.equal(payload.file, null);
});

void test('buildResponsePayload: 数组型 JSON（以 [ 开头）也被兜底 parse', async () => {
  const buildResponsePayload = await loadBuildResponsePayload();
  const arrayJson = '[{"url":"https://example.com/a.png"}]';
  const payload = buildResponsePayload(buildParams({
    contentType: 'text/plain',
    receivedBytes: Buffer.byteLength(arrayJson, 'utf-8'),
    inlineChunks: [Buffer.from(arrayJson, 'utf-8')],
  }));
  assert.equal(payload.bodyType, 'json');
  assert.ok(Array.isArray(payload.body));
});

void test('buildResponsePayload: 空响应体保持 body=null / bodyType=null', async () => {
  const buildResponsePayload = await loadBuildResponsePayload();
  const payload = buildResponsePayload(buildParams({
    contentType: 'text/plain; charset=utf-8',
    inlineChunks: [],
  }));
  assert.equal(payload.body, null);
  assert.equal(payload.bodyType, null);
});

void test('buildResponsePayload: 文本前后有空白仍能识别 JSON 并 parse', async () => {
  const buildResponsePayload = await loadBuildResponsePayload();
  // 某些网关会在 JSON 前后塞 BOM 或空白；trimStart 后以 { 开头也应识别。
  const padded = '   \n  {"data":"ok"}  \n  ';
  const payload = buildResponsePayload(buildParams({
    contentType: 'text/plain',
    receivedBytes: Buffer.byteLength(padded, 'utf-8'),
    inlineChunks: [Buffer.from(padded, 'utf-8')],
  }));
  assert.equal(payload.bodyType, 'json');
  assert.deepEqual(payload.body, { data: 'ok' });
});

/**
 * parsePollingResponseBody 单元测试（polling 路径）。
 *
 * 覆盖与 http sync 路径同源的修复点：polling 旧逻辑只按 Content-Type 判定是否 JSON.parse，
 * 中转网关把 JSON 标成 text/plain 时 body 存为字符串。轮询判定（readValueByPath 可解析
 * JSON 字符串）能成功，但下游 output_mapping_rules 物化（readValuesByPath 不解析字符串）
 * 在字符串 body 上映射未命中，任务报 result_output_mapping_missed——「轮询成功但任务失败」。
 * 修复后 polling 与 http sync 共享同一兜底口径：是否 parse 由文本内容决定。
 */

type ParsePollingResponseBody = (params: {
  buffer: Buffer;
  contentType: string;
}) => { body: unknown; bodyType: string | null; evaluationBody: unknown };

const loadParsePollingResponseBody = async (): Promise<ParsePollingResponseBody> => {
  const imported = await import('../task-engine-http-response.cts');
  const record = imported as { parsePollingResponseBody?: unknown };
  if (typeof record.parsePollingResponseBody !== 'function') {
    throw new Error('parsePollingResponseBody export missing');
  }
  return record.parsePollingResponseBody as ParsePollingResponseBody;
};

void test('parsePollingResponseBody: text/plain 包裹的 JSON 应被 parse 为 json', async () => {
  const parsePollingResponseBody = await loadParsePollingResponseBody();
  const jsonBody = '{"status":"succeeded","output":{"image_url":"https://example.com/a.png"}}';
  const result = parsePollingResponseBody({
    buffer: Buffer.from(jsonBody, 'utf-8'),
    contentType: 'text/plain; charset=utf-8',
  });
  assert.equal(result.bodyType, 'json');
  assert.equal(typeof result.body, 'object');
  // evaluationBody 与 body 同源：轮询判定与下游物化读取同一份解析结果。
  assert.equal(result.evaluationBody, result.body);
});

void test('parsePollingResponseBody: 超过历史 256KB inline 阈值的 text/plain JSON 仍被 parse', async () => {
  const parsePollingResponseBody = await loadParsePollingResponseBody();
  // 旧逻辑中 size > TASK_RESULT_INLINE_LIMIT 时走非 inline 分支，text/plain 一律存为字符串。
  // 该阈值从未产生实际效果（responseFile 恒为 null），修复后大小不影响解析口径。
  const padding = 'x'.repeat(300 * 1024);
  const jsonBody = `{"status":"succeeded","data":"${padding}"}`;
  const result = parsePollingResponseBody({
    buffer: Buffer.from(jsonBody, 'utf-8'),
    contentType: 'text/plain',
  });
  assert.equal(result.bodyType, 'json');
  const body = result.body as { status: string };
  assert.equal(body.status, 'succeeded');
});

void test('parsePollingResponseBody: application/json 正常 parse', async () => {
  const parsePollingResponseBody = await loadParsePollingResponseBody();
  const result = parsePollingResponseBody({
    buffer: Buffer.from('{"progress":50}', 'utf-8'),
    contentType: 'application/json; charset=utf-8',
  });
  assert.equal(result.bodyType, 'json');
  assert.deepEqual(result.body, { progress: 50 });
});

void test('parsePollingResponseBody: 真正的纯文本保持 text', async () => {
  const parsePollingResponseBody = await loadParsePollingResponseBody();
  const result = parsePollingResponseBody({
    buffer: Buffer.from('Task queued.', 'utf-8'),
    contentType: 'text/plain',
  });
  assert.equal(result.bodyType, 'text');
  assert.equal(result.body, 'Task queued.');
});

void test('parsePollingResponseBody: 截断的 JSON 文本回退为 text 不抛错', async () => {
  const parsePollingResponseBody = await loadParsePollingResponseBody();
  const truncated = '{"status":"succeeded","output":';
  const result = parsePollingResponseBody({
    buffer: Buffer.from(truncated, 'utf-8'),
    contentType: 'text/plain',
  });
  assert.equal(result.bodyType, 'text');
  assert.equal(result.body, truncated);
});

void test('parsePollingResponseBody: 非文本 Content-Type 与空 buffer 均返回 null', async () => {
  const parsePollingResponseBody = await loadParsePollingResponseBody();
  const binary = parsePollingResponseBody({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    contentType: 'application/octet-stream',
  });
  assert.equal(binary.body, null);
  assert.equal(binary.bodyType, null);
  assert.equal(binary.evaluationBody, null);
  const empty = parsePollingResponseBody({
    buffer: Buffer.alloc(0),
    contentType: 'application/json',
  });
  assert.equal(empty.body, null);
  assert.equal(empty.bodyType, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * buildLocalizedTaskResponse 单元测试。
 *
 * 覆盖「物化成功后剔除 response.body」修复点：
 * inline base64 型大响应（如 Gemini 文生图 2.6MB JSON）在物化完成后，
 * 媒体已解码落盘为 media 文件、outputs 已组装入库，body 再无下游消费者。
 * 若 body 继续驻留 record，长会话大批量任务时内存会按 body 全量累积，
 * 且与 media 文件形成「内存 + 磁盘」双份内容。
 * 物化成功路径必须将 body 置 null；media 文件是唯一持久副本。
 */

type LocalTaskOutputLike = {
  mediaType: string;
  url: string | null;
  textValue: string | null;
};

type BuildLocalizedTaskResponse = (params: {
  response: Record<string, unknown>;
  localOutputs: LocalTaskOutputLike[];
  mediaCandidates: string[];
}) => Record<string, unknown>;

const loadBuildLocalizedTaskResponse = async (): Promise<BuildLocalizedTaskResponse> => {
  const imported = await import('../task-result-materializer.cts');
  const record = imported as { buildLocalizedTaskResponse?: unknown };
  if (typeof record.buildLocalizedTaskResponse !== 'function') {
    throw new Error('buildLocalizedTaskResponse export missing');
  }
  return record.buildLocalizedTaskResponse as BuildLocalizedTaskResponse;
};

const buildOutput = (overrides: Partial<LocalTaskOutputLike> = {}): LocalTaskOutputLike => ({
  mediaType: 'image',
  url: 'local-media://prj_abc/xyz.png',
  textValue: null,
  ...overrides,
});

void test('buildLocalizedTaskResponse: 物化成功后 body 置 null，outputs 保留', async () => {
  const buildLocalizedTaskResponse = await loadBuildLocalizedTaskResponse();
  // 模拟 inline base64 大响应：body 携带数 MB 内联媒体。
  const bigInlineBody = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'x'.repeat(1024) } }] } }],
  };
  const outputs = [buildOutput()];
  const localized = buildLocalizedTaskResponse({
    response: { body: bigInlineBody, bodyType: 'json', status: 200 },
    localOutputs: outputs,
    mediaCandidates: ['data:image/png;base64,eA=='],
  });
  assert.equal(localized.body, null);
  // 物化产物必须完整保留，不受 body 剔除影响。
  assert.deepEqual(localized.localOutputs, outputs);
  assert.deepEqual(localized.outputs, outputs);
  assert.deepEqual(localized.localOutput, outputs[0]);
  assert.equal(localized.bodyType, 'json');
  assert.equal(localized.status, 200);
});

void test('buildLocalizedTaskResponse: 有媒体候选时 mediaDownload 标记为 stored', async () => {
  const buildLocalizedTaskResponse = await loadBuildLocalizedTaskResponse();
  const localized = buildLocalizedTaskResponse({
    response: { body: { ok: true }, mediaDownload: { phase: 'fetching' } },
    localOutputs: [buildOutput()],
    mediaCandidates: ['https://cdn.example.com/a.png'],
  });
  const mediaDownload = localized.mediaDownload as { phase?: unknown; candidates?: unknown; lastError?: unknown };
  assert.equal(mediaDownload.phase, 'stored');
  assert.deepEqual(mediaDownload.candidates, ['https://cdn.example.com/a.png']);
  assert.equal(mediaDownload.lastError, null);
});

void test('buildLocalizedTaskResponse: 无媒体候选（纯文本输出）时 mediaDownload 原样保留，body 仍置 null', async () => {
  const buildLocalizedTaskResponse = await loadBuildLocalizedTaskResponse();
  const textOutput = buildOutput({ mediaType: 'text', url: null, textValue: 'hello' });
  const localized = buildLocalizedTaskResponse({
    response: { body: { text: 'hello' }, mediaDownload: { phase: 'idle' } },
    localOutputs: [textOutput],
    mediaCandidates: [],
  });
  assert.equal(localized.body, null);
  assert.deepEqual(localized.mediaDownload, { phase: 'idle' });
});

void test('buildLocalizedTaskResponse: 多输出时 localOutput 为 null，localOutputs 全量保留', async () => {
  const buildLocalizedTaskResponse = await loadBuildLocalizedTaskResponse();
  const outputs = [buildOutput(), buildOutput({ url: 'local-media://prj_abc/xyz2.png' })];
  const localized = buildLocalizedTaskResponse({
    response: { body: { ok: true } },
    localOutputs: outputs,
    mediaCandidates: ['a', 'b'],
  });
  assert.equal(localized.localOutput, null);
  assert.deepEqual(localized.localOutputs, outputs);
  assert.equal(localized.body, null);
});

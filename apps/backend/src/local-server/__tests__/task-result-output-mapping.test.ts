import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RuntimeMediaAssetRow, RuntimeTaskOutputRow, RuntimeTransactionPayload } from '@iart/contracts';

type RuntimeTransactionWithOutputs = RuntimeTransactionPayload & {
  taskOutputs: RuntimeTaskOutputRow[];
  mediaAssets: RuntimeMediaAssetRow[];
};

const emitProcessMessage = (message: unknown) => {
  (process as NodeJS.Process & { emit(event: 'message', message: unknown): boolean }).emit('message', message);
};

const isRuntimeTransactionWithOutputs = (message: unknown): message is RuntimeTransactionWithOutputs => {
  if (!message || typeof message !== 'object') return false;
  const transaction = message as Partial<RuntimeTransactionPayload>;
  return transaction.type === 'runtime:execute-transaction' &&
    Array.isArray(transaction.taskOutputs) &&
    transaction.taskOutputs.length > 0 &&
    Array.isArray(transaction.mediaAssets);
};

const isRuntimeTransaction = (message: unknown): message is RuntimeTransactionPayload => {
  if (!message || typeof message !== 'object') return false;
  return (message as Partial<RuntimeTransactionPayload>).type === 'runtime:execute-transaction';
};

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_unavailable');
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: http.Server) => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

void test('result output mapping: output_mapping_rules 从最终响应提取 video 输出', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

    const taskRecord = {
      metadata: {
        taskExecutionPlan: {
          result_output_mapping: {
            response_mode: 'structured_payload',
            output_mapping_rules: [
              {
                target: 'output.video_url',
                source: { kind: 'response', path: 'detail.upsample_video_url' },
                required: false,
                default_value: null,
              },
              {
                target: 'output.video_url',
                source: { kind: 'response', path: 'video_url' },
                required: false,
                default_value: null,
              },
            ],
          },
        },
      },
    };

    const outputs = extractMappedTaskOutputs({
      taskRecord,
      responseBody: {
        video_url: 'https://media.example.com/fallback.mp4',
        detail: {
          upsample_video_url: 'https://media.example.com/final.mp4',
        },
      },
    });

    assert.deepEqual(outputs, [
      {
        mediaType: 'video',
        url: 'https://media.example.com/final.mp4',
        textValue: undefined,
        sourceTarget: 'output.video_url',
      },
    ]);
});

void test('result output mapping: 同一 target 命中空值后继续按规则顺序寻找有效值', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

    const taskRecord = {
      metadata: {
        taskExecutionPlan: {
          result_output_mapping: {
            response_mode: 'structured_payload',
            output_mapping_rules: [
              {
                target: 'output.video_url',
                source: { kind: 'response', path: 'detail.upsample_video_url' },
              },
              {
                target: 'output.video_url',
                source: { kind: 'response', path: 'detail.download_url' },
              },
            ],
          },
        },
      },
    };

    const outputs = extractMappedTaskOutputs({
      taskRecord,
      responseBody: {
        detail: {
          upsample_video_url: null,
          download_url: 'https://media.example.com/download.mp4',
        },
      },
    });

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.mediaType, 'video');
    assert.equal(outputs[0]?.url, 'https://media.example.com/download.mp4');
});

void test('result output mapping: 支持数组通配路径提取文本输出', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

  const taskRecord = {
    metadata: {
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.text',
              source: { kind: 'response', path: 'choices[].message.content' },
            },
          ],
        },
      },
    },
  };

  const outputs = extractMappedTaskOutputs({
    taskRecord,
    responseBody: {
      choices: [
        { message: { content: 'first text' } },
        { message: { content: 'second text' } },
      ],
    },
  });

  assert.deepEqual(outputs, [
    { mediaType: 'text', textValue: 'first text', url: undefined, sourceTarget: 'output.text' },
    { mediaType: 'text', textValue: 'second text', url: undefined, sourceTarget: 'output.text' },
  ]);
});

void test('result output mapping: Gemini inline image 不把 inlineData 和 thoughtSignature 提取为 text', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

  const taskRecord = {
    metadata: {
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.image_url',
              source: { kind: 'response', path: 'candidates.0.content.parts' },
            },
            {
              target: 'output.text',
              source: { kind: 'response', path: 'candidates.0.content.parts.0.text' },
            },
            {
              target: 'output.text',
              source: { kind: 'response', path: 'candidates' },
            },
          ],
        },
      },
    },
  };

  const outputs = extractMappedTaskOutputs({
    taskRecord,
    responseBody: {
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: Buffer.from('fake jpeg bytes').toString('base64'),
                },
                thoughtSignature: Buffer.from('fake thought signature').toString('base64'),
              },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    },
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.mediaType, 'image');
  assert.equal(outputs[0]?.sourceTarget, 'output.image_url');
  assert.match(String(outputs[0]?.url), /^data:image\/jpeg;base64,/);
  assert.equal(outputs.some((output) => output.mediaType === 'text'), false);
});

void test('result output mapping: Gemini inline image 混合明确 text 时只提取正文 text', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

  const taskRecord = {
    metadata: {
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.image_url',
              source: { kind: 'response', path: 'candidates.0.content.parts' },
            },
            {
              target: 'output.text',
              source: { kind: 'response', path: 'candidates' },
            },
          ],
        },
      },
    },
  };

  const outputs = extractMappedTaskOutputs({
    taskRecord,
    responseBody: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'caption' },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: Buffer.from('fake jpeg bytes').toString('base64'),
                },
                thoughtSignature: Buffer.from('fake thought signature').toString('base64'),
              },
              {
                text: 'internal chain of thought',
                thought: true,
              },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    },
  });

  assert.equal(outputs.length, 2);
  assert.equal(outputs.filter((output) => output.mediaType === 'image').length, 1);
  const textOutputs = outputs.filter((output) => output.mediaType === 'text');
  assert.deepEqual(textOutputs, [
    { mediaType: 'text', textValue: 'caption', url: undefined, sourceTarget: 'output.text' },
  ]);
  assert.equal(outputs.some((output) => output.textValue === 'image/jpeg'), false);
  assert.equal(outputs.some((output) => output.textValue === 'model'), false);
  assert.equal(outputs.some((output) => output.textValue === 'STOP'), false);
  assert.equal(outputs.some((output) => output.textValue === 'internal chain of thought'), false);
});

void test('result output mapping: Interactions 内联图像块缺 mime_type 时按目标类型兜底回读', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

  const imageBase64 = Buffer.from('interactions-inline-image').toString('base64');
  const taskRecord = {
    metadata: {
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.image_url',
              source: { kind: 'response', path: 'steps.[].content' },
              required: true,
            },
            {
              target: 'output.text',
              source: { kind: 'response', path: 'steps.[].content' },
            },
          ],
        },
      },
    },
  };

  const outputs = extractMappedTaskOutputs({
    taskRecord,
    responseBody: {
      steps: [
        {
          type: 'model_output',
          content: [
            { type: 'text', text: 'here is your image' },
            // Interactions 图像块：只有 data，没有 mime_type
            { type: 'image', data: imageBase64 },
          ],
        },
      ],
    },
  });

  const imageOutputs = outputs.filter((output) => output.mediaType === 'image');
  assert.equal(imageOutputs.length, 1);
  // 缺 mime_type -> 按 output.image_url 的目标类型兜底为 image/png
  assert.equal(imageOutputs[0]?.url, `data:image/png;base64,${imageBase64}`);
  // 内联媒体块不应被当作 text 收集（base64 与 type 字面量都不得进入 text 输出）
  const textValues = outputs.filter((output) => output.mediaType === 'text').map((output) => output.textValue);
  assert.deepEqual(textValues, ['here is your image']);
});

void test('result output mapping: Interactions 内联图像块带显式 mime_type 时优先使用', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

  const imageBase64 = Buffer.from('interactions-inline-webp').toString('base64');
  const taskRecord = {
    metadata: {
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.image_url',
              source: { kind: 'response', path: 'steps.[].content' },
              required: true,
            },
          ],
        },
      },
    },
  };

  const outputs = extractMappedTaskOutputs({
    taskRecord,
    responseBody: {
      steps: [
        {
          content: [{ type: 'image', mime_type: 'image/webp', data: imageBase64 }],
        },
      ],
    },
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.url, `data:image/webp;base64,${imageBase64}`);
});

void test('result output mapping: 无媒体类型标识的 data 字段不被误判为内联媒体', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');

  const taskRecord = {
    metadata: {
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.image_url',
              source: { kind: 'response', path: 'detail' },
              required: true,
            },
          ],
        },
      },
    },
  };

  const outputs = extractMappedTaskOutputs({
    taskRecord,
    responseBody: {
      // 普通业务字段名为 data，且没有 media type 标识 -> 不产出媒体
      detail: { data: 'not-a-media-block' },
    },
  });

  assert.equal(outputs.length, 0);
});

void test('result materialization: video_url 下载后一次提交 outputs 与 mediaAssets', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-result-materialize-'));
  fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ name: 'materialize-test' }), 'utf-8');

  const server = http.createServer((req, res) => {
    if (req.url !== '/out.mp4') {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = Buffer.from('fake mp4 bytes');
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(body.length),
    });
    res.end(body);
  });
  const baseUrl = await listen(server);
  const sentMessages: unknown[] = [];
  const previousSend = (process as NodeJS.Process & { send?: unknown }).send;
  (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send = (message: unknown) => {
    sentMessages.push(message);
    const msg = message as { type?: string; transactionId?: string };
    if (msg.transactionId) {
      setImmediate(() => {
        emitProcessMessage({
          type: 'runtime:transaction-result',
          transactionId: msg.transactionId,
          success: true,
        });
      });
    }
    return true;
  };

  t.after(async () => {
    if (previousSend === undefined) {
      delete (process as NodeJS.Process & { send?: unknown }).send;
    } else {
      (process as NodeJS.Process & { send?: unknown }).send = previousSend;
    }
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeTaskResultMaterialization } = await import('../task-executor.cts');
  const taskRecord = {
    taskId: 'task-materialize-video',
    id: 'task-materialize-video',
    projectPath: tempDir,
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      taskId: 'task-materialize-video',
      projectPath: tempDir,
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.video_url',
              source: { kind: 'response', path: 'video_url' },
            },
          ],
        },
      },
    },
    response: {
      status: 200,
      ok: true,
      contentType: 'application/json',
      bodyType: 'json',
      body: {
        video_url: `${baseUrl}/out.mp4`,
      },
    },
  };

  const outputs = await executeTaskResultMaterialization(taskRecord, undefined);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.mediaType, 'video');
  assert.match(String(outputs[0]?.url), /^local-media:\/\/prj_[^/]+\/.+\.mp4$/);

  const finalTransaction = sentMessages
    .filter(isRuntimeTransactionWithOutputs)
    .find((message) => message.taskOutputs.length > 0);
  assert.ok(finalTransaction);
  assert.equal(finalTransaction.taskOutputs?.length, 1);
  assert.equal(finalTransaction.mediaAssets?.length, 1);
  assert.equal(finalTransaction.taskOutputs?.[0]?.assetId, finalTransaction.mediaAssets?.[0]?.assetId);

  const storedFilename = String(outputs[0]?.fileKey ?? '');
  assert.equal(fs.existsSync(path.join(tempDir, 'media', storedFilename)), true);
});

void test('result materialization: inlineData 音频输出落盘后一次提交 outputs 与 mediaAssets', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-result-materialize-inline-audio-'));
  fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ name: 'materialize-inline-audio-test' }), 'utf-8');

  const sentMessages: unknown[] = [];
  const previousSend = (process as NodeJS.Process & { send?: unknown }).send;
  (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send = (message: unknown) => {
    sentMessages.push(message);
    const msg = message as { transactionId?: string };
    if (msg.transactionId) {
      setImmediate(() => {
        emitProcessMessage({
          type: 'runtime:transaction-result',
          transactionId: msg.transactionId,
          success: true,
        });
      });
    }
    return true;
  };

  t.after(() => {
    if (previousSend === undefined) {
      delete (process as NodeJS.Process & { send?: unknown }).send;
    } else {
      (process as NodeJS.Process & { send?: unknown }).send = previousSend;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeTaskResultMaterialization } = await import('../task-executor.cts');
  const taskRecord = {
    taskId: 'task-materialize-inline-audio',
    id: 'task-materialize-inline-audio',
    projectPath: tempDir,
    status: 'generating',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      taskId: 'task-materialize-inline-audio',
      projectPath: tempDir,
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.audio_url',
              source: { kind: 'response', path: 'candidates[0].content.parts[0].inlineData' },
            },
          ],
        },
      },
    },
    response: {
      status: 200,
      ok: true,
      contentType: 'application/json',
      bodyType: 'json',
      body: {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;codec=pcm;rate=24000',
                    data: Buffer.from('fake pcm bytes').toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };

  const outputs = await executeTaskResultMaterialization(taskRecord, undefined);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.mediaType, 'audio');
  assert.match(String(outputs[0]?.url), /^local-media:\/\/prj_[^/]+\/.+\.wav$/);
  // 裸 PCM（audio/l16）落盘前必须被补 WAV 头，mimeType 归一为 audio/wav，
  // 否则扩展名是 .wav 但内容无 RIFF/WAVE 头，播放器无法识别。
  assert.equal(outputs[0]?.mimeType, 'audio/wav');

  const finalTransaction = sentMessages
    .filter(isRuntimeTransactionWithOutputs)
    .find((message) => message.taskOutputs.length > 0);
  assert.ok(finalTransaction);
  assert.equal(finalTransaction.taskOutputs?.[0]?.mediaType, 'audio');
  const storedFilename = String(outputs[0]?.fileKey ?? '');
  const storedPath = path.join(tempDir, 'media', storedFilename);
  assert.equal(fs.existsSync(storedPath), true);
  // 校验落盘文件是合法 WAV 容器：RIFF/WAVE 头 + fmt 子块 + 采样率 24000 + 单声道 + 16bit
  const wavBuffer = fs.readFileSync(storedPath);
  assert.equal(wavBuffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wavBuffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wavBuffer.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wavBuffer.readUInt32LE(16), 16, 'fmt 子块大小应为 16');
  assert.equal(wavBuffer.readUInt16LE(20), 1, '音频格式应为 PCM(1)');
  assert.equal(wavBuffer.readUInt16LE(22), 1, '声道数应为 1');
  assert.equal(wavBuffer.readUInt32LE(24), 24000, '采样率应为 24000');
  assert.equal(wavBuffer.readUInt16LE(34), 16, '位深应为 16');
  assert.equal(wavBuffer.toString('ascii', 36, 40), 'data');
  // 原始 PCM 为 'fake pcm bytes'（14 字节），data 子块大小应为 14
  assert.equal(wavBuffer.readUInt32LE(40), 14, 'data 子块大小应等于 PCM 字节数');
  assert.equal(wavBuffer.length, 44 + 14, '文件总大小应为 44 字节头 + PCM 字节数');
});

void test('result materialization: output_mapping_rules 未命中时收口 failed 且不写 succeeded', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-result-materialize-missed-'));
  fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ name: 'materialize-missed-test' }), 'utf-8');

  const sentMessages: unknown[] = [];
  const previousSend = (process as NodeJS.Process & { send?: unknown }).send;
  (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send = (message: unknown) => {
    sentMessages.push(message);
    const msg = message as { transactionId?: string };
    if (msg.transactionId) {
      setImmediate(() => {
        emitProcessMessage({
          type: 'runtime:transaction-result',
          transactionId: msg.transactionId,
          success: true,
        });
      });
    }
    return true;
  };

  t.after(() => {
    if (previousSend === undefined) {
      delete (process as NodeJS.Process & { send?: unknown }).send;
    } else {
      (process as NodeJS.Process & { send?: unknown }).send = previousSend;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeTaskResultMaterialization } = await import('../task-executor.cts');
  const taskRecord = {
    taskId: 'task-materialize-missed',
    id: 'task-materialize-missed',
    projectPath: tempDir,
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      taskId: 'task-materialize-missed',
      projectPath: tempDir,
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.video_url',
              source: { kind: 'response', path: 'missing.video_url' },
            },
          ],
        },
      },
    },
    response: {
      status: 200,
      ok: true,
      contentType: 'application/json',
      bodyType: 'json',
      body: {
        detail: {},
      },
    },
  };

  await assert.rejects(
    () => executeTaskResultMaterialization(taskRecord, undefined),
    /Result output mapping did not produce formal outputs/,
  );

  const taskTransactions = sentMessages.filter(isRuntimeTransaction);
  assert.equal(
    taskTransactions.some((message) => message.tasks?.some((task) => task.status === 'succeeded')),
    false,
  );
  assert.equal(
    taskTransactions.some((message) => message.tasks?.some((task) => task.status === 'failed')),
    true,
  );
});

void test('result output mapping: inline_media raw_base64 补 data: 前缀并按 media_type 兜底 mime', async () => {
  const { extractMappedTaskOutputs } = await import('../task-result-output-mapping.cts');
  const rawBase64 = Buffer.from('raw-image-bytes'.repeat(8)).toString('base64');
  const outputs = extractMappedTaskOutputs({
    taskRecord: {
      metadata: {
        taskExecutionPlan: {
          result_output_mapping: {
            response_mode: 'structured_payload',
            output_mapping_rules: [
              { target: 'output.image_url', source: { kind: 'response', path: 'b64' }, required: false },
            ],
          },
        },
      },
    },
    responseBody: { b64: rawBase64 },
  });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.mediaType, 'image');
  assert.equal(outputs[0]?.url, `data:image/png;base64,${rawBase64}`);
});

void test('result materialization: raw_base64 内联媒体落盘后一次提交 outputs 与 mediaAssets', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-result-materialize-raw-b64-'));
  fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ name: 'materialize-raw-b64' }), 'utf-8');
  const rawBytes = Buffer.from('raw-png-bytes-for-materialization'.repeat(4));
  const rawBase64 = rawBytes.toString('base64');

  const sentMessages: unknown[] = [];
  const previousSend = (process as NodeJS.Process & { send?: unknown }).send;
  (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send = (message: unknown) => {
    sentMessages.push(message);
    const msg = message as { transactionId?: string };
    if (msg.transactionId) {
      setImmediate(() => {
        emitProcessMessage({
          type: 'runtime:transaction-result',
          transactionId: msg.transactionId,
          success: true,
        });
      });
    }
    return true;
  };

  t.after(() => {
    if (previousSend === undefined) {
      delete (process as NodeJS.Process & { send?: unknown }).send;
    } else {
      (process as NodeJS.Process & { send?: unknown }).send = previousSend;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeTaskResultMaterialization } = await import('../task-executor.cts');
  const taskRecord = {
    taskId: 'task-materialize-raw-b64',
    id: 'task-materialize-raw-b64',
    projectPath: tempDir,
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      taskId: 'task-materialize-raw-b64',
      projectPath: tempDir,
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          output_mapping_rules: [
            {
              target: 'output.image_url',
              source: { kind: 'response', path: 'b64' },
              required: true,
            },
          ],
        },
      },
    },
    response: {
      status: 200,
      ok: true,
      contentType: 'application/json',
      bodyType: 'json',
      body: { b64: rawBase64 },
    },
  };

  const outputs = await executeTaskResultMaterialization(taskRecord, undefined);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.mediaType, 'image');
  assert.equal(outputs[0]?.mimeType, 'image/png');
  assert.match(String(outputs[0]?.url), /^local-media:\/\/prj_[^/]+\/.+\.png$/);

  const finalTransaction = sentMessages
    .filter(isRuntimeTransactionWithOutputs)
    .find((message) => message.taskOutputs.length > 0);
  assert.ok(finalTransaction);
  assert.equal(finalTransaction.taskOutputs?.[0]?.assetId, finalTransaction.mediaAssets?.[0]?.assetId);

  const storedPath = path.join(tempDir, 'media', String(outputs[0]?.fileKey ?? ''));
  assert.equal(fs.existsSync(storedPath), true);
  assert.deepEqual(fs.readFileSync(storedPath), rawBytes, '落盘内容应为解码后的原始字节');
});

void test('result materialization: requires_auth 但取不到凭证时收口 failed，不退化成无鉴权下载', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-result-materialize-auth-missing-'));
  fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({ name: 'materialize-auth-missing' }), 'utf-8');

  const sentMessages: unknown[] = [];
  const previousSend = (process as NodeJS.Process & { send?: unknown }).send;
  (process as NodeJS.Process & { send?: (message: unknown) => boolean }).send = (message: unknown) => {
    sentMessages.push(message);
    const msg = message as { transactionId?: string };
    if (msg.transactionId) {
      setImmediate(() => {
        emitProcessMessage({
          type: 'runtime:transaction-result',
          transactionId: msg.transactionId,
          success: true,
        });
      });
    }
    return true;
  };

  t.after(() => {
    if (previousSend === undefined) {
      delete (process as NodeJS.Process & { send?: unknown }).send;
    } else {
      (process as NodeJS.Process & { send?: unknown }).send = previousSend;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { executeTaskResultMaterialization } = await import('../task-executor.cts');
  const taskRecord = {
    taskId: 'task-materialize-auth-missing',
    id: 'task-materialize-auth-missing',
    projectPath: tempDir,
    status: 'polling',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      taskId: 'task-materialize-auth-missing',
      projectPath: tempDir,
      taskExecutionPlan: {
        result_output_mapping: {
          response_mode: 'structured_payload',
          requires_auth: true,
          output_mapping_rules: [
            {
              target: 'output.video_url',
              source: { kind: 'response', path: 'video_url' },
              required: true,
            },
          ],
        },
      },
    },
    response: {
      status: 200,
      ok: true,
      contentType: 'application/json',
      bodyType: 'json',
      body: { video_url: 'https://cdn.example.com/out.mp4' },
    },
  };

  await assert.rejects(
    () => executeTaskResultMaterialization(taskRecord, undefined),
    /鉴权/,
  );

  const taskTransactions = sentMessages.filter(isRuntimeTransaction);
  assert.equal(
    taskTransactions.some((message) => message.tasks?.some((task) => task.status === 'succeeded')),
    false,
  );
  assert.equal(
    taskTransactions.some((message) => message.tasks?.some((task) => task.status === 'failed')),
    true,
  );
});

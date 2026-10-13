import assert from 'node:assert/strict';
import test from 'node:test';

void test('assembleExecutionPlanFromPrebuiltPayload: multipart payload 不再重放 extractFirstFile transform', async () => {
  const { assembleExecutionPlanFromPrebuiltPayload } = await import('../local-server/request-assembler.cts');

  const serializedFormData = {
    __formData: {
      fields: [
        { name: 'model', value: 'gpt-image-2' },
        { name: 'prompt', value: 'hello world' },
        { name: 'size', value: '1024x1024' },
      ],
      files: [
        {
          name: 'image',
          filename: 'reference.png',
          contentType: 'image/png',
          dataBase64: Buffer.from('mock-image').toString('base64'),
        },
      ],
    },
  };

  const assembled = await assembleExecutionPlanFromPrebuiltPayload(
    {
      model_id: 'gpt-image-2',
      payload: {
        body: serializedFormData,
        api: {
          endpoint: '/v1/images/edits',
          method: 'POST',
          contentType: null,
        },
      },
    },
    {
      projectPath: null,
      baseDir: process.cwd(),
    },
  );

  assert.equal(assembled.executionPlan.model_id, 'gpt-image-2');
  assert.equal(assembled.executionPlan.submit_request.method, 'POST');
  assert.equal(assembled.executionPlan.submit_request.headers['content-type'], undefined);
  assert.deepEqual(assembled.executionPlan.submit_request.body, serializedFormData);
  assert.match(assembled.executionPlan.submit_request.url, /\/v1\/images\/edits$/);
});

void test('assembleGenerationTaskRequest: kling-v3-text2video 缺 prompt 时本地失败', async () => {
  const { assembleGenerationTaskRequest } = await import('../local-server/request-assembler.cts');

  await assert.rejects(
    () =>
      assembleGenerationTaskRequest(
        {
          model_id: 'kling-v3-text2video',
          arguments: {},
        },
        {
          projectPath: null,
          baseDir: process.cwd(),
        },
      ),
    /请填写提示词。/,
  );
});

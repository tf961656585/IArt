import { describe, expect, it } from 'vitest';

import { CustomChatModelIdSchema } from '../src/custom-chat-model-contract';
import { CustomGenerationModelSchema } from '../src/custom-generation-model-contract';

/**
 * 自建生成模型记录契约（spec 03 §6.1「Deployment 与自建模型记录」，2026-09-25 单记录形态）：
 * `.strict()` 边界拒绝未知字段；`model_id` 字符集与对话侧共用同一正则常量（本文件末条
 * 用两侧 schema 对同样本给出一致判定作守卫）；`family_adapter_id` 试点单族封闭；
 * 接入归属（record_id / connection_id / remote_model_id）内嵌于记录。
 */

const validModel = {
  model_id: 'my-image-model',
  record_id: 'up_dep_abc123',
  connection_id: 'up_conn_abc123',
  remote_model_id: 'remote-image-model',
  family_adapter_id: 'openai-image-v1' as const,
  supports_reference_image: true,
  created_at: '2026-09-24T00:00:00.000Z',
};

describe('CustomGenerationModelSchema', () => {
  it('合法记录 parse 通过，supports_reference_image 可省略（缺省 false），parameter_overrides 缺省空覆盖', () => {
    expect(CustomGenerationModelSchema.parse(validModel)).toEqual({
      ...validModel,
      parameter_overrides: { official: [], custom: [] },
    });

    const withoutReference = {
      model_id: 'another-image-model',
      record_id: 'up_dep_def456',
      connection_id: 'up_conn_def456',
      remote_model_id: 'remote-another',
      family_adapter_id: 'openai-image-v1' as const,
      created_at: '2026-09-24T00:00:00.000Z',
    };
    // 不带 supports_reference_image / parameter_overrides 的形状：parse 必须通过
    // 且物化缺省（.strict() 下缺键无默认值会整条解析失败，等于数据丢失）。
    expect(CustomGenerationModelSchema.parse(withoutReference)).toEqual({
      ...withoutReference,
      supports_reference_image: false,
      parameter_overrides: { official: [], custom: [] },
    });
  });

  it('parameter_overrides 只写单分区时另一分区物化为空数组；自定义参数 required 缺省 false', () => {
    // 生成模型参数高级自定义设计 §3.2：官方覆盖按 field_key 索引，自定义参数以 wire_name 兼任内部标识。
    const parsed = CustomGenerationModelSchema.parse({
      ...validModel,
      parameter_overrides: {
        official: [{ field_key: 'quality' }],
        custom: [{ label: '风格强度', wire_name: 'style_strength', value_type: 'number' }],
      },
    });
    expect(parsed.parameter_overrides).toEqual({
      official: [{ field_key: 'quality' }],
      custom: [{ label: '风格强度', wire_name: 'style_strength', value_type: 'number', required: false }],
    });
  });

  it('缺必填字段（model_id / record_id / connection_id / remote_model_id / family_adapter_id / created_at）拒绝', () => {
    const { model_id: _modelId, ...withoutModelId } = validModel;
    const { record_id: _recordId, ...withoutRecordId } = validModel;
    const { connection_id: _connectionId, ...withoutConnectionId } = validModel;
    const { remote_model_id: _remoteModelId, ...withoutRemoteModelId } = validModel;
    const { family_adapter_id: _family, ...withoutFamily } = validModel;
    const { created_at: _createdAt, ...withoutCreatedAt } = validModel;

    expect(() => CustomGenerationModelSchema.parse(withoutModelId)).toThrow();
    expect(() => CustomGenerationModelSchema.parse(withoutRecordId)).toThrow();
    expect(() => CustomGenerationModelSchema.parse(withoutConnectionId)).toThrow();
    expect(() => CustomGenerationModelSchema.parse(withoutRemoteModelId)).toThrow();
    expect(() => CustomGenerationModelSchema.parse(withoutFamily)).toThrow();
    expect(() => CustomGenerationModelSchema.parse(withoutCreatedAt)).toThrow();
  });

  it('多出未知字段拒绝（.strict()）', () => {
    expect(() =>
      CustomGenerationModelSchema.parse({
        ...validModel,
        protocol_adapter_id: 'openai-image-v1',
      }),
    ).toThrow();
    // 接入归属不可被请求侧伪造为部署语义：bound_connections 之类旧计数键同样拒收。
    expect(() =>
      CustomGenerationModelSchema.parse({
        ...validModel,
        bound_connections: 1,
      }),
    ).toThrow();
  });

  it('record_id / connection_id / remote_model_id 非法形状拒绝', () => {
    expect(() => CustomGenerationModelSchema.parse({ ...validModel, record_id: 'not-up-dep' })).toThrow();
    expect(() => CustomGenerationModelSchema.parse({ ...validModel, connection_id: '' })).toThrow();
    expect(() => CustomGenerationModelSchema.parse({ ...validModel, remote_model_id: '' })).toThrow();
  });

  it('非法 model_id 拒绝（前导符号 / 空白 / 超长 / 空串）', () => {
    expect(() =>
      CustomGenerationModelSchema.parse({ ...validModel, model_id: '-leading-dash' }),
    ).toThrow();
    expect(() =>
      CustomGenerationModelSchema.parse({ ...validModel, model_id: 'has space' }),
    ).toThrow();
    expect(() =>
      CustomGenerationModelSchema.parse({ ...validModel, model_id: 'a'.repeat(65) }),
    ).toThrow();
    expect(() => CustomGenerationModelSchema.parse({ ...validModel, model_id: '' })).toThrow();
  });

  it('族归属试点单族：openai-image-v1 之外的 family_adapter_id 拒绝', () => {
    expect(() =>
      CustomGenerationModelSchema.parse({
        ...validModel,
        family_adapter_id: 'gemini-image-interactions-v1',
      }),
    ).toThrow();
  });

  it('model_id 字符集与对话侧一致：同一样本两侧判定相同', () => {
    for (const sample of ['my-image-model', 'A-b._9', '-bad', 'has space', '']) {
      expect(CustomGenerationModelSchema.shape.model_id.safeParse(sample).success).toBe(
        CustomChatModelIdSchema.safeParse(sample).success,
      );
    }
  });
});

import { describe, expect, it } from 'vitest';

import { CustomChatModelIdSchema } from '../src/custom-chat-model-contract';
import {
  CustomGenerationModelCreateBodySchema,
  CustomGenerationModelSchema,
  CustomGenerationModelUpdateBodySchema,
  GENERATION_FAMILY_ADAPTER_IDS,
  GENERATION_MEDIA_SLOT_IDS,
  GenerationFamilyAdapterIdSchema,
  GenerationMediaSlotIdSchema,
} from '../src/custom-generation-model-contract';

/**
 * 自建生成模型记录契约（spec 03 §6.1「Deployment 与自建模型记录」，2026-09-25 单记录形态）：
 * `.strict()` 边界拒绝未知字段；`model_id` 字符集与对话侧共用同一正则常量（本文件末条
 * 用两侧 schema 对同样本给出一致判定作守卫）；`family_adapter_id` 值域为生成族接口类型
 * 清单（顺序即界面下拉顺序）；`accepted_media_slots` 是受控素材位词表；
 * 接入归属（record_id / connection_id / remote_model_id）内嵌于记录。
 */

const validModel = {
  model_id: 'my-image-model',
  record_id: 'up_dep_abc123',
  connection_id: 'up_conn_abc123',
  remote_model_id: 'remote-image-model',
  family_adapter_id: 'openai-image-v1' as const,
  accepted_media_slots: ['reference_image'] as ('reference_image' | 'first_frame')[],
  created_at: '2026-09-24T00:00:00.000Z',
};

describe('CustomGenerationModelSchema', () => {
  it('合法记录 parse 通过，accepted_media_slots 可省略（缺省空清单），parameter_overrides 缺省空覆盖', () => {
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
    // 不带 accepted_media_slots / parameter_overrides 的形状：parse 必须通过
    // 且物化缺省（.strict() 下缺键无默认值会整条解析失败，等于数据丢失）。
    expect(CustomGenerationModelSchema.parse(withoutReference)).toEqual({
      ...withoutReference,
      accepted_media_slots: [],
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

  it('族归属值域：7 个生成族接口类型全部可被接受，清单外的 id 拒绝', () => {
    expect(GENERATION_FAMILY_ADAPTER_IDS).toEqual([
      'openai-image-v1',
      'gemini-image-interactions-v1',
      'seedance-2-0-v1',
      'veo-v1',
      'kling-text2video-v1',
      'kling-image2video-v1',
      'kling-omni-video-v1',
    ]);
    for (const familyAdapterId of GENERATION_FAMILY_ADAPTER_IDS) {
      expect(GenerationFamilyAdapterIdSchema.safeParse(familyAdapterId).success).toBe(true);
      expect(() =>
        CustomGenerationModelSchema.parse({ ...validModel, family_adapter_id: familyAdapterId }),
      ).not.toThrow();
    }
    // 契约清单外的值（含已删除的旧 id kling-v1）拒绝
    for (const unknownId of ['kling-v1', 'not-a-family', '']) {
      expect(GenerationFamilyAdapterIdSchema.safeParse(unknownId).success).toBe(false);
      expect(() =>
        CustomGenerationModelSchema.parse({ ...validModel, family_adapter_id: unknownId }),
      ).toThrow();
    }
  });

  it('素材位：词表 7 位全部可接受，词表外的取值拒绝；清单顺序原样保留', () => {
    expect(GENERATION_MEDIA_SLOT_IDS).toEqual([
      'reference_image',
      'first_frame',
      'last_frame',
      'reference_video',
      'reference_audio',
      'feature_video',
      'base_video',
    ]);
    for (const slot of GENERATION_MEDIA_SLOT_IDS) {
      expect(GenerationMediaSlotIdSchema.safeParse(slot).success).toBe(true);
    }
    const parsed = CustomGenerationModelSchema.parse({
      ...validModel,
      accepted_media_slots: [...GENERATION_MEDIA_SLOT_IDS],
    });
    expect(parsed.accepted_media_slots).toEqual([...GENERATION_MEDIA_SLOT_IDS]);
    expect(() =>
      CustomGenerationModelSchema.parse({ ...validModel, accepted_media_slots: ['not_a_slot'] }),
    ).toThrow();
    // 旧布尔字段已退场：残留键被 .strict() 拒收（读取侧必须先剥键，迁移侧有专项测试）
    expect(() =>
      CustomGenerationModelSchema.parse({ ...validModel, supports_reference_image: true }),
    ).toThrow();
  });

  it('请求体：CreateBody 可选素材位、UpdateBody 必填素材位且都拒绝旧布尔字段', () => {
    const createBase = {
      model_id: 'my-image-model',
      connection_id: 'up_conn_abc123',
      family_adapter_id: 'openai-image-v1' as const,
    };
    expect(CustomGenerationModelCreateBodySchema.parse(createBase).accepted_media_slots).toBeUndefined();
    expect(
      CustomGenerationModelCreateBodySchema.parse({
        ...createBase,
        accepted_media_slots: ['first_frame', 'last_frame'],
      }).accepted_media_slots,
    ).toEqual(['first_frame', 'last_frame']);
    expect(() =>
      CustomGenerationModelCreateBodySchema.parse({ ...createBase, supports_reference_image: true }),
    ).toThrow();

    expect(
      CustomGenerationModelUpdateBodySchema.parse({ accepted_media_slots: [] }).accepted_media_slots,
    ).toEqual([]);
    expect(() =>
      CustomGenerationModelUpdateBodySchema.parse({ supports_reference_image: true }),
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

import { describe, expect, it } from 'vitest';

import {
  ADAPTER_AUTH_KINDS,
  ADAPTER_REGISTRY,
  AdapterAuthSchema,
  CHAT_PROTOCOL_ADAPTER_IDS,
  PROTOCOL_ADAPTER_IDS,
  ProviderConnectionSchema,
  buildAdapterAuthInjection,
  isChatProtocolAdapterId,
  resolveChatAdapterIdFromProtocolAdapter,
} from '../src/provider-connection-contract';
import { CustomChatModelCreateBodySchema } from '../src/custom-chat-model-contract';

/**
 * 协议适配器族与对话映射（spec docs/custom-providers/03 §1、§4.1）：
 * 2026-09-26 起协议归属模型级——对话协议清单 `CHAT_PROTOCOL_ADAPTER_IDS` 是自建对话模型
 * 记录 `protocol_adapter_id` 的值域；「协议 → 执行层对话适配器」只有一处映射，漏配即红
 * （第三、四条用例是键集一致性守卫）。
 */

describe('协议适配器族分流', () => {
  it('对话协议与生成协议按 family 分流，判定走唯一入口', () => {
    expect(isChatProtocolAdapterId('openai-chat-completions-v1')).toBe(true);
    expect(isChatProtocolAdapterId('openai-responses-v1')).toBe(true);
    expect(isChatProtocolAdapterId('anthropic-messages-v1')).toBe(true);
    expect(isChatProtocolAdapterId('gemini-chat-v1')).toBe(true);

    expect(isChatProtocolAdapterId('openai-image-v1')).toBe(false);
    expect(isChatProtocolAdapterId('gemini-image-interactions-v1')).toBe(false);
    expect(isChatProtocolAdapterId('seedance-2-0-v1')).toBe(false);
    expect(isChatProtocolAdapterId('veo-v1')).toBe(false);
    expect(isChatProtocolAdapterId('kling-text2video-v1')).toBe(false);
    expect(isChatProtocolAdapterId('kling-image2video-v1')).toBe(false);
    expect(isChatProtocolAdapterId('kling-omni-video-v1')).toBe(false);
  });

  it('对话协议映射到执行层对话适配器；非对话协议返回 null（不静默回退）', () => {
    expect(resolveChatAdapterIdFromProtocolAdapter('openai-chat-completions-v1')).toBe('openai_chat');
    expect(resolveChatAdapterIdFromProtocolAdapter('openai-responses-v1')).toBe('openai_responses');
    expect(resolveChatAdapterIdFromProtocolAdapter('anthropic-messages-v1')).toBe('anthropic_messages');
    expect(resolveChatAdapterIdFromProtocolAdapter('gemini-chat-v1')).toBe('gemini');

    expect(resolveChatAdapterIdFromProtocolAdapter('openai-image-v1')).toBeNull();
    expect(resolveChatAdapterIdFromProtocolAdapter('kling-text2video-v1')).toBeNull();
    expect(resolveChatAdapterIdFromProtocolAdapter('kling-image2video-v1')).toBeNull();
    expect(resolveChatAdapterIdFromProtocolAdapter('kling-omni-video-v1')).toBeNull();
  });

  it('CHAT_PROTOCOL_ADAPTER_IDS 的每个对话协议都必须有执行层映射：漏配映射时本用例失败', () => {
    expect(CHAT_PROTOCOL_ADAPTER_IDS.length).toBeGreaterThan(0);
    for (const id of CHAT_PROTOCOL_ADAPTER_IDS) {
      expect(resolveChatAdapterIdFromProtocolAdapter(id)).not.toBeNull();
    }
  });

  it('生成侧不再有代码适配器：注册表只剩对话族（2026-10-27 退场守卫）', () => {
    // 生成族的传输定义由接口格式实体承载；本表若再出现生成条目，说明双份事实源回潮。
    expect(Object.keys(ADAPTER_REGISTRY).sort()).toEqual([...CHAT_PROTOCOL_ADAPTER_IDS].sort());
    for (const entry of Object.values(ADAPTER_REGISTRY)) {
      expect(entry.family).toBe('chat');
    }
  });

  it('历史数据仍可解析：PROTOCOL_ADAPTER_IDS 保留 8 个生成预设 id', () => {
    // 连接遗留字段与已落库任务快照带这些值，缩小值域会让整条记录解析失败。
    for (const legacyId of ['openai-image-v1', 'veo-v1', 'kling-omni-video-v1'] as const) {
      expect(PROTOCOL_ADAPTER_IDS).toContain(legacyId);
      expect(isChatProtocolAdapterId(legacyId)).toBe(false);
    }
  });

  it('CHAT_PROTOCOL_ADAPTER_IDS 与 CHAT_PROTOCOL_TO_CHAT_ADAPTER 键集一致：映射不收录清单外的协议', () => {
    for (const id of PROTOCOL_ADAPTER_IDS) {
      const chatAdapter = resolveChatAdapterIdFromProtocolAdapter(id);
      if (chatAdapter !== null) {
        expect(CHAT_PROTOCOL_ADAPTER_IDS).toContain(id);
      } else {
        expect(CHAT_PROTOCOL_ADAPTER_IDS).not.toContain(id);
      }
    }
  });
});

describe('鉴权形态与凭证注入（唯一实现）', () => {
  it('三种鉴权形态：bearer / header_api_key / query_api_key', () => {
    expect([...ADAPTER_AUTH_KINDS]).toEqual(['bearer', 'header_api_key', 'query_api_key']);
    expect(AdapterAuthSchema.parse({ kind: 'bearer', header_name: 'Authorization' })).toEqual({
      kind: 'bearer',
      header_name: 'Authorization',
    });
    expect(AdapterAuthSchema.parse({ kind: 'header_api_key', header_name: 'x-api-key' })).toEqual({
      kind: 'header_api_key',
      header_name: 'x-api-key',
    });
    expect(AdapterAuthSchema.parse({ kind: 'query_api_key', query_name: 'key' })).toEqual({
      kind: 'query_api_key',
      query_name: 'key',
    });
    // 判别联合：查询参数形态不接受 header_name，请求头形态不接受 query_name。
    expect(() =>
      AdapterAuthSchema.parse({ kind: 'query_api_key', query_name: 'key', header_name: 'Authorization' }),
    ).toThrow();
    expect(() =>
      AdapterAuthSchema.parse({ kind: 'header_api_key', header_name: 'x-api-key', query_name: 'key' }),
    ).toThrow();
  });

  it('buildAdapterAuthInjection 把凭证渲染成注入位置（请求头或查询参数）', () => {
    expect(
      buildAdapterAuthInjection({ kind: 'bearer', header_name: 'Authorization' }, 'sk-1'),
    ).toEqual({ kind: 'header', name: 'Authorization', value: 'Bearer sk-1' });
    expect(
      buildAdapterAuthInjection({ kind: 'bearer', header_name: 'Authorization', prefix: 'Token' }, 'sk-1'),
    ).toEqual({ kind: 'header', name: 'Authorization', value: 'Token sk-1' });
    expect(
      buildAdapterAuthInjection({ kind: 'header_api_key', header_name: 'x-goog-api-key' }, 'sk-2'),
    ).toEqual({ kind: 'header', name: 'x-goog-api-key', value: 'sk-2' });
    expect(buildAdapterAuthInjection({ kind: 'query_api_key', query_name: 'key' }, 'sk-3')).toEqual({
      kind: 'query',
      name: 'key',
      value: 'sk-3',
    });
  });

});

describe('连接级 protocol_adapter_id 为迁移兼容遗留字段（2026-09-29 起退役）', () => {
  const connectionBase = {
    connection_id: 'up_conn_abc123',
    display_name: 'my-provider',
    base_url: 'https://byok.example.com/v1',
    has_credential: false,
    lifecycle: 'enabled' as const,
    revision: 0,
    created_at: '2026-09-26T00:00:00.000Z',
    updated_at: '2026-09-26T00:00:00.000Z',
  };

  it('字段可缺省：新创建的连接不携带接口类型，解析必须通过', () => {
    expect(ProviderConnectionSchema.parse(connectionBase)).toEqual(connectionBase);
  });

  it('历史数据兼容：存量文件携带该字段仍解析通过（仅对话模型 v1/v2→v3 迁移回填保留读取）', () => {
    // 字段本身保留在 schema 里，迁移链路（custom-chat-model-store v1/v2 迁移）经
    // getConnection(...).protocol_adapter_id 读取回填；待存量迁移全量完成后一次性删除。
    expect(ProviderConnectionSchema.parse({ ...connectionBase, protocol_adapter_id: 'openai-image-v1' })).toEqual({
      ...connectionBase,
      protocol_adapter_id: 'openai-image-v1',
    });
  });

  it('CustomChatModelCreateBody.protocol_adapter_id 必填且限定对话族值域', () => {
    const body = { model_id: 'my-llm', connection_id: 'up_conn_abc123' };
    // 缺协议 → 拒绝（协议随记录必填）
    expect(() => CustomChatModelCreateBodySchema.parse(body)).toThrow();
    // 对话族协议 → 通过
    expect(CustomChatModelCreateBodySchema.parse({ ...body, protocol_adapter_id: 'openai-chat-completions-v1' }))
      .toMatchObject({ protocol_adapter_id: 'openai-chat-completions-v1' });
    // 生成族协议不在对话值域内 → 拒绝
    expect(() => CustomChatModelCreateBodySchema.parse({ ...body, protocol_adapter_id: 'openai-image-v1' })).toThrow();
  });
});

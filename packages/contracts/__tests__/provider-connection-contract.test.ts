import { describe, expect, it } from 'vitest';

import {
  CHAT_PROTOCOL_ADAPTER_IDS,
  PROTOCOL_ADAPTER_IDS,
  ProviderConnectionSchema,
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
    expect(isChatProtocolAdapterId('kling-v1')).toBe(false);
  });

  it('对话协议映射到执行层对话适配器；非对话协议返回 null（不静默回退）', () => {
    expect(resolveChatAdapterIdFromProtocolAdapter('openai-chat-completions-v1')).toBe('openai_chat');
    expect(resolveChatAdapterIdFromProtocolAdapter('openai-responses-v1')).toBe('openai_responses');
    expect(resolveChatAdapterIdFromProtocolAdapter('anthropic-messages-v1')).toBe('anthropic_messages');
    expect(resolveChatAdapterIdFromProtocolAdapter('gemini-chat-v1')).toBe('gemini');

    expect(resolveChatAdapterIdFromProtocolAdapter('openai-image-v1')).toBeNull();
    expect(resolveChatAdapterIdFromProtocolAdapter('kling-v1')).toBeNull();
  });

  it('CHAT_PROTOCOL_ADAPTER_IDS 的每个对话协议都必须有执行层映射：漏配映射时本用例失败', () => {
    expect(CHAT_PROTOCOL_ADAPTER_IDS.length).toBeGreaterThan(0);
    for (const id of CHAT_PROTOCOL_ADAPTER_IDS) {
      expect(resolveChatAdapterIdFromProtocolAdapter(id)).not.toBeNull();
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

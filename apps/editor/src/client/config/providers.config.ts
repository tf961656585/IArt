/**
 * 文件作用：模型服务 (Provider) 配置层
 * - 定义 ProviderConfig 接口，承载厂商元信息（名称、Logo、官网、文档等）
 * - 提供查找函数 getProviderConfig / listProviderConfigs
 * - 为模型资产投影和本地内建节点提供已知 Provider 的展示元数据
 */

import type { DynamicRecord } from '@/client/utils/typeGuards';

export type ProviderId = string;

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  logo: string | undefined;
  website: string | undefined;
  docUrl: string | undefined;
  description: string | undefined;
  aliases: string[] | undefined;
  metadata: DynamicRecord | undefined;
}

const providers: ProviderConfig[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    logo: '/providers/openai.svg',
    website: 'https://openai.com',
    docUrl: 'https://platform.openai.com/docs',
    description: '提供文本、图像与视频生成能力。',
    aliases: ['openai'],
    metadata: undefined,
  },
  {
    id: 'google',
    displayName: 'Google AI',
    logo: '/providers/google.svg',
    website: 'https://ai.google.dev',
    docUrl: 'https://ai.google.dev/gemini-api',
    description: '提供 Gemini、Veo 等创作能力。',
    aliases: ['google', 'google-ai', 'gemini', 'veo'],
    metadata: undefined,
  },
  {
    id: 'alibaba',
    displayName: '阿里百炼',
    logo: '/providers/alibaba.svg',
    website: 'https://bailian.console.aliyun.com',
    docUrl: 'https://help.aliyun.com/zh/bailian/',
    description: '提供图像、视频等创作能力。',
    aliases: ['alibaba', 'alibailian', 'bailian', 'dashscope'],
    metadata: undefined,
  },
  {
    id: 'bytedance',
    displayName: '字节跳动（豆包）',
    logo: '/providers/bytedance.svg',
    website: 'https://www.doubao.com',
    docUrl: 'https://www.volcengine.com/docs/82379',
    description: '提供 Seedream、Seedance 等图像与视频创作能力。',
    aliases: ['bytedance', 'volcengine', 'doubao'],
    metadata: undefined,
  },
  {
    id: 'vidu',
    displayName: 'Vidu',
    logo: undefined,
    website: 'https://www.vidu.com',
    docUrl: undefined,
    description: '提供视频生成能力。',
    aliases: ['vidu', 'viduq3'],
    metadata: undefined,
  },
  {
    id: 'kling',
    displayName: 'Kling AI（可灵）',
    logo: '/providers/kling.svg',
    website: 'https://klingai.com',
    docUrl: 'https://klingai.com/docs',
    description: '提供视频生成、图像生成与对口型能力。',
    aliases: ['kling'],
    metadata: undefined,
  },
  {
    id: 'xai',
    displayName: 'xAI',
    logo: '/providers/xai.svg',
    website: 'https://x.ai',
    docUrl: 'https://docs.x.ai',
    description: '提供 Grok 系列图像与视频创作能力。',
    aliases: ['xai', 'grok'],
    metadata: undefined,
  },
  {
    id: 'fal',
    displayName: 'Fal.ai',
    logo: '/providers/fal.svg',
    website: 'https://fal.ai',
    docUrl: 'https://fal.ai/docs',
    description: '提供多种图像和视频生成能力。',
    aliases: ['fal', 'fal-ai'],
    metadata: undefined,
  },
  {
    id: 'suno',
    displayName: 'Suno',
    logo: '/providers/suno.svg',
    website: 'https://suno.com',
    docUrl: undefined,
    description: '提供音乐与歌词生成能力。',
    aliases: ['suno'],
    metadata: undefined,
  },
  {
    id: 'example',
    displayName: '示例模型',
    logo: '/providers/example.svg',
    website: undefined,
    docUrl: undefined,
    description: '用于体验流程的示例模型。',
    aliases: ['example'],
    metadata: undefined,
  },
  {
    id: 'local',
    displayName: '本地处理',
    description: '提供图片和视频的本地处理工具。',
    logo: '/providers/local.svg',
    website: undefined,
    docUrl: undefined,
    aliases: ['local', 'builtin'],
    metadata: undefined,
  },
];

// 构建索引: id + aliases
const byId = new Map<string, ProviderConfig>();
const byAlias = new Map<string, ProviderConfig>();

providers.forEach((p) => {
  const idKey = p.id.toLowerCase();
  if (!byId.has(idKey)) {
    byId.set(idKey, p);
  }
  (p.aliases ?? []).forEach((alias) => {
    const aliasKey = alias.toLowerCase();
    if (!byAlias.has(aliasKey)) {
      byAlias.set(aliasKey, p);
    }
  });
});

/**
 * 列出所有 Provider 配置
 */
export const listProviderConfigs = (): ProviderConfig[] => [...providers];

/**
 * 根据 id 或 alias 查找 Provider 配置
 * @param identifier - Provider ID 或别名（如 'openai' / 'google' / 'veo'）
 */
export const getProviderConfig = (identifier: string | null | undefined): ProviderConfig | undefined => {
  if (!identifier) return undefined;
  const key = identifier.trim().toLowerCase();
  if (!key) return undefined;
  return byId.get(key) ?? byAlias.get(key);
};

export const getProviderConfigOrFallback = (identifier: string | null | undefined): ProviderConfig => {
  const trimmed = identifier !== null && identifier !== undefined ? identifier.trim() : '';
  const normalized = trimmed !== '' ? trimmed.toLowerCase() : 'unknown';
  return getProviderConfig(normalized) ?? {
    id: normalized,
    displayName: trimmed !== '' ? trimmed : 'Unknown Provider',
    logo: undefined,
    website: undefined,
    docUrl: undefined,
    description: undefined,
    aliases: undefined,
    metadata: undefined,
  };
};

/**
 * 按 Provider ID 分组模型（工具函数）
 * 注意：需要配合 models.config.ts 中的 ModelConfigEntry 使用
 */
export const groupModelsByProvider = <T extends { providerId: ProviderId }>(
  models: T[]
): Map<ProviderId, T[]> => {
  const groups = new Map<ProviderId, T[]>();
  models.forEach((model) => {
    const list = groups.get(model.providerId) ?? [];
    list.push(model);
    groups.set(model.providerId, list);
  });
  return groups;
};

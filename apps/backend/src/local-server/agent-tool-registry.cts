/**
 * Agent Tool Registry
 *
 * agent 可调用工具的投影注册表（spec 04「工具集合投影」）。每轮请求实时投影为
 * 对话模型 function calling 的 tools 清单，两把统一生成工具按 deployable 目录投影，
 * 加工工具为内置固定注册表。
 *
 * 语义事实源: docs/agent/04-执行管道与WS协议.md、docs/agent/01-核心概念与术语.md
 * （生成工具 / 加工工具术语）。执行语义见 agent-tool-executor.cts。
 */

import type { ChatToolDefinition } from '@iart/chat-adapter';
import type { AgentToolKind, ExecutableModelDirectoryEntry } from '@iart/contracts';
import { listExecutableCatalogEntries } from './model-catalog-entry.cts';
import { logDebug } from './logging.cts';

/** 生成工具名（spec 04：两把统一工具）。 */
const GENERATION_TOOL_IMAGE = 'generate_image';
const GENERATION_TOOL_VIDEO = 'generate_video';

/** 单轮用户消息的工具循环轮数上限（spec 04「工具调用循环语义」）。 */
export const AGENT_TOOL_LOOP_ROUND_LIMIT = 8;

/** confirm 档提案待决超时（毫秒，spec 05「提案超时」）。 */
export const AGENT_TOOL_PROPOSAL_TIMEOUT_MS = 10 * 60 * 1000;

type ProcessingToolRegistration = {
  definition: ChatToolDefinition;
};

// ────────────────────────────────────────────
// 生成工具参数投影
// ────────────────────────────────────────────

/**
 * 单模型参数速览（进 model_id 枚举项描述）：统一工具的参数差异只能靠描述文本承载，
 * 速览质量直接决定模型传参准确率——必填字段、枚举档位与默认值逐项列出。
 */
const buildModelParameterDigest = (
  parameterSchema: ExecutableModelDirectoryEntry['parameter_schema'] | undefined,
): string => {
  const fields = parameterSchema?.fields ?? [];
  if (fields.length === 0) return '（无额外参数）';
  const requiredFields = new Set(parameterSchema?.required_fields ?? []);
  const lines: string[] = [];
  for (const field of fields) {
    if (field.fieldKey === '__prompt') continue;
    const parts: string[] = [];
    if (field.enumOptions && field.enumOptions.length > 0) {
      parts.push(`可选值: ${field.enumOptions.map((option) => String(option.value)).join(' | ')}`);
    } else {
      parts.push(`类型: ${describeComponent(field.component)}`);
    }
    const defaultValue = field.defaultValue ?? parameterSchema?.default_values?.[field.fieldKey];
    if (defaultValue !== undefined && defaultValue !== null && defaultValue !== '') {
      parts.push(`默认 ${String(defaultValue)}`);
    }
    lines.push(
      `- ${field.fieldKey}（${requiredFields.has(field.fieldKey) ? '必填' : '可选'}）: ${parts.join('，')}`,
    );
  }
  return lines.join('\n');
};

const describeComponent = (component: string): string => {
  switch (component) {
    case 'number':
    case 'slider':
      return '数字';
    case 'select':
    case 'radio':
      return '枚举';
    case 'switch':
    case 'checkbox':
      return '布尔开关';
    case 'imageupload':
      return '图片引用';
    case 'videoupload':
      return '视频引用';
    case 'audioupload':
      return '音频引用';
    default:
      return '文本';
  }
};

type MediaType = 'image' | 'video';

const buildGenerationToolDefinition = (
  mediaType: MediaType,
  entries: ReturnType<typeof listExecutableCatalogEntries>,
): ChatToolDefinition | null => {
  const deployable = entries.filter(
    (entry) => entry.deployment.deployable && entry.capability.output_modalities.includes(mediaType),
  );
  if (deployable.length === 0) {
    logDebug('[agent-tool-registry] no deployable generation model, tool omitted', { mediaType });
    return null;
  }
  const modelIds = deployable.map((entry) => entry.model_id);
  const digest = deployable
    .map((entry) => `【${entry.model_id}】\n${buildModelParameterDigest(entry.parameter_schema)}`)
    .join('\n');
  const promptFieldLabel = mediaType === 'image' ? '图片内容描述' : '视频内容描述';
  return {
    name: mediaType === 'image' ? GENERATION_TOOL_IMAGE : GENERATION_TOOL_VIDEO,
    description:
      mediaType === 'image'
        ? '调用图片生成模型产出新图片资产，等待生成完成后返回产物资产。'
        : '调用视频生成模型产出新视频资产，等待生成完成后返回产物资产。',
    parameters: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: `目标生成模型的 model_id（唯一标识，原样使用，不翻译）：\n${digest}`,
          enum: modelIds,
        },
        prompt: {
          type: 'string',
          description: promptFieldLabel,
        },
        arguments: {
          type: 'object',
          description:
            '目标模型的生成参数（对象，键为参数字段名）。各模型可用字段与取值见 model_id 描述中的参数速览；未提供的可选参数由系统按模型默认值补齐。',
          additionalProperties: true,
        },
        reference_asset_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '作为生成参考输入的资产 assetId 列表（来自会话资产清单，仅在模型支持参考媒体时提供）。',
        },
      },
      required: ['model_id', 'prompt'],
    },
  };
};

// ────────────────────────────────────────────
// 加工工具固定注册表
// ────────────────────────────────────────────

const assetIdProperty = {
  type: 'string',
  description: '要处理的资产 assetId（来自会话资产清单）。',
} as const;

const PROCESSING_TOOL_DEFINITIONS: ProcessingToolRegistration[] = [
  {
    definition: {
      name: 'crop_image',
      description: '裁剪图片资产：按像素矩形裁出指定区域，产出新图片资产。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: assetIdProperty,
          x: { type: 'integer', description: '裁剪区左上角横坐标（像素）。' },
          y: { type: 'integer', description: '裁剪区左上角纵坐标（像素）。' },
          width: { type: 'integer', description: '裁剪区宽度（像素）。' },
          height: { type: 'integer', description: '裁剪区高度（像素）。' },
        },
        required: ['asset_id', 'x', 'y', 'width', 'height'],
      },
    },
  },
  {
    definition: {
      name: 'resize_image',
      description: '缩放图片资产：按原始尺寸的百分比缩小（当前只支持缩小），产出新图片资产。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: assetIdProperty,
          percent: { type: 'number', description: '相对原始尺寸的百分比（10–100，只支持缩小）。' },
        },
        required: ['asset_id', 'percent'],
      },
    },
  },
  {
    definition: {
      name: 'chroma_key_image',
      description: '色键抠像：移除图片中接近指定颜色的像素（透明化），产出新图片资产。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: assetIdProperty,
          target_color: { type: 'string', description: '要移除的目标色，十六进制 RGB（如 #00FF00）。' },
          tolerance: { type: 'number', description: '颜色容差（0–100，默认 30）。' },
          feather: { type: 'number', description: '边缘羽化（0–20，默认 2）。' },
        },
        required: ['asset_id', 'target_color'],
      },
    },
  },
  {
    definition: {
      name: 'smart_split_image',
      description: '智能分割：识别图片中的独立主体并逐个切出为多张新图片资产。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: assetIdProperty,
        },
        required: ['asset_id'],
      },
    },
  },
  {
    definition: {
      name: 'trim_video',
      description: '截取视频片段：按起止时间裁出新视频资产（mp4）。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: assetIdProperty,
          start_time: { type: 'number', description: '开始时间（秒）。' },
          end_time: { type: 'number', description: '结束时间（秒，必须大于开始时间）。' },
          with_audio: { type: 'boolean', description: '是否保留音轨（默认保留）。' },
        },
        required: ['asset_id', 'start_time', 'end_time'],
      },
    },
  },
  {
    definition: {
      name: 'make_video_spritesheet',
      description: '生成视频序列帧图集：把指定时间段的帧拼成网格图，产出新图片资产（可用于展示视频概览）。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: assetIdProperty,
          start_time: { type: 'number', description: '开始时间（秒）。' },
          end_time: { type: 'number', description: '结束时间（秒，必须大于开始时间）。' },
          fps_multiplier: { type: 'number', description: '抽帧密度（0–1，默认 0.5，越大帧越密）。' },
        },
        required: ['asset_id', 'start_time', 'end_time'],
      },
    },
  },
  {
    definition: {
      name: 'extract_video_frames',
      description: '抽取视频指定时间点的单帧，产出新图片资产。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: assetIdProperty,
          time_sec: { type: 'number', description: '抽帧时间点（秒）。' },
        },
        required: ['asset_id', 'time_sec'],
      },
    },
  },
];

// ────────────────────────────────────────────
// 投影出口
// ────────────────────────────────────────────

export type AgentToolProjection = {
  definition: ChatToolDefinition;
  kind: AgentToolKind;
};

/** 每轮请求时实时投影工具清单（生成工具随 deployable 目录漂移；加工工具固定）。 */
const listAgentToolProjections = (): AgentToolProjection[] => {
  const projections: AgentToolProjection[] = [];
  const entries = listExecutableCatalogEntries();
  for (const mediaType of ['image', 'video'] as const) {
    const definition = buildGenerationToolDefinition(mediaType, entries);
    if (definition) {
      projections.push({ definition, kind: 'generation' });
    }
  }
  for (const registration of PROCESSING_TOOL_DEFINITIONS) {
    projections.push({ definition: registration.definition, kind: 'processing' });
  }
  return projections;
};

/** 判断工具名属于生成类还是加工类（参数校验与执行分派的第一判据）。 */
const resolveToolKind = (toolName: string): AgentToolKind | null => {
  if (toolName === GENERATION_TOOL_IMAGE || toolName === GENERATION_TOOL_VIDEO) return 'generation';
  if (PROCESSING_TOOL_DEFINITIONS.some((registration) => registration.definition.name === toolName)) {
    return 'processing';
  }
  return null;
};

export {
  GENERATION_TOOL_IMAGE,
  GENERATION_TOOL_VIDEO,
  listAgentToolProjections,
  resolveToolKind,
  buildModelParameterDigest,
};

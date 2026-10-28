import type { InterfaceFormatSummary } from '@iart/contracts';
import type { InterfaceFormatOption } from '../useInterfaceFormatOptions';

/**
 * 接口格式下拉的测试夹具（Hub 组件测试共用）。
 *
 * 值取自随软件分发的 8 个预设接口格式（`interface-format/presets/*.json`）：展示名、素材位、
 * order 与预设一致。测试用它喂「接口格式列表」这条真实数据入口——组件不再有第二份名称清单，
 * 也不允许测试用产品代码的常量反推期望值。
 */
export const PRESET_FORMAT_SUMMARIES: InterfaceFormatSummary[] = [
  {
    format_id: 'openai-image-v1',
    display_name: 'OpenAI Image',
    family: 'generation',
    status: 'ready',
    supports_media_slots: ['reference_image'],
    required_media_slots: [],
    order: 10,
    origin: 'preset',
    version: '1.0.0',
  },
  {
    format_id: 'openai-video-v1',
    display_name: 'OpenAI 视频',
    family: 'generation',
    status: 'ready',
    supports_media_slots: ['first_frame', 'last_frame', 'reference_image'],
    required_media_slots: [],
    order: 20,
    origin: 'preset',
    version: '1.0.0',
  },
  {
    format_id: 'gemini-image-interactions-v1',
    display_name: 'Gemini Image',
    family: 'generation',
    status: 'ready',
    supports_media_slots: ['reference_image'],
    required_media_slots: [],
    order: 30,
    origin: 'preset',
    version: '1.0.0',
  },
  {
    format_id: 'seedance-2-0-v1',
    display_name: 'Seedance 2.0',
    family: 'generation',
    status: 'ready',
    supports_media_slots: ['first_frame', 'last_frame', 'reference_image', 'reference_video', 'reference_audio'],
    required_media_slots: [],
    order: 40,
    origin: 'preset',
    version: '1.0.0',
  },
  {
    format_id: 'veo-v1',
    display_name: 'Veo',
    family: 'generation',
    status: 'ready',
    supports_media_slots: ['first_frame', 'last_frame'],
    required_media_slots: [],
    order: 50,
    origin: 'preset',
    version: '1.0.0',
  },
  {
    format_id: 'kling-text2video-v1',
    display_name: 'Kling 文生视频',
    family: 'generation',
    status: 'ready',
    supports_media_slots: [],
    required_media_slots: [],
    order: 60,
    origin: 'preset',
    version: '1.0.0',
  },
  {
    format_id: 'kling-image2video-v1',
    display_name: 'Kling 图生视频',
    family: 'generation',
    status: 'ready',
    supports_media_slots: ['first_frame', 'last_frame'],
    required_media_slots: ['first_frame'],
    order: 70,
    origin: 'preset',
    version: '1.0.0',
  },
  {
    format_id: 'kling-omni-video-v1',
    display_name: 'Kling 全模态视频',
    family: 'generation',
    status: 'ready',
    supports_media_slots: ['first_frame', 'last_frame', 'reference_image', 'feature_video', 'base_video'],
    required_media_slots: [],
    order: 80,
    origin: 'preset',
    version: '1.0.0',
  },
];

/** 与 summary 一一对应的下拉选项（`useInterfaceFormatOptions` 的输出形状）。 */
export const PRESET_FORMAT_OPTIONS: InterfaceFormatOption[] = PRESET_FORMAT_SUMMARIES.map((summary) => ({
  value: summary.format_id,
  label: summary.display_name,
}));

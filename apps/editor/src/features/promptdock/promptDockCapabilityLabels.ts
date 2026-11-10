import type { PromptDockCatalogEntry } from '@/client/api/promptDockApi';

/**
 * 创作面呈现模型能力标签（spec docs/model-assets/48-产物形态派生与消费契约.md §6.2）。
 *
 * 标签是添加模型的人手写的自由文本，说明这个模型能产出什么素材（如「静态图」「动图」）。
 * 创作面只做两件事：原样显示、未标注时如实说一句。不得翻译、不得推断，也不得据标签
 * 改变参数表单或提交资格。
 *
 * 判据是「标签数组为空」：它表示还没人填，不等于这个模型不能用，也不等于它什么都产不出。
 */

export const CAPABILITY_UNLABELED_LABEL = '能力未标注';
export const CAPABILITY_UNLABELED_HINT =
  '这个模型还没填能力标签，看不出它能产出什么素材。不影响使用；到主窗口「服务商与模型 → 修改模型」里补一句即可。';

/** 该目录条目上的能力标签；旧后端没给字段时按空数组读。 */
export const capabilityLabelsOf = (
  entry: PromptDockCatalogEntry | null | undefined,
): string[] => entry?.capability_labels ?? [];

/** 该目录条目是否还没标注能力。 */
export const hasUnlabeledCapability = (
  entry: PromptDockCatalogEntry | null | undefined,
): boolean => capabilityLabelsOf(entry).length === 0;

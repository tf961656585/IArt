/**
 * 模型表单字段的规范 key（canonical field key）。
 *
 * 该 key 是 PromptDock 提交与模型表单归一的口径之一；旧「端口 id ↔ 规范 key」的
 * 映射已随画布端口退场，这里只保留 key 命名与别名解析。
 */

export type CanonicalFieldKey =
  | 'prompt'
  | 'negativePrompt'
  | 'images'
  | 'referenceImages'
  | 'referenceImage'
  | 'imageInput'
  | 'imageReference'
  | 'firstFrameImage'
  | 'lastFrameImage'
  | 'firstFrame'
  | 'endFrame'
  | 'motionControlSourceImage'
  | 'tailImage'
  | 'image'
  | 'video'
  | 'audio'
  | 'aspectRatio'
  | 'imageSize'
  | 'resolution'
  | 'duration'
  | 'orientation'
  | 'seed'
  | 'model'
  | 'imageMode';

/**
 * 非规范名到规范名的别名映射。
 * 仅当上游产出方因外部约束无法使用规范名时才在此添加映射。
 * 如果 fieldKey 本身就是 CanonicalFieldKey，resolveCanonicalFieldKey 会直接返回，无需在此列出。
 */
export const FIELD_ALIASES: Record<string, CanonicalFieldKey> = {
};

const CANONICAL_FIELDS: readonly CanonicalFieldKey[] = [
  'prompt', 'negativePrompt', 'images', 'referenceImages', 'referenceImage', 'imageInput',
  'imageReference', 'firstFrameImage', 'lastFrameImage', 'firstFrame', 'endFrame',
  'motionControlSourceImage', 'tailImage', 'image', 'video', 'audio', 'aspectRatio',
  'imageSize', 'resolution', 'duration', 'orientation', 'seed', 'model', 'imageMode',
];

const CANONICAL_KEY_SET: ReadonlySet<string> = new Set<string>(CANONICAL_FIELDS);

export function resolveCanonicalFieldKey(fieldKey: string | undefined, explicit: CanonicalFieldKey | undefined): CanonicalFieldKey | undefined {
  if (explicit) return explicit;
  if (!fieldKey) return undefined;
  // fieldKey 本身就是规范名，直接返回
  if (CANONICAL_KEY_SET.has(fieldKey)) return fieldKey as CanonicalFieldKey;
  // 查找别名映射
  return FIELD_ALIASES[fieldKey] ?? undefined;
}

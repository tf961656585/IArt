/**
 * referenceBlobs mention 注入（request-assembler-mention.cts）
 *
 * 归后端物化层的 mention 注入（spec §5.4 / §7.3：mention 不进 payload_rules DSL，
 * 由后端依据编辑器传入的 "@锚点 → 素材" 映射，为被提示词 @ 的素材 referenceBlob
 * 补 `mention:{id:21位base64url随机串, label:"ImageN"/"VideoN"/"AudioN"}`）。
 *
 * 范式（spec §7）：连线=上传、@=mention。连线素材全部进 referenceBlobs（由
 * payload_rules 的 map_array 生成基础结构），mention 只加在被 @ 的素材上。
 *
 * 组偏移模型：referenceBlobs 由 compact_array([images..., videos..., audios...])
 * 组装（spec §5.4 抓包实证顺序），因此：
 * - image 组偏移 = 0
 * - video 组偏移 = N_image
 * - audio 组偏移 = N_image + N_video
 * 目标绝对下标 = 组偏移 + mention_map 条目里的组内 index。
 *
 * 防御性：mention 注入失败（映射越界、条目畸形、目标非对象）只记 debug 日志跳过，
 * 不 throw——mention 缺失不应阻塞任务提交。
 */
import { randomBytes } from "node:crypto";
import { logDebug } from "./logging.cts";
import {
  isPlainObject,
  readOpenField,
  writeOpenField,
  type PlainObject,
} from "./request-assembler-shared.cts";

type MentionMediaKind = "image" | "video" | "audio";

const MENTION_MEDIA_KINDS: readonly MentionMediaKind[] = ["image", "video", "audio"];

// mention_map 的 media_kind 语义字段（spec §5.4 / §7.4 命名规则）对应的
// parameter_schema field_key。normalizeMediaInputBuckets 对 video/audio 实际
// 以 media_kind 作桶 key（fieldKey = mediaKindToFieldKey.get(kind) || kind），
// 故读取计数时 canonical field_key 优先、media_kind 兜底。
const MENTION_KIND_FIELD_KEYS: Record<MentionMediaKind, string> = {
  image: "reference_images",
  video: "reference_videos",
  audio: "reference_audios",
};

const normalizeMentionMediaKind = (
  value: unknown,
): MentionMediaKind | "" => {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized === "video" || normalized === "audio") {
    return normalized;
  }
  return "";
};

const normalizeMentionIndex = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
};

/** 生成 21 位 base64url 随机串（spec §6.4：mention.id 由后端生成，跨会话不重复）。 */
export const generateMentionId = (): string =>
  randomBytes(16).toString("base64url").slice(0, 21);

const countArrayField = (
  mediaInputFields: PlainObject,
  key: string,
): number => {
  const value = readOpenField(mediaInputFields, key);
  return Array.isArray(value) ? value.length : 0;
};

const resolveMediaCount = (
  mediaInputFields: PlainObject,
  mediaKind: MentionMediaKind,
): number => {
  const canonicalCount = countArrayField(
    mediaInputFields,
    MENTION_KIND_FIELD_KEYS[mediaKind],
  );
  if (canonicalCount > 0) return canonicalCount;
  return countArrayField(mediaInputFields, mediaKind);
};

const resolveGroupOffset = (
  mediaKind: MentionMediaKind,
  counts: Record<MentionMediaKind, number>,
): number => {
  if (mediaKind === "image") return 0;
  if (mediaKind === "video") return counts.image;
  return counts.image + counts.video;
};

/**
 * 为 payload.body.referenceBlobs 中被提示词 @ 的素材补 mention。
 *
 * @param payload 组装中的 payload（{ api, body, meta } 形态）
 * @param mentionMap 编辑器传入的 "@锚点 → 素材" 映射（形如
 *   { Image1: { media_kind: "image", index: 0 }, Video1: { media_kind: "video", index: 0 } }）
 * @param mediaInputFields normalizeMediaInputBuckets 的产物，用于取各媒体类型数量
 */
export const injectMentionsIntoReferenceBlobs = (
  payload: PlainObject,
  mentionMap: unknown,
  mediaInputFields: PlainObject,
): void => {
  if (!isPlainObject(mentionMap)) return;
  const entries = Object.entries(mentionMap);
  if (entries.length === 0) return;
  const body = readOpenField(payload, "body");
  const referenceBlobsRaw = isPlainObject(body)
    ? readOpenField(body, "referenceBlobs")
    : undefined;
  if (!Array.isArray(referenceBlobsRaw) || referenceBlobsRaw.length === 0) return;
  const referenceBlobs: unknown[] = referenceBlobsRaw;

  const counts: Record<MentionMediaKind, number> = {
    image: resolveMediaCount(mediaInputFields, "image"),
    video: resolveMediaCount(mediaInputFields, "video"),
    audio: resolveMediaCount(mediaInputFields, "audio"),
  };

  for (const [label, rawEntry] of entries) {
    if (!isPlainObject(rawEntry)) {
      logDebug("[request-assembler-mention] mention_map entry is not an object, skipping", { label });
      continue;
    }
    const mediaKind = normalizeMentionMediaKind(
      readOpenField(rawEntry, "media_kind"),
    );
    if (!mediaKind) {
      logDebug("[request-assembler-mention] mention_map entry has invalid media_kind, skipping", { label });
      continue;
    }
    const index = normalizeMentionIndex(readOpenField(rawEntry, "index"));
    if (index === null) {
      logDebug("[request-assembler-mention] mention_map entry has invalid index, skipping", { label });
      continue;
    }
    const groupOffset = resolveGroupOffset(mediaKind, counts);
    const absoluteIndex = groupOffset + index;
    const target = referenceBlobs[absoluteIndex];
    if (!isPlainObject(target)) {
      logDebug("[request-assembler-mention] mention target out of bounds or not an object, skipping", {
        label,
        mediaKind,
        index,
        absoluteIndex,
        referenceBlobsLength: referenceBlobs.length,
      });
      continue;
    }
    writeOpenField(target, "mention", { id: generateMentionId(), label });
    logDebug("[request-assembler-mention] mention injected", {
      label,
      mediaKind,
      index,
      absoluteIndex,
    });
  }
};

export {
  type MentionMediaKind,
  MENTION_MEDIA_KINDS,
  MENTION_KIND_FIELD_KEYS,
};

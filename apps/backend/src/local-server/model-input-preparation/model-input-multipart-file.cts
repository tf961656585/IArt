import type { SerializedFormDataBody } from "@iart/contracts";
import { isPlainObject, type DynamicObject } from "./model-input-source.cts";

/**
 * multipart 文件值的审计外壳。
 *
 * 物化只负责把占位符变成字节；但「这张字节来自哪个资产、原本是什么媒体类型」在变成
 * 裸 Buffer 后就丢了，序列化只能写出通用的 `file` / `application/octet-stream`。
 * 这层外壳把来源描述挂在字节旁边：`buffer` 照旧进出网，其余字段只进文件描述（审计）。
 * 出网形态由序列化器固定写出，不受这些字段影响。
 */
const MULTIPART_FILE_MARKER = "__multipart_file__" as const;
type MultipartFileValue = {
  __multipart_file__: typeof MULTIPART_FILE_MARKER;
  buffer: Buffer;
  /** 占位符携带的来源文件名（未带时为 undefined）。 */
  sourceFilename?: string;
  /** 占位符携带的真实媒体类型。 */
  mimeType?: string;
  /** 提交面显式给出的资产身份与素材位标识。 */
  assetId?: string;
  slotId?: string;
};

const isMultipartFileValue = (value: unknown): value is MultipartFileValue => {
  if (!isPlainObject(value)) return false;
  const record = value as { __multipart_file__?: unknown; buffer?: unknown };
  return record.__multipart_file__ === MULTIPART_FILE_MARKER && Buffer.isBuffer(record.buffer);
};

const wrapMultipartFile = (
  buffer: Buffer,
  metadata: {
    sourceFilename?: string | undefined;
    mimeType?: string | undefined;
    assetId?: string | undefined;
    slotId?: string | undefined;
  } = {},
): MultipartFileValue => ({
  __multipart_file__: MULTIPART_FILE_MARKER,
  buffer,
  ...(metadata.sourceFilename ? { sourceFilename: metadata.sourceFilename } : {}),
  ...(metadata.mimeType ? { mimeType: metadata.mimeType } : {}),
  ...(metadata.assetId ? { assetId: metadata.assetId } : {}),
  ...(metadata.slotId ? { slotId: metadata.slotId } : {}),
});

const collectFormDataEntries = (
  value: unknown,
  parentKey: string,
  entries: Array<{ key: string; value: unknown }>,
  repeatedTopLevelKeys: ReadonlySet<string>,
  isTopLevel: boolean,
) => {
  if (value === undefined || value === null) return;
  if (isMultipartFileValue(value)) {
    entries.push({ key: parentKey, value });
    return;
  }
  if (Buffer.isBuffer(value)) {
    entries.push({ key: parentKey, value });
    return;
  }
  if (Array.isArray(value)) {
    // 仅在声明了 multipart_array_naming=repeated 的顶层字段上，
    // 数组展开为同名重复 part；其余维持 indexed（兼容既有行为）。
    const useRepeated = isTopLevel && repeatedTopLevelKeys.has(parentKey);
    for (const [index, item] of value.entries()) {
      const childKey = useRepeated ? parentKey : `${parentKey}[${index}]`;
      collectFormDataEntries(item, childKey, entries, repeatedTopLevelKeys, false);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const childKey = parentKey ? `${parentKey}.${key}` : key;
      collectFormDataEntries(item, childKey, entries, repeatedTopLevelKeys, false);
    }
    return;
  }
  entries.push({ key: parentKey, value });
};

const EMPTY_REPEATED_KEYS: ReadonlySet<string> = new Set<string>();

const convertBodyToSerializedFormData = (
  body: DynamicObject,
  repeatedTopLevelKeys: ReadonlySet<string> = EMPTY_REPEATED_KEYS,
): SerializedFormDataBody => {
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const [key, item] of Object.entries(body)) {
    collectFormDataEntries(item, key, entries, repeatedTopLevelKeys, true);
  }
  const fields: Array<{ name: string; value: string }> = [];
  const files: Array<{
    name: string;
    dataBase64: string;
    contentType: string;
    filename: string;
    sourceFilename?: string;
    mimeType?: string;
    assetId?: string;
    slotId?: string;
  }> = [];
  for (const entry of entries) {
    if (isMultipartFileValue(entry.value)) {
      // 出网值与裸 Buffer 路径保持完全一致（file / application/octet-stream）；
      // 来源描述只写进审计字段，发送链读不到也用不到它们。
      files.push({
        name: entry.key,
        dataBase64: entry.value.buffer.toString("base64"),
        contentType: "application/octet-stream",
        filename: "file",
        ...(entry.value.sourceFilename ? { sourceFilename: entry.value.sourceFilename } : {}),
        ...(entry.value.mimeType ? { mimeType: entry.value.mimeType } : {}),
        ...(entry.value.assetId ? { assetId: entry.value.assetId } : {}),
        ...(entry.value.slotId ? { slotId: entry.value.slotId } : {}),
      });
    } else if (Buffer.isBuffer(entry.value)) {
      files.push({
        name: entry.key,
        dataBase64: entry.value.toString("base64"),
        contentType: "application/octet-stream",
        filename: "file",
      });
    } else {
      const stringValue = (entry.value === undefined || entry.value === null)
        ? ""
        : String(entry.value);
      fields.push({ name: entry.key, value: stringValue });
    }
  }
  return {
    __formData: { fields, files },
  };
};

export {
  type MultipartFileValue,
  convertBodyToSerializedFormData,
  isMultipartFileValue,
  wrapMultipartFile,
};

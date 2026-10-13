import {
  normalizeUploadItems,
} from '@/features/canvas/nodes/model/mediaHelpers';
import type { DynamicRecord } from '@/client/utils/typeGuards';
import type { GraphNode, ModelNodeData } from '@/features/canvas/types';
import { classifyMediaUrl } from '@/features/models/shared/mediaResolutionTypes';
import { importLocalFile } from './localMediaImport';
export const shouldDisableEmbeddedResultsAutoLayoutPersistence = (modelId: string): boolean => {
  void modelId;
  return false;
};
export type PersistedMediaIssueCode =
  | 'session_url_invalid'
  | 'inline_data_disallowed'
  | 'non_local_reference_disallowed'
  | 'media_localize_failed';
export interface PersistedMediaIssue { fieldKey: string; code: PersistedMediaIssueCode; message: string; itemId: string | undefined; src: string | undefined; }
export type PersistedUploadItem = { id: string | undefined; src: string };
export interface SanitizePersistedUploadItemsParams { fieldKey: string; value: unknown; maxFiles: number | undefined; }
export interface SanitizePersistedUploadItemsResult { items: PersistedUploadItem[]; issues: PersistedMediaIssue[]; changed: boolean; }
export interface PersistUploadItemsForModelFieldParams { fieldKey: string; value: unknown; maxFiles: number | undefined; }
export interface PersistUploadItemsForModelFieldResult { items: PersistedUploadItem[]; issues: PersistedMediaIssue[]; }
export interface SanitizeModelMediaValueForPersistenceParams { fieldKey: string; value: unknown; maxFiles: number | undefined; }
export interface SanitizeModelMediaValueForPersistenceResult { value: unknown; issues: PersistedMediaIssue[]; changed: boolean; }
export interface PersistModelMediaValueForFieldParams { fieldKey: string; value: unknown; maxFiles: number | undefined; }
export interface PersistModelMediaValueForFieldResult { value: unknown; issues: PersistedMediaIssue[]; }
export interface SanitizeModelFormValuesForPersistenceResult { formValues: DynamicRecord; issues: PersistedMediaIssue[]; changed: boolean; }
export interface SanitizeModelNodeForPersistenceResult<T extends GraphNode = GraphNode> { node: T; issues: PersistedMediaIssue[]; changed: boolean; }
export interface SanitizeModelNodePatchForPersistenceResult { patch: ModelNodePatchForPersistence; issues: PersistedMediaIssue[]; changed: boolean; }
export type ModelNodePatchForPersistence = DynamicRecord;
type ModelNodePatchWithFormValues = DynamicRecord & { formValues: unknown | undefined; };
interface RawUploadLikeRecord { file: unknown | undefined; src: unknown | undefined; id: unknown | undefined; }
const trimValue = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const toModelMediaReferenceUrl = (value: unknown): string | null => {
  const raw = trimValue(value);
  if (!raw) return null;
  const classified = classifyMediaUrl(raw);
  if (
    classified.kind === 'local-media' ||
    classified.kind === 'remote-http'
  ) {
    return classified.normalizedUrl;
  }
  return null;
};
const isUploadLikeRecord = (value: unknown): value is RawUploadLikeRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'file' in value || 'src' in value || 'id' in value;
};
const shouldSanitizeUploadValue = (value: unknown): boolean => {
  if (Array.isArray(value)) return true;
  return isUploadLikeRecord(value);
};
const isStringValue = (value: unknown): value is string => typeof value === 'string';
const normalizeItemId = (value: unknown): string | undefined => {
  const trimmed = trimValue(value);
  return trimmed || undefined;
};
const createIssue = (
  fieldKey: string,
  code: PersistedMediaIssueCode,
  options: { itemId: string | undefined; src: string | undefined } | undefined
): PersistedMediaIssue => {
  const message = (() => {
    switch (code) {
      case 'session_url_invalid':
        return '会话图片已失效，请重新上传。';
      case 'inline_data_disallowed':
        return '检测到 data: 媒体引用，请重新上传为本地文件。';
      case 'non_local_reference_disallowed':
        return '仅支持本地媒体引用或远程 URL，请重新上传。';
      case 'media_localize_failed':
      default:
        return '媒体导入失败，请重试。';
    }
  })();
  return {
    fieldKey,
    code,
    message,
    itemId: (options !== null && options !== undefined) ? options.itemId : undefined,
    src: (options !== null && options !== undefined) ? options.src : undefined,
  };
};
const isBlobLike = (value: unknown): value is Blob => {
  return typeof Blob !== 'undefined' && value instanceof Blob;
};
const guessExtensionFromMimeType = (mimeType: string): string => {
  const parts = mimeType.toLowerCase().split(';');
  const normalized = parts[0] !== null && parts[0] !== undefined ? parts[0].trim() : '';
  switch (normalized) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    default: {
      const slashParts = normalized.split('/');
      const ext = slashParts[1] !== null && slashParts[1] !== undefined ? slashParts[1].trim() : undefined;
      return ext || 'bin';
    }
  }
};
const guessExtensionFromUrl = (rawUrl: string): string | null => {
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    const withoutQuery = parsed.pathname || '';
    const match = withoutQuery.match(/\.([a-zA-Z0-9]{2,8})$/);
    if (match !== null && match !== undefined && match[1] !== null && match[1] !== undefined) return match[1].toLowerCase();
    return null;
  } catch {
    return null;
  }
};
const buildUploadFilename = (
  fieldKey: string,
  index: number,
  options: { mimeType: string | undefined; sourceUrl: string | undefined } | undefined
): string => {
  const field = trimValue(fieldKey) || 'media';
  const mimeTypeStr = (options !== null && options !== undefined) ? options.mimeType : undefined;
  const sourceUrlStr = (options !== null && options !== undefined) ? options.sourceUrl : undefined;
  const extFromMime = mimeTypeStr ? guessExtensionFromMimeType(mimeTypeStr) : '';
  const extFromUrl = sourceUrlStr ? guessExtensionFromUrl(sourceUrlStr) : '';
  const ext = extFromMime || extFromUrl || 'bin';
  return `${field}_${Date.now()}_${index}.${ext}`;
};
const normalizePersistedItemsFromRaw = (
  value: unknown,
  maxFiles: number | undefined
): PersistedUploadItem[] => {
  const normalized = normalizeUploadItems(value, maxFiles);
  const items: PersistedUploadItem[] = [];
  for (const item of normalized) {
    if (item.file != null) return [];
    const localSrc = toModelMediaReferenceUrl(item.src);
    if (!localSrc) return [];
    const itemId = normalizeItemId(item.id);
    items.push({
      id: itemId,
      src: localSrc,
    });
  }
  return items;
};
const arePersistedItemsEqual = (
  rawValue: unknown,
  persistedItems: PersistedUploadItem[],
  maxFiles: number | undefined
): boolean => {
  if (!Array.isArray(rawValue)) return false;
  const normalized = normalizePersistedItemsFromRaw(rawValue, maxFiles);
  if (normalized.length !== persistedItems.length) return false;
  for (let i = 0; i < normalized.length; i += 1) {
    const a = normalized[i];
    const b = persistedItems[i];
    if (!a || !b) return false;
    if (a.id !== b.id) return false;
    if (a.src !== b.src) return false;
  }
  return true;
};
export const sanitizePersistedUploadItems = (
  params: SanitizePersistedUploadItemsParams
): SanitizePersistedUploadItemsResult => {
  const normalized = normalizeUploadItems(params.value, params.maxFiles);
  const items: PersistedUploadItem[] = [];
  const issues: PersistedMediaIssue[] = [];
  for (const item of normalized) {
    const itemId = normalizeItemId(item.id);
    const src = trimValue(item.src);
    const localSrc = toModelMediaReferenceUrl(src);
    if (localSrc) {
      items.push({
        id: itemId,
        src: localSrc,
      });
      continue;
    }
    if (item.file != null) {
      issues.push(createIssue(params.fieldKey, 'media_localize_failed', { itemId, src }));
      continue;
    }
    if (!src) continue;
    const lower = src.toLowerCase();
    if (lower.startsWith('blob:')) {
      issues.push(createIssue(params.fieldKey, 'session_url_invalid', { itemId, src }));
      continue;
    }
    if (lower.startsWith('data:')) {
      issues.push(createIssue(params.fieldKey, 'inline_data_disallowed', { itemId, src }));
      continue;
    }
    issues.push(createIssue(params.fieldKey, 'non_local_reference_disallowed', { itemId, src }));
  }
  return {
    items,
    issues,
    changed: !arePersistedItemsEqual(params.value, items, params.maxFiles),
  };
};
const sanitizeStringMediaValueForPersistence = (
  params: SanitizeModelMediaValueForPersistenceParams
): SanitizeModelMediaValueForPersistenceResult => {
  const rawValue = isStringValue(params.value) ? params.value : '';
  const src = trimValue(rawValue);
  if (!src) {
    return {
      value: '',
      issues: [],
      changed: rawValue !== '',
    };
  }
  const localSrc = toModelMediaReferenceUrl(src);
  if (localSrc) {
    return {
      value: localSrc,
      issues: [],
      changed: localSrc !== rawValue,
    };
  }
  const lower = src.toLowerCase();
  if (lower.startsWith('blob:')) {
    return {
      value: '',
      issues: [createIssue(params.fieldKey, 'session_url_invalid', { itemId: undefined, src })],
      changed: true,
    };
  }
  if (lower.startsWith('data:')) {
    return {
      value: '',
      issues: [createIssue(params.fieldKey, 'inline_data_disallowed', { itemId: undefined, src })],
      changed: true,
    };
  }
  return {
    value: '',
    issues: [createIssue(params.fieldKey, 'non_local_reference_disallowed', { itemId: undefined, src })],
    changed: true,
  };
};
const blobToImportableFile = (
  fieldKey: string,
  blob: Blob,
  index: number,
  options: { sourceUrl: string | undefined } | undefined
): File => {
  const sourceUrl = (options !== null && options !== undefined) ? options.sourceUrl : undefined;
  const filename = buildUploadFilename(fieldKey, index, {
    mimeType: blob.type || undefined,
    sourceUrl,
  });
  if (typeof File !== 'undefined' && blob instanceof File) {
    return blob;
  }
  return new File([blob], filename, { type: blob.type || 'application/octet-stream' });
};
const persistStringMediaValueForField = async (
  params: PersistModelMediaValueForFieldParams
): Promise<PersistModelMediaValueForFieldResult> => {
  const src = trimValue(params.value);
  if (!src) {
    return { value: '', issues: [] };
  }
  const localSrc = toModelMediaReferenceUrl(src);
  if (localSrc) {
    return { value: localSrc, issues: [] };
  }
  const lower = src.toLowerCase();
  if (lower.startsWith('blob:')) {
    return {
      value: '',
      issues: [createIssue(params.fieldKey, 'session_url_invalid', { itemId: undefined, src })],
    };
  }
  if (lower.startsWith('data:')) {
    return {
      value: '',
      issues: [createIssue(params.fieldKey, 'inline_data_disallowed', { itemId: undefined, src })],
    };
  }
  return {
    value: '',
    issues: [createIssue(params.fieldKey, 'non_local_reference_disallowed', { itemId: undefined, src })],
  };
};
export const persistUploadItemsForModelField = async (
  params: PersistUploadItemsForModelFieldParams
): Promise<PersistUploadItemsForModelFieldResult> => {
  const normalized = normalizeUploadItems(params.value, params.maxFiles);
  const items: PersistedUploadItem[] = [];
  const issues: PersistedMediaIssue[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index];
    if (!item) continue;
    const itemId = normalizeItemId(item.id);
    const src = trimValue(item.src);
    const localSrc = toModelMediaReferenceUrl(src);
    if (localSrc) {
      items.push({
        id: itemId,
        src: localSrc,
      });
      continue;
    }
    if (isBlobLike(item.file)) {
      try {
        const file = blobToImportableFile(params.fieldKey, item.file, index, { sourceUrl: src });
        const imported = await importLocalFile(file);
        items.push({
          id: itemId,
          src: imported.persistentUrl,
        });
      } catch {
        issues.push(createIssue(params.fieldKey, 'media_localize_failed', { itemId, src }));
      }
      continue;
    }
    if (item.file != null) {
      issues.push(createIssue(params.fieldKey, 'media_localize_failed', { itemId, src }));
      continue;
    }
    if (!src) continue;
    const lower = src.toLowerCase();
    if (lower.startsWith('blob:')) {
      issues.push(createIssue(params.fieldKey, 'session_url_invalid', { itemId, src }));
      continue;
    }
    const referenceUrl = toModelMediaReferenceUrl(src);
    if (referenceUrl) {
      items.push({
        id: itemId,
        src: referenceUrl,
      });
      continue;
    }
    issues.push(createIssue(params.fieldKey, 'non_local_reference_disallowed', { itemId, src }));
  }
  return { items, issues };
};
export const sanitizeModelMediaValueForPersistence = (
  params: SanitizeModelMediaValueForPersistenceParams
): SanitizeModelMediaValueForPersistenceResult => {
  if (isStringValue(params.value)) {
    return sanitizeStringMediaValueForPersistence(params);
  }
  if (!shouldSanitizeUploadValue(params.value)) {
    return {
      value: params.value,
      issues: [],
      changed: false,
    };
  }
  const sanitized = sanitizePersistedUploadItems({
    fieldKey: params.fieldKey,
    value: params.value,
    maxFiles: params.maxFiles,
  });
  return {
    value: sanitized.items,
    issues: sanitized.issues,
    changed: sanitized.changed,
  };
};
export const persistModelMediaValueForField = async (
  params: PersistModelMediaValueForFieldParams
): Promise<PersistModelMediaValueForFieldResult> => {
  if (isStringValue(params.value)) {
    return persistStringMediaValueForField(params);
  }
  if (!shouldSanitizeUploadValue(params.value)) {
    return {
      value: params.value,
      issues: [],
    };
  }
  const persisted = await persistUploadItemsForModelField({
    fieldKey: params.fieldKey,
    value: params.value,
    maxFiles: params.maxFiles,
  });
  return {
    value: persisted.items,
    issues: persisted.issues,
  };
};
export const sanitizeModelFormValuesForPersistence = (params: {
  node: GraphNode<ModelNodeData>;
  formValues: DynamicRecord;
}): SanitizeModelFormValuesForPersistenceResult => {
  // 媒体字段 key 此前由画布输入端口派生；端口已随连线退场，这里不再有端口可派生，
  // 表单值按原样保留。
  void params;
  return { formValues: params.formValues, issues: [], changed: false };
};
export const sanitizeModelNodeForPersistence = <T extends GraphNode>(
  node: T
): SanitizeModelNodeForPersistenceResult<T> => {
  if (node.type !== 'model') return { node, issues: [], changed: false };
  const modelNode = node as GraphNode<ModelNodeData>;
  const modelId = typeof (modelNode.data !== null && modelNode.data !== undefined ? modelNode.data.modelId : undefined) === 'string' ? modelNode.data.modelId.trim() : '';
  const disableEmbeddedLayoutPersistence = shouldDisableEmbeddedResultsAutoLayoutPersistence(modelId);
  const currentFormValues =
    (modelNode.data !== null && modelNode.data !== undefined ? modelNode.data.formValues : undefined) && typeof modelNode.data.formValues === 'object'
      ? modelNode.data.formValues
      : {};
  const sanitized = sanitizeModelFormValuesForPersistence({ node: modelNode, formValues: currentFormValues });
  let changed = false;
  let nextData: ModelNodeData = modelNode.data ?? { modelId, formValues: {} };
  if (
    disableEmbeddedLayoutPersistence &&
    Object.prototype.hasOwnProperty.call(nextData, 'embeddedResultsAutoLayout')
  ) {
    const { embeddedResultsAutoLayout: _drop, ...rest } = nextData as ModelNodeData & {
      embeddedResultsAutoLayout: unknown | undefined;
    };
    nextData = rest;
    changed = true;
  }
  if (sanitized.changed) {
    nextData = { ...nextData, formValues: sanitized.formValues };
    changed = true;
  }
  if (!changed) return { node, issues: sanitized.issues, changed: false };
  return { node: { ...node, data: nextData } as T, issues: sanitized.issues, changed: true };
};
export const sanitizeModelNodePatchForPersistence = (
  node: GraphNode<ModelNodeData>,
  patch: ModelNodePatchForPersistence
): SanitizeModelNodePatchForPersistenceResult => {
  const modelId = typeof (node.data !== null && node.data !== undefined ? node.data.modelId : undefined) === 'string' ? node.data.modelId.trim() : '';
  const disableEmbeddedLayoutPersistence = shouldDisableEmbeddedResultsAutoLayoutPersistence(modelId);
  let nextPatch = patch;
  let changed = false;
  if (
    disableEmbeddedLayoutPersistence &&
    Object.prototype.hasOwnProperty.call(nextPatch, 'embeddedResultsAutoLayout')
  ) {
    const { embeddedResultsAutoLayout: _drop, ...rest } = nextPatch;
    nextPatch = rest;
    changed = true;
  }
  const hasFormValues = Object.prototype.hasOwnProperty.call(nextPatch, 'formValues');
  if (!hasFormValues) {
    return { patch: nextPatch, issues: [], changed };
  }
  const rawFormValues = (nextPatch as ModelNodePatchWithFormValues).formValues;
  if (!rawFormValues || typeof rawFormValues !== 'object' || Array.isArray(rawFormValues)) {
    const { formValues: _drop, ...rest } = nextPatch;
    return { patch: rest, issues: [], changed: true };
  }
  const sanitized = sanitizeModelFormValuesForPersistence({ node, formValues: rawFormValues as DynamicRecord });
  if (!sanitized.changed) return { patch: nextPatch, issues: sanitized.issues, changed };
  return { patch: { ...nextPatch, formValues: sanitized.formValues }, issues: sanitized.issues, changed: true };
};

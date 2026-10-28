import * as z from 'zod';
import {
  PUBLIC_RELAY_TARGET_TYPE,
} from './public-relay-contract';

type EditorBackendMessageView = {
  projectPath: unknown | undefined;
  nodeGraphId: unknown | undefined;
  taskId: unknown | undefined;
  remoteRequestId: unknown | undefined;
  actionId: unknown | undefined;
  actionName: unknown | undefined;
  actionClass: unknown | undefined;
  payload: unknown | undefined;
  requestedAt: unknown | undefined;
  accepted: unknown | undefined;
  error: unknown | undefined;
  result: unknown | undefined;
  emittedAt: unknown | undefined;
};

type EditorBackendErrorView = {
  code: unknown | undefined;
  message: unknown | undefined;
};

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export type EditorBackendActionClass =
  | 'business_async'
  | 'business_sync'
  | 'infra_runtime';

export type EditorBackendMessageType =
  | 'editor_backend_business_submit'
  | 'editor_backend_business_ack'
  | 'editor_backend_business_result'
  | 'editor_backend_business_event';

export type EditorBackendAsyncEvent =
  | 'ack'
  | 'snapshot'
  | 'delta'
  | 'final'
  | 'error'
  | 'cancelled';

export interface EditorBackendIdentity {
  projectPath: string;
  nodeGraphId: string | null | undefined;
  taskId: string | null | undefined;
  remoteRequestId: string | null | undefined;
}

export interface EditorBackendBusinessSubmitEnvelope {
  type: 'editor_backend_business_submit';
  actionId: string;
  actionName: string;
  actionClass: EditorBackendActionClass;
  projectPath: string;
  nodeGraphId: string | null | undefined;
  payload: unknown;
  requestedAt: string;
}

export interface EditorBackendAsyncAckEnvelope extends EditorBackendIdentity {
  type: 'editor_backend_business_ack';
  actionId: string;
  actionName: string;
  actionClass: EditorBackendActionClass;
  accepted: boolean;
  emittedAt: number;
}

export interface EditorBackendBusinessResultEnvelope {
  type: 'editor_backend_business_result';
  actionId: string;
  actionName: string;
  actionClass: EditorBackendActionClass;
  projectPath: string;
  nodeGraphId: string | null | undefined;
  result: unknown | undefined;
  error: {
    code: string;
    message: string;
  } | undefined;
  emittedAt: number;
}

export interface EditorLocalizedMediaDescriptor {
  owner: 'backend';
  localized: boolean;
  url: string | null;
  originalUrl: string | null;
  mediaType: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export type EditorWindowEntry = 'editor';

export interface EditorWindowContext {
  entry: EditorWindowEntry;
}

export interface EditorDesktopBootstrap {
  runtime: 'desktop';
  backendBaseUrl: string;
  projectPath: string | null;
  projectRef: string | null;
  stableProjectId: string | null;
  sessionToken: string | null;
  locale: string;
  windowContext: EditorWindowContext;
}

export const EditorWindowContextSchema = z.object({
  entry: z.literal('editor'),
});

export const EditorDesktopBootstrapSchema = z.object({
  runtime: z.literal('desktop'),
  backendBaseUrl: z.string().min(1),
  projectPath: z.string().min(1).nullable(),
  // 当前保留宽松校验：DB 读取路径（resolveStableProjectId / ensureStableProjectId）
  // 与大量测试 fixture 尚未全部迁移到合规 prj_[a-f0-9]{32} 前缀。
  // 新代码消费 scope 时应使用 ScopeRefSchema（packages/contracts/src/local-media-scope.ts）严格校验。
  // 待 DB 读取路径增加 isStableProjectId 守卫、fixture 全部合规后，统一收紧为 ProjectRefSchema.nullable()。
  projectRef: z.string().min(1).nullable(),
  // 同上，待迁移后收紧为 StableProjectIdSchema.nullable()。
  stableProjectId: z.string().min(1).nullable(),
  sessionToken: z.string().min(1).nullable(),
  locale: z.string().min(1),
  windowContext: EditorWindowContextSchema,
});

export const OpenEditorWindowRequestSchema = z.object({
  projectPath: z.string().min(1),
  sessionToken: z.string().min(1),
});

export const OpenEditorWindowResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'invalid-editor-window-target',
      'invalid-project-folder',
      'open-editor-window-failed',
    ]),
    message: z.string().min(1),
    projectPath: z.string().min(1).nullable(),
  }),
]);

export const ElectronRuntimeFlagsSchema = z.object({
  isPackaged: z.boolean().optional(),
});

export const DesktopE2EEventPayloadSchema = z.object({
  type: z.string().min(1),
  detail: z.record(z.unknown()).nullable().optional(),
});

export const EditorBackendThumbnailReportReasonSchema = z.enum(['file_404', 'render_error']);

export const EditorBackendThumbnailReportMissingRequestSchema = z.object({
  projectPath: z.string().min(1),
  assetId: z.string().min(1).nullable().optional(),
  mediaType: z.enum(['image', 'video']).nullable().optional(),
  thumbnailUrl: z.string().min(1).nullable().optional(),
  reason: EditorBackendThumbnailReportReasonSchema,
}).strict();

export const EditorBackendThumbnailReportMissingResultSchema = z.object({
  accepted: z.boolean(),
  scheduled: z.boolean(),
  downgradedAssetIds: z.array(z.string().min(1)),
}).strict();

export type EditorBackendThumbnailReportReason = z.infer<typeof EditorBackendThumbnailReportReasonSchema>;
export type EditorBackendThumbnailReportMissingRequest = z.infer<typeof EditorBackendThumbnailReportMissingRequestSchema>;
export type EditorBackendThumbnailReportMissingResult = z.infer<typeof EditorBackendThumbnailReportMissingResultSchema>;
export type OpenEditorWindowRequest = z.infer<typeof OpenEditorWindowRequestSchema>;
export type OpenEditorWindowResult = z.infer<typeof OpenEditorWindowResultSchema>;
export type ElectronRuntimeFlags = z.infer<typeof ElectronRuntimeFlagsSchema>;
export type DesktopE2EEventPayload = z.infer<typeof DesktopE2EEventPayloadSchema>;

export const EDITOR_BACKEND_CONTRACT_VERSION = 3;

export const EDITOR_BACKEND_ACTION_CLASS = Object.freeze({
  BUSINESS_ASYNC: 'business_async',
  BUSINESS_SYNC: 'business_sync',
  INFRA_RUNTIME: 'infra_runtime',
});

export const EDITOR_BACKEND_ACTION_CLASSES = Object.freeze([
  EDITOR_BACKEND_ACTION_CLASS.BUSINESS_ASYNC,
  EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
  EDITOR_BACKEND_ACTION_CLASS.INFRA_RUNTIME,
]);

export const EDITOR_BACKEND_ACTION_CLASS_SET: ReadonlySet<string> = new Set(EDITOR_BACKEND_ACTION_CLASSES);

export const EDITOR_BACKEND_MESSAGE_TYPE = Object.freeze({
  SUBMIT: 'editor_backend_business_submit',
  ACK: 'editor_backend_business_ack',
  RESULT: 'editor_backend_business_result',
  EVENT: 'editor_backend_business_event',
});

export const EDITOR_BACKEND_ASYNC_EVENT = Object.freeze({
  ACK: 'ack',
  SNAPSHOT: 'snapshot',
  DELTA: 'delta',
  FINAL: 'final',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

export const EDITOR_BACKEND_ASYNC_EVENTS = Object.freeze([
  EDITOR_BACKEND_ASYNC_EVENT.ACK,
  EDITOR_BACKEND_ASYNC_EVENT.SNAPSHOT,
  EDITOR_BACKEND_ASYNC_EVENT.DELTA,
  EDITOR_BACKEND_ASYNC_EVENT.FINAL,
  EDITOR_BACKEND_ASYNC_EVENT.ERROR,
  EDITOR_BACKEND_ASYNC_EVENT.CANCELLED,
]);

export const EDITOR_BACKEND_ASYNC_EVENT_SET: ReadonlySet<string> = new Set(EDITOR_BACKEND_ASYNC_EVENTS);

export const EDITOR_BACKEND_RUNTIME_BOUNDARY = Object.freeze({
  bootstrap: Object.freeze({
    projectPath: EDITOR_BACKEND_ACTION_CLASS.INFRA_RUNTIME,
    localApiBase: EDITOR_BACKEND_ACTION_CLASS.INFRA_RUNTIME,
  }),
  session: Object.freeze({
    open: EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
    heartbeat: EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
  }),
  editor: Object.freeze({
    flush: EDITOR_BACKEND_ACTION_CLASS.INFRA_RUNTIME,
    close: EDITOR_BACKEND_ACTION_CLASS.INFRA_RUNTIME,
  }),
});

export const EDITOR_BACKEND_IDENTITY_OWNER = Object.freeze({
  projectPath: 'backend_authoritative_bootstrap',
  nodeGraphId: 'backend_scoped_projection',
  taskId: 'backend_assigned_on_ack',
  remoteRequestId: 'backend_optional_remote_identity',
});

export const EDITOR_BACKEND_MEDIA_CONTRACT = Object.freeze({
  owner: 'backend',
  localizedUrlPrefix: '/files/',
  displayRequiresLocalizedFile: true,
  adapterRoutes: Object.freeze(['/api/upload', '/api/media/localize']),
});

export const EDITOR_BACKEND_COMPAT = Object.freeze({
  wsPath: '/ws/business',
  jobsAdapterMode: 'backend_internal_adapter',
});

export const EDITOR_BACKEND_PROJECT_SCOPE = Object.freeze({
  WORKSPACE: '__editor_workspace__',
});

export const EDITOR_BACKEND_ACTION_NAME = Object.freeze({
  WORKERS_PROXY_ANNOUNCEMENT: 'workers_proxy.announcement',
  CHARACTERS_LIST: 'characters.list',
  CHARACTERS_GET: 'characters.get',
  CHARACTERS_CREATE: 'characters.create',
  CHARACTERS_UPDATE: 'characters.update',
  CHARACTERS_DELETE: 'characters.delete',
  MEDIA_UPLOAD: 'media.upload',
  MEDIA_LOCALIZE: 'media.localize',
  MEDIA_PERSIST_RESULT: 'media.persist_result',
  MEDIA_IMAGE_THUMBNAIL: 'media.image_thumbnail',
  MEDIA_VIDEO_THUMBNAIL: 'media.video_thumbnail',
  MEDIA_THUMBNAIL_REPORT_MISSING: 'media.thumbnail_report_missing',
  MEDIA_IMAGE_PROCESS: 'media.image_process',
  MEDIA_VIDEO_SPRITESHEET: 'media.video_spritesheet',
});

export const EDITOR_BACKEND_MEDIA_UPLOAD_MODE = Object.freeze({
  PROJECT_LOCAL: 'project_local',
  PUBLIC_RELAY: 'public_relay',
});

export const EDITOR_BACKEND_MEDIA_UPLOAD_TARGET_TYPE = PUBLIC_RELAY_TARGET_TYPE;

// ---------------------------------------------------------------------------
// MediaRefPlaceholder — 新协议（替代下方旧 token 协议）
// ---------------------------------------------------------------------------

export const MediaRefSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('inline_data'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    kind: z.literal('url'),
    url: z.string(),
  }),
]);

export type MediaRefSource = z.infer<typeof MediaRefSourceSchema>;

export const MEDIA_REF_TRANSPORT = Object.freeze({
  PUBLIC_URL: 'public_url',
  MULTIPART_FILE: 'multipart_file',
  INLINE_DATA: 'inline_data',
} as const);

export type MediaRefTransport =
  (typeof MEDIA_REF_TRANSPORT)[keyof typeof MEDIA_REF_TRANSPORT];

export const MediaRefPlaceholderSchema = z.object({
  __media_ref__: z.literal(true),
  source: MediaRefSourceSchema,
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  fieldPath: z.string().optional(),
  /** 媒体来源资产身份（提交面给出时随占位符一路带到序列化文件描述，供档案溯源）。 */
  assetId: z.string().optional(),
  /** 媒体来源素材位标识（产品级用途 id，提交面给出时同上）。 */
  slotId: z.string().optional(),
  transport: z.enum([
    MEDIA_REF_TRANSPORT.PUBLIC_URL,
    MEDIA_REF_TRANSPORT.MULTIPART_FILE,
    MEDIA_REF_TRANSPORT.INLINE_DATA,
  ]).optional(),
});

export type MediaRefPlaceholder = z.infer<typeof MediaRefPlaceholderSchema>;

export function isMediaRefPlaceholder(value: unknown): value is MediaRefPlaceholder {
  return MediaRefPlaceholderSchema.safeParse(value).success;
}


// ---------------------------------------------------------------------------
// SerializedFormData — 序列化 multipart/form-data 的标准结构
//
// 注意：运行时 body 中的 fields/files 数据可能是松散的（value 类型为 unknown、
// file 字段可能为 undefined）。Zod schema 反映运行时实际结构。
// isSerializedFormDataBody 只做顶层结构判断（存在 __formData 且有 fields 或
// files 数组），不做字段级深度校验。
// ---------------------------------------------------------------------------

export const SerializedFormDataFieldSchema = z.object({
  name: z.string(),
  value: z.unknown(),
});

/**
 * 序列化 multipart 文件条目。
 *
 * - `filename` / `contentType` 是**出网值**（multipart part 上的两个标签），发送链只读这两个字段；
 * - `sourceFilename` / `mimeType` / `assetId` / `slotId` 是**审计值**，由素材位占位符物化时带上，
 *   不参与发送。二者的存在意义：出网值历史上被统一成 `file` / `application/octet-stream`，
 *   档案若只看出网值就无法回答「发出去的是哪张资产、什么媒体类型」。
 */
export const SerializedFormDataFileSchema = z.object({
  name: z.string(),
  dataBase64: z.string().nullable(),
  contentType: z.string().nullable(),
  filename: z.string().nullable(),
  sourceFilename: z.string().optional(),
  mimeType: z.string().optional(),
  assetId: z.string().optional(),
  slotId: z.string().optional(),
});

export const SerializedFormDataSchema = z.object({
  fields: z.array(SerializedFormDataFieldSchema),
  files: z.array(SerializedFormDataFileSchema),
});

export const SerializedFormDataBodySchema = z.object({
  __formData: SerializedFormDataSchema,
});

export type SerializedFormDataField = z.infer<typeof SerializedFormDataFieldSchema>;
export type SerializedFormDataFile = z.infer<typeof SerializedFormDataFileSchema>;
export type SerializedFormData = z.infer<typeof SerializedFormDataSchema>;
export type SerializedFormDataBody = z.infer<typeof SerializedFormDataBodySchema>;

/**
 * 轻量级结构判断 schema：只验证 __formData 存在且至少有 fields 或 files 数组，
 * 不验证字段内部结构，以兼容中间态数据。
 */
const SerializedFormDataBodyStructureSchema = z.object({
  __formData: z.object({
    fields: z.array(z.unknown()).optional(),
    files: z.array(z.unknown()).optional(),
  }).refine((data) => Array.isArray(data.fields) || Array.isArray(data.files), {
    message: '__formData must have fields or files array',
  }),
});

/**
 * 判断 value 是否为序列化 FormData body。
 * 只做结构判断（存在 __formData 且有 fields 或 files 数组），
 * 不做字段级深度校验，以兼容中间态数据。
 */
export function isSerializedFormDataBody(value: unknown): value is SerializedFormDataBody {
  return SerializedFormDataBodyStructureSchema.safeParse(value).success;
}

export const normalizeEditorBackendActionClass = (
  value: unknown,
  fallback: EditorBackendActionClass | null = null,
): EditorBackendActionClass | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  return EDITOR_BACKEND_ACTION_CLASS_SET.has(normalized)
    ? (normalized as EditorBackendActionClass)
    : fallback;
};

export const isEditorBackendActionClass = (value: unknown): value is EditorBackendActionClass =>
  typeof value === 'string' && EDITOR_BACKEND_ACTION_CLASS_SET.has(value);

export const normalizeEditorBackendAsyncEvent = (
  value: unknown,
  fallback: EditorBackendAsyncEvent | null = null,
): EditorBackendAsyncEvent | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  return EDITOR_BACKEND_ASYNC_EVENT_SET.has(normalized)
    ? (normalized as EditorBackendAsyncEvent)
    : fallback;
};

export const isEditorBackendAsyncEvent = (value: unknown): value is EditorBackendAsyncEvent =>
  typeof value === 'string' && EDITOR_BACKEND_ASYNC_EVENT_SET.has(value);

export const normalizeEditorBackendIdentity = (value: unknown): EditorBackendIdentity => {
  const record = (value && typeof value === 'object' ? value : {}) as EditorBackendMessageView;
  return {
    projectPath: normalizeString(record.projectPath),
    nodeGraphId: normalizeString(record.nodeGraphId) || null,
    taskId: normalizeString(record.taskId) || null,
    remoteRequestId: normalizeString(record.remoteRequestId) || null,
  };
};

export const normalizeEditorBackendBusinessSubmit = (
  value: unknown,
  fallback: EditorBackendBusinessSubmitEnvelope | null = null,
): EditorBackendBusinessSubmitEnvelope | null => {
  if (!value || typeof value !== 'object') return fallback;
  const record = value as EditorBackendMessageView;
  const actionId = normalizeString(record.actionId);
  const actionName = normalizeString(record.actionName);
  const actionClass = normalizeEditorBackendActionClass(record.actionClass, null);
  const projectPath = normalizeString(record.projectPath);
  if (!actionId || !actionName || !actionClass || !projectPath) {
    return fallback;
  }
  return {
    type: EDITOR_BACKEND_MESSAGE_TYPE.SUBMIT,
    actionId,
    actionName,
    actionClass,
    projectPath,
    nodeGraphId: normalizeString(record.nodeGraphId) || null,
    payload: record.payload,
    requestedAt: normalizeString(record.requestedAt) || new Date().toISOString(),
  };
};

export const buildEditorBackendAsyncAck = (value: unknown): EditorBackendAsyncAckEnvelope => {
  const record = (value && typeof value === 'object' ? value : {}) as EditorBackendMessageView;
  const identity = normalizeEditorBackendIdentity(record);
  return {
    type: EDITOR_BACKEND_MESSAGE_TYPE.ACK,
    actionId: normalizeString(record.actionId),
    actionName: normalizeString(record.actionName),
    actionClass:
      normalizeEditorBackendActionClass(record.actionClass, EDITOR_BACKEND_ACTION_CLASS.BUSINESS_ASYNC)
      ?? EDITOR_BACKEND_ACTION_CLASS.BUSINESS_ASYNC,
    accepted: record.accepted !== false,
    projectPath: identity.projectPath,
    nodeGraphId: identity.nodeGraphId,
    taskId: identity.taskId,
    remoteRequestId: identity.remoteRequestId,
    emittedAt: Number.isFinite(record.emittedAt) ? Number(record.emittedAt) : Date.now(),
  };
};

export const buildEditorBackendBusinessResult = (value: unknown): EditorBackendBusinessResultEnvelope => {
  const record = (value && typeof value === 'object' ? value : {}) as EditorBackendMessageView;
  const normalizedNodeGraphId = normalizeString(record.nodeGraphId) || null;
  const errorRecord: EditorBackendErrorView | null = record.error && typeof record.error === 'object'
    ? record.error as EditorBackendErrorView
    : null;
  const normalizedError =
    errorRecord
      ? {
          code: normalizeString(errorRecord.code) || 'business_action_failed',
          message: normalizeString(errorRecord.message) || 'Business action failed',
        }
      : undefined;

  return {
    type: EDITOR_BACKEND_MESSAGE_TYPE.RESULT,
    actionId: normalizeString(record.actionId),
    actionName: normalizeString(record.actionName),
    actionClass:
      normalizeEditorBackendActionClass(record.actionClass, EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC)
      ?? EDITOR_BACKEND_ACTION_CLASS.BUSINESS_SYNC,
    projectPath: normalizeString(record.projectPath),
    nodeGraphId: normalizedNodeGraphId,
    result: record.result,
    error: normalizedError,
    emittedAt: Number.isFinite(record.emittedAt) ? Number(record.emittedAt) : Date.now(),
  };
};

export const isEditorDisplayMediaUrlLocal = (value: unknown): boolean =>
  normalizeString(value).startsWith(EDITOR_BACKEND_MEDIA_CONTRACT.localizedUrlPrefix);

export const normalizeEditorDisplayMediaUrl = (value: unknown, fallback: string | null = null): string | null => {
  const normalized = normalizeString(value);
  if (!normalized) return fallback;
  return isEditorDisplayMediaUrlLocal(normalized) ? normalized : fallback;
};

export const buildEditorLocalizedMediaDescriptor = (value: unknown = {}): EditorLocalizedMediaDescriptor => {
  const record = value && typeof value === 'object' ? value : {};
  const mediaRecord = record as {
    url: unknown | undefined;
    originalUrl: unknown | undefined;
    mediaType: unknown | undefined;
    mimeType: unknown | undefined;
    sizeBytes: unknown | undefined;
  };
  const localizedUrl = normalizeEditorDisplayMediaUrl(mediaRecord.url, null);
  return {
    owner: EDITOR_BACKEND_MEDIA_CONTRACT.owner,
    localized: Boolean(localizedUrl),
    url: localizedUrl,
    originalUrl: normalizeString(mediaRecord.originalUrl) || null,
    mediaType: normalizeString(mediaRecord.mediaType) || null,
    mimeType: normalizeString(mediaRecord.mimeType) || null,
    sizeBytes: Number.isFinite(mediaRecord.sizeBytes) ? Number(mediaRecord.sizeBytes) : null,
  };
};

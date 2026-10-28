import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloneJsonValue, buildAdapterAuthInjection, ExecutionSnapshotSchema } from '@iart/contracts';
import type { AdapterAuthInjection, RuntimeMediaAssetRow, RuntimeTaskOutputRow } from '@iart/contracts';
import mediaFileKeyModule = require('@iart/utils/media-file-key');
import * as loggingModule from './logging.cts';
import * as storageModule from './storage.cts';
import * as mediaDownloadModule from './media-download.cts';
import { coercePcmToWavIfNeeded, type MimeTypeParams } from './audio-pcm-wav-wrapping.cts';
import { deriveContentAddressedAssetId } from './media-asset-id.cts';
import * as projectMediaScopeModule from './project-media-scope.cts';
import * as taskEngineModule from './task-engine.cts';
import * as taskResultOutputMappingModule from './task-result-output-mapping.cts';
import * as taskRecordViewModule from './task-record-view.cts';
import * as mediaAssetRegistryModule from './media-asset-registry.cts';
import { resolveSnapshotAuth } from './provider-connection/snapshot-protocol.cts';
import { acquireLease, releaseLease } from './provider-connection/credential-store.cts';
import type { DownloadResult } from './media-download.cts';
import { toRecord } from './task-engine-shared.cts';


type DownloadOptions = {
  source: string | undefined;
  abortSignal: AbortSignal | undefined;
  headers: Record<string, string> | undefined;
  /** 查询参数形态的鉴权；由下载模块拼到 fetch 地址副本，不进日志/记录。 */
  authQuery?: { name: string; value: string } | null;
  mediaDir: string | undefined;
  projectRef: string | undefined;
};

type DynamicJsonObject = Record<string, unknown>;
type DownloadFailure = {
  error: unknown;
};
type MediaDownloadRaw = DynamicJsonObject & {
  candidates: unknown | undefined;
};
type TaskResponseRaw = DynamicJsonObject & {
  body: unknown | undefined;
  mediaDownload: unknown | undefined;
  localOutput: unknown | undefined;
  localOutputs: unknown | undefined;
  outputs: unknown | undefined;
};
type TaskRecordRaw = DynamicJsonObject & {
  taskId: unknown | undefined;
  id: unknown | undefined;
  metadata: unknown | undefined;
  projectPath: unknown | undefined;
  response: unknown | undefined;
  createdAt: unknown | undefined;
  request: unknown | undefined;
  startedAt: unknown | undefined;
  finishedAt: unknown | undefined;
};
type LocalTaskOutputRaw = DynamicJsonObject & {
  url: unknown | undefined;
  mediaType: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
  sourceUrl: unknown | undefined;
  downloadedAt: unknown | undefined;
  textValue: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  durationMs: unknown | undefined;
  assetId: unknown | undefined;
  fileKey: unknown | undefined;
  projectRef: unknown | undefined;
};
type RuntimeMediaRows = {
  taskOutputs: RuntimeTaskOutputRow[];
  mediaAssets: RuntimeMediaAssetRow[];
};
type LocalTaskOutput = {
  url: string | null | undefined;
  mediaType: string;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
  sourceUrl: string | null | undefined;
  downloadedAt: string | null | undefined;
  textValue: string | null | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  durationMs: unknown | undefined;
  assetId: string | undefined;
  fileKey: string | null | undefined;
  projectRef: string | null | undefined;
};

const { ensureProjectFolderDirs, isValidProjectFolder } = storageModule;
const { downloadRemoteMediaToFiles } = mediaDownloadModule;
const { registerRuntimeProjectScope, resolveProjectMediaFilePath, resolveLocalMediaUrl } = projectMediaScopeModule;
const {
  patchTaskRecord,
  patchTaskRecordWithOutputs,
  appendTaskArchiveEventSafely,
  summarizeArchiveResponse,
} = taskEngineModule;
const { extractMappedTaskOutputs, hasResultOutputMapping } = taskResultOutputMappingModule;
const { readTaskRecordId, readResultOutputMapping } = taskRecordViewModule;
const { repairProjectMediaAssetThumbnail } = mediaAssetRegistryModule;

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';
const cloneValue = <T,>(value: T): T => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};
const isPlainObject = (value: unknown): value is DynamicJsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
};
const readObjectField = (value: DynamicJsonObject, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
// 记录级投影只剥大载荷（response.body 由 buildLocalizedTaskResponse 置 null 释放内存），
// 小体量元数据字段必须原样带过：createdAt（受理时刻）/ request（受理时摘要化的请求）/
// startedAt / finishedAt（执行真实时刻）——物化链以本投影产物为基底做终态 patch 与整行
// INSERT OR REPLACE，剥掉这些字段会把受理时刻回落成物化时刻、请求摘要洗成 null（v0.6.10 实锤）。
const asTaskRecordRaw = (value: unknown): TaskRecordRaw => {
  if (!isPlainObject(value)) {
    return {
      taskId: undefined,
      id: undefined,
      metadata: undefined,
      projectPath: undefined,
      response: undefined,
      createdAt: undefined,
      request: undefined,
      startedAt: undefined,
      finishedAt: undefined,
    };
  }
  return {
    taskId: readObjectField(value, 'taskId'),
    id: readObjectField(value, 'id'),
    metadata: readObjectField(value, 'metadata'),
    projectPath: readObjectField(value, 'projectPath'),
    response: readObjectField(value, 'response'),
    createdAt: readObjectField(value, 'createdAt'),
    request: readObjectField(value, 'request'),
    startedAt: readObjectField(value, 'startedAt'),
    finishedAt: readObjectField(value, 'finishedAt'),
  };
};
const asTaskResponseRaw = (value: unknown): TaskResponseRaw => {
  if (!isPlainObject(value)) {
    return {
      body: undefined,
      mediaDownload: undefined,
      localOutput: undefined,
      localOutputs: undefined,
      outputs: undefined,
    };
  }
  return {
    body: readObjectField(value, 'body'),
    mediaDownload: readObjectField(value, 'mediaDownload'),
    localOutput: readObjectField(value, 'localOutput'),
    localOutputs: readObjectField(value, 'localOutputs'),
    outputs: readObjectField(value, 'outputs'),
  };
};
const asMediaDownloadRaw = (value: unknown): MediaDownloadRaw => {
  if (!isPlainObject(value)) return { candidates: undefined };
  return { candidates: readObjectField(value, 'candidates') };
};
const asLocalTaskOutputRaw = (value: unknown): LocalTaskOutputRaw => {
  if (!isPlainObject(value)) {
    return {
      url: undefined,
      mediaType: undefined,
      mimeType: undefined,
      sizeBytes: undefined,
      sourceUrl: undefined,
      downloadedAt: undefined,
      textValue: undefined,
      width: undefined,
      height: undefined,
      durationMs: undefined,
      assetId: undefined,
      fileKey: undefined,
      projectRef: undefined,
    };
  }
  return {
    url: readObjectField(value, 'url'),
    mediaType: readObjectField(value, 'mediaType'),
    mimeType: readObjectField(value, 'mimeType'),
    sizeBytes: readObjectField(value, 'sizeBytes'),
    sourceUrl: readObjectField(value, 'sourceUrl'),
    downloadedAt: readObjectField(value, 'downloadedAt'),
    textValue: readObjectField(value, 'textValue'),
    width: readObjectField(value, 'width'),
    height: readObjectField(value, 'height'),
    durationMs: readObjectField(value, 'durationMs'),
    assetId: readObjectField(value, 'assetId'),
    fileKey: readObjectField(value, 'fileKey'),
    projectRef: readObjectField(value, 'projectRef'),
  };
};
const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : normalizeString(error) || fallback;
const normalizeNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
const decodeUrlSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const extractRuntimeFileKey = (fileUrl: unknown) => {
  const normalizedUrl = normalizeString(fileUrl);
  if (!normalizedUrl) return null;
  // 主路径：local-media:// 复用统一解析器（获得 V2 spid_ 支持与 scope 校验）
  if (normalizedUrl.startsWith('local-media://')) {
    return mediaFileKeyModule.extractMediaFileKey(normalizedUrl);
  }
  // 历史兼容：/files/ 与 /project-media/ 仅读取端保留（按 spec，写入端已禁止产出）。
  // 此分支待 task 历史输出全部迁移到 local-media:// 后可移除，迁移触发条件见
  // docs/runtime/运行时媒体渲染地址协议契约.md 的 deprecated 标注。
  if (normalizedUrl.startsWith('/files/')) {
    const raw = normalizedUrl.slice('/files/'.length);
    return raw ? decodeUrlSegment(raw) : null;
  }
  try {
    const parsed = new URL(normalizedUrl, 'http://localhost');
    if (parsed.pathname.startsWith('/files/')) {
      const raw = parsed.pathname.slice('/files/'.length);
      return raw ? decodeUrlSegment(raw) : null;
    }
    if (parsed.pathname.startsWith('/project-media/')) {
      const rest = parsed.pathname.slice('/project-media/'.length);
      const slashIndex = rest.indexOf('/');
      const raw = slashIndex >= 0 ? rest.slice(slashIndex + 1) : '';
      return raw ? decodeUrlSegment(raw) : null;
    }
  } catch {
    // ignore
  }
  return null;
};
const isDownloadedMedia = (value: unknown): value is DownloadResult => {
  if (!isPlainObject(value)) return false;
  const media = asLocalTaskOutputRaw(value);
  return typeof media.url === 'string' &&
    typeof media.fileKey === 'string' &&
    typeof media.mediaType === 'string' &&
    typeof media.mimeType === 'string' &&
    typeof media.sizeBytes === 'number';
};
const isDownloadFailure = (value: unknown): value is DownloadFailure =>
  isPlainObject(value) && 'error' in value;
const normalizeLocalTaskOutput = (value: unknown): LocalTaskOutput | null => {
  const output = asLocalTaskOutputRaw(value);
  const mediaType = normalizeString(output.mediaType);
  const textValue = typeof output.textValue === 'string' ? output.textValue : null;
  if (!mediaType) return null;
  if (mediaType === 'text') {
    return textValue ? { mediaType, textValue, url: null, mimeType: null, sizeBytes: null, sourceUrl: null, downloadedAt: null, width: undefined, height: undefined, durationMs: undefined, assetId: undefined, fileKey: undefined, projectRef: undefined } : null;
  }
  const url = normalizeString(output.url);
  const sourceUrl = normalizeString(output.sourceUrl);
  const downloadedAt = normalizeString(output.downloadedAt);
  const fileKey = normalizeString(output.fileKey) || extractRuntimeFileKey(url);
  const projectRef = normalizeString(output.projectRef);
  if (!url || !fileKey || !sourceUrl || !downloadedAt) return null;
  const normalized: LocalTaskOutput = {
    url,
    fileKey,
    projectRef: projectRef || null,
    mediaType,
    mimeType: normalizeString(output.mimeType) || null,
    sizeBytes: normalizeNumber(output.sizeBytes),
    sourceUrl,
    downloadedAt,
    textValue,
    width: output.width,
    height: output.height,
    durationMs: output.durationMs,
    assetId: normalizeString(output.assetId) || undefined,
  };
  const assetId = normalizeString(output.assetId);
  if (assetId) normalized.assetId = assetId;
  return normalized;
};
const normalizeLocalTaskOutputs = (value: unknown): LocalTaskOutput[] | null => {
  if (!Array.isArray(value)) return null;
  const outputs: LocalTaskOutput[] = [];
  for (const item of value) {
    const output = normalizeLocalTaskOutput(item);
    if (!output) return null;
    outputs.push(output);
  }
  return outputs;
};
const computeFileContentHash = (filePath: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(filePath)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolve(hash.digest('hex')))
    .on('error', reject);
});
const buildRuntimeMediaRows = async (
  taskRecordInput: unknown,
  localOutputs: LocalTaskOutput[],
): Promise<RuntimeMediaRows> => {
  const taskRecord = asTaskRecordRaw(taskRecordInput);
  const now = Date.now();
  const taskId = readTaskRecordId(taskRecord);
  const projectPath = normalizeString(taskRecord.projectPath);
  const registeredProject = registerRuntimeProjectScope(projectPath);
  const projectRef = (registeredProject !== null && registeredProject !== undefined ? registeredProject.projectRef : undefined) ?? null;
  if (!projectRef) throw new Error('Missing project media scope for runtime transaction');
  const taskOutputs: RuntimeTaskOutputRow[] = [];
  const mediaAssets: RuntimeMediaAssetRow[] = [];
  for (let index = 0; index < localOutputs.length; index++) {
    const output = localOutputs[index];
    if (!output) continue;
    const mediaType = normalizeString(output.mediaType);
    if (mediaType === 'text') {
      const textValue = normalizeString(output.textValue);
      if (!textValue) throw new Error('Missing text value for runtime task output');
      taskOutputs.push({ outputId: `${taskId}:output:${index}`, taskId, mediaType, assetId: null, textValue, sortOrder: index });
      continue;
    }
    const fileKey = normalizeString(output.fileKey) || extractRuntimeFileKey(output.url);
    const resolvedFile = fileKey ? resolveProjectMediaFilePath(projectRef, fileKey) : null;
    if (!mediaType || !resolvedFile || !resolvedFile.ok || !fs.existsSync(resolvedFile.filePath)) {
      throw new Error(`Missing localized media file for runtime transaction: ${String(output.url || '')}`);
    }
    const filePath = resolvedFile.filePath;
    const projectMediaUrl = resolveLocalMediaUrl(projectRef, resolvedFile.fileKey);
    const contentHash = await computeFileContentHash(filePath);
    const assetId = deriveContentAddressedAssetId(mediaType, contentHash);
    taskOutputs.push({
      outputId: `${taskId}:output:${index}`,
      taskId,
      mediaType,
      assetId,
      textValue: typeof output.textValue === 'string' ? output.textValue : null,
      sortOrder: index,
    });
    mediaAssets.push({
      assetId,
      mediaType,
      payloadJson: JSON.stringify({
        original: {
          url: projectMediaUrl,
          projectRef,
          fileKey: resolvedFile.fileKey,
          sourceUrl: normalizeString(output.sourceUrl) || null,
          sizeBytes: normalizeNumber(output.sizeBytes),
          mimeType: normalizeString(output.mimeType) || null,
          width: normalizeNumber(output.width),
          height: normalizeNumber(output.height),
          durationMs: normalizeNumber(output.durationMs),
        },
        thumbnail: { url: null, mimeType: null, width: null, height: null, status: 'missing', generatedAt: null, error: null },
      }),
      createdAt: now,
      updatedAt: now,
    });
    output.assetId = assetId;
    output.projectRef = projectRef;
    if (resolvedFile.ok) {
      output.fileKey = resolvedFile.fileKey;
    }
    output.url = projectMediaUrl;
  }
  return { taskOutputs, mediaAssets };
};
const buildDownloadOptions = (taskId: string, mediaDir: string | null, controller: AbortController | undefined, projectRefValue: string | null, injection: AdapterAuthInjection | null): DownloadOptions => {
  const options: DownloadOptions = { source: `task:${taskId}`, mediaDir: undefined, abortSignal: undefined, headers: undefined, projectRef: undefined };
  if (mediaDir) options.mediaDir = mediaDir;
  if (controller) options.abortSignal = controller.signal;
  if (projectRefValue) options.projectRef = projectRefValue;
  if (injection?.kind === 'header') options.headers = { [injection.name]: injection.value };
  if (injection?.kind === 'query') options.authQuery = { name: injection.name, value: injection.value };
  return options;
};

type DownloadAuthResolution =
  | { ok: true; injection: AdapterAuthInjection | null; release: () => void }
  | { ok: false; code: string; message: string };

/**
 * 结果下载鉴权头（`result_output_mapping.requires_auth`）。
 *
 * 凭证读取只走 credential-store 租约：物化发生在轮询租约释放之后，因此这里按任务冻结的
 * ExecutionSnapshot 重新 acquire 一个租约，下载全部结束后释放。明文只参与请求头构造，
 * 不写任务记录、不进日志、不进失败 payload。
 */
/** ExecutionSnapshot 在任务 metadata 上的候选键（固定字段禁止字面量下标访问，按键遍历读取）。 */
const SNAPSHOT_METADATA_KEYS = ['executionSnapshot', 'execution_snapshot'] as const;

const resolveDownloadAuth = async (taskRecordInput: unknown): Promise<DownloadAuthResolution> => {
  const mapping = readResultOutputMapping(taskRecordInput);
  if (mapping === null || mapping.requires_auth !== true) {
    return { ok: true, injection: null, release: () => undefined };
  }
  const taskRecord = asTaskRecordRaw(taskRecordInput);
  const metadata = isPlainObject(taskRecord.metadata) ? taskRecord.metadata : {};
  let snapshotRaw: unknown;
  for (const key of SNAPSHOT_METADATA_KEYS) {
    const candidate: unknown = metadata[key];
    if (candidate !== undefined) {
      snapshotRaw = candidate;
      break;
    }
  }
  const parsed = ExecutionSnapshotSchema.safeParse(snapshotRaw);
  if (!parsed.success) {
    loggingModule.logDebug('[task-result-materializer] requires_auth but execution snapshot invalid', {
      taskId: readTaskRecordId(taskRecord),
      error: parsed.error.message,
    });
    return {
      ok: false,
      code: 'credential_missing',
      message: '结果地址需要鉴权，但任务缺少可用的接入信息，请重新提交任务',
    };
  }
  const snapshot = parsed.data;
  if (!snapshot.credential_ref) {
    loggingModule.logDebug('[task-result-materializer] requires_auth but credential_ref missing', {
      taskId: readTaskRecordId(taskRecord),
      connectionId: snapshot.connection_id,
    });
    return {
      ok: false,
      code: 'credential_missing',
      message: '结果地址需要鉴权，但这条连接没有可用凭证，请先在设置里补充 API Key 后重新提交任务',
    };
  }
  const auth = resolveSnapshotAuth(snapshot);
  if (!auth) {
    loggingModule.logDebug('[task-result-materializer] requires_auth but protocol unresolved', {
      taskId: readTaskRecordId(taskRecord),
      snapshotId: snapshot.snapshot_id,
    });
    return {
      ok: false,
      code: 'credential_missing',
      message: '结果地址需要鉴权，但认不出这个模型使用的接口格式，请重新提交任务',
    };
  }
  const lease = await acquireLease({
    connectionId: snapshot.connection_id,
    credentialRef: snapshot.credential_ref,
    credentialVersion: snapshot.credential_version ?? 0,
    connectionRevision: snapshot.connection_revision,
  });
  if (!lease) {
    loggingModule.logDebug('[task-result-materializer] requires_auth but credential lease unavailable', {
      taskId: readTaskRecordId(taskRecord),
      connectionId: snapshot.connection_id,
    });
    return {
      ok: false,
      code: 'credential_missing',
      message: '结果地址需要鉴权，但没能读取到这条连接的凭证，请检查设置后重新提交任务',
    };
  }
  const header = buildAdapterAuthInjection(auth, lease.value);
  return {
    ok: true,
    injection: header,
    release: () => {
      try {
        releaseLease(lease.lease.leaseId);
      } catch { void 0; }
    },
  };
};
const EXT_BY_INLINE_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
};
const parseDataUrl = (value: unknown) => {
  const raw = normalizeString(value);
  const match = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/i.exec(raw);
  if (!match) return null;
  const mimeType = normalizeString(match[1]) || 'application/octet-stream';
  const parameters = normalizeString(match[2]).toLowerCase();
  const payload = match[3] ?? '';
  if (!payload) return null;
  try {
    const buffer = parameters.includes(';base64')
      ? Buffer.from(payload.replace(/\s+/g, ''), 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (buffer.length === 0) return null;
    // 解析 mimeType 参数（如 audio/l16; rate=24000; channels=1），用于裸 PCM 补 WAV 头。
    // 只提取 PCM 封装需要的固定字段（rate / channels），其余参数当前不消费。
    let rate: string | undefined;
    let channels: string | undefined;
    for (const segment of parameters.split(';')) {
      const trimmed = segment.trim();
      if (!trimmed || trimmed === 'base64') continue;
      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex <= 0) continue;
      const key = trimmed.slice(0, equalsIndex).trim();
      const paramValue = trimmed.slice(equalsIndex + 1).trim();
      if (!key || !paramValue) continue;
      if (key === 'rate') rate = paramValue;
      else if (key === 'channels') channels = paramValue;
    }
    const params: MimeTypeParams = { rate, channels };
    return { buffer, mimeType, params };
  } catch {
    return null;
  }
};
const persistInlineMediaToFiles = (
  dataUrl: string,
  mediaType: string,
  mediaDir: string,
): DownloadResult | { error: { code: string; message: string } } => {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return { error: { code: 'invalid_data_url', message: 'Invalid data URL' } };
  fs.mkdirSync(mediaDir, { recursive: true });
  const normalizedMime = (parsed.mimeType.split(';')[0] || '').trim().toLowerCase() || 'application/octet-stream';
  // Gemini TTS 返回裸 PCM（audio/l16），必须补 WAV 头，否则播放器无法识别。
  // 补头后 mime 归一为 audio/wav，扩展名为 .wav，保证扩展名/容器/内容三者一致。
  const coerced = coercePcmToWavIfNeeded(parsed.buffer, normalizedMime, parsed.params);
  const ext = EXT_BY_INLINE_MIME[coerced.mimeType] || '.bin';
  const digest = crypto.createHash('sha256').update(coerced.buffer).digest('hex');
  const filename = `${digest}${ext}`;
  const targetPath = path.join(mediaDir, filename);
  if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, coerced.buffer);
  return {
    url: `/files/${encodeURIComponent(filename)}`,
    fileKey: filename,
    sizeBytes: coerced.buffer.length,
    mimeType: coerced.mimeType,
    mediaType,
  };
};

// 物化成功后的 response 组装。body 在此被置 null：物化成功后 body 已无下游消费者
// （inline 媒体已解码落盘为 media 文件、outputs 已组装入库），而 body 可能含数 MB
// base64 内联媒体，置 null 释放内存驻留，避免长会话大批量任务时 body 在 record 中
// 全量累积（media 文件是唯一持久副本，无双份存储）。
// 注意：物化失败路径不经过这里，失败 record 仍保留 body 供排查。
const buildLocalizedTaskResponse = (params: {
  response: TaskResponseRaw;
  localOutputs: LocalTaskOutput[];
  mediaCandidates: string[];
}): TaskResponseRaw => {
  const responseMediaDownload = asMediaDownloadRaw(params.response.mediaDownload);
  return {
    ...params.response,
    body: null,
    localOutput: params.localOutputs.length === 1 ? params.localOutputs[0] : null,
    localOutputs: params.localOutputs,
    outputs: params.localOutputs,
    mediaDownload: params.mediaCandidates.length > 0
      ? { ...responseMediaDownload, phase: 'stored', candidates: params.mediaCandidates, attempts: 1, nextAttemptAt: null, lastError: null, succeededAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      : params.response.mediaDownload,
  };
};

async function executeTaskResultMaterialization(
  taskRecordInput: unknown,
  controller: AbortController | undefined,
): Promise<LocalTaskOutput[]> {
  const taskRecord = asTaskRecordRaw(taskRecordInput);
  const taskId = readTaskRecordId(taskRecord);
  if (!taskId) throw new Error('Missing taskId');
  if (!hasResultOutputMapping(taskRecord)) throw new Error('Missing result output mapping');
  const projectPath = normalizeString(taskRecord.projectPath);
  if (!projectPath || !isValidProjectFolder(projectPath)) throw new Error('Missing project path for task result materialization');
  const response = asTaskResponseRaw(taskRecord.response);
  const mappedOutputs = extractMappedTaskOutputs({ taskRecord, responseBody: response.body });
  if (mappedOutputs.length === 0) {
    const failurePatch = toRecord({
      status: 'failed',
      finishedAt: Date.now(),
      error: { code: 'result_output_mapping_missed', message: '结果输出映射未命中正式输出', stage: 'result_mapping' },
      progress: { phase: null },
    });
    const failed = await patchTaskRecord(taskRecord, failurePatch);
    appendTaskArchiveEventSafely(failed, 'task.result_output_mapping_failed', { phase: 'result_output_mapping_failed', reason: 'output_mapping_rules_missed' }, '[task-result-materializer] Failed to write result_output_mapping_failed archive event:');
    throw new Error('Result output mapping did not produce formal outputs');
  }

  const mediaCandidates = mappedOutputs
    .filter((output) => output.mediaType !== 'text')
    .map((output) => normalizeString(output.url))
    .filter(Boolean);
  const projectDirs = ensureProjectFolderDirs(projectPath);
  const mediaDir = mediaCandidates.length > 0 ? (projectDirs ? projectDirs.media : null) : null;
  if (mediaCandidates.length > 0 && !mediaDir) throw new Error('Missing project media dir');

  const registeredProjectForDownload = registerRuntimeProjectScope(projectPath);
  const projectRefForDownload = (registeredProjectForDownload !== null && registeredProjectForDownload !== undefined ? registeredProjectForDownload.projectRef : undefined) ?? null;

  // 结果地址需要鉴权时，下载前取得与提交同源的鉴权头；取不到凭证必须收口失败，
  // 不得静默退化成无鉴权请求（否则上游 401 会被误报成普通下载失败）。
  let downloadAuthInjection: AdapterAuthInjection | null = null;
  let releaseDownloadAuth: () => void = () => undefined;
  if (mediaCandidates.length > 0) {
    const authResolution = await resolveDownloadAuth(taskRecord);
    if (!authResolution.ok) {
      await patchTaskRecord(taskRecord, toRecord({
        status: 'failed',
        finishedAt: Date.now(),
        error: { code: authResolution.code, message: authResolution.message, stage: 'download' },
        progress: { phase: null },
      }));
      throw new Error(authResolution.message);
    }
    downloadAuthInjection = authResolution.injection;
    releaseDownloadAuth = authResolution.release;
  }

  const responseMediaDownload = asMediaDownloadRaw(response.mediaDownload);
  let currentRecord: unknown = taskRecord;
  if (mediaCandidates.length > 0) {
    const downloadPhasePatch = toRecord({
      status: 'downloading',
      response: {
        ...response,
        mediaDownload: { ...responseMediaDownload, phase: 'fetching', candidates: mediaCandidates, attempts: 1, lastAttemptAt: new Date().toISOString(), nextAttemptAt: null, lastError: null, updatedAt: new Date().toISOString() },
      },
      progress: { phase: 'downloading' },
    });
    currentRecord = await patchTaskRecord(taskRecord, downloadPhasePatch);
  }

  const localOutputs: LocalTaskOutput[] = [];
  try {
    for (const output of mappedOutputs) {
      if (output.mediaType === 'text') {
        const textValue = normalizeString(output.textValue);
        if (textValue) localOutputs.push({ mediaType: 'text', textValue, url: null, mimeType: null, sizeBytes: null, sourceUrl: null, downloadedAt: null, width: undefined, height: undefined, durationMs: undefined, assetId: undefined, fileKey: undefined, projectRef: undefined });
        continue;
      }
      const candidateUrl = normalizeString(output.url);
      if (!candidateUrl) continue;
      const stored = /^data:/i.test(candidateUrl)
        ? persistInlineMediaToFiles(candidateUrl, output.mediaType, mediaDir ?? '')
        : await downloadRemoteMediaToFiles(candidateUrl, buildDownloadOptions(taskId, mediaDir, controller, projectRefForDownload, downloadAuthInjection)) as DownloadResult | { error: { code: string; message: string } } | null;
      if (isDownloadedMedia(stored)) {
        const registeredProject = registerRuntimeProjectScope(projectPath);
        const projectRef = (registeredProject !== null && registeredProject !== undefined ? registeredProject.projectRef : undefined) ?? null;
        const fileKey = normalizeString(stored.fileKey) || extractRuntimeFileKey(stored.url);
        const url = (projectRef && fileKey ? resolveLocalMediaUrl(projectRef, fileKey) : null) ?? stored.url;
        localOutputs.push({ url, fileKey, projectRef, mediaType: output.mediaType || stored.mediaType, mimeType: stored.mimeType || null, sizeBytes: stored.sizeBytes || null, sourceUrl: /^data:/i.test(candidateUrl) ? 'inline_data' : candidateUrl, downloadedAt: new Date().toISOString(), textValue: null, width: undefined, height: undefined, durationMs: undefined, assetId: undefined });
        continue;
      }
      const storedError = isDownloadFailure(stored) ? stored.error : { code: 'download_failed', message: 'No candidate downloaded' };
      const errorPayload = { ...(isPlainObject(storedError) ? storedError : { message: String(storedError) }), url: candidateUrl };
      const errorMessage = normalizeString(readObjectField(errorPayload, 'message')) || 'No candidate downloaded';
      const downloadFailurePatch = toRecord({
        status: 'failed',
        finishedAt: Date.now(),
        error: {
          code: normalizeString(readObjectField(errorPayload, 'code')) || 'download_failed',
          message: errorMessage,
          stage: 'download',
        },
        response: { ...response, mediaDownload: { ...responseMediaDownload, phase: 'blocked', candidates: mediaCandidates, attempts: 1, nextAttemptAt: null, lastError: cloneValue(errorPayload), updatedAt: new Date().toISOString() } },
        progress: { phase: null },
      });
      await patchTaskRecord(currentRecord, downloadFailurePatch);
      throw new Error(errorMessage);
    }
  } finally {
    releaseDownloadAuth();
  }

  if (localOutputs.length === 0) {
    const emptyOutputPatch = toRecord({
      status: 'failed',
      finishedAt: Date.now(),
      error: { code: 'result_output_mapping_empty', message: '结果输出映射未生成可入库输出', stage: 'result_mapping' },
      progress: { phase: null },
    });
    await patchTaskRecord(currentRecord, emptyOutputPatch);
    throw new Error('Result output mapping produced no materialized outputs');
  }

  const localizedResponse: TaskResponseRaw = buildLocalizedTaskResponse({
    response,
    localOutputs,
    mediaCandidates,
  });
  const { taskOutputs, mediaAssets } = await buildRuntimeMediaRows({ ...asTaskRecordRaw(currentRecord), response: localizedResponse }, localOutputs);
  if (taskOutputs.length === 0) throw new Error('Missing runtime task outputs');
  for (const output of taskOutputs.filter((item) => item.mediaType !== 'text')) {
    const assetId = normalizeString(output.assetId);
    if (!assetId || !mediaAssets.some((asset) => asset.assetId === assetId)) throw new Error(`Missing media asset for task output: ${output.outputId}`);
  }

  let succeededRecord: unknown = currentRecord;
  try {
    succeededRecord = await patchTaskRecordWithOutputs(
      currentRecord,
      { status: 'succeeded', finishedAt: Date.now(), error: null, response: localizedResponse, progress: { phase: 'completed', percent: 100 } },
      { taskOutputs, mediaAssets },
    );
  } catch (error) {
    try {
      const runtimeFailurePatch = toRecord({
        status: 'failed',
        finishedAt: Date.now(),
        error: { code: 'runtime_transaction_failed', message: getErrorMessage(error, 'Unexpected error') },
        progress: { phase: null },
      });
      await patchTaskRecord(currentRecord, runtimeFailurePatch);
    } catch (patchError) {
      loggingModule.logWarn('[task-result-materializer] Failed to mark runtime transaction failure:', { error: getErrorMessage(patchError, 'patchTaskRecord failed') });
    }
    throw error;
  }

  for (const asset of mediaAssets) {
    if (asset.mediaType !== 'image' && asset.mediaType !== 'video') continue;
    repairProjectMediaAssetThumbnail(projectPath, { assetId: asset.assetId, mediaType: asset.mediaType, maxEdge: undefined, quality: undefined, width: undefined, timeSec: undefined })
      .catch((repairError: unknown) => {
        loggingModule.logWarn('[task-result-materializer] Async thumbnail repair failed for asset', { assetId: asset.assetId, error: getErrorMessage(repairError, 'Unknown error') });
      });
  }

  const succeededResponse = asTaskResponseRaw(asTaskRecordRaw(succeededRecord).response);
  appendTaskArchiveEventSafely(
    succeededRecord,
    'task.result_materialized',
    { phase: 'result_materialized', outputs: (() => { const summary = summarizeArchiveResponse(succeededResponse); return summary ? summary.localOutputs : undefined; })() },
    '[task-result-materializer] Failed to write result_materialized archive event:',
  );
  return normalizeLocalTaskOutputs(succeededResponse.localOutputs) ?? localOutputs;
}

export {
  type LocalTaskOutput,
  buildRuntimeMediaRows,
  buildLocalizedTaskResponse,
  executeTaskResultMaterialization,
};

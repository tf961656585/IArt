import type { ProjectMediaAssets, MediaAsset, MediaAssetOriginal, MediaAssetThumbnail, MediaAssetThumbnailError, ProjectMediaType, RuntimeRef } from '@iart/contracts';
import { normalizeNodeGraph } from './project-graph.cts';

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeFiniteNumber = <TFallback = null,>(
  value: unknown,
  fallback: TFallback = null as TFallback,
): number | TFallback => (Number.isFinite(value) ? Number(value) : fallback);

const normalizeMediaType = (value: unknown): ProjectMediaType | null => {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'image' || normalized === 'video' || normalized === 'audio') {
    return normalized;
  }
  return null;
};

type DynamicValueMap = object;

type ProjectNodeGraph = object & {
  nodes: unknown | undefined;
};

type ProjectNode = object & {
  type: unknown | undefined;
  data: unknown | undefined;
};

type ResultAreaData = object & {
  items: unknown | undefined;
};

type ResultAreaItem = {
  id: unknown | undefined;
  targetKey: unknown | undefined;
  itemType: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
  expectedAspectRatio: unknown | undefined;
  errorDetails: unknown | undefined;
  runtimeRef: unknown | undefined;
  assetId: unknown | undefined;
  textValue: unknown | undefined;
};

type RuntimeRefInput = {
  taskId: unknown | undefined;
  resultId: unknown | undefined;
  assetId: unknown | undefined;
};

type RuntimeData = object & {
  runtimeRef: unknown | undefined;
};

type ProjectDocumentInput = {
  nodeGraph: unknown | undefined;
  mediaAssets: unknown | undefined;
};

type RawMediaAsset = {
  id: unknown | undefined;
  mediaType: unknown | undefined;
  original: RawMediaAssetOriginal | undefined;
  thumbnail: RawMediaAssetThumbnail | undefined;
  lifecycle: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
};

type RawMediaAssetOriginal = {
  url: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  durationMs: unknown | undefined;
};

type RawMediaAssetThumbnail = {
  url: unknown | undefined;
  mimeType: unknown | undefined;
  width: unknown | undefined;
  height: unknown | undefined;
  status: unknown | undefined;
  generatedAt: unknown | undefined;
  error: RawMediaAssetThumbnailError | undefined;
};

type RawMediaAssetThumbnailError = {
  code: unknown | undefined;
  message: unknown | undefined;
  failedAt: unknown | undefined;
};

const isObjectRecord = (value: unknown): value is DynamicValueMap =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeProjectNodeGraph = normalizeNodeGraph as (raw: unknown) => unknown;

const readRawMediaAsset = (value: unknown): RawMediaAsset | null => {
  if (!isObjectRecord(value)) return null;
  const raw = value as RawMediaAsset;
  const original = isObjectRecord(raw.original) ? raw.original : undefined;
  const thumbnail = isObjectRecord(raw.thumbnail) ? raw.thumbnail : undefined;
  const result: RawMediaAsset = {
    id: raw.id,
    mediaType: raw.mediaType,
    lifecycle: raw.lifecycle,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  } as RawMediaAsset;
  if (original) result.original = original;
  if (thumbnail) result.thumbnail = thumbnail;
  return result;
};

const normalizeMediaAsset = (rawValue: unknown): MediaAsset | null => {
  const raw = readRawMediaAsset(rawValue);
  if (!raw) {
    throw new Error('invalid-media-asset-record');
  }
  const id = normalizeString(raw.id);
  const mediaType = normalizeMediaType(raw.mediaType);
  const originalRaw = raw.original;
  if (!id || !mediaType || !originalRaw) {
    throw new Error('invalid-media-asset-record');
  }

  const originalUrl = normalizeString(originalRaw.url);
  if (!originalUrl) {
    throw new Error('invalid-media-asset-record');
  }

  const thumbnailRaw: RawMediaAssetThumbnail = raw.thumbnail ?? ({} as RawMediaAssetThumbnail);
  const createdAt = normalizeFiniteNumber(raw.createdAt, Date.now()) ?? Date.now();
  const updatedAt = normalizeFiniteNumber(raw.updatedAt, createdAt) ?? createdAt;
  const thumbnailStatus = normalizeString(thumbnailRaw.status).toLowerCase();

  const original: MediaAssetOriginal = {
    url: originalUrl,
    projectRef: null,
    fileKey: null,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: normalizeString(originalRaw.mimeType) || null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    fps: null,
  };
  const sizeBytes = normalizeFiniteNumber(originalRaw.sizeBytes);
  const width = normalizeFiniteNumber(originalRaw.width);
  const height = normalizeFiniteNumber(originalRaw.height);
  const durationMs = normalizeFiniteNumber(originalRaw.durationMs);
  if (sizeBytes !== null) original.sizeBytes = sizeBytes;
  if (width !== null) original.width = width;
  if (height !== null) original.height = height;
  if (durationMs !== null) original.durationMs = durationMs;

  const thumbnail: MediaAssetThumbnail = {
    url: normalizeString(thumbnailRaw.url) || null,
    mimeType: normalizeString(thumbnailRaw.mimeType) || null,
    width: null,
    height: null,
    status:
      thumbnailStatus === 'ready' ||
      thumbnailStatus === 'stale' ||
      thumbnailStatus === 'missing' ||
      thumbnailStatus === 'generating' ||
      thumbnailStatus === 'failed'
        ? thumbnailStatus
        : 'missing',
    generatedAt: null,
    error: null,
  };
  const thumbnailWidth = normalizeFiniteNumber(thumbnailRaw.width);
  const thumbnailHeight = normalizeFiniteNumber(thumbnailRaw.height);
  const generatedAt = normalizeFiniteNumber(thumbnailRaw.generatedAt);
  if (thumbnailWidth !== null) thumbnail.width = thumbnailWidth;
  if (thumbnailHeight !== null) thumbnail.height = thumbnailHeight;
  if (generatedAt !== null) thumbnail.generatedAt = generatedAt;
  if (thumbnailRaw.error) {
    const error: MediaAssetThumbnailError = {
      code: normalizeString(thumbnailRaw.error.code) || null,
      message: normalizeString(thumbnailRaw.error.message) || null,
      failedAt: null,
    };
    const failedAt = normalizeFiniteNumber(thumbnailRaw.error.failedAt);
    if (failedAt !== null) error.failedAt = failedAt;
    thumbnail.error = error;
  } else {
    thumbnail.error = null;
  }

  return {
    id,
    mediaType,
    original,
    thumbnail,
    lifecycle: {
      createdAt,
      updatedAt,
    },
  };
};

const normalizeProjectMediaAssets = (raw: unknown): ProjectMediaAssets => {
  const out: ProjectMediaAssets = {};

  if (raw === null || raw === undefined) {
    throw new Error('invalid-media-asset-record');
  }

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const normalized = normalizeMediaAsset(entry);
      if (normalized) out[normalized.id] = normalized;
    }
    return out;
  }

  if (!isObjectRecord(raw)) {
    throw new Error('invalid-media-asset-record');
  }

  for (const [assetId, entry] of Object.entries(raw)) {
    const entryRecord = isObjectRecord(entry) ? entry : {};
    const entryAsset = entryRecord as RawMediaAsset;
    const normalized = normalizeMediaAsset({
      ...entryRecord,
      id: normalizeString(entryAsset.id) || assetId,
    });
    if (normalized) out[normalized.id] = normalized;
  }
  return out;
};

const readRuntimeRefInput = (value: unknown): RuntimeRefInput | null => {
  if (!isObjectRecord(value)) return null;
  return value as RuntimeRefInput;
};

const readResultAreaItem = (value: unknown): ResultAreaItem | null => {
  if (!isObjectRecord(value)) return null;
  if (Object.prototype.hasOwnProperty.call(value, 'taskInfo')) {
    throw new Error('invalid-resultArea-item-protocol');
  }
  return value as ResultAreaItem;
};

const readProjectNode = (value: unknown): ProjectNode | null => {
  if (!isObjectRecord(value)) return null;
  return value as ProjectNode;
};

const normalizeRuntimeRef = (raw: unknown): RuntimeRef | undefined => {
  const input = readRuntimeRefInput(raw);
  if (!input) return undefined;
  const taskId = normalizeString(input.taskId) || null;
  const resultId = normalizeString(input.resultId) || null;
  const assetId = normalizeString(input.assetId) || null;
  if (!taskId && !resultId && !assetId) return undefined;
  return { taskId, resultId, assetId };
};

const sanitizeResultAreaItemForPersistence = (rawItem: unknown) => {
  const item = readResultAreaItem(rawItem);
  if (!item) {
    throw new Error('invalid-resultArea-item-protocol');
  }
  const itemType = normalizeString(item.itemType) === 'text' ? 'text' : 'media';
  const base = {
    id: normalizeString(item.id),
    targetKey: normalizeString(item.targetKey),
    itemType,
    createdAt: normalizeFiniteNumber(item.createdAt, Date.now()) ?? Date.now(),
    updatedAt: normalizeFiniteNumber(item.updatedAt, Date.now()) ?? Date.now(),
  };
  if (!base.id || !base.targetKey) {
    throw new Error('invalid-resultArea-item-protocol');
  }

  const optionalFields: {
    expectedAspectRatio: number | undefined;
    errorDetails: unknown | undefined;
    runtimeRef: RuntimeRef | undefined;
  } = {} as typeof optionalFields;
  if (Number.isFinite(item.expectedAspectRatio)) {
    optionalFields.expectedAspectRatio = Number(item.expectedAspectRatio);
  }
  if (item.errorDetails && typeof item.errorDetails === 'object') {
    optionalFields.errorDetails = item.errorDetails;
  }
  const runtimeRef = normalizeRuntimeRef(item.runtimeRef || { assetId: item.assetId });
  if (runtimeRef) {
    optionalFields.runtimeRef = runtimeRef;
  }

  if (itemType === 'text') {
    const textValue = normalizeString(item.textValue);
    return {
      ...base,
      ...optionalFields,
      itemType: 'text',
      assetId: null,
      textValue: textValue || null,
    };
  }

  const assetId = normalizeString(item.assetId);
  return {
    ...base,
    ...optionalFields,
    itemType: 'media',
    assetId: null,
    textValue: null,
    runtimeRef: normalizeRuntimeRef(optionalFields.runtimeRef || { assetId }),
  };
};

const sanitizeNodeRuntimeForPersistence = (rawNode: unknown) => {
  const node = readProjectNode(rawNode);
  if (!node) return rawNode;
  const data = isObjectRecord(node.data) ? (node.data as RuntimeData) : null;
  if (!data || node.type === 'resultArea') return node;
  if (Object.prototype.hasOwnProperty.call(data, 'taskInfo')) {
    throw new Error('invalid-resultArea-item-protocol');
  }
  const runtimeRef = normalizeRuntimeRef(data.runtimeRef);
  return {
    ...node,
    data: runtimeRef ? { ...data, runtimeRef } : data,
  };
};

const sanitizeNodeGraphResultAreaItemsForPersistence = (rawNodeGraph: unknown) => {
  const nodeGraph = isObjectRecord(rawNodeGraph) ? (rawNodeGraph as ProjectNodeGraph) : null;
  if (!nodeGraph || !Array.isArray(nodeGraph.nodes)) {
    return rawNodeGraph;
  }
  return {
    ...nodeGraph,
    nodes: nodeGraph.nodes.map((rawNode: unknown) => {
      const node = readProjectNode(rawNode);
      if (!node) return rawNode;
      if (node.type !== 'resultArea') {
        return sanitizeNodeRuntimeForPersistence(node);
      }
      const data = isObjectRecord(node.data) ? (node.data as ResultAreaData) : ({} as ResultAreaData);
      const items = Array.isArray(data.items) ? data.items : [];
      return {
        ...node,
        data: {
          ...data,
          items: items.map((item: unknown) => sanitizeResultAreaItemForPersistence(item)),
        },
      };
    }),
  };
};

const assertNoTopLevelMediaAssetsPersistenceInput = (raw: unknown) => {
  if (isObjectRecord(raw) && Object.prototype.hasOwnProperty.call(raw, 'mediaAssets')) {
    throw new Error('invalid-project-media-assets');
  }
};

const normalizeProjectDocument = (raw: unknown) => {
  const documentInput = isObjectRecord(raw) ? (raw as ProjectDocumentInput) : null;
  if (!documentInput) return null;
  const normalizedRawNodeGraph = normalizeProjectNodeGraph(documentInput.nodeGraph);
  if (!normalizedRawNodeGraph) return null;
  const mediaAssets = documentInput.mediaAssets == null ? {} : normalizeProjectMediaAssets(documentInput.mediaAssets);
  const nodeGraph = sanitizeNodeGraphResultAreaItemsForPersistence(normalizedRawNodeGraph);
  return {
    nodeGraph,
    mediaAssets,
  };
};

const buildProjectDocument = (nodeGraph: unknown, runtimeMediaProjection: unknown = {}) => {
  const mediaAssets = normalizeProjectMediaAssets(runtimeMediaProjection);
  return {
    nodeGraph: sanitizeNodeGraphResultAreaItemsForPersistence(normalizeProjectNodeGraph(nodeGraph)),
    mediaAssets,
  };
};

export {
  assertNoTopLevelMediaAssetsPersistenceInput,
  normalizeMediaAsset,
  normalizeProjectMediaAssets,
  normalizeProjectDocument,
  buildProjectDocument,
};

import type {
  ModelAssetNodeProjectionRuntimeCondition,
  ModelAssetNodeProjectionRuntimeNumberRoundOptions,
} from '@iart/contracts/model-asset-contract';

const normalizeRuntimeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isRuntimeRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isRuntimeBlobLike = (value: unknown): value is Blob =>
  typeof Blob !== 'undefined' && value instanceof Blob;

export type ModelAssetRuntimeRecord = Record<string, unknown>;
export type ModelAssetRuntimePathSegment = string | number;

export interface ModelAssetRuntimeEvaluationContext {
  fields: ModelAssetRuntimeRecord;
  currentItem: unknown | undefined;
}

export const cloneRuntimeValue = (value: unknown): unknown => {
  if (isRuntimeBlobLike(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneRuntimeValue(item));
  }
  if (isRuntimeRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneRuntimeValue(item)]),
    );
  }
  return value;
};

export const parseRuntimePath = (rawPath: unknown): ModelAssetRuntimePathSegment[] => {
  const normalizedPath = normalizeRuntimeString(rawPath);
  if (!normalizedPath) return [];
  const segments: ModelAssetRuntimePathSegment[] = [];
  const pattern = /([^.[\]]+)|(\[(\d+)\])/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(normalizedPath)) !== null) {
    if (match[1]) {
      segments.push(match[1]);
      continue;
    }
    if (match[3]) {
      segments.push(Number.parseInt(match[3], 10));
    }
  }
  return segments;
};

export const readRuntimeField = (source: unknown, key: string): unknown => {
  if (source === null || source === undefined) return undefined;
  return Reflect.get(Object(source), key);
};

export const readRuntimePath = (value: unknown, rawPath: unknown): unknown => {
  const segments = parseRuntimePath(rawPath);
  let current: unknown = value;
  for (const segment of segments) {
    if (current == null) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isRuntimeRecord(current) && !Array.isArray(current)) return undefined;
    current = readRuntimeField(current, segment);
  }
  return current;
};

export const isEmptyRuntimeValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (isRuntimeBlobLike(value)) return false;
  if (Array.isArray(value)) return value.every((item) => isEmptyRuntimeValue(item));
  if (isRuntimeRecord(value)) return Object.values(value).every((item) => isEmptyRuntimeValue(item));
  return false;
};

export const compactRuntimeArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.filter((item) => !isEmptyRuntimeValue(item)) : [];

export const compactRuntimeObject = (value: unknown): ModelAssetRuntimeRecord =>
  isRuntimeRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => !isEmptyRuntimeValue(item)))
    : {};

export const toNumberOrUndefined = (value: unknown): number | undefined =>
  Number.isFinite(Number(value)) ? Number(value) : undefined;

export const normalizeRoundMode = (
  value: ModelAssetNodeProjectionRuntimeNumberRoundOptions['round'] | unknown,
): 'none' | 'round' | 'floor' | 'ceil' => {
  const normalized = normalizeRuntimeString(value).toLowerCase();
  if (normalized === 'floor' || normalized === 'ceil' || normalized === 'none') return normalized;
  return 'round';
};

export const applyRoundMode = (
  value: number,
  mode: 'none' | 'round' | 'floor' | 'ceil',
): number => {
  if (mode === 'none') return value;
  if (mode === 'floor') return Math.floor(value);
  if (mode === 'ceil') return Math.ceil(value);
  return Math.round(value);
};

const compareRuntimeValues = (leftValue: unknown, rightValue: unknown): number => {
  if (leftValue === rightValue) return 0;
  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    return leftValue - rightValue;
  }
  const left = typeof leftValue === 'string' ? leftValue : String(leftValue ?? '');
  const right = typeof rightValue === 'string' ? rightValue : String(rightValue ?? '');
  if (left === right) return 0;
  return left > right ? 1 : -1;
};


export const evaluateRuntimeCondition = async <
  TContext extends ModelAssetRuntimeEvaluationContext,
>(
  condition: ModelAssetNodeProjectionRuntimeCondition | undefined,
  context: TContext,
): Promise<boolean> => {
  if (!condition) return true;
  const op = normalizeRuntimeString(condition.op).toLowerCase();

  if (op === 'and' || op === 'or') {
    const children = (condition as { conditions: ModelAssetNodeProjectionRuntimeCondition[] | undefined }).conditions ?? [];
    if (op === 'and') {
      for (const child of children) {
        if (!(await evaluateRuntimeCondition(child, context))) return false;
      }
      return true;
    }
    for (const child of children) {
      if (await evaluateRuntimeCondition(child, context)) return true;
    }
    return false;
  }

  if (op === 'not') {
    return !(await evaluateRuntimeCondition(
      (condition as { condition: ModelAssetNodeProjectionRuntimeCondition | undefined }).condition,
      context,
    ));
  }

  const field = normalizeRuntimeString((condition as { field: unknown | undefined }).field);
  const actual = readRuntimePath(context.fields, field);
  // `truthy` / `falsy` 沿用 JavaScript `Boolean` 语义，空数组因此为真。
  // 判「数组是否非空」必须用 `{ op: 'ne', field, value: [] }`（见 evaluator.test.ts）。
  if (op === 'truthy') return Boolean(actual);
  if (op === 'falsy') return !actual;

  const expected = (condition as { value: unknown | undefined }).value;
  if (op === 'eq') return compareRuntimeValues(actual, expected) === 0;
  if (op === 'ne') return compareRuntimeValues(actual, expected) !== 0;
  if (op === 'gt') return compareRuntimeValues(actual, expected) > 0;
  if (op === 'gte') return compareRuntimeValues(actual, expected) >= 0;
  if (op === 'lt') return compareRuntimeValues(actual, expected) < 0;
  if (op === 'lte') return compareRuntimeValues(actual, expected) <= 0;
  if (op === 'includes') {
    if (Array.isArray(actual)) return actual.some((item) => compareRuntimeValues(item, expected) === 0);
    return typeof actual === 'string' ? actual.includes(String(expected)) : false;
  }
  if (op === 'excludes') {
    if (Array.isArray(actual)) return actual.every((item) => compareRuntimeValues(item, expected) !== 0);
    return typeof actual === 'string' ? !actual.includes(String(expected)) : true;
  }
  return false;
};

type ShotListRawItem = {
  index: unknown | undefined; startAtSeconds: unknown | undefined; startAt: unknown | undefined; start: unknown | undefined;
  endAtSeconds: unknown | undefined; endAt: unknown | undefined; end: unknown | undefined; durationSeconds: unknown | undefined;
  duration: unknown | undefined; seconds: unknown | undefined; length: unknown | undefined; beats: unknown | undefined;
  storyBeats: unknown | undefined; timeline: unknown | undefined; notes: unknown | undefined; tags: unknown | undefined;
  id: unknown | undefined; key: unknown | undefined; slug: unknown | undefined; title: unknown | undefined; name: unknown | undefined;
  label: unknown | undefined; summary: unknown | undefined; logline: unknown | undefined; description: unknown | undefined;
  prompt: unknown | undefined; text: unknown | undefined; cameraMotion: unknown | undefined; camera: unknown | undefined;
  motion: unknown | undefined; audioCue: unknown | undefined; audio: unknown | undefined; soundtrack: unknown | undefined;
  referenceUrl: unknown | undefined; reference: unknown | undefined; referenceImage: unknown | undefined; assetUrl: unknown | undefined;
  transition: unknown | undefined; metadata: unknown | undefined;
};

type ShotSegment = {
  id: string | undefined; index: number; title: string | undefined; summary: string | undefined; description: string | undefined;
  beats: string[] | undefined; durationSeconds: number | undefined; cameraMotion: string | undefined; audioCue: string | undefined;
  referenceUrl: string | undefined; tags: string[] | undefined; transition: string | undefined; startAtSeconds: number;
  endAtSeconds: number | undefined; metadata: ModelAssetRuntimeRecord | undefined;
};

const toStringArrayValue = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => normalizeRuntimeString(item)).filter(Boolean);
  if (typeof value === 'string') return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [];
};

export const normalizeShotListValue = (value: unknown): ShotSegment[] => {
  if (!Array.isArray(value)) return [];
  let cursor = 0;
  return value.reduce<ShotSegment[]>((segments, item, index) => {
    if (!isRuntimeRecord(item)) return segments;
    const shotItem = item as ShotListRawItem;
    const start = toNumberOrUndefined(shotItem.startAtSeconds ?? shotItem.startAt ?? shotItem.start);
    const end = toNumberOrUndefined(shotItem.endAtSeconds ?? shotItem.endAt ?? shotItem.end);
    let duration = toNumberOrUndefined(shotItem.durationSeconds ?? shotItem.duration ?? shotItem.seconds ?? shotItem.length);
    const startAt = start ?? cursor;
    let endAt = end;
    if (typeof duration === 'number' && duration < 0) duration = Math.abs(duration);
    if (duration === undefined && endAt !== undefined) duration = Math.max(0, endAt - startAt);
    if (duration !== undefined && endAt === undefined) endAt = startAt + duration;
    if (duration !== undefined && duration === 0) duration = undefined;
    if (endAt !== undefined) cursor = endAt;
    else if (duration !== undefined) cursor = startAt + duration;

    const beats = toStringArrayValue(shotItem.beats ?? shotItem.storyBeats ?? shotItem.timeline ?? shotItem.notes);
    const tags = toStringArrayValue(shotItem.tags);
    const segment: ShotSegment = {
      index: toNumberOrUndefined(shotItem.index) ?? index,
      startAtSeconds: startAt,
      id: undefined,
      title: undefined,
      summary: undefined,
      description: undefined,
      beats: undefined,
      durationSeconds: undefined,
      cameraMotion: undefined,
      audioCue: undefined,
      referenceUrl: undefined,
      tags: undefined,
      transition: undefined,
      endAtSeconds: undefined,
      metadata: undefined,
    };
    const entries: Array<[keyof ShotSegment, string]> = [
      ['id', normalizeRuntimeString(shotItem.id ?? shotItem.key ?? shotItem.slug)],
      ['title', normalizeRuntimeString(shotItem.title ?? shotItem.name ?? shotItem.label)],
      ['summary', normalizeRuntimeString(shotItem.summary ?? shotItem.logline)],
      ['description', normalizeRuntimeString(shotItem.description ?? shotItem.prompt ?? shotItem.text)],
      ['cameraMotion', normalizeRuntimeString(shotItem.cameraMotion ?? shotItem.camera ?? shotItem.motion)],
      ['audioCue', normalizeRuntimeString(shotItem.audioCue ?? shotItem.audio ?? shotItem.soundtrack)],
      ['referenceUrl', normalizeRuntimeString(shotItem.referenceUrl ?? shotItem.reference ?? shotItem.referenceImage ?? shotItem.assetUrl)],
      ['transition', normalizeRuntimeString(shotItem.transition)],
    ];
    entries.forEach(([key, entryValue]) => {
      if (entryValue) (segment as Record<string, unknown>)[key] = entryValue;
    });
    if (beats.length > 0) segment.beats = beats;
    if (duration !== undefined) segment.durationSeconds = duration;
    if (tags.length > 0) segment.tags = tags;
    if (endAt !== undefined) segment.endAtSeconds = endAt;
    if (isRuntimeRecord(shotItem.metadata)) segment.metadata = shotItem.metadata;
    if (!segment.description) {
      const fallbackDescription = segment.summary ?? (segment.beats !== null && segment.beats !== undefined ? segment.beats.join('; ') : undefined);
      if (fallbackDescription) segment.description = fallbackDescription;
    }
    segments.push(segment);
    return segments;
  }, []);
};

export const timelineToNarrative = (value: unknown): string | undefined => {
  const lines = normalizeShotListValue(value)
    .map((segment, index) => {
      const parts = [`${Number.isFinite(Number(segment.index)) ? Number(segment.index) + 1 : index + 1}.`];
      if (typeof segment.durationSeconds === 'number' && segment.durationSeconds > 0) {
        parts.push(`[${Math.round(segment.durationSeconds)}s]`);
      }
      if (normalizeRuntimeString(segment.title)) parts.push(normalizeRuntimeString(segment.title));
      const descriptors = [
        normalizeRuntimeString(segment.description),
        normalizeRuntimeString(segment.cameraMotion) ? `Camera: ${normalizeRuntimeString(segment.cameraMotion)}` : '',
        (segment.beats !== null && segment.beats !== undefined && segment.beats.length > 0) ? `Beats: ${segment.beats.map((item) => normalizeRuntimeString(item)).filter(Boolean).join(' / ')}` : '',
        normalizeRuntimeString(segment.audioCue) ? `Audio: ${normalizeRuntimeString(segment.audioCue)}` : '',
        normalizeRuntimeString(segment.transition) ? `Transition: ${normalizeRuntimeString(segment.transition)}` : '',
      ].filter(Boolean);
      if (descriptors.length > 0) parts.push('-', descriptors.join(' | '));
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
};

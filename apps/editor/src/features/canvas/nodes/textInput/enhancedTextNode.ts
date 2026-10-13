import { nanoid } from 'nanoid';
import type { PromptCollectionItem, TextInputNodeData, TextInputSegment } from '../../types';

const PROMPT_PRESET_TOKEN_REGEX = /\[\[pp:([^\]]+)\]\]/g;

export type PromptPresetTokenMatch = {
  presetId: string;
  start: number;
  end: number;
};

export type ComposeEnhancedTextInputOptions = {
  /**
   * 当文本中出现 `[[pp:<presetId>]]` 但快照缺失时：
   * - keep：保留原 token（用于 UI 预览/非阻断场景）
   * - throw：抛错阻断执行
   */
  promptPresetMissing: 'keep' | 'throw' | undefined;
};

export type TextInputSeparatorPreset = NonNullable<TextInputNodeData['separator']>;

interface RawPromptPresetSnapshotItem {
  id: unknown | undefined;
  name: unknown | undefined;
  content: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
}

interface RawTextInputSegment {
  kind: unknown | undefined;
  id: unknown | undefined;
  enabled: unknown | undefined;
  text: unknown | undefined;
  edgeId: unknown | undefined;
}

interface RawTextInputNodeData {
  text: unknown | undefined;
  separator: unknown | undefined;
  customSeparator: unknown | undefined;
  segments: unknown | undefined;
  promptPresetSnapshots: unknown | undefined;
}

export function createLocalTextSegment(text = ''): Extract<TextInputSegment, { kind: 'local' }> {
  return { kind: 'local', id: nanoid(), enabled: true, text };
}

export function resolveTextInputSeparatorString(data: Partial<TextInputNodeData> | null | undefined): string {
  const preset = (data !== null && data !== undefined ? data.separator : undefined) ?? 'comma';
  switch (preset) {
    case 'comma':
      return ', ';
    case 'space':
      return ' ';
    case 'newline':
      return '\n';
    case 'doubleNewline':
      return '\n\n';
    case 'none':
      return '';
    case 'custom':
      if (data === null || data === undefined) return '';
      return typeof data.customSeparator === 'string' ? data.customSeparator : '';
    default:
      return ', ';
  }
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function coerceNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function sanitizePromptPresetSnapshots(
  raw: unknown,
): Record<string, PromptCollectionItem> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const next: Record<string, PromptCollectionItem> = {};
  for (const value of Object.values(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const item = value as RawPromptPresetSnapshotItem;
    const id = coerceString(item.id, '');
    const name = coerceString(item.name, '');
    const content = coerceString(item.content, '');
    if (!id || !name || !content) continue;
    const createdAt = coerceNumber(item.createdAt, 0);
    const updatedAt = coerceNumber(item.updatedAt, createdAt);
    next[id] = { id, name, content, createdAt, updatedAt };
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function listPromptPresetTokenMatches(text: string): PromptPresetTokenMatch[] {
  const safe = typeof text === 'string' ? text : '';
  const matches: PromptPresetTokenMatch[] = [];

  PROMPT_PRESET_TOKEN_REGEX.lastIndex = 0;
  for (let m = PROMPT_PRESET_TOKEN_REGEX.exec(safe); m; m = PROMPT_PRESET_TOKEN_REGEX.exec(safe)) {
    const presetId = m[1] ?? '';
    if (!presetId) continue;
    const start = typeof m.index === 'number' ? m.index : -1;
    if (start < 0) continue;
    const end = start + m[0].length;
    matches.push({ presetId, start, end });
  }

  return matches;
}

export function extractPromptPresetTokenIds(text: string): string[] {
  return Array.from(new Set(listPromptPresetTokenMatches(text).map((m) => m.presetId)));
}

export function prunePromptPresetSnapshots(params: {
  segments: TextInputSegment[];
  promptPresetSnapshots: Record<string, PromptCollectionItem> | null | undefined;
}): Record<string, PromptCollectionItem> | undefined {
  const snapshots = params.promptPresetSnapshots ?? undefined;
  if (!snapshots) return undefined;

  const used = new Set<string>();
  for (const seg of params.segments ?? []) {
    if (seg.kind !== 'local') continue;
    for (const id of extractPromptPresetTokenIds(seg.text)) {
      used.add(id);
    }
  }

  if (used.size === 0) return undefined;

  const next: Record<string, PromptCollectionItem> = {};
  for (const id of used) {
    const snapshot = snapshots[id];
    if (!snapshot) continue;
    next[id] = snapshot;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * 单文本编辑面的预设快照维护（模型节点 Inspector prompt 字段；文本节点多段场景
 * 走 prunePromptPresetSnapshots 主口径）。先并入本次插入的预设快照，再按文本中
 * 实际存留的 `[[pp:]]` token 剪枝：删 token 即清快照，快照随 token 生命周期。
 */
export function syncPromptPresetSnapshotsForText(params: {
  text: string;
  promptPresetSnapshots: Record<string, PromptCollectionItem> | null | undefined;
  insertedPreset?: PromptCollectionItem | undefined;
}): Record<string, PromptCollectionItem> | undefined {
  const base = params.promptPresetSnapshots ?? undefined;
  const inserted = params.insertedPreset;
  const merged: Record<string, PromptCollectionItem> | undefined =
    inserted !== undefined
      ? { ...(base ?? {}), [inserted.id]: inserted }
      : base;
  return prunePromptPresetSnapshots({
    segments: [{ kind: 'local', id: 'single-text', enabled: true, text: params.text }],
    promptPresetSnapshots: merged,
  });
}

export function expandPromptPresetTokens(params: {
  text: string;
  promptPresetSnapshots: Record<string, PromptCollectionItem> | null | undefined;
  missing: NonNullable<ComposeEnhancedTextInputOptions['promptPresetMissing']>;
}): string {
  const source = typeof params.text === 'string' ? params.text : '';
  if (!source) return '';

  const snapshots = params.promptPresetSnapshots ?? undefined;

  PROMPT_PRESET_TOKEN_REGEX.lastIndex = 0;
  return source.replace(PROMPT_PRESET_TOKEN_REGEX, (full, presetId: string) => {
    const snapshot = snapshots !== undefined ? snapshots[presetId] : undefined;
    if (snapshot !== undefined && snapshot.content) return snapshot.content;
    if (params.missing === 'throw') {
      throw new Error(`提示词预设缺失：${presetId}`);
    }
    return full;
  });
}

function isLocalSegment(raw: unknown): raw is Extract<TextInputSegment, { kind: 'local' }> {
  if (!raw || typeof raw !== 'object') return false;
  const record = raw as RawTextInputSegment;
  return record.kind === 'local';
}

/**
 * 归一化 segments。素材节点不持有输入端口（spec：docs/runtime/已退场对象与术语.md），
 * 历史数据中的上游段（kind:'upstream'，text-source 连线的拓扑表达）无法被喂值，
 * 归一化时一律剥离。
 */
export function sanitizeTextInputSegments(raw: unknown): TextInputSegment[] {
  if (!Array.isArray(raw)) return [];
  const segments: TextInputSegment[] = [];

  for (const item of raw) {
    if (isLocalSegment(item)) {
      const record = item as RawTextInputSegment;
      segments.push({
        kind: 'local',
        id: coerceString(record.id, nanoid()),
        enabled: coerceBoolean(record.enabled, true),
        text: coerceString(record.text, ''),
      });
      continue;
    }
  }

  return segments;
}

export function normalizeTextInputNodeData(
  raw: unknown
): TextInputNodeData {
  const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const record = rawRecord !== null
    ? rawRecord as RawTextInputNodeData
    : {
        text: undefined,
        separator: undefined,
        customSeparator: undefined,
        segments: undefined,
        promptPresetSnapshots: undefined,
      };
  const passthrough = rawRecord !== null ? rawRecord as Partial<TextInputNodeData> : {};
  const legacyText = coerceString(record.text, '');

  const separatorCandidate = record.separator;
  const separator: TextInputSeparatorPreset =
    separatorCandidate === 'comma' ||
    separatorCandidate === 'space' ||
    separatorCandidate === 'newline' ||
    separatorCandidate === 'doubleNewline' ||
    separatorCandidate === 'none' ||
    separatorCandidate === 'custom'
      ? (separatorCandidate as TextInputSeparatorPreset)
      : 'comma';

  const customSeparator = coerceString(record.customSeparator, '');
  const segmentsFromRaw = sanitizeTextInputSegments(record.segments);
  const promptPresetSnapshots = sanitizePromptPresetSnapshots(record.promptPresetSnapshots);

  const segments: TextInputSegment[] = (() => {
    // 1) 已是增强结构：直接使用 segments（并尽量消化 legacy text，避免 defaultData 覆盖导致丢失）
    if (segmentsFromRaw.length > 0) {
      const next = [...segmentsFromRaw];
      if (legacyText) {
        const hasAnyLocalText = next.some((seg) => seg.kind === 'local' && seg.text.trim().length > 0);
        if (!hasAnyLocalText) {
          const firstLocalIndex = next.findIndex((seg) => seg.kind === 'local');
          if (firstLocalIndex >= 0) {
            const seg = next[firstLocalIndex] as Extract<TextInputSegment, { kind: 'local' }>;
            next[firstLocalIndex] = { ...seg, text: legacyText };
          } else {
            next.unshift({ kind: 'local', id: nanoid(), enabled: true, text: legacyText });
          }
        }
      }
      return ensureAtLeastOneLocalSegment(next);
    }

    // 2) 旧结构：text -> 单个本地段
    return [
      {
        kind: 'local',
        id: nanoid(),
        enabled: true,
        text: legacyText,
      },
    ];
  })();

  return {
    label: passthrough.label,
    description: passthrough.description,
    runtimeRef: passthrough.runtimeRef,
    lastExecutionId: passthrough.lastExecutionId,
    lastSourceNodeId: passthrough.lastSourceNodeId,
    lastSourcePortId: passthrough.lastSourcePortId,
    taskInfo: passthrough.taskInfo,
    promptInterview: passthrough.promptInterview,
    segments,
    separator,
    customSeparator,
    promptPresetSnapshots,
  };
}

function ensureAtLeastOneLocalSegment(
  segments: TextInputSegment[]
): TextInputSegment[] {
  if (segments.some((seg) => seg.kind === 'local')) return segments;
  return [{ kind: 'local', id: nanoid(), enabled: true, text: '' }, ...segments];
}

export function composeEnhancedTextInput(params: {
  data: TextInputNodeData;
  options: ComposeEnhancedTextInputOptions | undefined;
}): string {
  const separator = resolveTextInputSeparatorString(params.data);
  const missing = (params.options !== null && params.options !== undefined ? params.options.promptPresetMissing : undefined) ?? 'keep';

  const parts: string[] = [];
  for (const seg of params.data.segments ?? []) {
    if (!seg.enabled) continue;

    const value = expandPromptPresetTokens({
      text: seg.text,
      promptPresetSnapshots: params.data.promptPresetSnapshots ?? null,
      missing,
    });

    if (typeof value !== 'string') continue;
    if (value.trim().length === 0) continue;
    parts.push(value);
  }

  return parts.join(separator);
}

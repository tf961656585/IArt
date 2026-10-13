import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PromptPresetItem } from '@iart/contracts';
import { getStoragePaths } from './storage.cts';

type RawPromptPresetIndex = {
  updatedAt: unknown | undefined;
  presets: unknown | undefined;
};

type RawPromptPresetItem = Record<string, unknown> & {
  id: unknown | undefined;
  name: unknown | undefined;
  content: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
};

type PromptPresetIndex = {
  version: number;
  updatedAt: string;
  presets: PromptPresetItem[];
};

const PROMPT_PRESETS_VERSION = 1;

const normalizeString = (value: unknown): string => {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
};

const normalizeTimestamp = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const buildEmptyPromptPresetIndex = (): PromptPresetIndex => ({
  version: PROMPT_PRESETS_VERSION,
  updatedAt: new Date().toISOString(),
  presets: [],
});

const normalizePromptPresetItem = (value: unknown): PromptPresetItem | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as RawPromptPresetItem;
  const id = normalizeString(record.id);
  const name = normalizeString(record.name);
  const content = normalizeString(record.content);
  if (!id || !name || !content) return null;
  const now = Date.now();
  const createdAt = normalizeTimestamp(record.createdAt, now);
  const updatedAt = normalizeTimestamp(record.updatedAt, createdAt);
  return {
    id,
    name,
    content,
    createdAt,
    updatedAt,
  };
};

const normalizePromptPresetIndex = (value: unknown): PromptPresetIndex => {
  const base = buildEmptyPromptPresetIndex();
  if (!value || typeof value !== 'object') return base;
  const record = value as RawPromptPresetIndex;
  const normalizedPresets = Array.isArray(record.presets)
    ? record.presets
        .map(normalizePromptPresetItem)
        .filter((item): item is PromptPresetItem => item !== null)
    : [];
  const deduped = new Map<string, PromptPresetItem>();
  for (const preset of normalizedPresets) {
    const existing = deduped.get(preset.id);
    if (existing === undefined || preset.updatedAt > existing.updatedAt) {
      deduped.set(preset.id, preset);
    }
  }
  return {
    version: PROMPT_PRESETS_VERSION,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : base.updatedAt,
    presets: Array.from(deduped.values()),
  };
};

const buildPromptPresetId = (): string => {
  try {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    void 0;
  }
  return crypto.randomBytes(16).toString('hex');
};

const readPromptPresetIndex = (): PromptPresetIndex => {
  const filePath = getStoragePaths().promptPresets;
  try {
    if (!fs.existsSync(filePath)) return buildEmptyPromptPresetIndex();
    return normalizePromptPresetIndex(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown);
  } catch {
    return buildEmptyPromptPresetIndex();
  }
};

const writePromptPresetIndex = (index: PromptPresetIndex): void => {
  const filePath = getStoragePaths().promptPresets;
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalizePromptPresetIndex(index), null, 2), 'utf-8');
};

const listPromptPresets = (): PromptPresetItem[] => {
  return readPromptPresetIndex().presets
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt);
};

const createPromptPreset = (input: { name: unknown | undefined; content: unknown | undefined }): PromptPresetItem | null => {
  const name = normalizeString(input.name);
  const content = normalizeString(input.content);
  if (!name || !content) return null;
  const index = readPromptPresetIndex();
  const now = Date.now();
  const preset: PromptPresetItem = {
    id: buildPromptPresetId(),
    name,
    content,
    createdAt: now,
    updatedAt: now,
  };
  index.presets = [preset, ...index.presets];
  index.updatedAt = new Date().toISOString();
  writePromptPresetIndex(index);
  return preset;
};

const updatePromptPreset = (
  id: unknown,
  input: { name: unknown | undefined; content: unknown | undefined },
): PromptPresetItem | null => {
  const presetId = normalizeString(id);
  const name = normalizeString(input.name);
  const content = normalizeString(input.content);
  if (!presetId || !name || !content) return null;
  const index = readPromptPresetIndex();
  const now = Date.now();
  let updatedPreset: PromptPresetItem | null = null;
  index.presets = index.presets.map((preset) => {
    if (preset.id !== presetId) return preset;
    updatedPreset = {
      ...preset,
      name,
      content,
      updatedAt: now,
    };
    return updatedPreset;
  });
  if (updatedPreset === null) return null;
  index.updatedAt = new Date().toISOString();
  writePromptPresetIndex(index);
  return updatedPreset;
};

const deletePromptPreset = (id: unknown): boolean => {
  const presetId = normalizeString(id);
  if (!presetId) return false;
  const index = readPromptPresetIndex();
  const nextPresets = index.presets.filter((preset) => preset.id !== presetId);
  if (nextPresets.length === index.presets.length) return false;
  index.presets = nextPresets;
  index.updatedAt = new Date().toISOString();
  writePromptPresetIndex(index);
  return true;
};

export {
  listPromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
};

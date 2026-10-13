/**
 * Editor Storage Service — Prompt Presets
 *
 * 与 Backend HTTP route 共享同一物理文件：
 * <storageRoot>/config/prompt-presets.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import storageHintsModule = require('@iart/utils/storage-root-hints');

type ExternalPayload = Record<string, unknown>;

// ── Types ──

interface RawPresetIndex {
  updatedAt: unknown | undefined;
  presets: unknown | undefined;
}

interface RawPresetItem extends ExternalPayload {
  id: unknown | undefined;
  name: unknown | undefined;
  content: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
}

interface PromptPresetItem {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface PromptPresetsIndex {
  version: number;
  updatedAt: string;
  presets: PromptPresetItem[];
}

// ── Constants ──

const PROMPT_PRESETS_VERSION = 1;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ── Helpers ──

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

const normalizeTimestamp = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const buildEmptyIndex = (): PromptPresetsIndex => ({
  version: PROMPT_PRESETS_VERSION,
  updatedAt: new Date().toISOString(),
  presets: [],
});

const normalizePresetItem = (item: unknown): PromptPresetItem | null => {
  if (!item || typeof item !== 'object') return null;
  const record = item as RawPresetItem;
  const id = normalizeString(record.id);
  const name = normalizeString(record.name);
  const content = normalizeString(record.content);
  if (!id || !name || !content) return null;
  const now = Date.now();
  const createdAt = normalizeTimestamp(record.createdAt, now);
  const updatedAt = normalizeTimestamp(record.updatedAt, createdAt);
  return { id, name, content, createdAt, updatedAt };
};

const normalizeIndex = (raw: unknown): PromptPresetsIndex => {
  const base = buildEmptyIndex();
  if (!raw || typeof raw !== 'object') return base;
  const record = raw as RawPresetIndex;
  const presets = Array.isArray(record.presets)
    ? record.presets.map(normalizePresetItem).filter((item): item is PromptPresetItem => item !== null)
    : [];

  // Deduplicate by id, keep latest updatedAt
  const deduped = new Map<string, PromptPresetItem>();
  for (const preset of presets) {
    const existing = deduped.get(preset.id);
    if (!existing || preset.updatedAt > existing.updatedAt) {
      deduped.set(preset.id, preset);
    }
  }

  return {
    version: PROMPT_PRESETS_VERSION,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : base.updatedAt,
    presets: Array.from(deduped.values()),
  };
};

const makeId = (): string => {
  try {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return crypto.randomBytes(16).toString('hex');
};

// ── File path resolution ──

let _presetsFilePath: string | null = null;

/**
 * setPresetsFilePath — 在 main 进程初始化时调用，设置 prompt-presets.json 的完整绝对路径。
 */
const setPresetsFilePath = (filePath: string): void => {
  const normalizedFilePath = typeof filePath === 'string' ? filePath.trim() : '';
  _presetsFilePath = normalizedFilePath ? path.resolve(normalizedFilePath) : resolveSharedPromptPresetsFilePath();
};

const resolveSharedPromptPresetsFilePath = (): string =>
  String(
    storageHintsModule.resolvePromptPresetsFilePath({
      env: undefined,
      globalObject: undefined,
      platform: undefined,
      homeDir: undefined,
      execPath: undefined,
      moduleDir: __dirname,
      devFallbackRoot: REPO_ROOT,
      isElectronRuntime: undefined,
    }) || '',
  ).trim();

const getPresetsFilePath = (): string => {
  if (_presetsFilePath) return _presetsFilePath;
  return resolveSharedPromptPresetsFilePath();
};

const readIndexFromDisk = (): PromptPresetsIndex => {
  const filePath = getPresetsFilePath();
  try {
    if (!fs.existsSync(filePath)) return buildEmptyIndex();
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return normalizeIndex(parsed);
  } catch {
    return buildEmptyIndex();
  }
};

const writeIndexToDisk = (index: PromptPresetsIndex): void => {
  const filePath = getPresetsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const normalized = normalizeIndex(index);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
};

// ── CRUD ──

const listPromptPresets = (): PromptPresetItem[] => {
  const index = readIndexFromDisk();
  return [...(index.presets || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};

const getPromptPreset = (id: unknown): PromptPresetItem | null => {
  const presetId = normalizeString(id);
  if (!presetId) return null;
  const index = readIndexFromDisk();
  const presets = Array.isArray(index.presets) ? index.presets : [];
  return presets.find((item) => item.id === presetId) ?? null;
};

const createPromptPreset = (payload: { name: unknown | undefined; content: unknown | undefined }): PromptPresetItem | null => {
  const name = normalizeString((payload !== null && payload !== undefined ? payload.name : undefined));
  const content = normalizeString((payload !== null && payload !== undefined ? payload.content : undefined));
  if (!name || !content) return null;

  const index = readIndexFromDisk();
  const now = Date.now();
  const preset: PromptPresetItem = {
    id: makeId(),
    name,
    content,
    createdAt: now,
    updatedAt: now,
  };

  const existing = Array.isArray(index.presets) ? index.presets : [];
  index.presets = [preset, ...existing];
  index.updatedAt = new Date().toISOString();
  writeIndexToDisk(index);
  return preset;
};

const updatePromptPreset = (
  id: unknown,
  updates: { name: unknown | undefined; content: unknown | undefined },
): PromptPresetItem | null => {
  const presetId = normalizeString(id);
  if (!presetId) return null;
  const name = normalizeString((updates !== null && updates !== undefined ? updates.name : undefined));
  const content = normalizeString((updates !== null && updates !== undefined ? updates.content : undefined));
  if (!name || !content) return null;

  const index = readIndexFromDisk();
  const existing = Array.isArray(index.presets) ? index.presets : [];
  const next: PromptPresetItem[] = [];
  let updated: PromptPresetItem | null = null;
  const now = Date.now();

  for (const item of existing) {
    if (!item || typeof item !== 'object') continue;
    if (item.id !== presetId) {
      next.push(item);
      continue;
    }
    updated = {
      ...item,
      name,
      content,
      updatedAt: now,
    };
    next.push(updated);
  }

  if (!updated) return null;

  index.presets = next;
  index.updatedAt = new Date().toISOString();
  writeIndexToDisk(index);
  return updated;
};

const deletePromptPreset = (id: unknown): boolean => {
  const presetId = normalizeString(id);
  if (!presetId) return false;

  const index = readIndexFromDisk();
  const existing = Array.isArray(index.presets) ? index.presets : [];
  const next = existing.filter((item) => (item !== null && item !== undefined ? item.id : undefined) !== presetId);
  if (next.length === existing.length) return false;

  index.presets = next;
  index.updatedAt = new Date().toISOString();
  writeIndexToDisk(index);
  return true;
};

export {
  setPresetsFilePath,
  listPromptPresets,
  getPromptPreset,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
};

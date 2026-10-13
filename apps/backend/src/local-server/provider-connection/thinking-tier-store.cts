import * as fs from 'node:fs';
import {
  BUILTIN_THINKING_TIERS,
  CUSTOM_THINKING_TIER_LIMIT,
  THINKING_TIER_OFF,
  ThinkingTierSchema,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';

/**
 * 思考档位全局预设池（spec 37「思考档位」）。
 *
 * - 文件：config/thinking-tier-presets.json
 * - 池子 = 内置常用档（随 app 版本固定，不落盘）+ 用户自定义档（本文件承载）
 * - 池子是「档位标识与展示名的唯一定义处」；启用关系不在这里，落在 ModelDeployment 上
 * - 档位标识即展示名（spec 01：档位名直显主窗口的配置值），所以自定义档只有一个名字字段
 *
 * 删除自定义档位的级联清理（把该档位从各接入的启用列表里摘掉）不在本模块：本模块不感知部署，
 * 由调用方（thinking-tier 路由）编排，避免与本文件形成循环依赖。
 */

type ThinkingTierPresetsPathMap = { thinkingTierPresets: string | undefined };

interface CustomThinkingTierRecord {
  name: string;
  created_at: string;
}

interface ThinkingTierPresetsFile {
  version: number;
  updatedAt: string;
  custom: CustomThinkingTierRecord[];
}

const readFileVersion = (): number => 1;

const asPathMap = (value: unknown): ThinkingTierPresetsPathMap | null =>
  isPlainObject(value) ? (value as ThinkingTierPresetsPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.thinkingTierPresets : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): ThinkingTierPresetsFile => ({
  version: readFileVersion(),
  updatedAt: new Date(0).toISOString(),
  custom: [],
});

const normalizeTierName = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const parsed = ThinkingTierSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : '';
};

const normalizeFile = (raw: unknown): ThinkingTierPresetsFile | null => {
  if (!isPlainObject(raw)) return null;
  const version = Number((raw as { version: unknown }).version);
  if (!Number.isFinite(version) || version !== readFileVersion()) {
    loggingModule.logDebug('[thinking-tier-store] normalizeFile: unsupported version', { version });
    return null;
  }
  const custom: CustomThinkingTierRecord[] = [];
  const seen = new Set<string>();
  const rawCustom = (raw as { custom: unknown }).custom;
  if (Array.isArray(rawCustom)) {
    rawCustom.forEach((entry, index) => {
      if (!isPlainObject(entry)) return;
      const name = normalizeTierName((entry as { name: unknown }).name);
      if (!name) {
        loggingModule.logDebug('[thinking-tier-store] drop invalid custom tier', { index });
        return;
      }
      if (seen.has(name)) {
        loggingModule.logDebug('[thinking-tier-store] drop duplicated custom tier', { name });
        return;
      }
      seen.add(name);
      const createdAt = (entry as { created_at: unknown }).created_at;
      custom.push({
        name,
        created_at: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(),
      });
    });
  }
  const rawUpdatedAt = (raw as { updatedAt: unknown }).updatedAt;
  return {
    version: readFileVersion(),
    updatedAt: typeof rawUpdatedAt === 'string' ? rawUpdatedAt : new Date(0).toISOString(),
    custom,
  };
};

const readFromDisk = (paths: unknown): ThinkingTierPresetsFile | null => {
  const filePath = getFilePath(paths);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeFile(parsed);
  } catch {
    return null;
  }
};

const writeToDisk = (paths: unknown, file: ThinkingTierPresetsFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: ThinkingTierPresetsFile | null = null;

const getFile = (): ThinkingTierPresetsFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

const commitFile = (next: ThinkingTierPresetsFile): ThinkingTierPresetsFile => {
  const updated: ThinkingTierPresetsFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  cache = updated;
  writeToDisk(paths, updated);
  return updated;
};

/** 内置档位标识（恒定存在于池子里，不落盘、不可删除）。 */
const listBuiltinThinkingTiers = (): string[] => [...BUILTIN_THINKING_TIERS];

/** 自定义档位名列表（按添加顺序）。 */
const listCustomThinkingTierNames = (): string[] => getFile().custom.map((item) => item.name);

/**
 * 档位是否属于池子（内置档或自定义档）。
 *
 * `off` 不在池子里——它恒定可用、不参与声明，需要它的调用方自行放行。
 */
const isPoolThinkingTier = (name: unknown): boolean => {
  const normalized = normalizeTierName(name);
  if (!normalized) return false;
  if (normalized === THINKING_TIER_OFF) return false;
  if (listBuiltinThinkingTiers().includes(normalized)) return true;
  return getFile().custom.some((item) => item.name === normalized);
};

/**
 * 新增自定义档位；返回 null 表示名称非法、与内置/`off` 冲突、已存在或已达上限。
 *
 * 数量上限（`CUSTOM_THINKING_TIER_LIMIT`，owner 在 contracts）用于防止池子被灌爆后
 * 把每条接入的档位勾选列表撑到不可用。
 */
const addCustomThinkingTier = (name: unknown): CustomThinkingTierRecord | null => {
  const normalized = normalizeTierName(name);
  if (!normalized) {
    loggingModule.logDebug('[thinking-tier-store] addCustomThinkingTier: invalid name', { name: String(name) });
    return null;
  }
  if (normalized === THINKING_TIER_OFF || listBuiltinThinkingTiers().includes(normalized)) {
    loggingModule.logDebug('[thinking-tier-store] addCustomThinkingTier: reserved name', { name: normalized });
    return null;
  }
  const file = getFile();
  if (file.custom.some((item) => item.name === normalized)) {
    loggingModule.logDebug('[thinking-tier-store] addCustomThinkingTier: already exists', { name: normalized });
    return null;
  }
  if (file.custom.length >= CUSTOM_THINKING_TIER_LIMIT) {
    loggingModule.logDebug('[thinking-tier-store] addCustomThinkingTier: limit reached', {
      limit: CUSTOM_THINKING_TIER_LIMIT,
    });
    return null;
  }
  const record: CustomThinkingTierRecord = { name: normalized, created_at: new Date().toISOString() };
  commitFile({ ...file, custom: [...file.custom, record] });
  return record;
};

/** 删除自定义档位；返回 false 表示池子里没有这个自定义档位。级联清理由调用方编排。 */
const removeCustomThinkingTier = (name: unknown): boolean => {
  const normalized = normalizeTierName(name);
  if (!normalized) return false;
  const file = getFile();
  if (!file.custom.some((item) => item.name === normalized)) {
    loggingModule.logDebug('[thinking-tier-store] removeCustomThinkingTier: not found', { name: normalized });
    return false;
  }
  commitFile({ ...file, custom: file.custom.filter((item) => item.name !== normalized) });
  return true;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  listBuiltinThinkingTiers,
  listCustomThinkingTierNames,
  isPoolThinkingTier,
  addCustomThinkingTier,
  removeCustomThinkingTier,
  clearCacheForTest,
  normalizeTierName,
  type CustomThinkingTierRecord,
};

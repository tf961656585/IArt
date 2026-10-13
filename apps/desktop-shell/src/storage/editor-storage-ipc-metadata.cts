import { ipcMain } from 'electron';
import {
  CacheStatisticsSchema,
  CharacterPinsSchema,
  EDITOR_STORAGE_IPC_CHANNELS,
  NodeTypeUsageStatsSchema,
  StorageGetCacheStatisticsParamsSchema,
  StorageGetCacheStatisticsResultSchema,
  StorageGetCharacterPinsParamsSchema,
  StorageGetCharacterPinsResultSchema,
  StorageGetNodeTypeUsageParamsSchema,
  StorageGetNodeTypeUsageResultSchema,
  StorageSaveCharacterPinsParamsSchema,
  StorageSaveCharacterPinsResultSchema,
  StorageTrackNodeTypeUsageParamsSchema,
  StorageTrackNodeTypeUsageResultSchema,
} from '@iart/contracts';
import type {
  NodeTypeUsageStats,
} from '@iart/contracts';
import type { ZodType } from 'zod';
import { getDb, listProjects } from './editor-storage-service.cjs';

const parseJsonOrNull = (value: unknown): unknown | null => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim()),
    ),
  );
};

const defaultNodeTypeUsageStats = (updatedAt: number): NodeTypeUsageStats => ({
  version: 1,
  updatedAt,
  byNodeKey: {},
});

const readJsonMetaValue = <T,>(
  projectPath: string,
  key: string,
  schema: ZodType<T>,
): T | null => {
  const db = getDb(projectPath);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: unknown | undefined }
    | undefined;
  const rawValue = parseJsonOrNull(row !== null && row !== undefined ? row.value : undefined);
  if (rawValue === null) return null;
  const parsed = schema.safeParse(rawValue);
  return parsed.success ? parsed.data : null;
};

const writeJsonMetaValue = (
  projectPath: string,
  key: string,
  value: unknown,
) => {
  const db = getDb(projectPath);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    key,
    JSON.stringify(value),
  );
};

export const registerStorageMetadataIpcHandlers = (): void => {
  const CH = EDITOR_STORAGE_IPC_CHANNELS;

  ipcMain.handle(CH.GET_NODE_TYPE_USAGE, (_event, raw) => {
    const args = StorageGetNodeTypeUsageParamsSchema.parse(raw);
    return StorageGetNodeTypeUsageResultSchema.parse({
      stats: readJsonMetaValue(args.projectPath, 'node_type_usage', NodeTypeUsageStatsSchema),
    });
  });

  ipcMain.handle(CH.TRACK_NODE_TYPE_USAGE, (_event, raw) => {
    const args = StorageTrackNodeTypeUsageParamsSchema.parse(raw);
    const { projectPath, nodeKeys } = args;
    const now = Date.now();
    const stats =
      readJsonMetaValue(projectPath, 'node_type_usage', NodeTypeUsageStatsSchema) ??
      defaultNodeTypeUsageStats(now);
    stats.updatedAt = now;
    if (!stats.byNodeKey || typeof stats.byNodeKey !== 'object' || Array.isArray(stats.byNodeKey)) {
      stats.byNodeKey = {};
    }

    const uniqueKeys = normalizeStringArray(nodeKeys);
    for (const nodeKey of uniqueKeys) {
      const current = stats.byNodeKey[nodeKey] || { count: 0, lastUsedAt: 0 };
      stats.byNodeKey[nodeKey] = {
        count: (current.count || 0) + 1,
        lastUsedAt: now,
      };
    }

    writeJsonMetaValue(projectPath, 'node_type_usage', stats);
    return StorageTrackNodeTypeUsageResultSchema.parse({ stats });
  });

  ipcMain.handle(CH.GET_CHARACTER_PINS, (_event, raw) => {
    const args = StorageGetCharacterPinsParamsSchema.parse(raw);
    return StorageGetCharacterPinsResultSchema.parse({
      pins: readJsonMetaValue(args.projectPath, 'character_pins', CharacterPinsSchema),
    });
  });

  ipcMain.handle(CH.SAVE_CHARACTER_PINS, (_event, raw) => {
    const args = StorageSaveCharacterPinsParamsSchema.parse(raw);
    const pins = {
      version: 1,
      updatedAt: Date.now(),
      pinnedCharacterIds: normalizeStringArray(args.pinnedIds),
    };
    writeJsonMetaValue(args.projectPath, 'character_pins', pins);
    return StorageSaveCharacterPinsResultSchema.parse({ pins });
  });

  ipcMain.handle(CH.GET_CACHE_STATISTICS, (_event, raw) => {
    StorageGetCacheStatisticsParamsSchema.parse(raw);
    const projects = listProjects();
    let totalProjects = 0;
    let totalMediaAssets = 0;
    let totalTaskIndexEntries = 0;

    for (const project of projects) {
      if (!(project !== null && project !== undefined ? project.path : undefined)) continue;
      try {
        totalProjects += 1;
        const db = getDb(project.path);
        const mediaCount = (
          db.prepare('SELECT COUNT(*) as count FROM media_assets').get() as { count: number }
        ).count;
        totalMediaAssets += mediaCount;
        const taskCount = (
          db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }
        ).count;
        totalTaskIndexEntries += taskCount;
      } catch {
        // skip invalid projects
      }
    }

    const statistics = CacheStatisticsSchema.parse({
      totalProjects,
      totalMediaAssets,
      totalTaskIndexEntries,
    });
    return StorageGetCacheStatisticsResultSchema.parse({
      statistics: {
        totalProjects: statistics.totalProjects,
        totalMediaAssets: statistics.totalMediaAssets,
        totalTaskIndexEntries: statistics.totalTaskIndexEntries,
      },
    });
  });
};

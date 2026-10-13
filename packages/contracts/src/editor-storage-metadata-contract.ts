import * as z from 'zod';

export interface NodeTypeUsageStats {
  version: number;
  updatedAt: number;
  byNodeKey: Record<
    string,
    {
      count: number;
      lastUsedAt: number;
    }
  >;
}

export interface CharacterPins {
  version: number;
  updatedAt: number;
  pinnedCharacterIds: string[];
}

export interface CacheStatistics {
  totalProjects: number;
  totalMediaAssets: number;
  totalTaskIndexEntries: number;
}

export const NodeTypeUsageEntrySchema = z.object({
  count: z.number(),
  lastUsedAt: z.number(),
});

export const NodeTypeUsageStatsSchema: z.ZodType<NodeTypeUsageStats> = z.object({
  version: z.number(),
  updatedAt: z.number(),
  byNodeKey: z.record(NodeTypeUsageEntrySchema),
});

export const CharacterPinsSchema: z.ZodType<CharacterPins> = z.object({
  version: z.number(),
  updatedAt: z.number(),
  pinnedCharacterIds: z.array(z.string()),
});

export const CacheStatisticsSchema: z.ZodType<CacheStatistics> = z.object({
  totalProjects: z.number(),
  totalMediaAssets: z.number(),
  totalTaskIndexEntries: z.number(),
});

export interface StorageGetNodeTypeUsageParams {
  projectPath: string;
}

export interface StorageGetNodeTypeUsageResult {
  stats: NodeTypeUsageStats | null;
}

export const StorageGetNodeTypeUsageParamsSchema = z.object({
  projectPath: z.string(),
});

export const StorageGetNodeTypeUsageResultSchema = z.object({
  stats: NodeTypeUsageStatsSchema.nullable(),
});

export interface StorageTrackNodeTypeUsageParams {
  projectPath: string;
  nodeKeys: string[];
}

export interface StorageTrackNodeTypeUsageResult {
  stats: NodeTypeUsageStats | null;
}

export const StorageTrackNodeTypeUsageParamsSchema = z.object({
  projectPath: z.string(),
  nodeKeys: z.array(z.string()),
});

export const StorageTrackNodeTypeUsageResultSchema = z.object({
  stats: NodeTypeUsageStatsSchema.nullable(),
});

export interface StorageGetCharacterPinsParams {
  projectPath: string;
}

export interface StorageGetCharacterPinsResult {
  pins: CharacterPins | null;
}

export const StorageGetCharacterPinsParamsSchema = z.object({
  projectPath: z.string(),
});

export const StorageGetCharacterPinsResultSchema = z.object({
  pins: CharacterPinsSchema.nullable(),
});

export interface StorageSaveCharacterPinsParams {
  projectPath: string;
  pinnedIds: string[];
}

export interface StorageSaveCharacterPinsResult {
  pins: CharacterPins | null;
}

export const StorageSaveCharacterPinsParamsSchema = z.object({
  projectPath: z.string(),
  pinnedIds: z.array(z.string()),
});

export const StorageSaveCharacterPinsResultSchema = z.object({
  pins: CharacterPinsSchema.nullable(),
});

export type StorageGetCacheStatisticsParams = Record<string, never>;

export interface StorageGetCacheStatisticsResult {
  statistics: CacheStatistics;
}

export const StorageGetCacheStatisticsParamsSchema = z.object({}).strict();

export const StorageGetCacheStatisticsResultSchema = z.object({
  statistics: CacheStatisticsSchema,
});

import * as z from 'zod';
import type {
  RuntimeMediaAssetView,
  RuntimeTaskOutputRow,
  RuntimeTaskView,
} from './runtime-transaction';
import {
  RuntimeMediaAssetViewSchema,
  RuntimeTaskOutputRowSchema,
  RuntimeTaskViewSchema,
} from './runtime-transaction';

export interface StorageReadTaskByIdParams {
  projectPath: string;
  taskId: string;
}

export interface StorageReadTaskByIdResult {
  task: RuntimeTaskView | null;
}

export interface StorageReadTaskOutputsParams {
  projectPath: string;
  taskId: string;
}

export interface StorageReadTaskOutputsResult {
  outputs: RuntimeTaskOutputRow[];
}

export interface StorageReadMediaAssetsByTaskParams {
  projectPath: string;
  taskId: string;
}

export interface StorageReadMediaAssetsByTaskResult {
  mediaAssets: RuntimeMediaAssetView[];
}

export interface StorageReadAllTasksParams {
  projectPath: string;
}

export interface StorageReadAllTasksResult {
  tasks: RuntimeTaskView[];
}

export interface StorageReadAllMediaAssetsParams {
  projectPath: string;
}

export interface StorageReadAllMediaAssetsResult {
  mediaAssets: RuntimeMediaAssetView[];
}

export interface StorageReadMediaAssetByIdParams {
  projectPath: string;
  assetId: string;
}

export interface StorageReadMediaAssetByIdResult {
  mediaAsset: RuntimeMediaAssetView | null;
}

export const StorageReadTaskByIdParamsSchema = z.object({
  projectPath: z.string(),
  taskId: z.string(),
});

export const StorageReadTaskOutputsParamsSchema = z.object({
  projectPath: z.string(),
  taskId: z.string(),
});

export const StorageReadMediaAssetsByTaskParamsSchema = z.object({
  projectPath: z.string(),
  taskId: z.string(),
});

export const StorageReadAllTasksParamsSchema = z.object({
  projectPath: z.string(),
});

export const StorageReadAllMediaAssetsParamsSchema = z.object({
  projectPath: z.string(),
});

export const StorageReadMediaAssetByIdParamsSchema = z.object({
  projectPath: z.string(),
  assetId: z.string(),
});

export const StorageReadTaskByIdResultSchema = z.object({
  task: RuntimeTaskViewSchema.nullable(),
});

export const StorageReadTaskOutputsResultSchema = z.object({
  outputs: z.array(RuntimeTaskOutputRowSchema),
});

export const StorageReadMediaAssetsByTaskResultSchema = z.object({
  mediaAssets: z.array(RuntimeMediaAssetViewSchema),
});

export const StorageReadAllTasksResultSchema = z.object({
  tasks: z.array(RuntimeTaskViewSchema),
});

export const StorageReadAllMediaAssetsResultSchema = z.object({
  mediaAssets: z.array(RuntimeMediaAssetViewSchema),
});

export const StorageReadMediaAssetByIdResultSchema = z.object({
  mediaAsset: RuntimeMediaAssetViewSchema.nullable(),
});

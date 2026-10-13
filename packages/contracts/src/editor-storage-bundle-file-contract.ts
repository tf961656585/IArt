import * as z from 'zod';

export interface StorageReadFileBytesParams {
  filePath: string;
}

export interface StorageReadFileBytesResult {
  dataBase64: string;
  sizeBytes: number;
}

export interface StorageWriteTempFileParams {
  dataBase64: string;
  fileName: string | undefined;
}

export interface StorageWriteTempFileResult {
  filePath: string;
}

export const StorageReadFileBytesParamsSchema = z.object({
  filePath: z.string(),
});

export const StorageReadFileBytesResultSchema = z.object({
  dataBase64: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const StorageWriteTempFileParamsSchema = z.object({
  dataBase64: z.string(),
  fileName: z.string().optional(),
});

export const StorageWriteTempFileResultSchema = z.object({
  filePath: z.string(),
});

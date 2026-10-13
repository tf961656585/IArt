import { ipcInvoke, normalizeProjectRecord } from './backendCore';
import type { ProjectRecord } from './types';
import type {
  StorageExportBundleParams,
  StorageImportBundleParams,
  StorageImportBundleResult,
  StorageReadFileBytesParams,
  StorageReadFileBytesResult,
  StorageWriteTempFileParams,
  StorageWriteTempFileResult,
} from '@iart/contracts/editor-storage-contract';

// F 组：Bundle 导入导出
// ────────────────────────────────────────────

const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const fileToBase64 = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
};

export const exportProjectBundle = async (
  projectPath: string,
): Promise<Blob> => {
  if (!projectPath) {
    throw new Error("项目路径不能为空");
  }
  const destPath = `/tmp/iarts-export-${Date.now()}.iarts`;
  const params: StorageExportBundleParams = { projectPath, destPath };
  await ipcInvoke("storage:export-bundle", params);

  const readParams: StorageReadFileBytesParams = { filePath: destPath };
  const result = await ipcInvoke<StorageReadFileBytesResult>("storage:read-file-bytes", readParams);
  const bytes = base64ToBytes(result.dataBase64);
  return new Blob([bytesToArrayBuffer(bytes)], {
    type: "application/zip",
  });
};

export const getExportFilenameFromResponse = (response: Response): string => {
  const contentDisposition = response.headers.get("content-disposition");
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(
      /filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i,
    );
    const encodedFilename = filenameMatch !== null ? filenameMatch[1] : undefined;
    if (encodedFilename !== undefined && encodedFilename.length > 0) {
      return decodeURIComponent(encodedFilename);
    }
  }
  return "project.iarts";
};

export const importProjectBundle = async (
  file: File,
  parentDir: string,
  name: string | undefined,
): Promise<{ projectPath: string; project: ProjectRecord }> => {
  const tempParams: StorageWriteTempFileParams = {
    dataBase64: await fileToBase64(file),
    fileName: file.name || "project.iarts",
  };
  const tempFile = await ipcInvoke<StorageWriteTempFileResult>("storage:write-temp-file", tempParams);
  const importParams: StorageImportBundleParams = {
    bundlePath: tempFile.filePath,
    destDir: parentDir,
    name,
  };
  const result = await ipcInvoke<StorageImportBundleResult>("storage:import-bundle", importParams);
  const project = normalizeProjectRecord(result.project);
  if (!project) {
    throw new Error("导入失败：项目记录无效");
  }
  return {
    projectPath: result.projectPath,
    project,
  };
};

// ────────────────────────────────────────────

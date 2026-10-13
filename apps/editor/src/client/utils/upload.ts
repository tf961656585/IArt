/**
 * upload.ts
 * 说明：
 * - 该文件为上传工具的兼容层（中文注释遵循项目约定）
 * - 已将真实上传逻辑统一到 src/api/upload.ts 中；此文件保留为兼容旧 import 路径的桥接器
 * - 所有导出的函数将直接调用 src/api/upload.ts 中的实现，统一走本地后台上传接口
 */
 
import { uploadImageFile as apiUploadImageFile, ensureImageUrl as apiEnsureImageUrl, uploadAllSlots as apiUploadAllSlots } from '../api/upload';
 
export async function uploadImageFile(file: File): Promise<string> {
  // 直接委托到统一实现
  return apiUploadImageFile(file);
}
 
export async function ensureImageUrl(srcOrFile: File | string): Promise<string> {
  return apiEnsureImageUrl(srcOrFile);
}
 
export async function uploadAllSlots(slots: { id: string; src: string; file: File | undefined }[]): Promise<string[]> {
  return apiUploadAllSlots(slots);
}

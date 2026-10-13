/**
 * 上传结果类型（历史命名：R2Upload）
 *
 * 说明：
 * - success: 是否上传成功
 * - url: 上传成功后返回的访问链接
 * - error: 失败时的中文错误信息
 */
import { uploadToR2 as uploadToPublicR2 } from '@/client/api/upload';

export interface R2UploadResult {
  success: boolean;
  url: string | undefined;
  error: string | undefined;
}

/**
 * 兼容旧命名的类型别名
 *
 * 说明：
 * - 旧代码中使用的 FileIoUploadResult 仍然可用
 * - 新代码建议直接使用 R2UploadResult
 */
export type FileIoUploadResult = R2UploadResult;

/**
 * 上传单个文件到 R2（公网可访问 URL），用于模型请求体引用媒体资源。
 *
 * 行为：
 * - 使用统一上传实现（src/client/api/upload.ts → uploadToR2），请求公共中转上传端点
 *   （用户在 Hub「设置 → 公共中转」自带配置，不再内置默认）
 * - 期望返回 JSON：{ success: boolean; url?: string; error?: string }
 * - 成功时返回 { success: true, url }
 * - 失败时返回 { success: false, error }，错误信息为中文
 *
 * 错误处理：
 * - 网络错误：返回“网络错误，无法连接上传服务”
 * - 其他错误：透传上传函数抛出的中文错误信息
 */
export async function uploadToR2(file: File): Promise<R2UploadResult> {
  try {
    const url = await uploadToPublicR2(file, file.name);
    if (!url) {
      return { success: false, url: undefined, error: '文件没能上传成功，请重试。' };
    }
    return { success: true, url, error: undefined };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : '网络错误，连接不上上传服务，请重试。';
    return { success: false, url: undefined, error: message };
  }
}

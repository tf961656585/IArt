import * as z from 'zod';

/**
 * Backend ↔ Desktop Main 凭证加解密 IPC 契约（spec 03 §5 / credential-store.cts）。
 *
 * 归属与口径对齐：
 * - spec 主口径：`docs/custom-providers/03-Provider连接、协议适配与模型部署主口径.md` §5.1
 *   （真实 API Key 只进入操作系统安全凭证存储，Desktop Main 拥有宿主安全能力，Runtime Backend 不持有
 *   electron）。
 * - 可执行契约 owner：packages/contracts（跨 Electron 进程边界传输的 DTO 必须由 contracts 承载 Zod
 *   schema 与 .parse() 边界校验，AGENTS.md「共享契约与事实源」）。
 *
 * 方向（请求-响应）：
 * - Backend（fork 子进程）发送请求 → 进入 BackendToMainMessage。
 * - Desktop Main（Electron 宿主）用 electron.safeStorage 处理，经 runtime:transaction-result 回传
 *   → 响应类型进 MainToBackendMessage。
 *
 * 传输约定（AGENTS.md「IPC 边界用 Zod parse 不用 as」）：
 * - encryptString 返回 Buffer，无法直接经 structured-clone IPC 传输，故响应 payload 用 base64 字符串
 *   而非 Buffer；decrypt 接收 base64 字符串、成功回明文字符串；available 回 boolean。
 *
 * **不设超时**（AGENTS.md「远端请求与项目内接口不设超时」）：本请求走
 * 独立的无超时发送路径，IPC reply 关联靠 transactionId。
 */

/** backend -> desktop-shell：用 safeStorage 加密明文（响应 base64 密文）。 */
export const CredentialCryptoEncryptPayloadSchema = z.object({
  type: z.literal('runtime:credential-crypto-encrypt'),
  transactionId: z.string().min(1),
  /** 待加密明文（API Key 等一次性秘密材料）。 */
  value: z.string(),
}).strict();
export type CredentialCryptoEncryptPayload = z.infer<typeof CredentialCryptoEncryptPayloadSchema>;

/** backend -> desktop-shell：用 safeStorage 解密 base64 密文（响应明文字符串）。 */
export const CredentialCryptoDecryptPayloadSchema = z.object({
  type: z.literal('runtime:credential-crypto-decrypt'),
  transactionId: z.string().min(1),
  /** base64 密文（safeStorage 加密产物，对应 encryptPayload 落盘的 payload 字段）。 */
  encryptedBase64: z.string(),
}).strict();
export type CredentialCryptoDecryptPayload = z.infer<typeof CredentialCryptoDecryptPayloadSchema>;

/** backend -> desktop-shell：查询 safeStorage 是否可用（响应 boolean）。 */
export const CredentialCryptoAvailablePayloadSchema = z.object({
  type: z.literal('runtime:credential-crypto-available'),
  transactionId: z.string().min(1),
}).strict();
export type CredentialCryptoAvailablePayload = z.infer<typeof CredentialCryptoAvailablePayloadSchema>;

/**
 * 响应 payload（经 runtime:transaction-result 的 data 字段回传）。
 *
 * - encrypt 成功回 { encryptedBase64 }；decrypt 成功回 { plaintext }；available 回 { available }。
 * - 失败统一走 RuntimeTransactionResult 的 { success: false, error }，不使用本 payload 表达错误。
 */
export const CredentialCryptoEncryptResultSchema = z.object({
  encryptedBase64: z.string(),
}).strict();
export type CredentialCryptoEncryptResult = z.infer<typeof CredentialCryptoEncryptResultSchema>;

export const CredentialCryptoDecryptResultSchema = z.object({
  plaintext: z.string(),
}).strict();
export type CredentialCryptoDecryptResult = z.infer<typeof CredentialCryptoDecryptResultSchema>;

export const CredentialCryptoAvailableResultSchema = z.object({
  available: z.boolean(),
}).strict();
export type CredentialCryptoAvailableResult = z.infer<typeof CredentialCryptoAvailableResultSchema>;

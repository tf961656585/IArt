import * as z from 'zod';

/**
 * Hub Skill 商店契约。
 *
 * spec: docs/hub/skill-store.md（唯一稳定锚点）
 *
 * 本文件承载 app 与外部消费者的可执行边界契约：
 *   - SkillCatalogSchema（index.json）、SkillBundleSchema（bundle JSON）：Hub 渲染进程与
 *     desktop-shell 主进程从 R2 fetch 后必须 .parse()，是 app 与外部分发层的边界。
 *   - SkillInstall* / SkillInstalledState：Hub renderer ↔ desktop-shell main 的 IPC DTO。
 *   - CustomSkillInstallTarget / SkillCustomTarget*：自定义安装目标注册表的管理 IPC DTO
 *     （注册表文件本身是主进程私有持久化，包装 schema 归 desktop-shell）。
 *
 * 严格说第一类不是跨 Electron 进程 DTO，但它们是 app 与外部消费者的可执行边界契约，
 * 与云策略 bundle schema 的既有归属先例同类（见 docs/hub/api-key-policy-cloud-sync.md）。
 * guard:contract-ownership 做最终裁定。
 */

// ---------------------------------------------------------------------------
// SkillBundle：R2 分发的 bundle JSON
// ---------------------------------------------------------------------------

export const SkillBundleFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    executable: z.boolean(),
  })
  .strict();

export const SkillBundleSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    files: z.array(SkillBundleFileSchema).min(1),
  })
  .strict();

export type SkillBundle = z.infer<typeof SkillBundleSchema>;

// ---------------------------------------------------------------------------
// SkillCatalog：R2 分发的目录指针 index.json
// ---------------------------------------------------------------------------

export const SkillCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string(),
    bundleKey: z.string().min(1),
    sha512: z.string().min(1),
  })
  .strict();

export const SkillCatalogSchema = z
  .object({
    version: z.literal(1),
    skills: z.array(SkillCatalogEntrySchema),
  })
  .strict();

export type SkillCatalog = z.infer<typeof SkillCatalogSchema>;
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;

// ---------------------------------------------------------------------------
// IPC DTO：Hub renderer ↔ desktop-shell main（skills:install / get-installed-state）
// ---------------------------------------------------------------------------

/**
 * skill-store IPC channel 名集中管理。
 * 命名空间 `skills:` 与 `clipboard:` 对称。
 */
export const SKILL_IPC_CHANNELS = {
  GET_INSTALLED_STATE: 'skills:get-installed-state',
  INSTALL: 'skills:install',
  REVEAL_INSTALL_FOLDER: 'skills:reveal-install-folder',
  LIST_CUSTOM_TARGETS: 'skills:list-custom-targets',
  ADD_CUSTOM_TARGET: 'skills:add-custom-target',
  UPDATE_CUSTOM_TARGET: 'skills:update-custom-target',
  REMOVE_CUSTOM_TARGET: 'skills:remove-custom-target',
} as const;

export type SkillIpcChannel = (typeof SKILL_IPC_CHANNELS)[keyof typeof SKILL_IPC_CHANNELS];

/**
 * 内置安装目标 id 清单（硬编码，保持不变）。用户自定义目标走注册表增删，
 * 不进入本清单；内置 id 必须符合 SkillInstallTargetIdSchema 的 id 格式。
 */
export const SKILL_INSTALL_TARGETS = ['agents', 'claude'] as const;
export type SkillInstallTarget = (typeof SKILL_INSTALL_TARGETS)[number];

/**
 * 安装目标 id 格式（内置与自定义目标共用）：
 * 小写字母或数字开头，随后可为小写字母/数字/连字符，总长 1–64。
 */
export const SKILL_INSTALL_TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 安装目标 id schema：不再限定内置两值枚举，放宽为 id 格式校验。
 * 自定义目标的 id 由主进程注册表生成（`custom-` 前缀 + 随机 hex），同样符合本格式；
 * 目标 id 是否真实可解析（内置命中或注册表命中）由主进程在执行时裁定
 * （解析不到按 `unknown-target` 处理）。
 */
export const SkillInstallTargetIdSchema = z
  .string()
  .regex(SKILL_INSTALL_TARGET_ID_PATTERN, 'invalid skill install target id');

export type SkillInstallTargetId = string;

export const SkillInstallRequestSchema = z
  .object({
    bundleUrl: z.string().url(),
    sha512: z.string().min(1),
    target: SkillInstallTargetIdSchema,
    skillId: z.string().min(1),
  })
  .strict();

export type SkillInstallRequest = z.infer<typeof SkillInstallRequestSchema>;

export const SkillInstallResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      installedPath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1),
    })
    .strict(),
]);

export type SkillInstallResult = z.infer<typeof SkillInstallResultSchema>;

export const SkillInstalledStateEntrySchema = z
  .object({
    skillId: z.string().min(1),
    version: z.string().min(1),
    target: SkillInstallTargetIdSchema,
  })
  .strict();

export const SkillInstalledStateSchema = z
  .object({
    skills: z.array(SkillInstalledStateEntrySchema),
  })
  .strict();

export type SkillInstalledState = z.infer<typeof SkillInstalledStateSchema>;
export type SkillInstalledStateEntry = z.infer<typeof SkillInstalledStateEntrySchema>;

// ---------------------------------------------------------------------------
// 定位入口 IPC：Hub renderer ↔ desktop-shell main（skills:reveal-install-folder）
// spec: docs/editor/本地文件快捷跳转.md LFJ-007。安装目录的解析与存在性校验归主进程，
// 渲染层只传 skillId + target，不自持路径。
// ---------------------------------------------------------------------------

export const SkillRevealInstallFolderRequestSchema = z
  .object({
    skillId: z.string().min(1),
    target: SkillInstallTargetIdSchema,
  })
  .strict();

export type SkillRevealInstallFolderRequest = z.infer<typeof SkillRevealInstallFolderRequestSchema>;

export const SkillRevealInstallFolderResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum([
        'invalid-request',
        'unknown-target',
        'path-missing',
        'not-in-electron',
        'invoke-failed',
      ]),
    })
    .strict(),
]);

export type SkillRevealInstallFolderResult = z.infer<typeof SkillRevealInstallFolderResultSchema>;

// ---------------------------------------------------------------------------
// 自定义安装目标注册表 IPC：Hub renderer ↔ desktop-shell main
// （skills:list-custom-targets / add / update / remove）
//
// 内置两目标（SKILL_INSTALL_TARGETS）保持硬编码不进注册表；注册表只承载用户
// 自定义目标（目录来源为系统选择框，主进程只收已选取目录字符串）。
// 目标 id 是否可解析在 install/reveal 执行时裁定（unknown-target）。
// ---------------------------------------------------------------------------

/** 注册表条目：id 由主进程生成（`custom-` 前缀），name/skillsDir 来自用户输入与系统选择框。 */
export const CustomSkillInstallTargetSchema = z
  .object({
    id: SkillInstallTargetIdSchema,
    name: z.string().min(1).max(50),
    skillsDir: z.string().min(1).max(1024),
  })
  .strict();

export type CustomSkillInstallTarget = z.infer<typeof CustomSkillInstallTargetSchema>;

/**
 * 自定义目标管理操作的错误码。
 *   - invalid-request：请求非法（schema 不过或业务入参不合法，如 name 空白、dir 非绝对
 *     （含 `~` 展开后）路径、目标路径已存在但不是目录）。
 *   - duplicate-dir：目录与既有目标（内置或自定义）目录相同。update 时排除目标自身。
 *   - nested-dir：目录与既有目标目录互为祖先/后代。update 时排除目标自身。
 *   - reserved-dir：目录落在 app 自有数据目录（dev 与 prod 两个变体）之内或就是它。
 *   - not-found：按 id 未找到自定义目标（内置 id 传入 update/remove 同样按 not-found）。
 *   - unknown-target：install/reveal 执行时目标 id 解析不到（内置与注册表均未命中）。
 *   - persist-failed：注册表落盘失败。
 *   - invoke-failed：通用 IPC 失败（意外异常兜底）。
 */
export const SKILL_CUSTOM_TARGET_ERROR_CODES = [
  'invalid-request',
  'duplicate-dir',
  'nested-dir',
  'reserved-dir',
  'not-found',
  'unknown-target',
  'persist-failed',
  'invoke-failed',
] as const;

export const SkillCustomTargetErrorCodeSchema = z.enum(SKILL_CUSTOM_TARGET_ERROR_CODES);

export type SkillCustomTargetErrorCode = (typeof SKILL_CUSTOM_TARGET_ERROR_CODES)[number];

export const SkillListCustomTargetsResultSchema = z
  .object({
    targets: z.array(CustomSkillInstallTargetSchema),
  })
  .strict();

export type SkillListCustomTargetsResult = z.infer<typeof SkillListCustomTargetsResultSchema>;

export const SkillAddCustomTargetRequestSchema = z
  .object({
    name: z.string(),
    dir: z.string(),
  })
  .strict();

export type SkillAddCustomTargetRequest = z.infer<typeof SkillAddCustomTargetRequestSchema>;

/**
 * update 为全量提交：name 与 skillsDir 都必填（编辑自定义目标的名称与目录，不存在
 * 局部更新请求）。目录合法性（`~` 展开、绝对路径、重复/嵌套/reserved 防呆）由主进程
 * 重跑 add 的整套校验裁定，schema 只约束形状。
 */
export const SkillUpdateCustomTargetRequestSchema = z
  .object({
    id: SkillInstallTargetIdSchema,
    name: z.string(),
    skillsDir: z.string(),
  })
  .strict();

export type SkillUpdateCustomTargetRequest = z.infer<typeof SkillUpdateCustomTargetRequestSchema>;

export const SkillRemoveCustomTargetRequestSchema = z
  .object({
    id: SkillInstallTargetIdSchema,
  })
  .strict();

export type SkillRemoveCustomTargetRequest = z.infer<typeof SkillRemoveCustomTargetRequestSchema>;

/** add / update 的成功分支返回操作后的目标条目。 */
export const SkillCustomTargetMutationResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      target: CustomSkillInstallTargetSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: SkillCustomTargetErrorCodeSchema,
    })
    .strict(),
]);

export type SkillCustomTargetMutationResult = z.infer<typeof SkillCustomTargetMutationResultSchema>;

export const SkillRemoveCustomTargetResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: SkillCustomTargetErrorCodeSchema,
    })
    .strict(),
]);

export type SkillRemoveCustomTargetResult = z.infer<typeof SkillRemoveCustomTargetResultSchema>;

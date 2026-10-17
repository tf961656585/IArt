/**
 * Skill 自定义安装目标注册表（main 进程私有持久化）。
 *
 * spec: docs/hub/skill-store.md
 *
 * 内置两目标（agents/claude）保持硬编码不进注册表；内置根目录映射
 * （BUILTIN_TARGET_ROOT_DIRS）自 installer 移入本模块，供防呆比对与安装解析共用，
 * 避免互相 import 成环。本模块只承载用户自定义目标的增删改查：
 *
 *   - 持久化文件：<appDataDir>/skill-install-targets.json（dev 为 ~/.iart-studio-dev，
 *     prod 为 ~/.iart-studio，dev/prod 变体机制与 editor-storage-recent-projects.cts 一致）。
 *   - 文件结构 { version: 1, targets: CustomSkillInstallTarget[] }；外层包装 schema 在本模块
 *     （主进程私有持久化，不跨进程，不作契约 owner），条目校验复用 contracts 的
 *     CustomSkillInstallTargetSchema。
 *   - 读取每次现读不缓存；外层形状（版本/数组）异常按空注册表处理（警告留痕，不阻塞后续
 *     写覆盖）；条目逐条形状守卫，非法条目丢弃并留 debug 日志（单条脏数据不丢整份注册表）。
 *   - 写入临时文件 + rename 原子写（照 skill-runtime-config-store 先例；非敏感数据无需 0600），
 *     落盘前用包装 schema 自检（不落读不回来的形状）。
 *
 * 防呆（add 时 O(n) 前缀判断，含尾部分隔符归一；update 重跑同一整套校验，仅重复/嵌套
 * 检查排除目标自身）：
 *   - 与既有目标目录（内置 + 自定义）相同 → duplicate-dir；
 *   - 互为祖先/后代 → nested-dir；
 *   - 落在 app 自有数据目录（dev 与 prod 两个变体）之内或就是它 → reserved-dir。
 *   - 目录输入先 trim，再展开 `~` / `~/...`（用户主目录；不支持 `~user`）；展开后必须
 *     绝对路径；已存在但不是目录 → invalid-request；不存在则创建（mkdir recursive）。
 *
 * remove/update 只改注册表条目，绝不触碰磁盘上已有的 skill 文件（用户数据保留）；
 * update 换目录时按 add 同规则创建新目录（不搬迁既有文件）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as z from "zod";

import {
  CustomSkillInstallTargetSchema,
  SKILL_INSTALL_TARGETS,
  type CustomSkillInstallTarget,
  type SkillAddCustomTargetRequest,
  type SkillCustomTargetErrorCode,
  type SkillInstallTarget,
  type SkillRemoveCustomTargetRequest,
  type SkillRemoveCustomTargetResult,
  type SkillUpdateCustomTargetRequest,
} from "@iart/contracts";
import { appendMainLog } from "../main-log.cjs";

// ---------------------------------------------------------------------------
// 内置目标目录事实（自 installer 移入；dev 模式不切换目标目录——第三方约定目录
// 与 app 自有目录的 dev 隔离无关）
// ---------------------------------------------------------------------------

export const BUILTIN_TARGET_ROOT_DIRS: Readonly<Record<SkillInstallTarget, string>> = {
  agents: ".agents",
  claude: ".claude",
};

/** 安装域统一的 HOME 解析（与 installer 原实现一致）：缺失即抛，由调用方裁定失败形态。 */
const resolveHomeDir = (): string => {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    throw new Error(
      "HOME or USERPROFILE env var is required to resolve skill install target dirs",
    );
  }
  return home;
};

/** 内置目标解析出的 skills 目录（agents → ~/.agents/skills/，claude → ~/.claude/skills/）。 */
export const resolveBuiltinTargetSkillsDir = (target: SkillInstallTarget): string =>
  path.join(resolveHomeDir(), BUILTIN_TARGET_ROOT_DIRS[target], "skills");

/** app 自有数据目录（dev 与 prod 两个变体都算，reserved-dir 防呆用）。 */
export const getAppOwnDataDirs = (): string[] => {
  const home = resolveHomeDir();
  return [path.join(home, ".iart-studio"), path.join(home, ".iart-studio-dev")];
};

/** 目标 id 是否为内置目标（'agents'/'claude'）。类型守卫：命中后可安全按内置目标解析。 */
export const isBuiltinTargetId = (id: string): id is SkillInstallTarget =>
  SKILL_INSTALL_TARGETS.some((builtin) => builtin === id);

// ---------------------------------------------------------------------------
// 注册表文件读写
// ---------------------------------------------------------------------------

/** 注册表文件定位：dev/prod 变体机制与 editor-storage-recent-projects.cts 一致。 */
const getRegistryFilePath = (): string => {
  const appDataDir =
    process.env["NODE_ENV"] === "development"
      ? path.join(os.homedir(), ".iart-studio-dev")
      : path.join(os.homedir(), ".iart-studio");
  return path.join(appDataDir, "skill-install-targets.json");
};

/**
 * 注册表文件外层包装 schema（主进程私有持久化，不跨进程）。
 * 条目复用 contracts 的 CustomSkillInstallTargetSchema；写入侧用它自检，
 * 读取侧逐条守卫（见 readRegistryFile），单条脏数据不丢整份注册表。
 */
const SkillInstallTargetsFileSchema = z
  .object({
    version: z.literal(1),
    targets: z.array(CustomSkillInstallTargetSchema),
  })
  .strict();

const readRegistryFile = (): CustomSkillInstallTarget[] => {
  const filePath = getRegistryFilePath();
  if (!fs.existsSync(filePath)) {
    console.debug("[skill-install-targets] 注册表文件不存在，按空注册表处理", { filePath });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(
      "[skill-install-targets] 注册表文件解析失败，按空注册表处理（不阻塞后续写覆盖）",
      { filePath, error: err instanceof Error ? err.message : String(err) },
    );
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    console.warn(
      "[skill-install-targets] 注册表文件版本/外层形状不识别，按空注册表处理（不阻塞后续写覆盖）",
      { filePath },
    );
    return [];
  }

  const rawTargets = (parsed as { targets?: unknown }).targets;
  if (!Array.isArray(rawTargets)) {
    console.warn(
      "[skill-install-targets] 注册表文件 targets 不是数组，按空注册表处理（不阻塞后续写覆盖）",
      { filePath },
    );
    return [];
  }

  const targets: CustomSkillInstallTarget[] = [];
  for (const item of rawTargets) {
    const entry = CustomSkillInstallTargetSchema.safeParse(item);
    if (entry.success) {
      targets.push(entry.data);
    } else {
      console.debug("[skill-install-targets] 丢弃非法注册表条目", {
        error: entry.error.message,
      });
    }
  }
  return targets;
};

const writeRegistryFile = (targets: CustomSkillInstallTarget[]): void => {
  // 落盘前自检：不落读不回来的形状（自检失败属实现缺陷，直接上抛由调用方兜底）。
  const fileCheck = SkillInstallTargetsFileSchema.safeParse({ version: 1, targets });
  if (!fileCheck.success) {
    throw new Error(`skill install targets registry payload invalid: ${fileCheck.error.message}`);
  }

  const filePath = getRegistryFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 原子写：临时文件 → rename（照 skill-runtime-config-store 先例）。
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(fileCheck.data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
};

// ---------------------------------------------------------------------------
// 对外 API（同步风格，与 installer 现状一致）
// ---------------------------------------------------------------------------

/** 列出全部自定义安装目标（每次现读注册表，不缓存）。 */
export const listCustomSkillInstallTargets = (): CustomSkillInstallTarget[] => readRegistryFile();

/** 目录归一：trim → `~` / `~/...` 展开（用户主目录；不支持 `~user`）→ 必须为绝对路径，
 *  path.resolve 归一（顺带去尾部分隔符）。非绝对路径返回 null。 */
const normalizeSkillsDir = (dir: string): string | null => {
  const trimmed = dir.trim();
  let expanded = trimmed;
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    let home: string;
    try {
      home = resolveHomeDir();
    } catch (err) {
      // HOME 不可解析时 `~` 无法展开：按非法路径处理（调用方按 invalid-request 返回）
      appendMainLog("debug", "[skill-install-targets] 目录含 `~` 但主目录不可解析，拒绝", {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    expanded = trimmed === "~" ? home : path.join(home, trimmed.slice(2));
  }
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
};

/** 互为祖先/后代（前缀判断含尾部分隔符归一；相同目录不在此列）。 */
const isNestedDir = (a: string, b: string): boolean =>
  a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

/** 目录落在 app 自有数据目录（dev 与 prod 两个变体）之内或就是它。 */
const isReservedDir = (candidate: string): boolean =>
  getAppOwnDataDirs().some(
    (appDataDir) => candidate === appDataDir || candidate.startsWith(appDataDir + path.sep),
  );

/**
 * add / update 共用的目标目录校验（update 重跑 add 的整套校验，仅「重复/嵌套」排除自身）。
 *
 * 顺序与错误码：
 *   1. 归一后非绝对路径 → invalid-request（相对路径与非 `~` 展开拒绝）
 *   2. 与既有目标（内置 + 自定义，excludeId 排除自身）目录相同 → duplicate-dir
 *   3. 互为祖先/后代 → nested-dir
 *   4. 落在 app 自有数据目录 → reserved-dir
 *   5. 已存在但不是目录 → invalid-request；不存在则创建（mkdir recursive）
 *
 * 校验拒绝分支走主进程文件日志（logs/main.log）——打包态 GUI 主进程 console 无输出，
 * 仅 console 不构成有效留痕（AGENTS「条件跳过必须留痕」）。
 */
const prepareSkillsDir = (
  rawDir: string,
  existingTargets: Array<{ id: string; skillsDir: string }>,
  operation: "add" | "update",
): { ok: true; skillsDir: string } | { ok: false; error: SkillCustomTargetErrorCode } => {
  const candidate = normalizeSkillsDir(rawDir);
  if (candidate === null) {
    appendMainLog("debug", `[skill-install-targets] ${operation}: 目录不是绝对路径，拒绝`, {
      dir: rawDir,
    });
    return { ok: false, error: "invalid-request" };
  }

  for (const existing of existingTargets) {
    if (candidate === existing.skillsDir) {
      appendMainLog("debug", `[skill-install-targets] ${operation}: 目录与既有目标相同`, {
        dir: candidate,
        target: existing.id,
      });
      return { ok: false, error: "duplicate-dir" };
    }
    if (isNestedDir(candidate, existing.skillsDir)) {
      appendMainLog("debug", `[skill-install-targets] ${operation}: 目录与既有目标互为祖先/后代`, {
        dir: candidate,
        target: existing.id,
      });
      return { ok: false, error: "nested-dir" };
    }
  }

  if (isReservedDir(candidate)) {
    appendMainLog("debug", `[skill-install-targets] ${operation}: 目录落在 app 自有数据目录内`, {
      dir: candidate,
    });
    return { ok: false, error: "reserved-dir" };
  }

  const existingStat = fs.statSync(candidate, { throwIfNoEntry: false });
  if (existingStat !== undefined) {
    if (!existingStat.isDirectory()) {
      appendMainLog("debug", `[skill-install-targets] ${operation}: 目标已存在但不是目录，拒绝`, {
        dir: candidate,
      });
      return { ok: false, error: "invalid-request" };
    }
  } else {
    // 目录不存在则创建（创建失败属意外异常，上抛由 IPC 层按 invoke-failed 兜底）。
    fs.mkdirSync(candidate, { recursive: true });
    appendMainLog("debug", `[skill-install-targets] ${operation}: 目标目录不存在，已创建`, {
      dir: candidate,
    });
  }

  return { ok: true, skillsDir: candidate };
};

/** 既有目标目录集合（内置 + 自定义）；excludeId 用于 update 排除自身。 */
const collectExistingTargetDirs = (
  customs: CustomSkillInstallTarget[],
  excludeId: string | null,
): Array<{ id: string; skillsDir: string }> => [
  ...SKILL_INSTALL_TARGETS.map((target) => ({
    id: target,
    skillsDir: resolveBuiltinTargetSkillsDir(target),
  })),
  ...customs
    .filter((entry) => entry.id !== excludeId)
    .map((entry) => ({ id: entry.id, skillsDir: entry.skillsDir })),
];

export const addCustomSkillInstallTarget = (
  input: SkillAddCustomTargetRequest,
): { ok: true; target: CustomSkillInstallTarget } | { ok: false; error: SkillCustomTargetErrorCode } => {
  const name = input.name.trim();
  if (name.length === 0) {
    appendMainLog("debug", "[skill-install-targets] add: name 为空白，拒绝", undefined);
    return { ok: false, error: "invalid-request" };
  }

  const customs = readRegistryFile();
  const prepared = prepareSkillsDir(input.dir, collectExistingTargetDirs(customs, null), "add");
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const candidate = prepared.skillsDir;

  // id 生成：custom- + 随机 hex；与既有 id 冲突则重生成。
  const existingIds = new Set(customs.map((entry) => entry.id));
  let id = `custom-${crypto.randomBytes(4).toString("hex")}`;
  while (existingIds.has(id)) {
    id = `custom-${crypto.randomBytes(4).toString("hex")}`;
  }

  const target: CustomSkillInstallTarget = { id, name, skillsDir: candidate };
  try {
    writeRegistryFile([...customs, target]);
  } catch (err) {
    appendMainLog("warn", "[skill-install-targets] add: 注册表落盘失败", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "persist-failed" };
  }
  return { ok: true, target };
};

/**
 * 编辑自定义目标（名称 + 目录，全量提交）。
 * 目录侧重跑 add 的整套校验（重复/嵌套检查排除自身：只改名的记录不得与自己已占用的
 * 目录冲突；改到别的目标目录照常报 duplicate-dir / nested-dir）。
 */
export const updateCustomSkillInstallTarget = (
  input: SkillUpdateCustomTargetRequest,
): { ok: true; target: CustomSkillInstallTarget } | { ok: false; error: SkillCustomTargetErrorCode } => {
  const name = input.name.trim();
  if (name.length === 0) {
    appendMainLog("debug", "[skill-install-targets] update: name 为空白，拒绝", undefined);
    return { ok: false, error: "invalid-request" };
  }
  // 内置目标不在注册表（硬编码管理）：显式拦截，视同 not-found。
  if (isBuiltinTargetId(input.id)) {
    appendMainLog("debug", "[skill-install-targets] update: 内置目标不接受编辑", { id: input.id });
    return { ok: false, error: "not-found" };
  }

  const targets = readRegistryFile();
  const existing = targets.find((entry) => entry.id === input.id);
  if (existing === undefined) {
    appendMainLog("debug", "[skill-install-targets] update: 目标 id 不在注册表", { id: input.id });
    return { ok: false, error: "not-found" };
  }

  const prepared = prepareSkillsDir(
    input.skillsDir,
    collectExistingTargetDirs(targets, input.id),
    "update",
  );
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const updated: CustomSkillInstallTarget = {
    ...existing,
    name,
    skillsDir: prepared.skillsDir,
  };
  try {
    writeRegistryFile(targets.map((entry) => (entry.id === input.id ? updated : entry)));
  } catch (err) {
    appendMainLog("warn", "[skill-install-targets] update: 注册表落盘失败", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "persist-failed" };
  }
  return { ok: true, target: updated };
};

export const removeCustomSkillInstallTarget = (
  input: SkillRemoveCustomTargetRequest,
): SkillRemoveCustomTargetResult => {
  // 内置目标不在注册表（硬编码管理）：显式拦截，视同 not-found。
  if (isBuiltinTargetId(input.id)) {
    console.debug("[skill-install-targets] remove: 内置目标不可移除", { id: input.id });
    return { ok: false, error: "not-found" };
  }

  const targets = readRegistryFile();
  const next = targets.filter((entry) => entry.id !== input.id);
  if (next.length === targets.length) {
    console.debug("[skill-install-targets] remove: 目标 id 不在注册表", { id: input.id });
    return { ok: false, error: "not-found" };
  }

  // 只删注册表条目，绝不触碰磁盘上的 skill 文件（用户数据保留）。
  try {
    writeRegistryFile(next);
  } catch (err) {
    console.warn("[skill-install-targets] remove: 注册表落盘失败", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "persist-failed" };
  }
  return { ok: true };
};

// 测试导出
export const __test_only__ = {
  getRegistryFilePath,
  readRegistryFile,
  writeRegistryFile,
  normalizeSkillsDir,
  isNestedDir,
  isReservedDir,
  isBuiltinTargetId,
  BUILTIN_TARGET_ROOT_DIRS,
  resolveBuiltinTargetSkillsDir,
  getAppOwnDataDirs,
};

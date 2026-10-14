/**
 * skill 安装器。
 *
 * spec: docs/hub/skill-store.md
 *
 * 主进程提供 skill 安装能力：按 bundle URL 下载、sha512 校验、bundle parse、
 * 文件路径安全校验、写入目标目录、脚本 chmod +x。
 * 每条失败路径写 logs/main.log 留痕并携带具体原因（经 SkillInstallResult.error
 * 同步透传到 Hub UI），排查不依赖 console。
 *
 * 安装行为：
 *   - 目标解析：内置目标（agents → ~/.agents/skills/，claude → ~/.claude/skills/）硬编码；
 *     自定义目标查注册表（skill-install-targets-store，现读）。解析不到按 unknown-target 拒绝。
 *   - 覆盖安装先整目录删除再写（skill 全是文本小文件，无需增量）。
 *   - 写入 <target>/skills/<id>/。
 *   - 可执行文件（bundle 内 executable: true）chmod 0o755。
 *   - dev 模式不切换目标目录（第三方约定目录，与 app 自有目录的 dev 隔离无关）。
 *
 * 安全：
 *   - bundle 下载后必须经 SkillBundleSchema parse。
 *   - 文件路径拒绝绝对路径与 .. 穿越。
 *   - sha512 不匹配拒绝。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import {
  SKILL_INSTALL_TARGETS,
  SkillBundleSchema,
  type SkillBundle,
  type SkillInstallRequest,
  type SkillInstallResult,
  type SkillInstalledState,
  type SkillInstalledStateEntry,
} from "@iart/contracts";

import {
  isBuiltinTargetId,
  listCustomSkillInstallTargets,
  resolveBuiltinTargetSkillsDir,
} from "./skill-install-targets-store.cjs";

import { appendMainLog } from "../main-log.cjs";

/**
 * bundle 下载器：主进程出站请求的唯一传输入口。
 *
 * 生产接线传 Electron `net.fetch`（默认走 default session，session 级代理配置对其生效，
 * spec docs/runtime/远端请求执行治理原则.md「代理治理」验收 PROXY-003——主进程不自行
 * 解析代理）；测试可注入任意同形 fetch（Node 全局 fetch / 假实现）。
 */
export type BundleFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * 解析安装目标的 skills 目录绝对路径。
 * 内置目标：agents → ~/.agents/skills/，claude → ~/.claude/skills/（dev 模式不切换，
 * 第三方约定目录与 app 自有目录的 dev 隔离无关）。
 * 自定义目标：查注册表（现读，条目的 skillsDir 在登记时已归一为绝对路径）。
 * 内置与注册表均未命中返回 null，由调用方按 unknown-target 处理（install 与 reveal
 * 两条链都容错）。内置目标的 HOME 缺失仍按原行为抛错（安装环境缺失，非目标未知）。
 */
export const resolveTargetSkillsDir = (target: string): string | null => {
  if (isBuiltinTargetId(target)) {
    return resolveBuiltinTargetSkillsDir(target);
  }
  const custom = listCustomSkillInstallTargets().find((entry) => entry.id === target);
  return custom !== undefined ? custom.skillsDir : null;
};

/**
 * 文件路径安全校验：必须相对、不得含 .. 或绝对路径。
 */
const isSafeRelativePath = (relPath: string): boolean => {
  if (path.isAbsolute(relPath)) return false;
  if (relPath.includes("..")) return false;
  if (relPath.startsWith("/")) return false;
  return true;
};

/**
 * 下载 bundle JSON 字符串并校验 sha512。
 *
 * 不设超时（与远端请求治理原则一致）；重定向由 fetch 语义原生跟随，不再手写重定向；
 * 代理治理由注入的 fetcher 承载（生产 = net.fetch → default session）。失败抛错。
 */
const downloadBundleJson = async (
  bundleUrl: string,
  expectedSha512: string,
  fetchBundle: BundleFetcher,
): Promise<string> => {
  let response: Awaited<ReturnType<BundleFetcher>>;
  try {
    response = await fetchBundle(bundleUrl);
  } catch (err) {
    throw new Error(`bundle 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`bundle download failed: HTTP ${response.status} for ${bundleUrl}`);
  }
  // bundle 是内联全部文件的 JSON（小文本），整包缓冲后一次性计算 sha512
  const buffer = Buffer.from(await response.arrayBuffer());
  const hexDigest = crypto.createHash("sha512").update(buffer).digest("hex");
  if (hexDigest !== expectedSha512) {
    throw new Error(
      `bundle sha512 mismatch for ${bundleUrl}: expected ${expectedSha512}, got ${hexDigest}`,
    );
  }
  return buffer.toString("utf8");
};

/**
 * 安装失败全分支留痕（logs/main.log）：安装链每一条失败路径都必须有文件日志，
 * 否则 Windows 真机排查只能盲猜（历史上下载/写盘失败全部无痕、UI 只显示统一文案）。
 */
const logInstallFailure = (
  stage: string,
  request: SkillInstallRequest,
  detail: string,
): void => {
  appendMainLog("warn", `[skill-store] install failed at ${stage}`, {
    skillId: request.skillId,
    target: request.target,
    detail,
  });
};

/**
 * 安装单个 skill bundle。
 *
 * 入参经 SkillInstallRequestSchema parse（调用方负责）；返回经 SkillInstallResultSchema parse。
 * fetchBundle 必传（调用方按运行环境选择传输入口，见 BundleFetcher 注释）。
 */
export const installSkill = async (
  request: SkillInstallRequest,
  fetchBundle: BundleFetcher,
): Promise<SkillInstallResult> => {
  appendMainLog("info", "[skill-store] install start", {
    skillId: request.skillId,
    target: request.target,
    bundleUrl: request.bundleUrl,
  });

  // 1. 解析目标目录（内置命中或注册表命中；解析不到按 unknown-target 拒绝，
  //    错误码语义对齐 contracts SKILL_CUSTOM_TARGET_ERROR_CODES.unknown-target。
  //    在下载前先裁定，避免对无法安装的目标发起网络请求）
  let skillsRoot: string | null = null;
  try {
    skillsRoot = resolveTargetSkillsDir(request.target);
  } catch (err) {
    // 内置目标 HOME 缺失等环境问题会从这里抛出（resolveBuiltinTargetSkillsDir 契约）
    const message = err instanceof Error ? err.message : String(err);
    logInstallFailure("target-resolve-throw", request, message);
    return { ok: false, error: `安装目标解析失败: ${message}` };
  }
  if (skillsRoot === null) {
    logInstallFailure("unknown-target", request, "内置与注册表均未命中");
    return { ok: false, error: "unknown-target" };
  }

  // 2. 下载 + sha512 校验
  let bundleJson: string;
  try {
    bundleJson = await downloadBundleJson(request.bundleUrl, request.sha512, fetchBundle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInstallFailure("download", request, message);
    return { ok: false, error: `下载失败: ${message}` };
  }

  // 3. bundle parse
  let parsedBundle: unknown;
  try {
    parsedBundle = JSON.parse(bundleJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInstallFailure("bundle-json-parse", request, message);
    return { ok: false, error: `bundle 不是合法 JSON: ${message}` };
  }
  const bundleResult = SkillBundleSchema.safeParse(parsedBundle);
  if (!bundleResult.success) {
    logInstallFailure("bundle-schema", request, bundleResult.error.message);
    return { ok: false, error: `bundle 结构校验失败: ${bundleResult.error.message}` };
  }
  const bundle: SkillBundle = bundleResult.data;

  // bundle id 必须与请求的 skillId 一致
  if (bundle.id !== request.skillId) {
    logInstallFailure("bundle-id-mismatch", request, `bundle id ${bundle.id} != 请求 skillId ${request.skillId}`);
    return {
      ok: false,
      error: `bundle id (${bundle.id}) 与请求 skillId (${request.skillId}) 不一致`,
    };
  }

  // 4. 写入目标目录
  const installDir = path.join(skillsRoot, bundle.id);

  try {
    // 覆盖安装：先整目录删除（skill 全是文本小文件，无需增量）
    if (fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true });
    }
    fs.mkdirSync(installDir, { recursive: true });

    // 逐文件写入
    for (const file of bundle.files) {
      if (!isSafeRelativePath(file.path)) {
        // 清理已写入的部分
        fs.rmSync(installDir, { recursive: true, force: true });
        logInstallFailure("unsafe-path", request, file.path);
        return { ok: false, error: `不安全的文件路径（拒绝绝对路径或 .. 穿越）: ${file.path}` };
      }
      const filePath = path.join(installDir, file.path);
      const fileDir = path.dirname(filePath);
      fs.mkdirSync(fileDir, { recursive: true });
      fs.writeFileSync(filePath, file.content, "utf8");
      if (file.executable) {
        fs.chmodSync(filePath, 0o755);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInstallFailure("write", request, message);
    return { ok: false, error: `写入失败: ${message}` };
  }

  appendMainLog("info", "[skill-store] install done", {
    skillId: request.skillId,
    target: request.target,
    installedPath: installDir,
  });
  return { ok: true, installedPath: installDir };
};

/**
 * 读取已安装状态：扫描内置两目标 + 注册表全部自定义目标，返回每个 skill 的 id+version。
 *
 * version 从安装目录下的 skill.json 读取（安装时随 bundle 写入）。
 * 目标解析不到或目录不存在时跳过并留 debug 日志（条件跳过必须留痕）。
 */
export const getInstalledSkillState = (): SkillInstalledState => {
  const entries: SkillInstalledStateEntry[] = [];

  // 扫描范围 = 内置两目标 + 注册表全部自定义目标（现读；custom- 前缀保证与内置 id 不重）。
  const targetIds: string[] = [
    ...SKILL_INSTALL_TARGETS,
    ...listCustomSkillInstallTargets().map((entry) => entry.id),
  ];

  for (const target of targetIds) {
    const skillsRoot = resolveTargetSkillsDir(target);
    if (skillsRoot === null) {
      console.debug("[skill-store] installed state: target 解析不到，跳过", { target });
      continue;
    }
    if (!fs.existsSync(skillsRoot)) {
      console.debug("[skill-store] installed state: 目标目录不存在，跳过", {
        target,
        skillsRoot,
      });
      continue;
    }

    let skillDirs: string[] = [];
    try {
      skillDirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err) {
      console.debug("[skill-store] installed state: 目标目录读取失败，跳过", {
        target,
        skillsRoot,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const skillId of skillDirs) {
      const skillJsonPath = path.join(skillsRoot, skillId, "skill.json");
      if (!fs.existsSync(skillJsonPath)) continue;
      try {
        const raw = fs.readFileSync(skillJsonPath, "utf8");
        const meta = JSON.parse(raw) as { id?: unknown; version?: unknown };
        if (typeof meta.id === "string" && typeof meta.version === "string") {
          entries.push({ skillId: meta.id, version: meta.version, target });
        }
      } catch {
        // 跳过无效 skill.json
      }
    }
  }

  return { skills: entries };
};

// 测试导出（BundleFetcher 类型已在上方随声明导出）
export const __test_only__ = {
  isSafeRelativePath,
  resolveTargetSkillsDir,
  downloadBundleJson,
};

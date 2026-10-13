/**
 * skill 安装器。
 *
 * spec: docs/hub/skill-store.md
 *
 * 主进程提供 skill 安装能力：按 bundle URL 下载、sha512 校验、bundle parse、
 * 文件路径安全校验、写入目标目录、脚本 chmod +x。
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
import * as https from "node:https";
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

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
 * 下载 bundle JSON 字符串，流式计算 sha512 并校验。
 *
 * 不设超时（与远端请求治理原则一致；skill bundle 是小文本文件，下载很快但不设硬超时）。
 * 失败抛错。
 */
const downloadBundleJson = (
  bundleUrl: string,
  expectedSha512: string,
): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const hash = crypto.createHash("sha512");

    const handleResponse = (response: IncomingMessage): void => {
      // 单层重定向
      if (
        response.statusCode !== null &&
        response.statusCode !== undefined &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        const client = response.headers.location.startsWith("https:") ? https : http;
        client
          .get(response.headers.location, handleResponse)
          .on("error", (err) => reject(err));
        return;
      }

      if (
        response.statusCode !== null &&
        response.statusCode !== undefined &&
        (response.statusCode < 200 || response.statusCode >= 300)
      ) {
        reject(new Error(`bundle download failed: HTTP ${response.statusCode} for ${bundleUrl}`));
        return;
      }

      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        hash.update(chunk);
      });
      response.on("end", () => {
        const hexDigest = hash.digest("hex");
        if (hexDigest !== expectedSha512) {
          reject(
            new Error(
              `bundle sha512 mismatch for ${bundleUrl}: expected ${expectedSha512}, got ${hexDigest}`,
            ),
          );
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      response.on("error", (err) => reject(err));
    };

    const client = bundleUrl.startsWith("https:") ? https : http;
    client
      .get(bundleUrl, handleResponse)
      .on("error", (err) => reject(err));
  });
};

/**
 * 安装单个 skill bundle。
 *
 * 入参经 SkillInstallRequestSchema parse（调用方负责）；返回经 SkillInstallResultSchema parse。
 */
export const installSkill = async (request: SkillInstallRequest): Promise<SkillInstallResult> => {
  // 1. 解析目标目录（内置命中或注册表命中；解析不到按 unknown-target 拒绝，
  //    错误码语义对齐 contracts SKILL_CUSTOM_TARGET_ERROR_CODES.unknown-target。
  //    在下载前先裁定，避免对无法安装的目标发起网络请求）
  const skillsRoot = resolveTargetSkillsDir(request.target);
  if (skillsRoot === null) {
    console.debug("[skill-store] install: target 解析不到（内置与注册表均未命中）", {
      target: request.target,
    });
    return { ok: false, error: "unknown-target" };
  }

  // 2. 下载 + sha512 校验
  let bundleJson: string;
  try {
    bundleJson = await downloadBundleJson(request.bundleUrl, request.sha512);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `下载失败: ${message}` };
  }

  // 3. bundle parse
  let parsedBundle: unknown;
  try {
    parsedBundle = JSON.parse(bundleJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `bundle 不是合法 JSON: ${message}` };
  }
  const bundleResult = SkillBundleSchema.safeParse(parsedBundle);
  if (!bundleResult.success) {
    return { ok: false, error: `bundle 结构校验失败: ${bundleResult.error.message}` };
  }
  const bundle: SkillBundle = bundleResult.data;

  // bundle id 必须与请求的 skillId 一致
  if (bundle.id !== request.skillId) {
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
    return { ok: false, error: `写入失败: ${message}` };
  }

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

// 测试导出
export const __test_only__ = {
  isSafeRelativePath,
  resolveTargetSkillsDir,
  downloadBundleJson,
};

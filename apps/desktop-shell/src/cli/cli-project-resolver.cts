import * as fs from "node:fs";
import * as path from "node:path";

import type { ProjectRegistryEntry } from "../storage/editor-storage-recent-projects.cjs";

/**
 * CLI `--project` 参数解析（spec docs/integrations/CLI与本地Agent集成.md §3 项目解析、
 * §5.1）：接受项目绝对路径或项目名；按名解析命中多个同名项目时必须报错
 * （project_name_ambiguous）并要求改用路径，不得静默选取（§10 同名项目）；
 * 解析不到一律 project_not_found（§9：路径不存在或不在注册表）。
 *
 * 解析规则：
 * - 值含路径分隔符或为绝对路径 → 按路径解析：normalize 后必须存在且为目录，
 *   否则 project_not_found；在册时携带注册表条目（名称与在册状态以注册表为准）。
 * - 否则按项目名在注册表中精确匹配：恰一个命中即解析成功；多个命中 → ambiguous；
 *   零命中 → not_found。
 */

export type CliResolvedProject = {
  /** 项目名：在册条目的名称；路径解析但不在册时取目录名。 */
  name: string;
  /** 规范化绝对路径。 */
  path: string;
  /** 注册表在册状态。 */
  registered: boolean;
  /** 命中的注册表条目；路径解析但不在册为 null。 */
  registryEntry: ProjectRegistryEntry | null;
};

export type CliProjectResolution =
  | { ok: true; project: CliResolvedProject }
  | { ok: false; code: "project_not_found" | "project_name_ambiguous"; message: string };

export type CliProjectRegistryReader = () => readonly ProjectRegistryEntry[];

const USER_FACING_NOT_FOUND = "没有找到这个项目：请提供项目在项目清单中的准确名称，或项目文件夹的绝对路径。";
const USER_FACING_AMBIGUOUS = "存在多个同名项目：请改用 --project 传入项目文件夹的绝对路径。";

export const resolveCliProject = (rawValue: string, readProjects: CliProjectRegistryReader): CliProjectResolution => {
  const value = rawValue.trim();
  const isPathLike = path.isAbsolute(value) || /[\\/]/.test(value);
  if (isPathLike) {
    const normalized = path.resolve(value);
    let isDirectory = false;
    try {
      isDirectory = fs.existsSync(normalized) && fs.statSync(normalized).isDirectory();
    } catch (error: unknown) {
      console.debug("[cli-project] 项目路径状态读取失败", {
        path: normalized,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isDirectory) {
      console.debug("[cli-project] 项目路径不存在或不是目录", { path: normalized });
      return { ok: false, code: "project_not_found", message: USER_FACING_NOT_FOUND };
    }
    const entry = readProjects().find((candidate) => candidate.path === normalized) ?? null;
    return {
      ok: true,
      project: {
        name: entry !== null ? entry.name : path.basename(normalized),
        path: normalized,
        registered: entry !== null,
        registryEntry: entry,
      },
    };
  }

  const matches = readProjects().filter((entry) => entry.name === value);
  if (matches.length > 1) {
    console.debug("[cli-project] 按名解析命中多个同名项目", { name: value, count: matches.length });
    return { ok: false, code: "project_name_ambiguous", message: USER_FACING_AMBIGUOUS };
  }
  const match = matches[0];
  if (match === undefined) {
    console.debug("[cli-project] 按名解析未命中注册表条目", { name: value });
    return { ok: false, code: "project_not_found", message: USER_FACING_NOT_FOUND };
  }
  return {
    ok: true,
    project: {
      name: match.name,
      path: match.path,
      registered: true,
      registryEntry: match,
    },
  };
};

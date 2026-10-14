/**
 * skill-store IPC handler 注册。
 *
 * spec: docs/hub/skill-store.md
 *
 * 通道：
 *   - skills:get-installed-state：扫描内置两目标 + 注册表自定义目标，返回已安装 id+version
 *   - skills:install：入参含 bundleUrl、sha512、target、skillId
 *   - skills:reveal-install-folder：定位 skill 安装目录（docs/editor/本地文件快捷跳转.md LFJ-007）
 *   - skills:list-custom-targets / add / update / remove：自定义安装目标注册表管理
 *     （目录来源为系统选择框 selectFolder，主进程只收已选取目录字符串）
 *
 * 入参与返回均经 packages/contracts 的 Zod schema parse（IPC 边界规范）；
 * 管理通道的意外异常按 invoke-failed 兜底，不向渲染层抛裸异常。
 */

import { ipcMain, net, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  SKILL_IPC_CHANNELS,
  SkillAddCustomTargetRequestSchema,
  SkillCustomTargetMutationResultSchema,
  SkillInstallRequestSchema,
  SkillInstallResultSchema,
  SkillInstalledStateSchema,
  SkillListCustomTargetsResultSchema,
  SkillRemoveCustomTargetRequestSchema,
  SkillRemoveCustomTargetResultSchema,
  SkillRevealInstallFolderRequestSchema,
  SkillRevealInstallFolderResultSchema,
  SkillUpdateCustomTargetRequestSchema,
  type SkillCustomTargetMutationResult,
  type SkillRemoveCustomTargetResult,
} from "@iart/contracts";

import { getInstalledSkillState, installSkill, resolveTargetSkillsDir } from "./skill-store-installer.cjs";
import {
  addCustomSkillInstallTarget,
  listCustomSkillInstallTargets,
  removeCustomSkillInstallTarget,
  updateCustomSkillInstallTarget,
} from "./skill-install-targets-store.cjs";
import { appendMainLog } from "../main-log.cjs";

/** 管理通道（add/update）统一执行：意外异常按 invoke-failed 兜底并留主进程日志，出参经 contracts schema 构造。 */
const runCustomTargetMutation = (
  operation: () => SkillCustomTargetMutationResult,
): SkillCustomTargetMutationResult => {
  try {
    return SkillCustomTargetMutationResultSchema.parse(operation());
  } catch (err) {
    appendMainLog("warn", "[skill-store] custom target mutation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return SkillCustomTargetMutationResultSchema.parse({ ok: false, error: "invoke-failed" });
  }
};

/** remove 通道统一执行：意外异常按 invoke-failed 兜底并留主进程日志，出参经 contracts schema 构造。 */
const runCustomTargetRemoval = (
  operation: () => SkillRemoveCustomTargetResult,
): SkillRemoveCustomTargetResult => {
  try {
    return SkillRemoveCustomTargetResultSchema.parse(operation());
  } catch (err) {
    appendMainLog("warn", "[skill-store] custom target removal failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return SkillRemoveCustomTargetResultSchema.parse({ ok: false, error: "invoke-failed" });
  }
};

export const registerSkillStoreIpcHandlers = (): void => {
  ipcMain.handle(SKILL_IPC_CHANNELS.GET_INSTALLED_STATE, () => {
    try {
      const state = getInstalledSkillState();
      return SkillInstalledStateSchema.parse(state);
    } catch (err) {
      // 状态扫描失败不静默：留主进程文件日志后原样抛出，渲染层按既有兜底回退空状态
      appendMainLog("warn", "[skill-store] get-installed-state failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  ipcMain.handle(SKILL_IPC_CHANNELS.INSTALL, async (_event, payload: unknown) => {
    const parsed = SkillInstallRequestSchema.safeParse(payload);
    if (!parsed.success) {
      appendMainLog("warn", "[skill-store] install: invalid request payload", {
        issue: parsed.error.message,
      });
      return SkillInstallResultSchema.parse({
        ok: false,
        error: `安装请求参数无效: ${parsed.error.message}`,
      });
    }
    try {
      // 主进程出站统一走 default session 的 Chromium 网络栈（net.fetch），session 级代理
      // 配置对其生效（spec docs/runtime/远端请求执行治理原则.md「代理治理」PROXY-003）。
      const result = await installSkill(parsed.data, (url) => net.fetch(url));
      return SkillInstallResultSchema.parse(result);
    } catch (err) {
      // installSkill 内部失败均已自行返回结构化结果；走到这里的只应是意外异常
      // （如 contracts 依赖缺失、不可预期的运行时错误），必须留主进程文件日志
      appendMainLog("error", "[skill-store] install: unexpected exception", {
        skillId: parsed.data.skillId,
        target: parsed.data.target,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      return SkillInstallResultSchema.parse({
        ok: false,
        error: `安装过程异常: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // 定位 skill 安装目录（LFJ-007）：安装目录解析与存在性校验归主进程，
  // 渲染层只传 skillId + target。定位目录本身（高亮目录，不进入其内部）。
  ipcMain.handle(SKILL_IPC_CHANNELS.REVEAL_INSTALL_FOLDER, async (_event, payload: unknown) => {
    const parsed = SkillRevealInstallFolderRequestSchema.safeParse(payload);
    if (!parsed.success) {
      appendMainLog("info", "[skill-store] reveal install folder: invalid request", {
        issue: parsed.error.message,
      });
      return SkillRevealInstallFolderResultSchema.parse({ ok: false, reason: "invalid-request" });
    }

    const resolvedSkillsRoot = resolveTargetSkillsDir(parsed.data.target);
    if (resolvedSkillsRoot === null) {
      appendMainLog("info", "[skill-store] reveal install folder: target 解析不到", {
        target: parsed.data.target,
        skillId: parsed.data.skillId,
      });
      return SkillRevealInstallFolderResultSchema.parse({ ok: false, reason: "unknown-target" });
    }

    const skillsRoot = path.resolve(resolvedSkillsRoot);
    const installDir = path.resolve(path.join(skillsRoot, parsed.data.skillId));
    // skillId 来自远端目录数据，拒绝路径穿越（解析后必须仍位于目标根内）
    if (!installDir.startsWith(skillsRoot + path.sep)) {
      appendMainLog("info", "[skill-store] reveal install folder: skillId escapes target root", {
        skillId: parsed.data.skillId,
      });
      return SkillRevealInstallFolderResultSchema.parse({ ok: false, reason: "invalid-request" });
    }

    const stat = await fs.promises.stat(installDir).catch(() => null);
    if (!(stat !== null && stat !== undefined ? stat.isDirectory() : undefined)) {
      appendMainLog("info", "[skill-store] reveal install folder: install dir missing", {
        installDir,
      });
      return SkillRevealInstallFolderResultSchema.parse({ ok: false, reason: "path-missing" });
    }

    shell.showItemInFolder(installDir);
    return SkillRevealInstallFolderResultSchema.parse({ ok: true, path: installDir });
  });

  // ---- 自定义安装目标注册表管理（Hub 弹层统一管理） ----

  ipcMain.handle(SKILL_IPC_CHANNELS.LIST_CUSTOM_TARGETS, () =>
    SkillListCustomTargetsResultSchema.parse({
      targets: listCustomSkillInstallTargets(),
    }),
  );

  ipcMain.handle(SKILL_IPC_CHANNELS.ADD_CUSTOM_TARGET, (_event, payload: unknown) =>
    runCustomTargetMutation((): SkillCustomTargetMutationResult => {
      const parsed = SkillAddCustomTargetRequestSchema.safeParse(payload);
      if (!parsed.success) {
        console.debug("[skill-store] add custom target: invalid request", {
          issue: parsed.error.message,
        });
        return { ok: false, error: "invalid-request" };
      }
      return addCustomSkillInstallTarget(parsed.data);
    }),
  );

  ipcMain.handle(SKILL_IPC_CHANNELS.UPDATE_CUSTOM_TARGET, (_event, payload: unknown) =>
    runCustomTargetMutation((): SkillCustomTargetMutationResult => {
      const parsed = SkillUpdateCustomTargetRequestSchema.safeParse(payload);
      if (!parsed.success) {
        console.debug("[skill-store] update custom target: invalid request", {
          issue: parsed.error.message,
        });
        return { ok: false, error: "invalid-request" };
      }
      return updateCustomSkillInstallTarget(parsed.data);
    }),
  );

  ipcMain.handle(SKILL_IPC_CHANNELS.REMOVE_CUSTOM_TARGET, (_event, payload: unknown) =>
    runCustomTargetRemoval((): SkillRemoveCustomTargetResult => {
      const parsed = SkillRemoveCustomTargetRequestSchema.safeParse(payload);
      if (!parsed.success) {
        console.debug("[skill-store] remove custom target: invalid request", {
          issue: parsed.error.message,
        });
        return { ok: false, error: "invalid-request" };
      }
      return removeCustomSkillInstallTarget(parsed.data);
    }),
  );
};

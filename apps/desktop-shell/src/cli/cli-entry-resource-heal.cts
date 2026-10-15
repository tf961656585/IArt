import * as fs from "node:fs";
import * as path from "node:path";

/**
 * CLI 入口资源自愈（spec docs/integrations/CLI与本地Agent集成.md §3/§8 / CLI-036，2026-10-15
 * 批次）。兜底两类到达路径：
 * ①「从坏版本升级」——v0.6.8 打包配置错位（extraResources 的 from 为单文件、to 为不带尾
 *   斜杠的名字时，electron-builder 把 to 当目标文件名），产物 resources 下出现名为 cli 的
 *   无扩展名文件（内容恰是 cli-node-entry.cjs 本体，目录层级与扩展名丢失），CLI 全功能
 *   MODULE_NOT_FOUND，且用户「重新注册」「重启」均无法自助修复；
 * ②未来同类资源缺失/损坏。
 *
 * 语义（打包态，应用启动时由 GUI bootstrap fire-and-forget 调用）：
 * - `<resources>/cli/cli-node-entry.cjs` 存在且是常规文件 → 无事（healthy）；
 * - 名为 `cli` 的**文件**存在（错位态；Windows 同名文件与目录不能共存，文件占住了目录名位）
 *   → 先改名腾位（`cli.corrupt-<时间戳>`，保留现场供排查），再建目录、从源恢复；
 * - `<resources>/cli` 是目录但入口名位被非常规文件占用 → 同样腾位（`cli-node-entry.cjs.corrupt-<时间戳>`）后恢复；
 * - 入口缺失（无错位文件）→ 直接建目录、从源恢复。
 * 源为打包产物 app.asar 内的 `apps/desktop-shell/dist/cli/cli-node-entry.cjs`（Electron
 * patched fs 可直接读 asar 内文件；先读源、后动现场——源不可得时结构化失败且不破坏既有现场，
 * 避免把「错位但内容尚在」的状态降级成「什么都不剩」）。源内容为空视为损坏，不落空入口。
 *
 * 留痕与边界：结果由调用方落 `logs/main.log`（成功恢复记 info、失败记 warn，失败不阻断应用
 * 启动）；dev 形态不适用自愈（门控在调用方，与 resolveCliNodeEntryScriptPath 的打包判据同
 * 口径）。本模块不 import electron，只做注入路径上的纯 fs 逻辑，可测性即路径注入。
 */

/** 自愈结果：ok:true 时 outcome 区分四态；corruptBackupPath 仅在发生过腾位时非空。 */
export type CliEntryResourceHealResult =
  | {
      ok: true;
      outcome: "healthy" | "healed_misplaced" | "healed_damaged_entry" | "healed_missing";
      corruptBackupPath: string | null;
    }
  | { ok: false; message: string };

export interface CliEntryResourceHealDeps {
  /**
   * 打包安装的 resources 目录（生产态 process.resourcesPath；测试注入临时目录）。
   * 目标布局：`<resourcesDir>/cli/cli-node-entry.cjs`。
   */
  resourcesDir: string;
  /**
   * asar 内入口脚本绝对路径（生产态 `<app.getAppPath()>/apps/desktop-shell/dist/cli/cli-node-entry.cjs`；
   * Electron patched fs 直接读；测试注入真实普通文件替身）。
   */
  asarEntrySourcePath: string;
}

/** stat 安全封装：ENOENT/ENOTDIR（名位不可达——错位态下 `cli` 为文件时对其子路径 stat
 * 即 ENOTDIR）返回 null，其余异常抛出由主流程结构化收口。 */
const statOrNull = async (target: string): Promise<fs.Stats | null> => {
  try {
    return await fs.promises.stat(target);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw error;
  }
};

export const healCliEntryResource = async (
  deps: CliEntryResourceHealDeps,
): Promise<CliEntryResourceHealResult> => {
  const cliDirPath = path.join(deps.resourcesDir, "cli");
  const targetPath = path.join(cliDirPath, "cli-node-entry.cjs");

  try {
    // 1) 健康态短路：入口已是常规文件则无事（不校验内容/尺寸——打包校验面由
    //    verify:packaged-native-runtimes 承载，自愈只兜「缺位/错位」）。
    const targetStat = await statOrNull(targetPath);
    if (targetStat !== null && targetStat.isFile()) {
      return { ok: true, outcome: "healthy", corruptBackupPath: null };
    }

    // 2) 先读源、后动现场：源不可得（asar 缺文件、读失败）时不动任何既有现场。
    const sourceContent = await fs.promises.readFile(deps.asarEntrySourcePath);
    if (sourceContent.byteLength === 0) {
      return {
        ok: false,
        message: `入口资源源为空，放弃自愈（写入空入口等于换一种损坏）：${deps.asarEntrySourcePath}`,
      };
    }

    // 3) 腾位：错位态（名为 cli 的文件占住目录名位）优先；其次入口名位被非常规文件占用。
    let corruptBackupPath: string | null = null;
    let outcome: "healed_misplaced" | "healed_damaged_entry" | "healed_missing" = "healed_missing";
    const cliDirStat = await statOrNull(cliDirPath);
    if (cliDirStat !== null && !cliDirStat.isDirectory()) {
      const backupPath = `${cliDirPath}.corrupt-${Date.now()}`;
      await fs.promises.rename(cliDirPath, backupPath);
      corruptBackupPath = backupPath;
      outcome = "healed_misplaced";
    } else if (targetStat !== null) {
      // cliDir 是目录但 targetStat 非 null 且非常规文件（目录/其他）——腾位后恢复。
      const backupPath = `${targetPath}.corrupt-${Date.now()}`;
      await fs.promises.rename(targetPath, backupPath);
      corruptBackupPath = backupPath;
      outcome = "healed_damaged_entry";
    }

    // 4) 建目录并从源恢复。
    await fs.promises.mkdir(cliDirPath, { recursive: true });
    await fs.promises.writeFile(targetPath, sourceContent);

    return { ok: true, outcome, corruptBackupPath };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `CLI 入口资源自愈未完成（目标 ${targetPath}，源 ${deps.asarEntrySourcePath}）：${detail}`,
    };
  }
};

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * CLI 命令入口注册模块（spec docs/integrations/CLI与本地Agent集成.md §3 命令入口注册 /
 * §8 设置页一键注册 / CLI-016 幂等）。
 *
 * 形态：在用户可达的 PATH 目录放置指向应用可执行文件的**等价 shim**（非裸 symlink）——
 * shim 注入 `--cli` 启动参数，保证经入口启动的一律是 CLI 客户端模式（launch-mode 分流判据）：
 * - macOS/Linux：`#!/bin/sh` + `exec "<app-exec>" [app 入口参数] --cli "$@"`，chmod 0755；
 * - Windows：`iart.cmd` 内容 `@"<app-exec>" [app 入口参数] --cli %*`。
 * - app-exec：打包态为 process.execPath（应用可执行文件）；dev 态为 Electron 可执行文件 +
 *   当前启动入口文件（bootstrap 传 process.argv[1]，即 dist/main.cjs——Electron 需显式
 *   入口文件，dist 无 package.json 不能以目录自启动）。
 *
 * 目标目录（spec §3，平台分流）：
 * - macOS：/usr/local/bin/iart；
 * - Windows：%LOCALAPPDATA%\Microsoft\WindowsApps\iart.cmd；
 * - 其余平台不支持一键注册（状态按 null 承载，操作返回失败并引导手动注册）。
 *
 * 幂等（CLI-016）：目标已存在且内容一致 → no-op 成功；存在但内容不一致 → 覆盖（接管 iart
 * 名字）；卸除 → 仅当内容匹配本应用 shim 才删除（不删用户的同名物）。注册/卸除/状态各自
 * 留 debug 日志；失败结构化返回（不抛进 UI 层）。
 *
 * 可测性（CLI-016 测试关键缝）：目标目录与平台可注入；文件操作用临时目录真实 fs 验证。
 */

export const CLI_ENTRY_NAME_UNIX = "iart";
export const CLI_ENTRY_NAME_WINDOWS = "iart.cmd";

export type CliEntryPlatform = NodeJS.Platform;

export interface CliEntryRegistrationDeps {
  /** 入口目标目录（必须可注入：测试以临时目录验证，生产按平台默认解析）。 */
  targetDir: string;
  /** 应用可执行文件绝对路径（打包 process.execPath；dev 为 Electron 可执行文件）。 */
  appExecPath: string;
  /** 应用入口参数（dev 为 [app.getAppPath()]；打包为空数组）。 */
  appExecArgs: readonly string[];
  /** 平台；缺省 process.platform。 */
  platform?: CliEntryPlatform;
}

/** 一键注册结果：action 区分 created/overwritten/noop（幂等三态，供诊断与 UI 消息）。 */
export type CliEntryRegisterResult =
  | { ok: true; entryPath: string; action: "created" | "overwritten" | "noop" }
  | { ok: false; entryPath: string; message: string };

/** 卸除结果：removed=false 时 reason 区分 absent（本就未注册）与 foreign_content（同名他物不动）。 */
export type CliEntryUnregisterResult =
  | { ok: true; entryPath: string; removed: boolean; reason: "removed" | "absent" | "foreign_content" }
  | { ok: false; entryPath: string; message: string };

/** 状态三态（CLI-016）：registered=内容一致；missing=不存在；modified=存在但内容被改动。 */
export type CliEntryStatusResult =
  | { supported: true; entryPath: string; registered: boolean; state: "registered" | "missing" | "modified" }
  | { supported: false };

/** 平台是否支持一键注册（spec §3 目标目录分流；其余平台状态按 null 承载）。 */
const isPlatformSupported = (platform: CliEntryPlatform): boolean => platform === "darwin" || platform === "win32";

/** 入口文件名：Windows 用 .cmd（cmd 解释器按扩展名分派），其余平台无扩展名。 */
const entryFileName = (platform: CliEntryPlatform): string =>
  platform === "win32" ? CLI_ENTRY_NAME_WINDOWS : CLI_ENTRY_NAME_UNIX;

/**
 * 生产目标目录解析（测试不消费；目录可注入才是测试缝）。
 * Windows 取 %LOCALAPPDATA%（缺失回退 ~/AppData/Local）；macOS 固定 /usr/local/bin。
 */
export const resolveDefaultCliEntryTargetDir = (platform: CliEntryPlatform = process.platform): string | null => {
  if (platform === "win32") {
    const localAppData = (process.env["LOCALAPPDATA"] ?? "").trim();
    const base = localAppData.length > 0 ? localAppData : path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Microsoft", "WindowsApps");
  }
  if (platform === "darwin") return "/usr/local/bin";
  return null;
};

/** sh 双引号包裹：内嵌双引号转义（路径含引号是病态输入，转义兜底）。 */
const quoteForSh = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

/** cmd 双引号包裹：cmd 无嵌套双引号转义，病态路径不支撑（原样包裹）。 */
const quoteForCmd = (value: string): string => `"${value}"`;

/** 构造 shim 内容（注册与状态比对共用同一事实，内容漂移即 modified）。 */
export const buildCliEntryShimContent = (deps: {
  appExecPath: string;
  appExecArgs: readonly string[];
  platform: CliEntryPlatform;
}): string => {
  if (deps.platform === "win32") {
    const quoted = [deps.appExecPath, ...deps.appExecArgs].map(quoteForCmd).join(" ");
    return `@${quoted} --cli %*\r\n`;
  }
  const quoted = [deps.appExecPath, ...deps.appExecArgs].map(quoteForSh).join(" ");
  return `#!/bin/sh\nexec ${quoted} --cli "$@"\n`;
};

export const createCliEntryRegistration = (
  options: CliEntryRegistrationDeps,
): {
  registerEntry: () => Promise<CliEntryRegisterResult>;
  unregisterEntry: () => Promise<CliEntryUnregisterResult>;
  getEntryStatus: () => Promise<CliEntryStatusResult>;
} => {
  const platform = options.platform ?? process.platform;
  const entryPath = path.join(options.targetDir, entryFileName(platform));
  const desiredContent = buildCliEntryShimContent({
    appExecPath: options.appExecPath,
    appExecArgs: options.appExecArgs,
    platform,
  });

  /**
   * 手动注册指引命令（一键注册权限失败时的可复制等价动作）：与 writeShim 写入的 shim
   * 同一形态（shebang + exec + --cli），printf 单引号格式串保护内嵌双引号路径。
   */
  const manualInstallCommand = (): string => {
    const quoted = [options.appExecPath, ...options.appExecArgs].map(quoteForSh).join(" ");
    return `printf '#!/bin/sh\\nexec ${quoted} --cli "$@"\\n' | sudo tee ${entryPath} && sudo chmod +x ${entryPath}`;
  };

  const readExistingContent = async (): Promise<string | null> => {
    try {
      return await fs.promises.readFile(entryPath, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };

  const writeShim = async (): Promise<void> => {
    await fs.promises.mkdir(options.targetDir, { recursive: true });
    await fs.promises.writeFile(entryPath, desiredContent, { encoding: "utf8" });
    if (platform !== "win32") {
      await fs.promises.chmod(entryPath, 0o755);
    }
  };

  const unsupportedResult = (action: "register" | "unregister"): string =>
    action === "register"
      ? "当前系统暂不支持一键注册命令入口。可以在终端手动创建 iart 命令入口：让 iart 指向本应用可执行文件，并在调用时附加 --cli 参数。"
      : "当前系统暂不支持一键卸除命令入口，可以在终端手动删除 iart 命令入口文件。";

  return {
    registerEntry: async (): Promise<CliEntryRegisterResult> => {
      if (!isPlatformSupported(platform)) {
        console.debug("[cli-entry] 平台不支持一键注册，跳过", { platform });
        return { ok: false, entryPath, message: unsupportedResult("register") };
      }
      try {
        const existing = await readExistingContent();
        if (existing === desiredContent) {
          console.debug("[cli-entry] 入口已注册且内容一致，no-op（CLI-016 幂等）", { entryPath });
          return { ok: true, entryPath, action: "noop" };
        }
        await writeShim();
        const action = existing === null ? "created" : "overwritten";
        console.debug("[cli-entry] 命令入口写入完成", { entryPath, action, overwritten: existing !== null });
        return { ok: true, entryPath, action };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] 命令入口写入失败", { entryPath, detail });
        return {
          ok: false,
          entryPath,
          message:
            platform === "win32"
              ? "没有权限写入命令入口目录，无法完成注册。请检查该目录的写权限后重试。"
              : `没有权限写入命令入口目录，无法完成注册。可以在终端复制执行以下命令手动创建入口：${manualInstallCommand()}`,
        };
      }
    },

    unregisterEntry: async (): Promise<CliEntryUnregisterResult> => {
      if (!isPlatformSupported(platform)) {
        console.debug("[cli-entry] 平台不支持一键卸除，跳过", { platform });
        return { ok: false, entryPath, message: unsupportedResult("unregister") };
      }
      try {
        const existing = await readExistingContent();
        if (existing === null) {
          console.debug("[cli-entry] 入口不存在，卸除幂等成功", { entryPath });
          return { ok: true, entryPath, removed: false, reason: "absent" };
        }
        if (existing !== desiredContent) {
          // 内容不匹配本应用 shim：不删用户的同名物（spec §3 命令入口注册语义）。
          console.debug("[cli-entry] 入口内容与本应用 shim 不一致，保留不动", { entryPath });
          return { ok: true, entryPath, removed: false, reason: "foreign_content" };
        }
        await fs.promises.unlink(entryPath);
        console.debug("[cli-entry] 命令入口已卸除", { entryPath });
        return { ok: true, entryPath, removed: true, reason: "removed" };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] 命令入口卸除失败", { entryPath, detail });
        return {
          ok: false,
          entryPath,
          message: "卸除命令入口没有成功，请检查命令入口目录的写权限后重试。",
        };
      }
    },

    getEntryStatus: async (): Promise<CliEntryStatusResult> => {
      if (!isPlatformSupported(platform)) {
        console.debug("[cli-entry] 平台不支持一键注册，注册状态未知", { platform });
        return { supported: false };
      }
      try {
        const existing = await readExistingContent();
        if (existing === null) {
          console.debug("[cli-entry] 入口状态查询：入口不存在", { entryPath });
          return { supported: true, entryPath, registered: false, state: "missing" };
        }
        const registered = existing === desiredContent;
        console.debug("[cli-entry] 入口状态查询", { entryPath, registered, modified: !registered });
        return {
          supported: true,
          entryPath,
          registered,
          state: registered ? "registered" : "modified",
        };
      } catch (error: unknown) {
        // 读取异常（权限等）：状态未知按未注册呈现，不留痕会变成静默降级。
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] 入口状态读取失败，按未注册呈现", { entryPath, detail });
        return { supported: true, entryPath, registered: false, state: "modified" };
      }
    },
  };
};

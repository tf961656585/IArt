import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * CLI 命令入口注册模块（spec docs/integrations/CLI与本地Agent集成.md §3 命令入口注册 /
 * §8 设置页一键注册 / CLI-016 幂等）。
 *
 * 形态：在用户可达的 PATH 目录放置指向应用可执行文件的**等价 shim**（非裸 symlink）——
 * shim 注入 `--cli` 启动参数，保证经入口启动的一律是 CLI 客户端模式（launch-mode 分流判据）。
 * 平台 → 形态列表（列表首位恒为 sh）：
 * - macOS/Linux 等 sh 形态平台：`#!/bin/sh` + `exec "<app-exec>" [app 入口参数] --cli "$@"`，
 *   chmod 0755（一键注册支持面仅 macOS，Linux 不支持）；
 * - Windows：sh + cmd 双形态。sh 形态 `iart`（无扩展名）服务 POSIX 风格 shell（Git Bash/MSYS
 *   等，经 PATH 发现；PowerShell/cmd 不消费该文件）；cmd 形态 `iart.cmd` 服务 cmd/PowerShell
 *   （解释器按扩展名经 PATHEXT 分派），内容 `@"<app-exec>" [app 入口参数] --cli %*`（CRLF）。
 * - sh 构造器两平台共用：路径先把 `\` 统一转为 `/`（sh 双引号内反斜杠是转义前缀，Windows
 *   路径保留反斜杠会改变路径语义且 POSIX 风格 shell 无法执行），再按 sh 双引号语义转义
 *   `$`、反引号与 `"`（阻止变量展开与命令替换）；posix 路径无反斜杠，转换恒等。
 * - app-exec：打包态为 process.execPath（应用可执行文件）；dev 态为 Electron 可执行文件 +
 *   当前启动入口文件（bootstrap 传 process.argv[1]，即 dist/main.cjs——Electron 需显式
 *   入口文件，dist 无 package.json 不能以目录自启动）。
 *
 * 目标目录（spec §3，平台分流）：
 * - macOS：/usr/local/bin/iart；
 * - Windows：%LOCALAPPDATA%\Microsoft\WindowsApps（双形态同目录）；
 * - 其余平台不支持一键注册（状态按 null 承载，操作返回失败并引导手动注册）。
 *
 * 幂等与聚合（CLI-016）：注册/状态/卸除按形态列表逐文件幂等处理，聚合为单一结果。
 * 注册：缺失→写入、一致→跳过、不一致→覆盖；任一新建聚合为 created，否则任一覆盖聚合为
 * overwritten，否则 noop；单文件写失败即整体失败返回结构化失败（不回滚已写文件，靠状态
 * 检测与重新注册自愈）。状态：全部形态内容一致→registered；全部缺失→missing；其余
 * （缺件、内容不符、读异常）→modified。卸除：一致→删除、缺失→跳过、不一致→保留（不删
 * 用户的同名物）；任一保留聚合为 foreign_content（该文件保留现场），否则有删除为 removed，
 * 否则 absent。各步留 debug 日志；失败结构化返回（不抛进 UI 层）。
 *
 * 可测性（CLI-016 测试关键缝）：目标目录与平台可注入；文件操作用临时目录真实 fs 验证。
 */

export const CLI_ENTRY_NAME_SH = "iart";
export const CLI_ENTRY_NAME_CMD = "iart.cmd";

export type CliEntryPlatform = NodeJS.Platform;

/** 入口 shim 形态：sh（shebang + exec，PATH 直接命中）与 cmd（.cmd 批处理，PATHEXT 分派）。 */
export type CliEntryForm = "sh" | "cmd";

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

/** 形态 → 入口文件名：sh 形态无扩展名（PATH 直接命中），cmd 形态靠扩展名让解释器分派。 */
const ENTRY_FILE_NAME_BY_FORM: Record<CliEntryForm, string> = {
  sh: CLI_ENTRY_NAME_SH,
  cmd: CLI_ENTRY_NAME_CMD,
};

/** 平台 → 形态列表：Windows 双形态（sh 服务 POSIX 风格 shell，cmd 服务 cmd/PowerShell），
 *  其余平台单 sh 形态；一键注册支持面由 isPlatformSupported 另行裁定。 */
const entryForms = (platform: CliEntryPlatform): readonly CliEntryForm[] =>
  platform === "win32" ? ["sh", "cmd"] : ["sh"];

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

/**
 * sh 双引号包裹：先统一路径分隔符为 `/`（Windows 路径保留反斜杠会在 sh 双引号内被当作
 * 转义前缀，POSIX 风格 shell 无法按原语义执行），再转义双引号内的 `$`、反引号与 `"`——
 * 双引号内这三者分别触发变量展开、命令替换与提前闭合引号；posix 路径无反斜杠，转换恒等。
 */
const quoteForSh = (value: string): string => {
  const posixified = value.replace(/\\/g, "/");
  return `"${posixified.replace(/[$`"]/g, "\\$&")}"`;
};

/** cmd 双引号包裹：cmd 无嵌套双引号转义，病态路径不支撑（原样包裹，反斜杠路径原样保留）。 */
const quoteForCmd = (value: string): string => `"${value}"`;

/** 构造单形态 shim 内容（注册与状态比对共用同一事实，内容漂移即 modified）。 */
export const buildCliEntryShimContent = (deps: {
  appExecPath: string;
  appExecArgs: readonly string[];
  form: CliEntryForm;
}): string => {
  if (deps.form === "cmd") {
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
  const entries = entryForms(platform).map((form) => ({
    form,
    entryPath: path.join(options.targetDir, ENTRY_FILE_NAME_BY_FORM[form]),
    content: buildCliEntryShimContent({
      appExecPath: options.appExecPath,
      appExecArgs: options.appExecArgs,
      form,
    }),
  }));
  // 聚合结果与日志统一以 sh 形态路径代表命令入口（entryForms 保证每个平台都含 sh 形态）。
  const entryPath = path.join(options.targetDir, ENTRY_FILE_NAME_BY_FORM.sh);

  /**
   * 手动注册指引命令（一键注册权限失败时的可复制等价动作）：与写入的 sh shim 同一形态
   * （shebang + exec + --cli），printf 单引号格式串保护内嵌双引号路径。
   */
  const manualInstallCommand = (): string => {
    const quoted = [options.appExecPath, ...options.appExecArgs].map(quoteForSh).join(" ");
    return `printf '#!/bin/sh\\nexec ${quoted} --cli "$@"\\n' | sudo tee ${entryPath} && sudo chmod +x ${entryPath}`;
  };

  const readEntryFileContent = async (filePath: string): Promise<string | null> => {
    try {
      return await fs.promises.readFile(filePath, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };

  const writeEntryFile = async (entry: { entryPath: string; content: string }): Promise<void> => {
    await fs.promises.mkdir(options.targetDir, { recursive: true });
    await fs.promises.writeFile(entry.entryPath, entry.content, { encoding: "utf8" });
    if (platform !== "win32") {
      await fs.promises.chmod(entry.entryPath, 0o755);
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
        let created = false;
        let overwritten = false;
        for (const entry of entries) {
          const existing = await readEntryFileContent(entry.entryPath);
          if (existing === entry.content) {
            console.debug("[cli-entry] 入口已注册且内容一致，跳过（CLI-016 幂等）", { entryPath: entry.entryPath });
            continue;
          }
          await writeEntryFile(entry);
          if (existing === null) {
            created = true;
          } else {
            overwritten = true;
          }
          console.debug("[cli-entry] 命令入口写入完成", {
            entryPath: entry.entryPath,
            action: existing === null ? "created" : "overwritten",
          });
        }
        const action = created ? "created" : overwritten ? "overwritten" : "noop";
        console.debug("[cli-entry] 命令入口注册聚合完成", { entryPath, action });
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
        let removed = false;
        let foreignContent = false;
        for (const entry of entries) {
          const existing = await readEntryFileContent(entry.entryPath);
          if (existing === null) {
            console.debug("[cli-entry] 入口形态缺失，卸除跳过", { entryPath: entry.entryPath });
            continue;
          }
          if (existing !== entry.content) {
            // 内容不匹配本应用 shim：不删用户的同名物（spec §3 命令入口注册语义）。
            console.debug("[cli-entry] 入口内容与本应用 shim 不一致，保留不动", { entryPath: entry.entryPath });
            foreignContent = true;
            continue;
          }
          await fs.promises.unlink(entry.entryPath);
          removed = true;
          console.debug("[cli-entry] 命令入口已卸除", { entryPath: entry.entryPath });
        }
        const reason = foreignContent ? "foreign_content" : removed ? "removed" : "absent";
        console.debug("[cli-entry] 命令入口卸除聚合完成", { entryPath, reason });
        return { ok: true, entryPath, removed: reason === "removed", reason };
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
        let equalCount = 0;
        let missingCount = 0;
        for (const entry of entries) {
          const existing = await readEntryFileContent(entry.entryPath);
          if (existing === null) {
            missingCount += 1;
            continue;
          }
          if (existing !== entry.content) {
            console.debug("[cli-entry] 入口状态查询：内容与本应用 shim 不一致", { entryPath: entry.entryPath });
            return { supported: true, entryPath, registered: false, state: "modified" };
          }
          equalCount += 1;
        }
        if (equalCount === entries.length) {
          console.debug("[cli-entry] 入口状态查询：全部形态内容一致", { entryPath });
          return { supported: true, entryPath, registered: true, state: "registered" };
        }
        if (missingCount === entries.length) {
          console.debug("[cli-entry] 入口状态查询：入口不存在", { entryPath });
          return { supported: true, entryPath, registered: false, state: "missing" };
        }
        console.debug("[cli-entry] 入口状态查询：形态缺件", { entryPath });
        return { supported: true, entryPath, registered: false, state: "modified" };
      } catch (error: unknown) {
        // 读取异常（权限等）：状态未知按未注册呈现，不留痕会变成静默降级。
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] 入口状态读取失败，按未注册呈现", { entryPath, detail });
        return { supported: true, entryPath, registered: false, state: "modified" };
      }
    },
  };
};

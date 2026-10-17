import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * CLI 命令入口注册模块（spec docs/integrations/CLI与本地Agent集成.md §3 命令入口注册 /
 * §8 设置页一键注册 / CLI-016 幂等 / CLI-024 shim 置位 / CLI-031 shim 自愈 / CLI-037 注册
 * 前入口资源探测）。
 *
 * 形态（2026-10-14 批次拍板翻转）：在用户可达的 PATH 目录放置指向应用可执行文件的**等价
 * shim**——shim 以 `ELECTRON_RUN_AS_NODE=1` 把应用可执行文件作为纯 Node 运行时启动 CLI
 * 轻量入口脚本（cli-node-entry.cjs，extraResources 落 app.asar 外），不注入 `--cli`、不进入
 * Chromium browser 进程（GPU FATAL / 退出码污染 / 控制台乱码三类问题结构性消失）。
 * 变量置位语义：显式置位覆盖一切外来值（agent harness 环境含该变量时从 0.6.5 的「事故」
 * 翻转为「正解」——轻量形态本来就要 run-as-node）。平台 → 形态列表（列表首位恒为 sh）：
 * - macOS/Linux 等 sh 形态平台：`#!/bin/sh` + `ELECTRON_RUN_AS_NODE=1 exec "<app-exec>"
 *   "<entry>" "$@"`（前置赋值只作用于 exec 的子进程环境，exec 替换进程镜像后父 shell 不复
 *   存在，不污染父 shell），chmod 0755（一键注册支持面仅 macOS，Linux 不支持）；
 * - Windows：sh + cmd 双形态。sh 形态 `iart`（无扩展名）服务 POSIX 风格 shell（Git Bash/MSYS
 *   等，经 PATH 发现；PowerShell/cmd 不消费该文件）；cmd 形态 `iart.cmd` 服务 cmd/PowerShell
 *   （解释器按扩展名经 PATHEXT 分派），内容 `set "ELECTRON_RUN_AS_NODE=1"` + `@"<app-exec>"
 *   "<entry>" %*`（CRLF；等号后不带空格）。
 * - sh 构造器两平台共用：路径先把 `\` 统一转为 `/`（sh 双引号内反斜杠是转义前缀，Windows
 *   路径保留反斜杠会改变路径语义且 POSIX 风格 shell 无法执行），再按 sh 双引号语义转义
 *   `$`、反引号与 `"`（阻止变量展开与命令替换）；posix 路径无反斜杠，转换恒等。
 * - app-exec：打包态为 process.execPath（应用可执行文件）；dev 态为 Electron 可执行文件
 *   （run-as-node 下等价纯 Node 二进制）。
 * - 入口脚本：打包态 `<resources>/cli/cli-node-entry.cjs`（extraResources，asar 外）；
 *   dev 态 `dist/cli/cli-node-entry.cjs`（与 main.cjs 同级构建产物，绝对路径——npm script
 *   以相对路径启动 dev，shim 里的相对路径会按用户执行 iart 时的 cwd 解析而失灵）。
 *
 * 目标目录（spec §8，平台分流，2026-10-16 macOS 落点改造）：
 * - macOS：候选序列 ①Homebrew 命令目录 `/opt/homebrew/bin`（存在且可写）②系统共用目录
 *   `/usr/local/bin`（可写时）③用户级目录 `~/.local/bin`（不存在则创建）。落点裁定：候选中
 *   已存本应用 shim 的可写目录优先（重复注册/卸除落点稳定不漂移），否则取第一个可写（或可
 *   创建）候选；逐一不可用时整体失败并给手动注册指引命令（sudo 形态，落点为第一候选）。
 * - Windows：`%LOCALAPPDATA%\Microsoft\WindowsApps`（双形态同目录）。
 * - 其余平台不支持一键注册（状态按 null 承载，操作返回失败并引导手动注册）。
 * - 旧入口与遮蔽（扫描面为目标候选序列）：落点之外目录中的同名入口视为旧入口，状态附带
 *   「终端可能优先命中」提示与手动清理指引；注册时对落点之外、内容具本应用模板特征的遗留
 *   shim 一并清理（不可写则保留并由状态提示手动处理）；同名他物一律不动（与卸除同语义）。
 * - PATH 引导：落点不在终端默认命令搜索路径（defaultSearchDirs）时，结果与状态携带
 *   pathSetupRequired，界面提示加入 PATH。
 *
 * 内容判别（状态五态与清理/自愈共用一套判据）：
 * - current：内容与当前模板逐字一致；
 * - ours（本应用模板）：含 `ELECTRON_RUN_AS_NODE` 置位行或引用本应用可执行文件——本应用
 *   历史模板（0.6.5/0.6.6 的 --cli 注入形态）与指向已失效位置的旧 shim 都命中；
 * - foreign（同名他物）：两者皆非，不删不动。
 * 状态聚合（spec §8 五态）：全 current→registered；全缺失→missing；任一 foreign→foreign；
 * 其余（ours 过期、形态缺件、读取异常）→stale。
 *
 * 幂等与聚合（CLI-016）：注册/状态/卸除/自愈按形态列表逐文件幂等处理，聚合为单一结果。
 * 注册：缺失→写入、一致→跳过、不一致→覆盖；任一新建聚合为 created，否则任一覆盖聚合为
 * overwritten，否则 noop；单文件写失败即整体失败返回结构化失败（不回滚已写文件，靠状态
 * 检测与重新注册自愈）。卸除：本应用 shim（含过期模板）→删除、缺失→跳过、同名他物→保留
 * （不删用户的同名物）；任一保留聚合为 foreign_content（该文件保留现场），否则有删除为
 * removed，否则 absent。自愈（CLI-031，应用启动时调用）：范围为全部候选目录（Windows 双
 * 形态注册目录 / macOS 注册候选序列；不可写或不存在的目录跳过留痕）；逐形态——缺失跳过
 * （用户从未注册或已删除，不擅自创建/重建）、内容一致跳过、过期模板且指向本应用可执行文件
 * （如 0.6.5 的 --cli 注入形态）→按当前模板重写、内容不指向本应用（含指向已失效位置的旧
 * shim 与同名他物）→保留不动；写失败返回结构化失败（已重写形态不回滚，靠下次启动再次自愈）。
 * 各步留 debug 日志；失败结构化返回（不抛进 UI 层）。
 *
 * 可测性（CLI-016 测试关键缝）：目标目录与平台可注入；文件操作用临时目录真实 fs 验证。
 */

export const CLI_ENTRY_NAME_SH = "iart";
export const CLI_ENTRY_NAME_CMD = "iart.cmd";

/**
 * 入口资源缺失/损坏时的注册失败消息（spec §8 / CLI-037）：shim 指向的轻量入口脚本缺位
 * （如 0.6.8 打包配置错位把入口拷成名为 cli 的无扩展名文件）时，注册出的 shim 注定
 * MODULE_NOT_FOUND——不静默注册注定失败的 shim，指引重启（启动自愈 CLI-036）或重装。
 * 用户视角文案（ui-copy-check）：说处境与出路，不引入资源路径等实现细节。
 */
const CLI_ENTRY_RESOURCE_MISSING_MESSAGE =
  "iart 命令依赖的程序文件缺失或损坏，暂时无法完成注册。请重启应用让它自动修复；若重启后仍出现此提示，请重新安装应用。";

/**
 * 非权限类写入失败消息（spec §8 失败分类）：磁盘空间不足、文件被占用等，不一律归因为权限。
 * 用户视角文案（ui-copy-check）：说可能原因与出路（重试），不倾倒 errno 等实现细节。
 */
const CLI_ENTRY_WRITE_OTHER_FAILURE_MESSAGE =
  "写入 iart 命令时遇到问题，没能完成注册。请检查磁盘空间是否充足，或稍后重试。";

export type CliEntryPlatform = NodeJS.Platform;

/** 入口 shim 形态：sh（shebang + exec，PATH 直接命中）与 cmd（.cmd 批处理，PATHEXT 分派）。 */
export type CliEntryForm = "sh" | "cmd";

export interface CliEntryRegistrationDeps {
  /**
   * 入口目标候选目录（有序；必须可注入：测试以临时目录验证，生产按平台默认解析）。
   * 落点裁定见模块头「目标目录」：已存本应用 shim 的可写候选优先，否则第一个可写/可创建候选。
   */
  targetDirs: readonly string[];
  /** 应用可执行文件绝对路径（打包 process.execPath；dev 为 Electron 可执行文件）。 */
  appExecPath: string;
  /**
   * CLI 轻量入口脚本绝对路径（shim 以 ELECTRON_RUN_AS_NODE=1 以纯 Node 运行它；spec §3 /
   * CLI-025）：打包态 `<resources>/cli/cli-node-entry.cjs`（extraResources，asar 外），
   * dev 态 `dist/cli/cli-node-entry.cjs`。shim 内路径必须绝对（按执行 cwd 解析会失灵）。
   */
  cliEntryScriptPath: string;
  /** 平台；缺省 process.platform。 */
  platform?: CliEntryPlatform;
  /**
   * 入口资源探测（spec §8 / CLI-037）：注册前校验 shim 指向的轻量入口脚本真实可用。
   * 缺省为按 cliEntryScriptPath 的真实 fs stat（存在且是常规文件；生产语义）；探测语义
   * 本体由真实 fs 的专测覆盖（cli-entry-registration.test 的资源探测组），仅内容形态类
   * 用例（Windows 风格路径转义等，路径不可能在本机真实存在）注入替身。
   */
  probeEntryResource?: () => Promise<boolean>;
  /**
   * 终端默认命令搜索路径内的目录集合（spec §8 PATH 引导）：落点不在其中时状态携带
   * pathSetupRequired=true，界面提示加入 PATH。缺省按平台内置（macOS：/usr/local/bin 与
   * Homebrew 目录；Windows：注册目录本身）。
   */
  defaultSearchDirs?: readonly string[];
}

/** 一键注册结果：action 区分 created/overwritten/noop（幂等三态，供诊断与 UI 消息）。 */
export type CliEntryRegisterResult =
  | { ok: true; entryPath: string; action: "created" | "overwritten" | "noop" }
  | { ok: false; entryPath: string; message: string };

/** 卸除结果：removed=false 时 reason 区分 absent（本就未注册）与 foreign_content（同名他物不动）。 */
export type CliEntryUnregisterResult =
  | { ok: true; entryPath: string; removed: boolean; reason: "removed" | "absent" | "foreign_content" }
  | { ok: false; entryPath: string; message: string };

/**
 * 状态五态（spec §8，2026-10-16 由三态扩展）：
 * registered=落点内容与当前模板一致；missing=落点无入口；stale=落点内容具本应用模板特征但
 * 与当前模板不一致（指向已失效位置或过期形态；形态缺件、读取异常也归此态）；foreign=落点
 * 为同名他物。legacyEntryPath=落点之外候选目录中的同名旧入口（终端可能优先命中；null=无）。
 */
export type CliEntryStatusResult =
  | {
      supported: true;
      entryPath: string;
      state: "registered" | "missing" | "stale" | "foreign";
      legacyEntryPath: string | null;
      pathSetupRequired: boolean;
    }
  | { supported: false };

/**
 * 自愈结果（CLI-031）：按形态分桶聚合（rewritten=过期模板已按当前模板重写；foreign=同名
 * 他物保留；missing=缺失跳过不擅自创建；current=内容已一致）。ok:false 为读/写 IO 失败。
 */
export type CliEntryHealResult =
  | {
      ok: true;
      rewrittenForms: readonly CliEntryForm[];
      foreignForms: readonly CliEntryForm[];
      missingForms: readonly CliEntryForm[];
      currentForms: readonly CliEntryForm[];
    }
  | { ok: false; message: string };

/** 平台是否支持一键注册（spec §3 目标目录分流；其余平台状态按 null 承载）。 */
const isPlatformSupported = (platform: CliEntryPlatform): boolean => platform === "darwin" || platform === "win32";

/**
 * 入口资源探测的缺省实现（spec §8 / CLI-037）：shim 即将指向的轻量入口脚本必须真实存在
 * 且是常规文件——缺失/错位（ENOTDIR：父级名位被文件占用，0.6.8 错位形态）或非文件形态
 * 一律拦截注册；其余 stat 异常（权限等）资源状态未知，不拦截（写 shim 本身不依赖资源可
 * 读），留 debug 痕。拦截时结构化失败并指引重启自愈/重装，不静默注册注定失败的 shim。
 */
const probeEntryResourceByStat = async (cliEntryScriptPath: string): Promise<boolean> => {
  try {
    const entryStat = await fs.promises.stat(cliEntryScriptPath);
    if (entryStat.isFile()) return true;
    console.debug("[cli-entry] 入口资源探测：入口脚本不是常规文件，注册拦截", { cliEntryScriptPath });
    return false;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      console.debug("[cli-entry] 入口资源探测：入口脚本缺失，注册拦截", { cliEntryScriptPath });
      return false;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.debug("[cli-entry] 入口资源探测异常，不拦截注册", { cliEntryScriptPath, detail });
    return true;
  }
};

/** 形态 → 入口文件名：sh 形态无扩展名（PATH 直接命中），cmd 形态靠扩展名让解释器分派。 */
const ENTRY_FILE_NAME_BY_FORM: Record<CliEntryForm, string> = {
  sh: CLI_ENTRY_NAME_SH,
  cmd: CLI_ENTRY_NAME_CMD,
};

/** 平台 → 形态列表：Windows 双形态（sh 服务 POSIX 风格 shell，cmd 服务 cmd/PowerShell），
 *  其余平台单 sh 形态；一键注册支持面由 isPlatformSupported 另行裁定。 */
const entryForms = (platform: CliEntryPlatform): readonly CliEntryForm[] =>
  platform === "win32" ? ["sh", "cmd"] : ["sh"];

/** Windows 注册目录（%LOCALAPPDATA%，缺失回退 ~/AppData/Local 下的 Microsoft\WindowsApps）。 */
const resolveWindowsAppsDir = (): string => {
  const localAppData = (process.env["LOCALAPPDATA"] ?? "").trim();
  const base = localAppData.length > 0 ? localAppData : path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Microsoft", "WindowsApps");
};

/**
 * 生产目标候选目录解析（测试不消费；目录可注入才是测试缝），spec §8 平台分流：
 * Windows 单候选 WindowsApps；macOS 候选序列 Homebrew 目录 → /usr/local/bin → ~/.local/bin
 * （不存在则创建）；其余平台空列表（不支持）。
 */
export const resolveDefaultCliEntryTargetDirs = (platform: CliEntryPlatform = process.platform): readonly string[] => {
  if (platform === "win32") return [resolveWindowsAppsDir()];
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  }
  return [];
};

/**
 * 终端默认命令搜索路径内的目录集合（spec §8 PATH 引导判据；测试可注入覆盖）：
 * macOS 系统共用目录与 Homebrew 目录由默认路径/包管理器 shellenv 覆盖；Windows 注册目录
 * 在用户 PATH；其余空。落点不在集合内 → pathSetupRequired。
 */
export const resolveDefaultCliEntrySearchDirs = (platform: CliEntryPlatform = process.platform): readonly string[] => {
  if (platform === "win32") return [resolveWindowsAppsDir()];
  if (platform === "darwin") return ["/usr/local/bin", "/opt/homebrew/bin"];
  return [];
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

/**
 * shim 变量置位语义（spec §3 / CLI-024，2026-10-14 由 0.6.5 的「清除」翻转为「显式置位」）：
 * shim 以 `ELECTRON_RUN_AS_NODE=1` 把应用可执行文件作为纯 Node 运行时启动 CLI 轻量入口
 * 脚本——置位覆盖一切外来值（agent harness 父环境含该变量从「事故」翻转为「正解」）。
 * 双形态必须同步：
 * - sh 形态：前置赋值 `ELECTRON_RUN_AS_NODE=1 exec …`——赋值只作用于 exec 的子进程环境；
 *   exec 替换进程镜像后父 shell 不复存在，无「污染父 shell」问题；若 exec 失败，非交互
 *   shell 按约定退出，赋值不外泄。
 * - cmd 形态：调用前 `set "ELECTRON_RUN_AS_NODE=1"`（引号形态防尾随空格；等号后不带空格），
 *   cmd 进程环境被置位后由子进程继承。
 * 既有幂等机制（内容一致跳过、不一致覆盖）与启动自愈（CLI-031）使升级后存量 shim 被改写。
 */
export const buildCliEntryShimContent = (deps: {
  appExecPath: string;
  cliEntryScriptPath: string;
  form: CliEntryForm;
}): string => {
  if (deps.form === "cmd") {
    const quoted = [deps.appExecPath, deps.cliEntryScriptPath].map(quoteForCmd).join(" ");
    return `@set "ELECTRON_RUN_AS_NODE=1"\r\n@${quoted} %*\r\n`;
  }
  const quoted = [deps.appExecPath, deps.cliEntryScriptPath].map(quoteForSh).join(" ");
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\n`;
};

/** 内容判别五态（模块头「内容判别」）：missing/current/ours/foreign/read_error。 */
type EntryContentKind = "missing" | "current" | "ours" | "foreign" | "read_error";

export const createCliEntryRegistration = (
  options: CliEntryRegistrationDeps,
): {
  registerEntry: () => Promise<CliEntryRegisterResult>;
  unregisterEntry: () => Promise<CliEntryUnregisterResult>;
  getEntryStatus: () => Promise<CliEntryStatusResult>;
  healEntryShims: () => Promise<CliEntryHealResult>;
} => {
  const platform = options.platform ?? process.platform;
  const entryResourceAvailable =
    options.probeEntryResource ?? (async () => probeEntryResourceByStat(options.cliEntryScriptPath));
  const defaultSearchDirs = options.defaultSearchDirs ?? resolveDefaultCliEntrySearchDirs(platform);
  const forms = entryForms(platform);

  /** 目录 + 形态 → 入口条目（内容在构造期一次性算好，与旧实现同语义）。 */
  const buildEntriesForDir = (dir: string): { form: CliEntryForm; entryPath: string; content: string }[] =>
    forms.map((form) => ({
      form,
      entryPath: path.join(dir, ENTRY_FILE_NAME_BY_FORM[form]),
      content: buildCliEntryShimContent({
        appExecPath: options.appExecPath,
        cliEntryScriptPath: options.cliEntryScriptPath,
        form,
      }),
    }));

  /**
   * 目录可用性（spec §8 落点裁定）：存在 → 可写；不存在 → 最近存在的祖先目录可写（mkdir
   * recursive 的前置条件等价物）。探测只读，不创建目录（状态查询不得有副作用）。
   */
  const isDirUsable = async (dir: string): Promise<boolean> => {
    let current = dir;
    for (;;) {
      try {
        await fs.promises.access(current, fs.constants.W_OK);
        return true;
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    }
  };

  /** 目录内是否已存在本应用 shim（含过期模板；用于落点稳定优先）。 */
  const dirHasOwnShim = async (dir: string): Promise<boolean> => {
    for (const entry of buildEntriesForDir(dir)) {
      const kind = await readEntryKind(entry);
      if (kind === "missing" || kind === "read_error") continue;
      if (kind !== "foreign") return true;
    }
    return false;
  };

  /**
   * 落点裁定（spec §8）：候选中已存本应用 shim 的可写目录优先（重复注册/卸除落点稳定不
   * 漂移），否则取第一个可写（或可创建）候选；逐一不可用返回 null（调用方给手动指引）。
   */
  const chooseTargetDir = async (): Promise<string | null> => {
    let firstUsable: string | null = null;
    for (const dir of options.targetDirs) {
      const usable = await isDirUsable(dir);
      if (!usable) {
        console.debug("[cli-entry] 目标候选目录不可用，跳过", { targetDir: dir });
        continue;
      }
      if (firstUsable === null) firstUsable = dir;
      if (await dirHasOwnShim(dir)) {
        console.debug("[cli-entry] 目标候选目录已存本应用 shim，选定为落点", { targetDir: dir });
        return dir;
      }
    }
    if (firstUsable !== null) {
      console.debug("[cli-entry] 落点裁定为第一个可用候选目录", { targetDir: firstUsable });
    }
    return firstUsable;
  };

  /**
   * 手动注册指引命令（一键注册权限失败时的可复制等价动作）：与写入的 sh shim 同一形态
   * （shebang + ELECTRON_RUN_AS_NODE=1 置位 + exec 入口脚本，CLI-024），printf 单引号格式串
   * 保护内嵌双引号路径。
   */
  const manualInstallCommand = (targetDir: string): string => {
    const entryPath = path.join(targetDir, CLI_ENTRY_NAME_SH);
    const quoted = [options.appExecPath, options.cliEntryScriptPath].map(quoteForSh).join(" ");
    return `printf '#!/bin/sh\\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\\n' | sudo tee ${entryPath} && sudo chmod +x ${entryPath}`;
  };

  /**
   * 本应用模板判据（模块头「内容判别」ours 档）：含 `ELECTRON_RUN_AS_NODE` 置位行（本应用
   * 历史模板的共同特征，0.6.5/0.6.6 的 unset 形态同样命中）或引用本应用可执行文件。命中即
   * 本应用遗留 shim（过期模板或指向已失效位置），未命中视为同名他物（不删不动）。
   */
  const isOwnShimTemplateContent = (content: string): boolean => {
    const posixExecPath = options.appExecPath.replace(/\\/g, "/");
    return content.includes("ELECTRON_RUN_AS_NODE") || content.includes(options.appExecPath) || content.includes(posixExecPath);
  };

  /**
   * 过期模板判据（CLI-031 自愈重写前提）：旧版模板必然引用**当前**应用可执行文件路径（sh
   * 形态经 quoteForSh 已 posixify，故两种分隔符形态都比对）。命中即认定为本应用的过期模板可
   * 安全重写；未命中（含指向已失效位置的旧 shim）保留不动——重写条件比 ours 档更严。
   */
  const isOwnStaleShimContent = (content: string): boolean => {
    const posixExecPath = options.appExecPath.replace(/\\/g, "/");
    return content.includes(options.appExecPath) || content.includes(posixExecPath);
  };

  const classifyEntryContent = (existing: string | null, expected: string): EntryContentKind => {
    if (existing === null) return "missing";
    if (existing === expected) return "current";
    return isOwnShimTemplateContent(existing) ? "ours" : "foreign";
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

  /** 读取并判别一档内容（不抛：缺失归 missing，读取异常归 read_error，均留 debug 痕）。 */
  const readEntryKind = async (entry: { entryPath: string; content: string }): Promise<EntryContentKind> => {
    try {
      const existing = await readEntryFileContent(entry.entryPath);
      return classifyEntryContent(existing, entry.content);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.debug("[cli-entry] 入口文件读取异常", { entryPath: entry.entryPath, detail });
      return "read_error";
    }
  };

  const writeEntryFile = async (targetDir: string, entry: { entryPath: string; content: string }): Promise<void> => {
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(entry.entryPath, entry.content, { encoding: "utf8" });
    if (platform !== "win32") {
      await fs.promises.chmod(entry.entryPath, 0o755);
    }
  };

  /** 失败消息按 errno 分类（spec §8）：权限类给手动指引/查权限出路，其余给重试出路。 */
  const isPermissionError = (error: unknown): boolean =>
    error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM");

  const registerFailureMessage = (error: unknown, targetDir: string): string => {
    if (!isPermissionError(error)) return CLI_ENTRY_WRITE_OTHER_FAILURE_MESSAGE;
    return platform === "win32"
      ? `没有权限写入 ${targetDir}，无法完成注册。请检查该目录的写权限后重试。`
      : `没有权限写入 ${targetDir}，无法完成注册。可以在终端复制执行以下命令手动创建 iart 命令：${manualInstallCommand(targetDir)}`;
  };

  const unsupportedResult = (action: "register" | "unregister"): string =>
    action === "register"
      ? "当前系统暂不支持一键注册 iart 命令。可以在终端手动创建：让 iart 指向本应用可执行文件，并设置 ELECTRON_RUN_AS_NODE=1 后启动本应用的命令行入口脚本。"
      : "当前系统暂不支持一键卸除 iart 命令，可以在终端手动删除它。";

  return {
    registerEntry: async (): Promise<CliEntryRegisterResult> => {
      if (!isPlatformSupported(platform)) {
        console.debug("[cli-entry] 平台不支持一键注册，跳过", { platform });
        const fallbackDir = options.targetDirs[0] ?? "";
        return {
          ok: false,
          entryPath: path.join(fallbackDir, CLI_ENTRY_NAME_SH),
          message: unsupportedResult("register"),
        };
      }
      // 入口资源探测（CLI-037）：资源缺位时注册出的 shim 注定失败，结构化拦截并指引自愈/重装。
      if (!(await entryResourceAvailable())) {
        const fallbackDir = options.targetDirs[0] ?? "";
        return {
          ok: false,
          entryPath: path.join(fallbackDir, CLI_ENTRY_NAME_SH),
          message: CLI_ENTRY_RESOURCE_MISSING_MESSAGE,
        };
      }
      const targetDir = await chooseTargetDir();
      const referenceDir = targetDir ?? options.targetDirs[0] ?? "";
      const entryPath = path.join(referenceDir, CLI_ENTRY_NAME_SH);
      if (targetDir === null) {
        // 候选逐一不可用（spec §8）：给手动注册指引（sudo 形态，落点为第一候选），不产生半成品。
        console.debug("[cli-entry] 目标候选目录逐一不可用，注册转手动指引", { targetDirs: options.targetDirs });
        return {
          ok: false,
          entryPath,
          message:
            platform === "win32"
              ? `没有权限写入 ${referenceDir}，无法完成注册。请检查该目录的写权限后重试。`
              : `没有权限写入 ${referenceDir}，无法完成注册。可以在终端复制执行以下命令手动创建 iart 命令：${manualInstallCommand(referenceDir)}`,
        };
      }
      try {
        let created = false;
        let overwritten = false;
        for (const entry of buildEntriesForDir(targetDir)) {
          const kind = await readEntryKind(entry);
          if (kind === "current") {
            console.debug("[cli-entry] 入口已注册且内容一致，跳过（CLI-016 幂等）", { entryPath: entry.entryPath });
            continue;
          }
          await writeEntryFile(targetDir, entry);
          if (kind === "missing") {
            created = true;
          } else {
            overwritten = true;
          }
          console.debug("[cli-entry] 命令入口写入完成", {
            entryPath: entry.entryPath,
            action: kind === "missing" ? "created" : "overwritten",
          });
        }
        // 落点之外的遗留 shim 清理（spec §8 旧入口与遮蔽）：只清本应用模板特征内容，
        // 同名他物不动；不可写（如 sudo 置入的系统目录文件）保留现场，由状态提示手动清理。
        for (const dir of options.targetDirs) {
          if (dir === targetDir) continue;
          for (const entry of buildEntriesForDir(dir)) {
            const kind = await readEntryKind(entry);
            if (kind !== "current" && kind !== "ours") continue;
            try {
              await fs.promises.unlink(entry.entryPath);
              console.debug("[cli-entry] 落点之外的遗留 shim 已清理", { entryPath: entry.entryPath });
            } catch (cleanupError: unknown) {
              const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
              console.debug("[cli-entry] 落点之外的遗留 shim 清理失败，保留现场", { entryPath: entry.entryPath, detail });
            }
          }
        }
        const action = created ? "created" : overwritten ? "overwritten" : "noop";
        console.debug("[cli-entry] 命令入口注册聚合完成", { entryPath, action, targetDir });
        return { ok: true, entryPath, action };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] 命令入口写入失败", { entryPath, detail });
        return { ok: false, entryPath, message: registerFailureMessage(error, targetDir) };
      }
    },

    unregisterEntry: async (): Promise<CliEntryUnregisterResult> => {
      if (!isPlatformSupported(platform)) {
        console.debug("[cli-entry] 平台不支持一键卸除，跳过", { platform });
        const fallbackDir = options.targetDirs[0] ?? "";
        return {
          ok: false,
          entryPath: path.join(fallbackDir, CLI_ENTRY_NAME_SH),
          message: unsupportedResult("unregister"),
        };
      }
      const referenceDir = options.targetDirs[0] ?? "";
      const entryPath = path.join(referenceDir, CLI_ENTRY_NAME_SH);
      // 失败消息定位用：记录正在处理的文件（unlink 失败时给该文件的 sudo rm 出路）。
      let currentEntryPath = entryPath;
      try {
        let removed = false;
        let foreignContent = false;
        // 卸除面 = 全部候选目录（spec §8：本应用 shim 含过期模板一并删除，卸除后终端不再可达）。
        for (const dir of options.targetDirs) {
          for (const entry of buildEntriesForDir(dir)) {
            currentEntryPath = entry.entryPath;
            const kind = await readEntryKind(entry);
            if (kind === "read_error") {
              console.debug("[cli-entry] 入口文件读取异常，卸除跳过该形态", { entryPath: entry.entryPath });
              foreignContent = true;
              continue;
            }
            if (kind === "current" || kind === "ours") {
              await fs.promises.unlink(entry.entryPath);
              removed = true;
              console.debug("[cli-entry] 命令入口已卸除", { entryPath: entry.entryPath, kind });
              continue;
            }
            if (kind === "foreign") {
              // 内容不匹配本应用 shim：不删用户的同名物（spec §3 命令入口注册语义）。
              console.debug("[cli-entry] 入口内容与本应用 shim 不一致，保留不动", { entryPath: entry.entryPath });
              foreignContent = true;
              continue;
            }
            console.debug("[cli-entry] 入口形态缺失，卸除跳过", { entryPath: entry.entryPath });
          }
        }
        const reason = foreignContent ? "foreign_content" : removed ? "removed" : "absent";
        console.debug("[cli-entry] 命令入口卸除聚合完成", { entryPath, reason });
        return { ok: true, entryPath, removed: reason === "removed", reason };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] 命令入口卸除失败", { entryPath: currentEntryPath, detail });
        return {
          ok: false,
          entryPath,
          message: isPermissionError(error)
            ? `没有权限卸除 iart 命令，可以在终端执行 sudo rm ${currentEntryPath} 删除。`
            : "没能卸除 iart 命令，请重试；若一直失败，可在终端手动删除该文件。",
        };
      }
    },

    getEntryStatus: async (): Promise<CliEntryStatusResult> => {
      if (!isPlatformSupported(platform)) {
        console.debug("[cli-entry] 平台不支持一键注册，注册状态未知", { platform });
        return { supported: false };
      }
      const targetDir = (await chooseTargetDir()) ?? options.targetDirs[0] ?? "";
      const entryPath = path.join(targetDir, CLI_ENTRY_NAME_SH);
      const pathSetupRequired = !defaultSearchDirs.includes(targetDir);
      // 旧入口扫描（spec §8 旧入口与遮蔽）：落点之外候选目录中的同名入口，首个命中即提示。
      let legacyEntryPath: string | null = null;
      for (const dir of options.targetDirs) {
        if (dir === targetDir) continue;
        for (const entry of buildEntriesForDir(dir)) {
          try {
            await fs.promises.access(entry.entryPath);
            legacyEntryPath = entry.entryPath;
            console.debug("[cli-entry] 状态查询发现落点之外的旧入口", { entryPath: entry.entryPath });
            break;
          } catch {
            // 不存在（或不可探测）：跳过留痕由外层承担，此处静默继续。
          }
        }
        if (legacyEntryPath !== null) break;
      }
      try {
        let currentCount = 0;
        let missingCount = 0;
        let foreignSeen = false;
        const entries = buildEntriesForDir(targetDir);
        for (const entry of entries) {
          const kind = await readEntryKind(entry);
          if (kind === "current") {
            currentCount += 1;
            continue;
          }
          if (kind === "missing") {
            missingCount += 1;
            continue;
          }
          if (kind === "foreign") {
            console.debug("[cli-entry] 入口状态查询：内容为同名他物", { entryPath: entry.entryPath });
            foreignSeen = true;
            continue;
          }
          // ours（过期模板/指向已失效位置）或 read_error（读取异常）→ 入口已失效面。
          console.debug("[cli-entry] 入口状态查询：入口已失效线索", { entryPath: entry.entryPath, kind });
        }
        const total = entries.length;
        if (currentCount === total) {
          console.debug("[cli-entry] 入口状态查询：全部形态内容一致", { entryPath });
          return { supported: true, entryPath, state: "registered", legacyEntryPath, pathSetupRequired };
        }
        if (missingCount === total) {
          console.debug("[cli-entry] 入口状态查询：入口不存在", { entryPath });
          return { supported: true, entryPath, state: "missing", legacyEntryPath, pathSetupRequired };
        }
        if (foreignSeen) {
          return { supported: true, entryPath, state: "foreign", legacyEntryPath, pathSetupRequired };
        }
        console.debug("[cli-entry] 入口状态查询：入口已失效（过期模板/形态缺件/读取异常）", { entryPath });
        return { supported: true, entryPath, state: "stale", legacyEntryPath, pathSetupRequired };
      } catch (error: unknown) {
        // 聚合外读取异常（权限等）：状态存疑按入口已失效呈现，不留痕会变成静默降级。
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] 入口状态读取失败，按入口已失效呈现", { entryPath, detail });
        return { supported: true, entryPath, state: "stale", legacyEntryPath, pathSetupRequired };
      }
    },

    /**
     * shim 自动自愈（spec §3 / CLI-031，应用启动时由 GUI bootstrap 调用）：范围为全部候选
     * 目录（Windows 双形态注册目录 / macOS 注册候选序列；不可写或不存在的目录跳过留痕）。
     * 存量旧 shim（0.6.5/0.6.6 的 --cli 注入 + unset 形态）经本函数在用户无感的情况下改写为
     * 当前模板，无需用户重进设置页手动重注册。逐形态语义见模块头注释；幂等（重写后下次启动
     * 落入 currentForms 桶）；写失败不回滚已重写形态。
     */
    healEntryShims: async (): Promise<CliEntryHealResult> => {
      try {
        const rewrittenForms: CliEntryForm[] = [];
        const foreignForms: CliEntryForm[] = [];
        const missingForms: CliEntryForm[] = [];
        const currentForms: CliEntryForm[] = [];
        for (const dir of options.targetDirs) {
          if (!(await isDirUsable(dir))) {
            // 不可写/不存在目录不属自愈面（spec §8：跳过留痕，由状态提示手动处理）。
            console.debug("[cli-entry] shim 自愈：目标目录不可用，跳过", { targetDir: dir });
            continue;
          }
          for (const entry of buildEntriesForDir(dir)) {
            const existing = await readEntryFileContent(entry.entryPath);
            if (existing === null) {
              // 缺失 = 用户从未注册或已删除：自愈不擅自创建/重建（尊重用户选择）。
              missingForms.push(entry.form);
              console.debug("[cli-entry] shim 自愈：形态缺失，跳过（不擅自创建）", { entryPath: entry.entryPath });
              continue;
            }
            if (existing === entry.content) {
              currentForms.push(entry.form);
              continue;
            }
            if (!isOwnStaleShimContent(existing)) {
              // 不引用当前应用可执行文件 = 同名他物或指向已失效位置的旧 shim，保留不动。
              foreignForms.push(entry.form);
              console.debug("[cli-entry] shim 自愈：内容不引用当前应用可执行文件，保留不动", {
                entryPath: entry.entryPath,
              });
              continue;
            }
            await writeEntryFile(dir, entry);
            rewrittenForms.push(entry.form);
            console.debug("[cli-entry] shim 自愈：过期模板按当前模板重写", { entryPath: entry.entryPath });
          }
        }
        console.debug("[cli-entry] shim 自愈聚合完成", { entryPath: path.join(options.targetDirs[0] ?? "", CLI_ENTRY_NAME_SH), rewrittenForms, foreignForms, missingForms, currentForms });
        return { ok: true, rewrittenForms, foreignForms, missingForms, currentForms };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        console.debug("[cli-entry] shim 自愈失败", { detail });
        return { ok: false, message: "命令入口自愈没有完成，请检查命令入口目录的写权限；可在设置页重新注册命令入口。" };
      }
    },
  };
};

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 本地控制服务发现文件（spec docs/integrations/CLI与本地Agent集成.md §6.1）。
 *
 * 文件内容仅是在役线索，不构成在役判据：CLI 连接成功才算在役（CLI-004）。
 * 禁止记录密钥、凭证或提示词（spec §13）。权限 0600，原子写。
 */
export interface CliDiscoveryFile {
  /** 控制服务监听端口（绑定 127.0.0.1）。 */
  port: number;
  /** 本次 GUI 进程启动随机生成的鉴权令牌。 */
  token: string;
  /** 应用主进程 PID。 */
  pid: number;
  /** 应用版本。 */
  version: string;
  /** 服务启动时间（UTC ISO 8601，仓库时间戳纪律：内部存储一律 UTC）。 */
  startedAt: string;
}

/**
 * 应用数据根：与 storage/editor-storage-recent-projects 的数据根分流保持同一逻辑
 * （NODE_ENV==='development' → ~/.iart-studio-dev，否则 ~/.iart-studio），
 * 安装版与开发版天然隔离各自的发现文件与控制服务（spec §10）。
 */
export const resolveDefaultAppDataRoot = (): string =>
  process.env["NODE_ENV"] === "development"
    ? path.join(os.homedir(), ".iart-studio-dev")
    : path.join(os.homedir(), ".iart-studio");

export const CLI_DISCOVERY_FILE_NAME = "cli-runtime.json";

export const resolveDefaultDiscoveryFilePath = (): string =>
  path.join(resolveDefaultAppDataRoot(), CLI_DISCOVERY_FILE_NAME);

/**
 * 读取发现文件；缺失、损坏或形状非法一律返回 null，由调用端按 not_running 处理
 * （spec §6.1：不得依据文件存在性断言在役）。
 */
export const readDiscoveryFile = (filePath: string): CliDiscoveryFile | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as Partial<CliDiscoveryFile>;
    if (
      typeof row.port !== "number" ||
      !Number.isInteger(row.port) ||
      row.port <= 0 ||
      typeof row.token !== "string" ||
      row.token.length === 0 ||
      typeof row.pid !== "number" ||
      typeof row.version !== "string" ||
      typeof row.startedAt !== "string"
    ) {
      return null;
    }
    return {
      port: row.port,
      token: row.token,
      pid: row.pid,
      version: row.version,
      startedAt: row.startedAt,
    };
  } catch {
    return null;
  }
};

/**
 * 0600 原子写（tmp 写入 + chmod 0600 + rename）。
 * mode 选项受 umask 影响，显式 chmod 确保 0600。写入失败向上抛，由启动方决定是否阻断。
 */
export const writeDiscoveryFile = (filePath: string, content: CliDiscoveryFile): void => {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 清理失败不影响原错误上报
    }
    throw error;
  }
};

/** 删除发现文件（存在才删）；返回是否实际删除，供 debug 留痕。 */
export const deleteDiscoveryFileIfExists = (filePath: string): boolean => {
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch (error: unknown) {
    console.warn(
      "[cli-control] 删除发现文件失败",
      filePath,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
};

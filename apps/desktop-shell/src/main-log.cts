/**
 * 主进程通用文件日志（logs/main.log）。
 *
 * 背景：打包态 GUI 主进程 console 无 stdout，主进程侧失败此前只有更新专用的
 * updater.log 一个落盘通道——skill 安装等主进程链路的失败在用户机上无任何留痕，
 * 排查只能盲猜。本模块提供主进程通用失败留痕通道；目录解析复用 updater 日志
 * （app.getPath("logs")，Windows 约 %APPDATA%\<app>\logs，回退 userData/logs）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getUpdaterLogDir } from "./update/app-update-log.cjs";

export function getMainLogPath(): string {
  return path.join(getUpdaterLogDir(), "main.log");
}

function stringifyLogValue(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function appendMainLog(
  level: "debug" | "info" | "warn" | "error",
  message: unknown,
  meta: unknown | undefined,
): void {
  try {
    const logPath = getMainLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line =
      `${new Date().toISOString()} [${level}] ${stringifyLogValue(message)}` +
      (meta !== undefined && meta !== null ? ` | meta=${stringifyLogValue(meta)}` : "") +
      "\n";
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    void 0;
  }
}

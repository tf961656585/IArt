import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export function getUpdaterLogDir(): string {
  try {
    const logs = app.getPath("logs");
    if (logs) return logs;
  } catch {
    void 0;
  }
  return path.join(app.getPath("userData"), "logs");
}

export function getUpdaterLogPath(): string {
  return path.join(getUpdaterLogDir(), "updater.log");
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

export function appendUpdaterLog(level: string, message: unknown, meta: unknown | undefined): void {
  try {
    const logPath = getUpdaterLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line =
      `${new Date().toISOString()} [${level}] ${stringifyLogValue(message)}` +
      (meta ? ` | meta=${stringifyLogValue(meta)}` : "") +
      "\n";
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    void 0;
  }
}

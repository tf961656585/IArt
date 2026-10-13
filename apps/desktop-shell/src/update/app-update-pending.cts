import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export type PendingUpdateRecord = {
  version: string;
  downloadPath: string | null;
  createdAt: number;
};

function pendingPath(): string {
  return path.join(app.getPath("userData"), "pending-update.json");
}

function isRecord(value: unknown): value is PendingUpdateRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PendingUpdateRecord>;
  return typeof record.version === "string" && typeof record.createdAt === "number";
}

export function readPendingUpdate(): PendingUpdateRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writePendingUpdate(record: PendingUpdateRecord): void {
  fs.mkdirSync(path.dirname(pendingPath()), { recursive: true });
  fs.writeFileSync(pendingPath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function clearPendingUpdate(): void {
  try {
    fs.rmSync(pendingPath(), { force: true });
  } catch {
    void 0;
  }
}

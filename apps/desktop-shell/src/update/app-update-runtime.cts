import { app } from "electron";
import type {
  AppUpdateArch,
  AppUpdateChannel,
  AppUpdatePlatform,
} from "@iart/contracts";
import { resolveAppVersion } from "../desktop-shell-utils.cjs";

export function resolveUpdatePlatform(): AppUpdatePlatform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  return "linux";
}

export function resolveUpdateArch(): AppUpdateArch {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "ia32") return "ia32";
  return "x64";
}

export function resolveUpdateChannel(): AppUpdateChannel {
  return "stable";
}

export function resolveCurrentAppVersion(): string {
  return resolveAppVersion() || app.getVersion();
}

export function isSupportedUpdateTarget(): boolean {
  const platform = resolveUpdatePlatform();
  const arch = resolveUpdateArch();
  return (platform === "win32" && arch === "x64") || (platform === "darwin" && arch === "arm64") || (platform === "darwin" && arch === "x64");
}

export function compareVersions(left: string, right: string): number {
  const toParts = (value: string) =>
    value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const leftParts = toParts(left);
  const rightParts = toParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

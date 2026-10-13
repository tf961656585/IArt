import * as fs from "node:fs";
import * as path from "node:path";

import {
  normalizeString,
  readPackageJson,
  readRecordMetadata,
  readRecordOptions,
} from "./common.cts";

const resolveAppVersion = (): string | null => {
  const envVersion = normalizeString(
    process.env["IART_APP_VERSION"] ||
      process.env["IART_SOFTWARE_VERSION"] ||
      process.env["npm_package_version"],
  );
  if (envVersion) return envVersion;

  try {
    const pkgPath = path.join(__dirname, "..", "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as unknown;
    const pkgVersion = (() => { const pj = readPackageJson(pkg); return pj !== null && pj !== undefined ? pj.version : undefined; })();
    const pkgVersionStr = normalizeString(pkgVersion);    if (pkgVersionStr) return pkgVersionStr;
  } catch {
    void 0;
  }

  return null;
};

export const resolveRecordAppVersion = (options: unknown): string | null => {
  const optionRecord = readRecordOptions(options);
  if (optionRecord) {
    const direct = normalizeString(optionRecord.appVersion);
    if (direct) return direct;

    const metaVersion = normalizeString(
      (() => { const rm = readRecordMetadata(optionRecord.metadata); return rm !== null && rm !== undefined ? rm.appVersion : undefined; })(),
    );
    if (metaVersion) return metaVersion;
  }

  return resolveAppVersion();
};

import fs from "node:fs/promises";
import path from "node:path";

export interface ModelEntry {
  key: string;
  importPath: string;
  indexPath: string;
}

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "apps", "editor", "src");
const MODELS_DIR = path.join(SRC_DIR, "features", "models");
const BUILTIN_AUTO_DISCOVERY_DIR = path.join(MODELS_DIR, "processors", "local");

const shouldSkip = (fullPath: string): boolean => {
  const normalized = fullPath.replace(/\\/g, "/");
  return (
    normalized.includes("/shared/") ||
    normalized.includes("/__tests__/") ||
    normalized.endsWith("modelDefinition.ts")
  );
};

const IGNORE_MISSING_INDEX = new Set(["gemini-image"]);

const shouldIgnoreMissingIndex = (dir: string): boolean => {
  const base = dir.split(/[\\/]/).pop();
  return base ? IGNORE_MISSING_INDEX.has(base) : false;
};

const pathToImport = (indexFile: string): string => {
  const relFromSrc = path
    .relative(SRC_DIR, indexFile.replace(/\\/g, "/"))
    .replace(/\\/g, "/");
  const withoutExt = relFromSrc.replace(/\.tsx?$/, "");
  return `@/${withoutExt}`;
};

const extractModelId = async (
  indexFile: string,
  fallback: string,
): Promise<string> => {
  try {
    const content = await fs.readFile(indexFile, "utf-8");
    const match = content.match(/modelId\s*:\s*['"]([^'"]+)['"]/);
    return match?.[1] ?? fallback;
  } catch {
    return fallback;
  }
};

export const collectModelEntries = async (): Promise<ModelEntry[]> => {
  const entries: ModelEntry[] = [];

  const walk = async (dir: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true });
    await Promise.all(
      items.map(async (item) => {
        const fullPath = path.join(dir, item.name);
        if (shouldSkip(fullPath)) return;

        if (item.isDirectory()) {
          return walk(fullPath);
        }

        if (item.isFile() && item.name === "index.ts") {
          const folder = path.basename(path.dirname(fullPath));
          const key = await extractModelId(fullPath, folder);
          entries.push({
            key,
            importPath: pathToImport(fullPath),
            indexPath: fullPath,
          });
        }
      }),
    );
  };

  await walk(BUILTIN_AUTO_DISCOVERY_DIR);

  // 稳定排序，避免生成文件抖动
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
};

export const renderGeneratedContent = (entries: ModelEntry[]): string => {
  const lines = entries
    .map(
      (entry) =>
        `  { key: '${entry.key}', loader: () => import('${entry.importPath}') }`,
    )
    .join(",\n");

  return `// @generated
// 本文件由 tooling/scripts/generate-model-auto-discovery.ts 自动生成，请勿手动修改。
// 如需更新，请运行：pnpm generate:model-discovery

import type { ModelDefinition } from '@/features/models/modelDefinition';

type ModelModule = { MODEL_DEFINITION: ModelDefinition | undefined };

export const modelLoaders: Array<{ key: string; loader: () => Promise<ModelModule> }> = [
${lines}
];
`;
};

export const findModelDirsMissingIndex = async (): Promise<string[]> => {
  const missing: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const hasIndex = items.some((i) => i.isFile() && i.name === "index.ts");
    const hasConfig = items.some(
      (i) =>
        i.isFile() &&
        ["config.ts", "schema.ts", "types.ts", "extractor.ts"].includes(i.name),
    );

    if (
      hasConfig &&
      !hasIndex &&
      !shouldSkip(dir) &&
      !shouldIgnoreMissingIndex(dir)
    ) {
      missing.push(dir);
    }

    await Promise.all(
      items
        .filter((item) => item.isDirectory())
        .map((item) => walk(path.join(dir, item.name))),
    );
  };

  await walk(BUILTIN_AUTO_DISCOVERY_DIR);
  return missing.sort();
};

export const MODELS_DIR_PATH = MODELS_DIR;
export const GENERATED_FILE = path.join(
  SRC_DIR,
  "client",
  "config",
  "modelAutoDiscovery.generated.ts",
);

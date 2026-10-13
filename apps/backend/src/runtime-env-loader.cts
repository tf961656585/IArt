import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenvModule from 'dotenv';

const dotenv = dotenvModule as {
  config: (options: { path: string; override: boolean | undefined }) => { error: unknown | undefined };
};

type RuntimeEnvLoaderOptions = {
  execDir: string | undefined;
  cwd: string | undefined;
  repoRoot: string | undefined;
  packagedAppRoot: string | undefined;
  resourcesDir: string | undefined;
};

const DEFAULT_RUNTIME_ENV_LOADER_OPTIONS: RuntimeEnvLoaderOptions = {
  execDir: undefined,
  cwd: undefined,
  repoRoot: undefined,
  packagedAppRoot: undefined,
  resourcesDir: undefined,
};

const normalizeDir = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed);
};

const uniquePaths = (values: readonly unknown[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) continue;
    const resolved = path.resolve(normalized);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
};

const pushEnvFile = (target: string[], dirPath: unknown): void => {
  const normalizedDir = normalizeDir(dirPath);
  if (!normalizedDir) return;
  target.push(path.join(normalizedDir, '.env'));
};

const resolveDefaultRepoRoot = () => path.resolve(__dirname, '..', '..', '..');

export const resolveRuntimeEnvFileCandidates = (options: RuntimeEnvLoaderOptions = DEFAULT_RUNTIME_ENV_LOADER_OPTIONS) => {
  const explicitEnvFile =
    typeof process.env['IART_ENV_FILE'] === 'string' ? process.env['IART_ENV_FILE'].trim() : '';
  const candidates: string[] = [];

  if (explicitEnvFile) {
    candidates.push(explicitEnvFile);
  }

  pushEnvFile(candidates, options.execDir ?? path.dirname(process.execPath || ''));
  pushEnvFile(candidates, options.cwd ?? process.cwd());
  pushEnvFile(candidates, options.repoRoot ?? resolveDefaultRepoRoot());
  pushEnvFile(candidates, options.packagedAppRoot);
  pushEnvFile(candidates, options.resourcesDir);

  return uniquePaths(candidates);
};

export const loadRuntimeEnv = (options: RuntimeEnvLoaderOptions = DEFAULT_RUNTIME_ENV_LOADER_OPTIONS) => {
  const loadedFiles: string[] = [];
  const candidates = resolveRuntimeEnvFileCandidates(options);

  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath) || !fs.statSync(envPath).isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    const result = dotenv.config({
      path: envPath,
      override: false,
    });

    if (!(result !== null && result !== undefined ? result.error : undefined)) {
      loadedFiles.push(envPath);
    }
  }

  return {
    candidates,
    loadedFiles,
  };
};

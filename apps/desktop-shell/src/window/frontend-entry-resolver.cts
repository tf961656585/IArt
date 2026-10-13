import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const normalizeConfiguredUrl = (
  value: string | null | undefined,
  allowedProtocols: readonly string[] = ['http:', 'https:', 'file:'],
): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (!allowedProtocols.includes(protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const resolveStaticEntryUrl = (rootDir: string): string | null => {
  const normalizedRoot = typeof rootDir === 'string' ? rootDir.trim() : '';
  if (!normalizedRoot) return null;

  const filePath = path.join(normalizedRoot, 'index.html');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return pathToFileURL(filePath).toString();
};

export const resolveHubWindowTarget = (options: {
  devUrl: string | null | undefined;
  staticRoot: string;
}): string | null => {
  return normalizeConfiguredUrl(options.devUrl ?? null) || resolveStaticEntryUrl(options.staticRoot);
};

export const resolveEditorWindowTarget = (options: {
  devUrl: string | null | undefined;
  backendBaseUrl: string | null | undefined;
  staticRoot: string | undefined;
}): string | null => {
  const devUrl = normalizeConfiguredUrl(options.devUrl ?? null, ['http:', 'https:']);
  if (devUrl) {
    return new URL('/', devUrl).toString();
  }
  const backendBaseUrl = normalizeConfiguredUrl(options.backendBaseUrl ?? null);
  if (!backendBaseUrl) {
    return null;
  }
  try {
    return new URL('/editor/', backendBaseUrl).toString();
  } catch {
    return null;
  }
};

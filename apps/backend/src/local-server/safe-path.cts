import * as path from 'node:path';

const safeJoin = (baseDir: string, target: unknown) => {
  const safeTarget = String(target || '')
    .replace(/\\/g, '/')
    .replace(/\.\.+/g, '')
    .replace(/^\/+/, '');
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, safeTarget);
  if (!resolved.startsWith(resolvedBase)) {
    return null;
  }
  return resolved;
};

export { safeJoin };

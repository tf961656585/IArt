import * as fs from 'node:fs';

/**
 * Resolve an executable file path in Electron environments with `asar` enabled.
 *
 * In packaged apps, some dependencies (e.g. `ffmpeg-static`) may resolve to a path under
 * `app.asar/...`. That path is readable via Electron's asar virtual FS but is not executable
 * by `child_process.spawn()`. The actual executable must live in `app.asar.unpacked/...`
 * (electron-builder `asarUnpack`).
 */
const resolveExecutablePath = (rawPath: unknown) => {
  const raw = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!raw) return null;

  if (raw.includes('app.asar') && !raw.includes('app.asar.unpacked')) {
    const unpacked = raw.replace('app.asar', 'app.asar.unpacked');
    return fs.existsSync(unpacked) ? unpacked : null;
  }

  return fs.existsSync(raw) ? raw : null;
};

export {
  resolveExecutablePath,
};

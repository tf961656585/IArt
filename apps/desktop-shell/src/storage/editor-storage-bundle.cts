/**
 * Editor Storage Service — Bundle Import/Export
 *
 * 迁移自 Backend bundle.cts 的 buildBundleBuffer / importBundle 逻辑。
 * 使用 JSZip 进行打包/解包。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';

// ── Constants ──

const BUNDLE_FORMAT_VERSION = 4;
const BUNDLE_PATHS = {
  MANIFEST: 'manifest.json',
  PROJECT: 'project.json',
  INDEX: 'index.json',
  NODE_TYPE_USAGE: 'node-type-usage.json',
  SQLITE: 'project.sqlite',
  MEDIA_DIR: 'media',
};

// ── Helpers ──

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

const safeBundleFileName = (value: unknown): string => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_\u4e00-\u9fa5]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'canvas';
};

const _extractMediaFilename = (url: string): string | null => {
  if (!url || typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  let encodedKey: string | null = null;
  if (raw.startsWith('/files/')) {
    const pathname = raw.split(/[?#]/)[0] ?? '';
    const match = pathname.match(/^\/files\/([^/]+)$/);
    encodedKey = match ? match[1] ?? null : null;
  }

  if (!encodedKey) return null;
  try {
    return decodeURIComponent(encodedKey);
  } catch {
    return encodedKey;
  }
};

// ── Export ──

/**
 * exportBundle — 打包 SQLite + media/ 为 zip 文件。
 *
 * 从项目目录读取 project.sqlite + media 文件夹，打包为 zip 写入 destPath。
 */
const exportBundle = async (
  projectPath: string,
  destPath: string,
): Promise<void> => {
  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedDestPath = path.resolve(destPath);

  if (!fs.existsSync(resolvedProjectPath)) {
    throw new Error('PROJECT_NOT_FOUND');
  }

  const sqlitePath = path.join(resolvedProjectPath, 'project.sqlite');
  const mediaDir = path.join(resolvedProjectPath, 'media');

  if (!fs.existsSync(sqlitePath)) {
    throw new Error('PROJECT_SQLITE_NOT_FOUND');
  }

  const zip = new JSZip();

  // 1. Add sqlite
  const sqliteBuffer = fs.readFileSync(sqlitePath);
  zip.file(BUNDLE_PATHS.SQLITE, sqliteBuffer, { compression: 'DEFLATE' });

  // 2. Add media files
  if (fs.existsSync(mediaDir)) {
    const mediaFiles = fs.readdirSync(mediaDir);
    for (const file of mediaFiles) {
      if (file.endsWith('.tmp')) continue;
      const filePath = path.join(mediaDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const buffer = fs.readFileSync(filePath);
        zip.file(`${BUNDLE_PATHS.MEDIA_DIR}/${file}`, buffer, { compression: 'DEFLATE' });
      } catch {
        // skip unreadable files
      }
    }
  }

  // 3. Add manifest
  const manifest = {
    version: BUNDLE_FORMAT_VERSION,
    format: 'iarts-bundle',
    storage: 'sqlite',
    exportedAt: new Date().toISOString(),
    compression: 'deflate',
  };
  zip.file(BUNDLE_PATHS.MANIFEST, JSON.stringify(manifest, null, 2));

  // 4. Generate zip
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  // Ensure dest directory exists
  const destDir = path.dirname(resolvedDestPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  fs.writeFileSync(resolvedDestPath, zipBuffer);
};

// ── Import ──

/**
 * importBundle — 解包 zip 到项目目录。
 *
 * 从 bundlePath 读取 zip，解压到 destDir 下新建的项目目录中。
 * 返回 projectPath。
 */
const importBundle = async (
  bundlePath: string,
  destDir: string,
  name: string | undefined,
): Promise<string> => {
  const resolvedBundlePath = path.resolve(bundlePath);
  const resolvedDestDir = path.resolve(destDir);

  if (!fs.existsSync(resolvedBundlePath)) {
    throw new Error('BUNDLE_NOT_FOUND');
  }

  // Read zip
  const zipBuffer = fs.readFileSync(resolvedBundlePath);
  const zip = await JSZip.loadAsync(zipBuffer);

  // Determine project name
  let projectName = normalizeString(name);
  if (!projectName) {
    // Try to read manifest for name
    const manifestFile = zip.file(BUNDLE_PATHS.MANIFEST);
    if (manifestFile) {
      try {
        const manifestText = await manifestFile.async('string');
        const _manifest = JSON.parse(manifestText) as unknown;
        void _manifest;
        // Use base name of bundle file as fallback
        projectName = safeBundleFileName(path.basename(resolvedBundlePath, '.iartbundle'));
      } catch {
        projectName = safeBundleFileName(path.basename(resolvedBundlePath, '.iartbundle'));
      }
    }
  }
  if (!projectName) projectName = `imported-${Date.now()}`;

  const projectPath = path.join(resolvedDestDir, projectName);

  // Create project directory
  fs.mkdirSync(projectPath, { recursive: true });
  const projectMediaDir = path.join(projectPath, 'media');
  fs.mkdirSync(projectMediaDir, { recursive: true });

  // Extract files
  const extractPromises: Promise<void>[] = [];

  zip.forEach((relativePath: string, file: JSZip.JSZipObject) => {
    if (file.dir) return;

    extractPromises.push(
      (async () => {
        try {
          const buffer = await file.async('nodebuffer');

          if (relativePath === BUNDLE_PATHS.SQLITE) {
            fs.writeFileSync(path.join(projectPath, 'project.sqlite'), buffer);
          } else if (relativePath.startsWith(`${BUNDLE_PATHS.MEDIA_DIR}/`)) {
            const mediaFileName = relativePath.slice(`${BUNDLE_PATHS.MEDIA_DIR}/`.length);
            if (mediaFileName && !mediaFileName.includes('/') && !mediaFileName.includes('..')) {
              fs.writeFileSync(path.join(projectMediaDir, mediaFileName), buffer);
            }
          }
          // Other files (manifest.json, project.json, index.json) are informational
          // in sqlite-backed bundles — the sqlite file is the source of truth.
        } catch {
          // skip problematic files
        }
      })(),
    );
  });

  await Promise.all(extractPromises);

  return projectPath;
};

export { exportBundle, importBundle };

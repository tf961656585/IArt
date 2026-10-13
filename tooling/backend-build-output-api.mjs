import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

class BackendToolingApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendToolingApiError';
    this.code = 'ERR_BACKEND_TOOLING_API_UNAVAILABLE';
  }
}

const normalizePathFromEnv = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const resolveEnvStorageRoot = () =>
  normalizePathFromEnv(process.env.IART_STORAGE_ROOT) ||
  normalizePathFromEnv(process.env.IART_DATA_ROOT) ||
  normalizePathFromEnv(process.env.IARTS_DATA_ROOT);

const resolveToolingStorageRoot = () =>
  resolveEnvStorageRoot() ||
  path.join(repoRoot, 'apps', 'backend', '.iarts-data');

const readPreferredBackendPort = () => {
  const configPath = path.join(resolveToolingStorageRoot(), 'config', 'backend.json');
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const preferred = Number.parseInt(parsed?.preferredPort, 10);
    return Number.isFinite(preferred) && preferred > 0 ? preferred : null;
  } catch {
    return null;
  }
};

const getProjectSqlitePath = (projectPath) => {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return '';
  return path.resolve(projectPath, 'project.sqlite');
};

const parseJsonObject = (payload) => {
  if (typeof payload !== 'string' || !payload.trim()) return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const loadBetterSqlite3 = () => {
  try {
    const loaded = require('better-sqlite3');
    if (typeof loaded === 'function') return loaded;
    if (loaded && typeof loaded.default === 'function') return loaded.default;
  } catch (error) {
    throw new BackendToolingApiError(
      [
        'Unable to load better-sqlite3 for tooling sqlite access.',
        'Run `pnpm abi:node -- --verify` before this tooling command.',
        error instanceof Error ? error.message : String(error),
      ].join('\n'),
    );
  }
  throw new BackendToolingApiError('better-sqlite3 does not expose a database constructor.');
};

const loadProjectGraphFromSqlite = (dbPath) => {
  const Database = loadBetterSqlite3();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const graphRow = db.prepare('SELECT payloadJson FROM graph LIMIT 1').get();
    const graphPayload = parseJsonObject(graphRow?.payloadJson);
    const nodes = db.prepare('SELECT payloadJson FROM nodes').all()
      .map((row) => parseJsonObject(row?.payloadJson));
    const edges = db.prepare('SELECT payloadJson FROM edges').all()
      .map((row) => parseJsonObject(row?.payloadJson));
    return { ...graphPayload, nodes, edges };
  } finally {
    db.close();
  }
};

const isValidProjectFolder = (projectPath) => {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return false;
  return fs.existsSync(getProjectSqlitePath(projectPath)) ||
    fs.existsSync(path.join(projectPath, 'manifest.json'));
};

const listProjectScanFiles = (projectPath) => {
  const candidates = [
    path.join(projectPath, 'nodeGraph.json'),
    path.join(projectPath, 'index.json'),
  ];
  const jobsDir = path.join(projectPath, '.iartstudio', 'jobs');
  try {
    if (fs.existsSync(jobsDir)) {
      for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
        if (entry.isFile() && /\.json$/i.test(entry.name)) {
          candidates.push(path.join(jobsDir, entry.name));
        }
      }
    }
  } catch {
    // ignore unreadable project internals
  }
  return candidates.filter((filePath) => fs.existsSync(filePath));
};

const computeLineNumberAtIndex = (text, index) => {
  if (!text || !Number.isFinite(index) || index < 0) return null;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
};

const visitJsonStrings = (value, visit) => {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitJsonStrings(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) visitJsonStrings(item, visit);
  }
};

const extractRemoteUrlsFromText = (text) => {
  const parsed = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const values = [];
  if (parsed) {
    visitJsonStrings(parsed, (value) => values.push(value));
  } else {
    values.push(text);
  }
  const urls = [];
  const remoteUrlPattern = /https?:\/\/[^\s"'<>),\]}]+/g;
  for (const value of values) {
    for (const match of value.matchAll(remoteUrlPattern)) {
      urls.push(match[0]);
    }
  }
  return urls;
};

const scanProjectRemoteMediaUrls = (projectPath) => {
  if (!isValidProjectFolder(projectPath)) return [];
  const findings = [];
  for (const filePath of listProjectScanFiles(projectPath)) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const seenInFile = new Set();
    for (const url of extractRemoteUrlsFromText(text)) {
      if (seenInFile.has(url)) continue;
      seenInFile.add(url);
      const index = text.indexOf(url);
      findings.push({
        url,
        kind: null,
        confidence: 'low',
        filePath,
        line: computeLineNumberAtIndex(text, index),
      });
    }
  }
  return findings;
};

export {
  BackendToolingApiError,
  getProjectSqlitePath,
  loadProjectGraphFromSqlite,
  readPreferredBackendPort,
  scanProjectRemoteMediaUrls,
};

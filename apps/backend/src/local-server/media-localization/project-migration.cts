import * as fs from 'node:fs';
import * as path from 'node:path';

import { isValidProjectFolder, getProjectFolderPaths } from '../storage.cts';
import { getDefaultMediaLocalization } from './index.cts';

const normalizeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const isHttpUrl = (value: unknown) => {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
};

const computeLineNumberAtIndex = (text: string, index: number) => {
  if (!text || typeof text !== 'string') return null;
  if (!Number.isFinite(index) || index < 0) return null;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
};

interface RawParsedJob {
  request: unknown | undefined;
}

const tryParseJson = (text: string) => {
  if (!text || typeof text !== 'string') return { ok: false as const, value: null };
  try {
    return { ok: true as const, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false as const, value: null };
  }
};

const safeReadText = (filePath: string) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
};

type MediaCandidateConfidence = 'high' | 'low';

interface MediaCandidateExtractorContext {
  statusUrl: string | null | undefined;
  successValue: unknown | undefined;
}

interface MediaLocalization {
  extractors: {
    extract: (input: unknown, context: MediaCandidateExtractorContext) => Array<{ url: string; kind: string; confidence: MediaCandidateConfidence }>;
  };
  ignore: {
    shouldIgnore: ((url: string, context: MediaCandidateExtractorContext) => boolean) | undefined;
  } | undefined;
}

const listProjectScanFiles = (projectPath: string) => {
  const out: string[] = [];
  const folderPaths = getProjectFolderPaths(projectPath);
  if (!folderPaths) return out;

  if (folderPaths.nodeGraph && fs.existsSync(folderPaths.nodeGraph)) {
    out.push(folderPaths.nodeGraph);
  }
  if (folderPaths.index && fs.existsSync(folderPaths.index)) {
    out.push(folderPaths.index);
  }

  const jobsDir = path.join(projectPath, '.iartstudio', 'jobs');
  try {
    if (fs.existsSync(jobsDir)) {
      const entries = fs.readdirSync(jobsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.json$/i.test(entry.name)) continue;
        out.push(path.join(jobsDir, entry.name));
      }
    }
  } catch {
    // ignore
  }

  return out;
};

interface RemoteMediaFinding {
  url: string;
  kind: string | null;
  confidence: 'high' | 'low';
  filePath: string;
  line: number | null;
}

const extractRemoteMediaUrlsFromFile = (filePath: string, localization: MediaLocalization) => {
  const text = safeReadText(filePath);
  if (!text) return [];

  const parsed = tryParseJson(text);
  const statusUrl = parsed.ok ? normalizeString(((parsed.value as RawParsedJob) !== null && (parsed.value as RawParsedJob) !== undefined ? (parsed.value as RawParsedJob).request : undefined)) : '';
  const statusUrlStr = typeof statusUrl === 'string' ? statusUrl : '';

  const extractContext: MediaCandidateExtractorContext = {
    statusUrl: statusUrlStr || null,
    successValue: undefined,
  };
  const raw = localization.extractors.extract(parsed.ok ? parsed.value : text, extractContext);

  const seen = new Set<string>();
  const findings: RemoteMediaFinding[] = [];

  for (const item of raw) {
    const url = normalizeString((item !== null && item !== undefined ? item.url : undefined));
    if (!isHttpUrl(url)) continue;
    if (seen.has(url)) continue;
    const ignorePolicy = (localization.ignore !== null && localization.ignore !== undefined) ? localization.ignore.shouldIgnore : undefined;
    if (ignorePolicy !== undefined && ignorePolicy(url, extractContext)) {
      continue;
    }

    seen.add(url);
    const idx = text.indexOf(url);
    findings.push({
      url,
      kind: normalizeString((item !== null && item !== undefined ? item.kind : undefined)) || null,
      confidence: (item !== null && item !== undefined ? item.confidence : undefined) === 'high' ? 'high' : 'low',
      filePath,
      line: idx >= 0 ? computeLineNumberAtIndex(text, idx) : null,
    });
  }
  return findings;
};

const scanProjectRemoteMediaUrls = (projectPath: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath || !isValidProjectFolder(normalizedProjectPath)) return [];

  const localization = getDefaultMediaLocalization() as MediaLocalization;
  const files = listProjectScanFiles(normalizedProjectPath);

  const out: RemoteMediaFinding[] = [];
  for (const filePath of files) {
    out.push(...extractRemoteMediaUrlsFromFile(filePath, localization));
  }
  return out;
};

export {
  scanProjectRemoteMediaUrls,
};

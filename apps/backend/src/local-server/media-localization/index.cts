const URL_REGEX = /https?:\/\/[^\s"')]+/gi;
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;

const MEDIA_URL_EXT_REGEX =
  /\.(png|jpe?g|gif|webp|bmp|svg|avif|mp4|mov|webm|mkv|mp3|wav|m4a|aac|flac|ogg)(\?|#|$)/i;

import {
  DEFAULT_DERIVE_MEDIA_DOWNLOAD_CANDIDATES_OPTIONS,
  DEFAULT_MEDIA_CANDIDATE_EXTRACTOR_CONTEXT,
  type DeriveMediaDownloadCandidatesOptions,
  type MediaCandidateExtractorContext,
} from './defaults.cts';
import { rankMediaUrlCandidate } from './ranking.cts';

type MediaCandidateConfidence = 'high' | 'low';
type UrlMap = Map<string, string>;
type WalkPrimitive = string | number | boolean;
type WalkAnyVisitor = (value: WalkPrimitive) => void;
type WalkObjectVisitor = (value: object) => void;

interface MediaUrlCandidate {
  url: string;
  confidence: MediaCandidateConfidence;
  kind: string;
}

type MediaCandidateExtractor = (input: unknown, context: MediaCandidateExtractorContext) => MediaUrlCandidate[];

interface MediaCandidateExtractorRegistry {
  register: (extractor: MediaCandidateExtractor) => void;
  extract: (input: unknown, context: MediaCandidateExtractorContext) => MediaUrlCandidate[];
}

type UrlIgnorePolicy = (url: string, context: MediaCandidateExtractorContext) => boolean;

interface UrlIgnorePolicyRegistry {
  register: (policy: UrlIgnorePolicy) => void;
  shouldIgnore: (url: string, context: MediaCandidateExtractorContext) => boolean;
}

interface RewriteResult {
  value: unknown;
  changed: boolean;
}

interface MediaContentRewriterContext extends MediaCandidateExtractorContext {
  urlMap: unknown | undefined;
}

type MediaContentRewriter = (input: unknown, context: MediaContentRewriterContext) => RewriteResult;

interface MediaContentRewriterRegistry {
  register: (rewriter: MediaContentRewriter) => void;
  rewrite: (input: unknown, context: MediaContentRewriterContext) => RewriteResult;
}

interface ProjectRemoteMediaScannerContext {
  projectPath: string | undefined;
  localization: MediaLocalization | undefined;
}

interface ProjectRemoteMediaFinding {
  url: string;
  kind: string | null;
  confidence: MediaCandidateConfidence;
  filePath: string;
  line: number | null;
}

type ProjectRemoteMediaScanner = (context: ProjectRemoteMediaScannerContext) => Promise<ProjectRemoteMediaFinding[]>;

interface ProjectRemoteMediaScannerRegistry {
  register: (scanner: ProjectRemoteMediaScanner) => void;
  scan: (context: ProjectRemoteMediaScannerContext) => Promise<ProjectRemoteMediaFinding[]>;
}

interface MediaLocalization {
  ignore: UrlIgnorePolicyRegistry;
  extractors: MediaCandidateExtractorRegistry;
  rewriters: MediaContentRewriterRegistry;
  scanners: ProjectRemoteMediaScannerRegistry;
}

interface NormalizeMediaUrlCandidateRaw {
  url: unknown | undefined;
}

interface LocalOutputRaw {
  originalUrl: unknown | undefined;
  url: unknown | undefined;
}

interface LocalOutputMapInput {
  localOutput: unknown | undefined;
  localOutputs: unknown | undefined;
}

const isPlainObject = (value: unknown): value is object => {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const normalizeString = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const isHttpUrl = (value: unknown): value is string => {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
};

const safeParseUrlHost = (url: unknown): string | null => {
  if (!isHttpUrl(url)) return null;
  try {
    const parsed = new URL(url);
    const host = String(parsed.hostname || '').toLowerCase();
    return host || null;
  } catch {
    return null;
  }
};

const readUrlMap = (context: MediaContentRewriterContext): UrlMap | null => {
  const { urlMap } = context;
  if (!(urlMap instanceof Map) || urlMap.size === 0) return null;
  return urlMap;
};

const hasRewriteResultShape = (value: object): value is { changed: unknown; value: unknown } =>
  'changed' in value && 'value' in value;

const isRewriteResult = (value: unknown): value is RewriteResult => {
  if (!isPlainObject(value)) return false;
  if (!hasRewriteResultShape(value)) return false;
  return typeof value.changed === 'boolean';
};

const readCandidateUrl = (value: unknown): string => {
  if (typeof value === 'string') return normalizeString(value);
  if (!isPlainObject(value)) return '';
  if (!('url' in value)) return '';
  const raw: NormalizeMediaUrlCandidateRaw = { url: value.url };
  return normalizeString(raw.url);
};

const readLocalOutput = (value: unknown): LocalOutputRaw | null => {
  if (!isPlainObject(value)) return null;
  return {
    originalUrl: 'originalUrl' in value ? value.originalUrl : undefined,
    url: 'url' in value ? value.url : undefined,
  };
};

const createMediaCandidateExtractorRegistry = (): MediaCandidateExtractorRegistry => {
  const extractors: MediaCandidateExtractor[] = [];

  const register = (extractor: MediaCandidateExtractor) => {
    if (typeof extractor !== 'function') {
      throw new Error('MediaCandidateExtractorRegistry.register: extractor must be a function');
    }
    extractors.push(extractor);
  };

  const extract = (input: unknown, context: MediaCandidateExtractorContext) => {
    const out: MediaUrlCandidate[] = [];
    for (const extractor of extractors) {
      try {
        const next = extractor(input, context);
        if (next.length > 0) {
          out.push(...next);
        }
      } catch {
        // ignore extractor errors -> try next
      }
    }
    return out;
  };

  return { register, extract };
};

const createUrlIgnorePolicyRegistry = (): UrlIgnorePolicyRegistry => {
  const policies: UrlIgnorePolicy[] = [];

  const register = (policy: UrlIgnorePolicy) => {
    if (typeof policy !== 'function') {
      throw new Error('UrlIgnorePolicyRegistry.register: policy must be a function');
    }
    policies.push(policy);
  };

  const shouldIgnore = (url: string, context: MediaCandidateExtractorContext) => {
    for (const policy of policies) {
      try {
        if (policy(url, context)) return true;
      } catch {
        // ignore policy errors -> treat as ignore to be safe
        return true;
      }
    }
    return false;
  };

  return { register, shouldIgnore };
};

const createMediaContentRewriterRegistry = (): MediaContentRewriterRegistry => {
  const rewriters: MediaContentRewriter[] = [];

  const register = (rewriter: MediaContentRewriter) => {
    if (typeof rewriter !== 'function') {
      throw new Error('MediaContentRewriterRegistry.register: rewriter must be a function');
    }
    rewriters.push(rewriter);
  };

  const rewrite = (input: unknown, context: MediaContentRewriterContext) => {
    let current = input;
    let changed = false;
    for (const rewriter of rewriters) {
      try {
        const result = rewriter(current, context);
        if (isRewriteResult(result) && result.changed) {
          current = result.value;
          changed = true;
        }
      } catch {
        // ignore rewriter errors -> try next
      }
    }
    return { value: current, changed };
  };

  return { register, rewrite };
};

const createProjectRemoteMediaScannerRegistry = (): ProjectRemoteMediaScannerRegistry => {
  const scanners: ProjectRemoteMediaScanner[] = [];

  const register = (scanner: ProjectRemoteMediaScanner) => {
    if (typeof scanner !== 'function') {
      throw new Error('ProjectRemoteMediaScannerRegistry.register: scanner must be a function');
    }
    scanners.push(scanner);
  };

  const scan = async (context: ProjectRemoteMediaScannerContext) => {
    const findings: ProjectRemoteMediaFinding[] = [];
    for (const scanner of scanners) {
      try {
        const next = await scanner(context);
        if (next.length > 0) {
          findings.push(...next);
        }
      } catch {
        // ignore scanner errors -> try next
      }
    }
    return findings;
  };

  return { register, scan };
};

const walkAny = (value: unknown, visitor: WalkAnyVisitor, visited: WeakSet<object>): void => {
  if (value === null || value === undefined) return;

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    visitor(value as WalkPrimitive);
    return;
  }

  if (valueType !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walkAny(item, visitor, visited);
    }
    return;
  }

  if (!isPlainObject(value)) return;
  for (const child of Object.values(value)) {
    walkAny(child, visitor, visited);
  }
};

const walkObjects = (value: unknown, visitor: WalkObjectVisitor, visited: WeakSet<object>): void => {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walkObjects(item, visitor, visited);
    }
    return;
  }

  if (!isPlainObject(value)) return;
  visitor(value);
  for (const child of Object.values(value)) {
    walkObjects(child, visitor, visited);
  }
};

const extractStructuredDataUrlCandidates: MediaCandidateExtractor = (input) => {
  const results: MediaUrlCandidate[] = [];
  const visited = new WeakSet<object>();
  walkObjects(
    input,
    (obj) => {
      if (!('data' in obj)) return;
      const { data } = obj;
      if (!Array.isArray(data)) return;
      for (const item of data) {
        if (!isPlainObject(item)) continue;
        if (!('url' in item)) continue;
        const url = normalizeString(item.url);
        if (!isHttpUrl(url)) continue;
        results.push({ url, confidence: 'high', kind: 'data.url' });
      }
    },
    visited
  );
  return results;
};

const extractMarkdownImageUrlCandidates: MediaCandidateExtractor = (input) => {
  const results: MediaUrlCandidate[] = [];
  const visited = new WeakSet<object>();
  walkAny(
    input,
    (value) => {
      if (typeof value !== 'string') return;
      const matches = value.matchAll(MARKDOWN_IMAGE_REGEX);
      for (const match of matches) {
        const url = normalizeString(match[1]);
        if (!isHttpUrl(url)) continue;
        results.push({ url, confidence: 'high', kind: 'markdown.image' });
      }
    },
    visited
  );
  return results;
};

const extractHttpUrlCandidatesFromStrings: MediaCandidateExtractor = (input) => {
  const results: MediaUrlCandidate[] = [];
  const visited = new WeakSet<object>();
  walkAny(
    input,
    (value) => {
      if (typeof value !== 'string') return;
      const matches = value.match(URL_REGEX);
      if (!matches || matches.length === 0) return;
      for (const raw of matches) {
        const url = normalizeString(raw);
        if (!isHttpUrl(url)) continue;
        results.push({ url, confidence: 'low', kind: 'url.regex' });
      }
    },
    visited
  );
  return results;
};

const extractHttpUrlCandidatesFromStringsWithContext: MediaCandidateExtractor = (input, context) => {
  const statusUrl = normalizeString(context.statusUrl);
  const results = extractHttpUrlCandidatesFromStrings(input, context);
  if (!statusUrl) return results;
  return results.filter((item) => item.url !== statusUrl);
};

const extractSuccessValueCandidate: MediaCandidateExtractor = (_input, context) => {
  const url = normalizeString(context.successValue);
  if (!isHttpUrl(url)) return [];
  return [{ url, confidence: 'high', kind: 'success.value' }];
};

const createDefaultMediaLocalization = (): MediaLocalization => {
  const ignore = createUrlIgnorePolicyRegistry();
  ignore.register((url) => {
    const trimmed = normalizeString(url);
    if (!isHttpUrl(trimmed)) return false;
    const host = safeParseUrlHost(trimmed);
    // 解析不出 host 的 URL 一律不作为媒体候选（保守忽略）。
    return !host;
  });

  const extractors = createMediaCandidateExtractorRegistry();
  extractors.register(extractSuccessValueCandidate);
  extractors.register(extractStructuredDataUrlCandidates);
  extractors.register(extractMarkdownImageUrlCandidates);
  extractors.register(extractHttpUrlCandidatesFromStringsWithContext);

  const rewriters = createMediaContentRewriterRegistry();
  rewriters.register((value, ctx) => {
    const urlMap = readUrlMap(ctx);
    if (!urlMap) {
      return { value, changed: false };
    }
    return rewriteAnyWithUrlMap(value, urlMap);
  });

  const scanners = createProjectRemoteMediaScannerRegistry();

  return {
    ignore,
    extractors,
    rewriters,
    scanners,
  };
};

const normalizeMediaUrlCandidates = (candidates: unknown): string[] => {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const url = readCandidateUrl(raw);
    if (!isHttpUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
};

const deriveMediaDownloadCandidates = (
  localization: MediaLocalization | null | undefined,
  body: unknown,
  statusUrl: unknown,
  options: DeriveMediaDownloadCandidatesOptions = DEFAULT_DERIVE_MEDIA_DOWNLOAD_CANDIDATES_OPTIONS
): string[] => {
  if (!localization) {
    return [];
  }

  const normalizedStatusUrl = normalizeString(statusUrl) || null;
  const raw = localization.extractors.extract(body, {
    statusUrl: normalizedStatusUrl,
    successValue: options.successValue,
  });
  const seen = new Set<string>();

  const out: string[] = [];
  for (const item of raw) {
    const url = normalizeString(item.url);
    if (!isHttpUrl(url)) continue;
    if (seen.has(url)) continue;
    if (normalizedStatusUrl && url === normalizedStatusUrl) continue;
    if (localization.ignore.shouldIgnore(url, { ...DEFAULT_MEDIA_CANDIDATE_EXTRACTOR_CONTEXT, statusUrl: normalizedStatusUrl })) continue;

    const confidence = item.confidence === 'high' ? 'high' : 'low';
    if (confidence === 'high') {
      seen.add(url);
      out.push(url);
      continue;
    }
    if (MEDIA_URL_EXT_REGEX.test(url)) {
      seen.add(url);
      out.push(url);
      continue;
    }
  }
  out.sort((a, b) => rankMediaUrlCandidate(b) - rankMediaUrlCandidate(a));
  return out;
};

const rewriteMarkdownImageUrls = (text: unknown, urlMap: UrlMap): unknown => {
  if (typeof text !== 'string') return text;
  if (urlMap.size === 0) return text;

  return text.replace(MARKDOWN_IMAGE_REGEX, (full: string, captured: string) => {
    const url = normalizeString(captured);
    const replacement = urlMap.get(url);
    if (!replacement) return full;
    return full.replace(captured, replacement);
  });
};

const rewriteAnyWithUrlMap = (value: unknown, urlMap: UrlMap): RewriteResult => {
  const visited = new WeakMap<object, object>();

  const walk = (input: unknown): RewriteResult => {
    if (typeof input === 'string') {
      const trimmed = input.trim();
      const directReplacement = urlMap.get(trimmed);
      const direct = directReplacement ? directReplacement : input;
      const rewritten = rewriteMarkdownImageUrls(direct, urlMap);
      return { value: rewritten, changed: rewritten !== input };
    }

    if (input === null || input === undefined) {
      return { value: input, changed: false };
    }

    if (Array.isArray(input)) {
      if (visited.has(input)) return { value: input, changed: false };
      visited.set(input, input);
      let changed = false;
      const next = input.map((item) => {
        const res = walk(item);
        if (res.changed) changed = true;
        return res.value;
      });
      return { value: changed ? next : input, changed };
    }

    if (!isPlainObject(input)) {
      return { value: input, changed: false };
    }

    if (visited.has(input)) return { value: input, changed: false };
    visited.set(input, input);

    let changed = false;
    const entries = Object.entries(input);
    const next = new Map<string, unknown>();
    for (const [key, child] of entries) {
      const res = walk(child);
      if (res.changed) changed = true;
      next.set(key, res.value);
    }
    return { value: changed ? Object.fromEntries(next) : input, changed };
  };

  return walk(value);
};

const buildOriginalUrlToLocalUrlMap = ({ localOutput, localOutputs }: LocalOutputMapInput): UrlMap => {
  const map: UrlMap = new Map();

  const add = (originalUrl: unknown, localUrl: unknown) => {
    const original = normalizeString(originalUrl);
    const local = normalizeString(localUrl);
    if (!isHttpUrl(original)) return;
    if (!local) return;
    map.set(original, local);
  };

  const singleLocalOutput = readLocalOutput(localOutput);
  if (singleLocalOutput) {
    add(singleLocalOutput.originalUrl, singleLocalOutput.url);
  }

  if (Array.isArray(localOutputs)) {
    for (const item of localOutputs) {
      const localOutputItem = readLocalOutput(item);
      if (!localOutputItem) continue;
      add(localOutputItem.originalUrl, localOutputItem.url);
    }
  }
  return map;
};

let defaultLocalization: MediaLocalization | null = null;
const getDefaultMediaLocalization = (): MediaLocalization => {
  if (defaultLocalization) return defaultLocalization;
  defaultLocalization = createDefaultMediaLocalization();
  return defaultLocalization;
};

export {
  MEDIA_URL_EXT_REGEX,
  normalizeMediaUrlCandidates,
  createMediaCandidateExtractorRegistry,
  createUrlIgnorePolicyRegistry,
  createMediaContentRewriterRegistry,
  createProjectRemoteMediaScannerRegistry,
  createDefaultMediaLocalization,
  getDefaultMediaLocalization,
  rankMediaUrlCandidate,
  deriveMediaDownloadCandidates,
  rewriteMarkdownImageUrls,
  rewriteAnyWithUrlMap,
  buildOriginalUrlToLocalUrlMap,
};

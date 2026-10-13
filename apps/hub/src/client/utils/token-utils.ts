const API_KEY_PREFIX = 'sk-';
const TOKEN_PATTERN = /^[A-Za-z0-9+/=_-]+$/;

type ComparableTokenValue = string | null | undefined;

type TokenOption = {
  value: ComparableTokenValue | undefined;
};

type ExtractedTokenOption = {
  value: string;
  label: string;
  raw: unknown;
};

const isTokenRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function stripApiKeyPrefix(value: ComparableTokenValue) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(API_KEY_PREFIX)) return trimmed;
  return trimmed.slice(API_KEY_PREFIX.length);
}

export function ensureApiKeyPrefix(value: ComparableTokenValue) {
  const base = stripApiKeyPrefix(value);
  if (!base) return '';
  return API_KEY_PREFIX + base;
}

export function isLikelyToken(value: ComparableTokenValue) {
  const normalized = stripApiKeyPrefix(value);
  const trimmed = normalized.trim();
  if (!trimmed) return false;
  if (trimmed.length < 16 || trimmed.length > 256) return false;
  if (!TOKEN_PATTERN.test(trimmed)) return false;
  return true;
}

export function maskTokenLabel(token: ComparableTokenValue) {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (trimmed.length <= 8) return trimmed;
  const lower = trimmed.toLowerCase();
  const hasPrefix = lower.startsWith(API_KEY_PREFIX);
  const prefix = hasPrefix ? trimmed.slice(0, API_KEY_PREFIX.length) : '';
  const core = hasPrefix ? trimmed.slice(API_KEY_PREFIX.length) : trimmed;
  if (core.length <= 8) {
    return prefix ? prefix + core : core;
  }
  const head = core.slice(0, 4);
  const tail = core.slice(-4);
  const maskedCore = head + '...' + tail;
  return prefix ? prefix + maskedCore : maskedCore;
}

export function normalizeTokenForCompare(value: ComparableTokenValue) {
  const normalized = stripApiKeyPrefix(value);
  return typeof normalized === 'string' ? normalized.trim() : '';
}

export function isSameToken(a: ComparableTokenValue, b: ComparableTokenValue) {
  const left = normalizeTokenForCompare(a);
  const right = normalizeTokenForCompare(b);
  if (!left || !right) return false;
  return left === right;
}

export function hasTokenInOptions(options: TokenOption[] | null | undefined, token: ComparableTokenValue) {
  if (!token) return false;
  return (options || []).some((opt: TokenOption) => isSameToken(opt && opt.value, token));
}

export function extractTokenOptions(payload: unknown): ExtractedTokenOption[] {
  const containerKeys = ['data', 'results', 'items', 'list', 'content', 'records', 'rows'];
  const tokenKeys = ['token', 'apiKey', 'api_key', 'value', 'key', 'access_token', 'accessToken'];
  const tokenNameKeys = [
    'name',
    'tokenName',
    'token_name',
    'tokenDisplayName',
    'display_name',
    'displayName',
    'label',
    'title',
    'alias',
    'remark',
    'description',
    'desc',
    'notes',
    'note',
  ];
  const discovered = new Map<string, ExtractedTokenOption>();
  const visited = new WeakSet<object>();
  const queue: unknown[] = [payload];

  const readTokenName = (source: Record<string, unknown>) => {
    for (const key of tokenNameKeys) {
      if (!source || typeof source !== 'object') continue;
      if (!(key in source)) continue;
      const candidate = source[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return null;
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === 'string') {
      const token = current.trim();
      if (token && isLikelyToken(token)) {
        if (!discovered.has(token)) {
          discovered.set(token, { value: token, label: maskTokenLabel(token), raw: current });
        }
      }
      continue;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }
    if (isTokenRecord(current)) {
      if (visited.has(current)) continue;
      visited.add(current);

      const objectRecord = current;
      const tokenCandidates: string[] = [];
      tokenKeys.forEach((key) => {
        if (!(key in current)) return;
        const candidate = objectRecord[key];
        if (typeof candidate !== 'string') return;
        const trimmed = candidate.trim();
        if (trimmed && isLikelyToken(trimmed)) {
          tokenCandidates.push(trimmed);
        }
      });

      if (tokenCandidates.length > 0) {
        const displayName = readTokenName(objectRecord);
        tokenCandidates.forEach((token) => {
          const existing = discovered.get(token);
          if (existing) {
            if (displayName && (!existing.label || existing.label === maskTokenLabel(existing.value))) {
              discovered.set(token, { ...existing, label: displayName, raw: current });
            }
            return;
          }
          discovered.set(token, {
            value: token,
            label: displayName || maskTokenLabel(token),
            raw: current,
          });
        });
      }

      containerKeys.forEach((key) => {
        if (key in current) {
          queue.push(objectRecord[key]);
        }
      });

      Object.keys(current).forEach((key) => {
        if (containerKeys.includes(key)) return;
        queue.push(objectRecord[key]);
      });
    }
  }

  return Array.from(discovered.values());
}

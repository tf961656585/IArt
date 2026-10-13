import { normalizeApiKey } from './utils.cts';

type TokenOption = {
  value: string;
  label: string;
  raw: unknown;
};

const readObjectProperty = (source: object, key: string): unknown => Reflect.get(source, key);

const isLikelyToken = (value: unknown) => {
  const normalized = normalizeApiKey(value);
  return normalized.length >= 16 && normalized.length <= 256;
};

const extractTokenOptions = (payload: unknown): TokenOption[] => {
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
  const discovered = new Map<string, TokenOption>();
  const visited = new WeakSet<object>();
  const queue: unknown[] = [payload];

  const readTokenName = (source: object): string | null => {
    for (const key of tokenNameKeys) {
      if (!(key in source)) continue;
      const candidate = readObjectProperty(source, key);
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return null;
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === 'string') {
      const token = normalizeApiKey(current);
      if (isLikelyToken(token) && !discovered.has(token)) {
        discovered.set(token, { value: token, label: token, raw: current });
      }
      continue;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }
    if (current && typeof current === 'object') {
      if (visited.has(current)) continue;
      visited.add(current);

      const tokenCandidates: string[] = [];
      tokenKeys.forEach((key) => {
        if (!(key in current)) return;
        const candidate = readObjectProperty(current, key);
        if (typeof candidate !== 'string') return;
        const normalized = normalizeApiKey(candidate);
        if (isLikelyToken(normalized)) {
          tokenCandidates.push(normalized);
        }
      });

      if (tokenCandidates.length > 0) {
        const displayName = readTokenName(current);
        tokenCandidates.forEach((token) => {
          if (!discovered.has(token)) {
            discovered.set(token, { value: token, label: displayName || token, raw: current });
          }
        });
      }

      containerKeys.forEach((key) => {
        if (key in current) queue.push(readObjectProperty(current, key));
      });
      if (isPlainObject(current)) {
        Object.values(current).forEach((value) => {
          if (value && (typeof value === 'object' || typeof value === 'string')) {
            queue.push(value);
          }
        });
      }
    }
  }

  return Array.from(discovered.values());
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';

export { extractTokenOptions, isLikelyToken };
export type { TokenOption };

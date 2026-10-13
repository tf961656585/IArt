const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;

type DynamicObj = Record<string, unknown>;

const isPlainObject = (value: unknown): value is DynamicObj => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Reflect.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const rewriteMarkdownImageUrls = (text: string, urlMap: Map<string, string>): string => {
  if (!text) return text;
  if (!(urlMap instanceof Map) || urlMap.size === 0) return text;
  return text.replace(MARKDOWN_IMAGE_REGEX, (full: string, captured: string) => {
    const url = typeof captured === 'string' ? captured.trim() : '';
    const replacement = urlMap.get(url);
    if (!replacement) return full;
    return full.replace(captured, replacement);
  });
};

export const rewriteAnyWithUrlMap = <T>(value: T, urlMap: Map<string, string>): { value: T; changed: boolean } => {
  if (!(urlMap instanceof Map) || urlMap.size === 0) {
    return { value, changed: false };
  }

  const visited = new WeakMap<object, unknown>();

  const walk = (input: unknown): { value: unknown; changed: boolean } => {
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
      if (visited.has(input)) {
        return { value: input, changed: false };
      }
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

    if (visited.has(input)) {
      return { value: input, changed: false };
    }
    visited.set(input, input);

    let changed = false;
    const next: DynamicObj = {};
    for (const [key, child] of Object.entries(input)) {
      const res = walk(child);
      if (res.changed) changed = true;
      next[key] = res.value;
    }
    return { value: (changed ? next : input) as unknown, changed };
  };

  const result = walk(value);
  return { value: result.value as T, changed: result.changed };
};

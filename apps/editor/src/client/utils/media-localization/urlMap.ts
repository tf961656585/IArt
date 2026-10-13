export type LocalOutputLike = {
  url: unknown | undefined;
  originalUrl: unknown | undefined;
  sourceUrl: unknown | undefined;
};

const normalizeString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const isHttpUrl = (value: string): boolean => {
  return value.startsWith('http://') || value.startsWith('https://');
};

export const buildOriginalUrlToLocalUrlMap = (params: {
  localOutput: unknown | undefined;
  localOutputs: unknown | undefined;
}): Map<string, string> => {
  const map = new Map<string, string>();

  const add = (originalUrl: unknown, localUrl: unknown) => {
    const original = normalizeString(originalUrl);
    const local = normalizeString(localUrl);
    if (!original || !local) return;
    if (!isHttpUrl(original)) return;
    map.set(original, local);
  };

  const localOutput = params.localOutput as LocalOutputLike | undefined;
  if (localOutput && typeof localOutput === 'object') {
    add(localOutput.sourceUrl ?? localOutput.originalUrl, localOutput.url);
  }

  const localOutputs = Array.isArray(params.localOutputs) ? (params.localOutputs as LocalOutputLike[]) : [];
  for (const item of localOutputs) {
    if (!item || typeof item !== 'object') continue;
    add(item.sourceUrl ?? item.originalUrl, item.url);
  }

  return map;
};


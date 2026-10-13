const looksLikeImageUrl = (raw: string): boolean => {
  const value = raw.trim();
  if (!value) return false;
  if (value.startsWith('/files/')) return true;
  if (value.startsWith('http://') || value.startsWith('https://')) return true;
  if (value.startsWith('data:image/')) return true;
  if (value.startsWith('blob:')) return true;
  if (value.startsWith('file://')) return true;
  return false;
};

const tryExtractImageUrlFromNodeGraphPayload = (raw: string): string | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const parsedRecord = parsed as { key: unknown | undefined; data: unknown | undefined };
    const key = typeof parsedRecord.key === 'string' ? parsedRecord.key.trim() : '';
    if (key !== 'imageInput') return null;

    const data = parsedRecord.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const imageUrl = (data as { imageUrl: unknown | undefined }).imageUrl;
    if (typeof imageUrl !== 'string') return null;
    const trimmed = imageUrl.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
};

export const tryExtractImageUrlFromDataTransfer = (dataTransfer: DataTransfer): string | null => {
  const rawNodeGraph = dataTransfer.getData('application/nodeGraph-node');
  if (rawNodeGraph) {
    const url = tryExtractImageUrlFromNodeGraphPayload(rawNodeGraph);
    if (url) return url;
  }

  const text = dataTransfer.getData('text/plain');
  if (text && looksLikeImageUrl(text)) {
    return text.trim();
  }

  return null;
};

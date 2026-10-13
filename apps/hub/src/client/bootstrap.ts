export const normalizeLocalApiBase = (value: string | null | undefined) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const protocol = String(parsed.protocol || '').toLowerCase();
    const host = String(parsed.hostname || '').toLowerCase();
    if ((protocol !== 'http:' && protocol !== 'https:') || (host !== 'localhost' && host !== '127.0.0.1')) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

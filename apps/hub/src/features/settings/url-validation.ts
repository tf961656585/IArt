/** 客户端预校验：合法 http/https URL 返回归一化串，非法返回 null。设置页各地址输入共用。 */
export const validateHttpUrlInput = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
};

import fs from 'node:fs';

/**
 * 媒体字节嗅探（spec 48 §5.5 / OF-05）：按文件头判定真实媒体格式。
 *
 * 为什么需要它：上游返回的 `Content-Type` 与内联 data URL 的 mime 声明都可能与内容不符
 * （实测：`format=gif` 的产物被声明为 `image/png`，body 是 GIF89a）。文件载体的扩展名必须与
 * 实际格式一致，而唯一可信的事实是字节本身。
 *
 * 边界：只认本产品会落盘的媒体格式；认不出就返回 null，由调用方回落到声明值。它是唯一实现，
 * 下载落盘与内联落盘共用同一份，不各自维护一张格式表。
 */

export interface SniffedMediaFormat {
  mimeType: string;
  /** 含前导点，与 path.extname 同形。 */
  extension: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 嗅探需要的最大头部字节数。
 *
 * 位图签名都在 16 字节内；SVG 是文本，`<svg` 可能出现在 XML 声明与注释之后，故放大到 512。
 */
export const MEDIA_SNIFF_HEAD_BYTES = 512;

export const sniffMediaFormat = (head: Buffer): SniffedMediaFormat | null => {
  if (head.length >= 6) {
    const signature = head.subarray(0, 6).toString('latin1');
    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return { mimeType: 'image/gif', extension: '.gif' };
    }
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF') {
    const kind = head.subarray(8, 12).toString('latin1');
    if (kind === 'WEBP') return { mimeType: 'image/webp', extension: '.webp' };
    if (kind === 'WAVE') return { mimeType: 'audio/wav', extension: '.wav' };
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return { mimeType: 'image/bmp', extension: '.bmp' };
  }
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { mimeType: 'image/avif', extension: '.avif' };
    if (brand === 'heic' || brand === 'heix') return { mimeType: 'image/heic', extension: '.heic' };
    return { mimeType: 'video/mp4', extension: '.mp4' };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { mimeType: 'video/webm', extension: '.webm' };
  }
  if (head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'ID3') {
    return { mimeType: 'audio/mpeg', extension: '.mp3' };
  }
  if (head.length >= 2 && head[0] === 0xff && (head[1] === 0xfb || head[1] === 0xf3 || head[1] === 0xf2)) {
    return { mimeType: 'audio/mpeg', extension: '.mp3' };
  }
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'OggS') {
    return { mimeType: 'audio/ogg', extension: '.ogg' };
  }
  // SVG：文本格式，没有二进制签名。判据是头部窗口内出现 `<svg`（小写后匹配），
  // 覆盖 BOM、XML 声明、注释与 DOCTYPE 前缀；比只看开头字符稳。
  const headWindow = head.subarray(0, MEDIA_SNIFF_HEAD_BYTES);
  if (headWindow.length > 0) {
    const text = headWindow.toString('utf8').replace(/^\uFEFF/, '').toLowerCase();
    if (text.includes('<svg')) return { mimeType: 'image/svg+xml', extension: '.svg' };
  }
  return null;
};

/**
 * 读文件头部若干字节并嗅探格式。读不出或认不出返回 null（调用方回落声明值）。
 */
export const sniffMediaFormatOfFile = (filePath: string): SniffedMediaFormat | null => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(MEDIA_SNIFF_HEAD_BYTES);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read <= 0) return null;
    return sniffMediaFormat(head.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
};

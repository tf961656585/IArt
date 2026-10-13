import * as fs from 'node:fs';

const readPngDimensions = (buffer: unknown) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null;
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
};

const readGifDimensions = (buffer: unknown) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  const signature = buffer.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
};

const readJpegDimensions = (buffer: unknown) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = buffer[offset + 1];
    if (marker === undefined) return null;
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= buffer.length) return null;
      marker = buffer[offset + 1];
      if (marker === undefined) return null;
    }

    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (offset + 2 > buffer.length) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (segmentLength < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }
  return null;
};

const readWebpDimensions = (buffer: unknown) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const chunkType = buffer.toString('ascii', 12, 16);
  if (chunkType === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunkType === 'VP8 ' && buffer.length >= 30) {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunkType === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
};

const readImageDimensionsFromFilePath = (filePath: unknown) => {
  const normalizedFilePath = typeof filePath === 'string' ? filePath.trim() : '';
  if (!normalizedFilePath || !fs.existsSync(normalizedFilePath)) return null;
  try {
    const buffer = fs.readFileSync(normalizedFilePath);
    return (
      readPngDimensions(buffer) ||
      readJpegDimensions(buffer) ||
      readGifDimensions(buffer) ||
      readWebpDimensions(buffer) ||
      null
    );
  } catch {
    return null;
  }
};

export { readImageDimensionsFromFilePath };

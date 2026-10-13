import * as path from 'node:path';
import { MIME_TYPES } from './constants.cts';

type KnownMimeExtension = keyof typeof MIME_TYPES;

const isKnownMimeExtension = (value: string): value is KnownMimeExtension =>
  Object.prototype.hasOwnProperty.call(MIME_TYPES, value);

const getMimeType = (filenameOrPath: unknown) => {
  const ext = path.extname(typeof filenameOrPath === 'string' ? filenameOrPath : '').toLowerCase();
  return isKnownMimeExtension(ext) ? MIME_TYPES[ext] : 'application/octet-stream';
};

export {
  getMimeType,
};

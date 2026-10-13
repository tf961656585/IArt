import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { cloneJsonValue } from '@iart/contracts';

const INLINE_STRING_LIMIT = 8 * 1024;
const INLINE_JSON_LIMIT = 16 * 1024;

type ArchiveJsonValue = string | number | boolean | null | undefined | ArchiveJsonValue[] | { [key: string]: ArchiveJsonValue };
type DynamicEventResult = Record<string, unknown>;

interface PayloadRef {
  __archive_payload_ref: {
    path: string;
    format: string;
    encoding: string;
    sha256: string;
    size: number;
  };
}

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const cloneValue = <T,>(value: T): T => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};

const ensurePayloadDir = (archiveDirPath: string | null | undefined) => {
  const archiveDir = normalizeString(archiveDirPath);
  if (!archiveDir) return null;
  const payloadDir = path.join(archiveDir, 'payloads');
  fs.mkdirSync(payloadDir, { recursive: true });
  return payloadDir;
};

const toPortableRelativePath = (fromPath: string, toPath: string) =>
  path.relative(fromPath, toPath).replace(/\\/g, '/');

const looksLikeBase64 = (value: unknown) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 256) return false;
  if (trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(trimmed);
};

interface PayloadRefInput {
  relativePath: string;
  format: string;
  encoding: string;
  sha256: string;
  size: number;
}

const buildPayloadRef = ({ relativePath, format, encoding, sha256, size }: PayloadRefInput): PayloadRef => ({
  __archive_payload_ref: {
    path: relativePath,
    format,
    encoding,
    sha256,
    size,
  },
});

interface WritePayloadInput {
  payloadDir: string;
  content: string;
  extension: string;
}

const writePayloadFile = ({ payloadDir, content, extension }: WritePayloadInput) => {
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  const fileName = `${sha256}${extension}`;
  const absolutePath = path.join(payloadDir, fileName);
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, content, 'utf-8');
  }
  return {
    absolutePath,
    sha256,
    size: Buffer.byteLength(content),
  };
};

const shouldExternalizeString = (value: unknown) =>
  typeof value === 'string' &&
  (value.length > INLINE_STRING_LIMIT || looksLikeBase64(value));

const shouldExternalizeObject = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return JSON.stringify(value).length > INLINE_JSON_LIMIT;
  } catch {
    return false;
  }
};

interface ExternalizeContext {
  payloadDir: string | null;
  depth: number | undefined;
}

const externalizeTaskArchiveValue = (value: unknown, context: ExternalizeContext): unknown => {
  const { payloadDir, depth = 0 } = context;
  if (!payloadDir) return cloneValue(value) as ArchiveJsonValue;

  if (shouldExternalizeString(value)) {
    const written = writePayloadFile({
      payloadDir,
      content: value as string,
      extension: '.txt',
    });
    return buildPayloadRef({
      relativePath: path.join('payloads', `${written.sha256}.txt`).replace(/\\/g, '/'),
      format: 'text',
      encoding: 'utf-8',
      sha256: written.sha256,
      size: written.size,
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      externalizeTaskArchiveValue(item, {
        ...context,
        depth: depth + 1,
      }),
    );
  }

  if (!value || typeof value !== 'object') return cloneValue(value) as ArchiveJsonValue;

  if (depth > 0 && shouldExternalizeObject(value)) {
    const written = writePayloadFile({
      payloadDir,
      content: JSON.stringify(value),
      extension: '.json',
    });
    return buildPayloadRef({
      relativePath: path.join('payloads', `${written.sha256}.json`).replace(/\\/g, '/'),
      format: 'json',
      encoding: 'utf-8',
      sha256: written.sha256,
      size: written.size,
    });
  }

  const result: DynamicEventResult = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = externalizeTaskArchiveValue(nested, {
      ...context,
      depth: depth + 1,
    });
  }
  return result;
};

const externalizeTaskArchiveEventPayloads = ({
  event,
  archiveRootPath,
  taskArchiveDirPath,
}: {
  event: unknown;
  archiveRootPath: string | null;
  taskArchiveDirPath: string | null;
}) => {
  if (!event || typeof event !== 'object') return cloneValue(event);
  const archiveRoot = normalizeString(archiveRootPath);
  const taskArchiveDir = normalizeString(taskArchiveDirPath);
  if (!archiveRoot || !taskArchiveDir) return cloneValue(event);
  const payloadDir = ensurePayloadDir(archiveRoot);
  if (!payloadDir) return cloneValue(event);
  const externalized = externalizeTaskArchiveValue(event, {
    payloadDir,
    depth: 0,
  });
  const rewriteRefPath = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => rewriteRefPath(item));
    }
    if (!value || typeof value !== 'object') return value;
    if (isPayloadRef(value)) {
      const ref = value.__archive_payload_ref;
      const absolutePath = path.join(payloadDir, `${ref.sha256}${ref.format === 'json' ? '.json' : '.txt'}`);
      return {
        __archive_payload_ref: {
          path: toPortableRelativePath(taskArchiveDir, absolutePath),
          format: ref.format,
          encoding: ref.encoding,
          sha256: ref.sha256,
          size: ref.size,
        },
      };
    }
    const result: DynamicEventResult = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = rewriteRefPath(nested);
    }
    return result;
  };
  return rewriteRefPath(externalized);
};

const isPayloadRef = (value: unknown): value is PayloadRef =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      '__archive_payload_ref' in value &&
      typeof (value as PayloadRef).__archive_payload_ref === 'object',
  );

const collectTaskArchivePayloadRefPaths = (event: unknown): string[] => {
  const refs = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (isPayloadRef(value)) {
      const refPath = normalizeString(value.__archive_payload_ref.path);
      if (refPath) refs.add(refPath);
      return;
    }
    for (const nested of Object.values(value)) {
      visit(nested);
    }
  };
  visit(event);
  return [...refs];
};

const readPayloadRefValue = (refValue: unknown, archiveDirPath: unknown): unknown => {
  const archiveDir = normalizeString(archiveDirPath);
  if (!archiveDir || !isPayloadRef(refValue)) return cloneValue(refValue);
  const ref = refValue.__archive_payload_ref;
  const relativePath = normalizeString(ref.path);
  const format = normalizeString(ref.format).toLowerCase() || 'text';
  if (!relativePath) return cloneValue(refValue);
  const absolutePath = path.resolve(archiveDir, relativePath);
  try {
    const text = fs.readFileSync(absolutePath, 'utf-8');
    if (format === 'json') {
      return JSON.parse(text);
    }
    return text;
  } catch {
    return null;
  }
};

const hydrateTaskArchiveEventPayloads = ({
  event,
  archiveDirPath,
}: {
  event: unknown;
  archiveDirPath: string | null;
}): unknown => {
  if (Array.isArray(event)) {
    return event.map((item) =>
      hydrateTaskArchiveEventPayloads({
        event: item,
        archiveDirPath,
      }),
    );
  }
  if (!event || typeof event !== 'object') return cloneValue(event);
  if (isPayloadRef(event)) {
    return readPayloadRefValue(event, archiveDirPath);
  }
  const result: DynamicEventResult = {};
  for (const [key, value] of Object.entries(event)) {
    result[key] = hydrateTaskArchiveEventPayloads({
      event: value,
      archiveDirPath,
    });
  }
  return result;
};

export {
  collectTaskArchivePayloadRefPaths,
  externalizeTaskArchiveEventPayloads,
  hydrateTaskArchiveEventPayloads,
  isPayloadRef,
};

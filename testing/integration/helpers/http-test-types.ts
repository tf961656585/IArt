import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';

// ─── Mock Response ──────────────────────────────────────────────

/**
 * A Writable-based HTTP response mock that accumulates body chunks.
 * Supports `writeHead` + `_write` + `end` (the subset used by the backend router).
 */
export class MemoryResponse extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = Buffer.alloc(0);

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
  }

  override _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    this.body = Buffer.concat([this.body, buf]);
    callback();
  }

  /**
   * End overload that also accepts optional data — matches the subset
   * of ServerResponse.end() the router actually calls.
   */
  override end(
    chunk?: unknown,
    encoding?: unknown,
    cb?: unknown,
  ): this {
    let data: unknown = chunk;
    let enc: unknown = encoding;
    let callback: unknown = cb;

    if (typeof data === 'function') {
      callback = data;
      data = undefined;
      enc = undefined;
    } else if (typeof enc === 'function') {
      callback = enc;
      enc = undefined;
    }

    if (data !== undefined && data !== null) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), (enc as BufferEncoding) || 'utf-8');
      this.body = Buffer.concat([this.body, buf]);
    }

    if (typeof callback === 'function') {
      super.end(callback as () => void);
      return this;
    }
    super.end();
    return this;
  }
}

// ─── Simple Object Response ─────────────────────────────────────

/**
 * For tests that build `res` as a plain object (not a Writable stream).
 * The router only calls `writeHead` and `end` on it.
 */
export interface SimpleObjectResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, headers: Record<string, string>): void;
  end(chunk?: unknown): void;
}

export function createSimpleObjectResponse(): SimpleObjectResponse {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk?: unknown) {
      if (chunk) this.body += Buffer.isBuffer(chunk) ? (chunk as Buffer).toString('utf-8') : String(chunk);
    },
  };
}

// ─── Mock Request ───────────────────────────────────────────────

/**
 * A Readable stream augmented with HTTP request properties.
 * Created via `Readable.from()` + property assignment, matching
 * the pattern used across integration tests.
 */
export interface MockRequest extends Readable {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface MockRequestOptions {
  method: string;
  url: string;
  body?: Buffer | undefined;
  headers?: Record<string, string>;
}

export function createMockRequest(options: MockRequestOptions): MockRequest {
  const chunks = options.body ? [options.body] : [];
  const req = Readable.from(chunks) as MockRequest;
  req.method = options.method;
  req.url = options.url;
  req.headers = options.headers ?? {};
  return req;
}

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) {
    throw new Error('Expected JSON object response');
  }
  return parsed;
}

export function parseSimpleObjectResponseJson(res: SimpleObjectResponse): JsonObject {
  return parseJsonObject(res.body);
}

export function parseMemoryResponseJson(res: MemoryResponse): JsonObject {
  return parseJsonObject(res.body.toString('utf-8'));
}

export function readJsonObjectProperty(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  if (!isJsonObject(value)) {
    throw new Error(`Expected JSON object property: ${key}`);
  }
  return value;
}

export function readStringProperty(source: JsonObject, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string property: ${key}`);
  }
  return value;
}

// ─── Request Handler Type ───────────────────────────────────────

/**
 * The raw handler signature returned by `createRequestHandler()` in router.cjs.
 * Uses IncomingMessage/ServerResponse as the actual router does.
 */
export type RawRequestHandler = (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => Promise<void>;

/**
 * Convenience: the handler type after wrapping to work with MockRequest / MemoryResponse.
 * Accepts either MemoryResponse (Writable-based) or SimpleObjectResponse.
 */
export type RequestHandler = (req: MockRequest, res: MemoryResponse | SimpleObjectResponse) => Promise<void>;

/**
 * The shape of the router module as loaded from `router.cjs`.
 * createRequestHandler returns a handler function that is duck-type
 * compatible with various test request/response types (MockRequest,
 * MemoryResponse, SimpleObjectResponse, IncomingMessage, ServerResponse).
 * Typed as unknown parameters for maximum test flexibility.
 */
export interface RouterModule {
  createRequestHandler: (options?: { baseDir?: string }) => (req: unknown, res: unknown) => Promise<void>;
  setServerPort: (value: unknown) => void;
  getServerPort: () => number | null;
  applyBundleMediaRefsToMediaAssets: (mediaAssets: Record<string, unknown>, mediaUrlMap: Map<string, string>) => Record<string, unknown>;
}

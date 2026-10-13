import type * as http from 'node:http';
import { URL } from 'node:url';
import { HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';

type HeaderRecord = Record<string, string>;

const isAllowedOrigin = (origin: unknown): boolean => {
  if (!origin || typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};

const buildCorsHeaders = (origin: unknown, allowHeaders: unknown | undefined): HeaderRecord => {
  if (!origin || typeof origin !== 'string') {
    return {};
  }
  const allowedHeaders =
    typeof allowHeaders === 'string' && allowHeaders.trim()
      ? allowHeaders
      : ['content-type', 'authorization', 'x-workers-timeout', 'new-api-user', HUB_LOCAL_WRITE_TOKEN_HEADER].join(',');
  const normalizedMethods = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': normalizedMethods,
    'Access-Control-Allow-Headers': allowedHeaders,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
};

const sendJson = (
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: HeaderRecord = {},
): void => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
};

const sendError = (
  res: http.ServerResponse,
  status: number | undefined,
  code: unknown,
  message: unknown,
  headers: HeaderRecord = {},
): void => {
  sendJson(res, typeof status === 'number' ? status : 500, { code, message }, headers);
};

const readBody = (req: http.IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on('end', () => {
    resolve(Buffer.concat(chunks));
  });
  req.on('error', (error: Error) => reject(error));
});

export {
  isAllowedOrigin,
  buildCorsHeaders,
  sendJson,
  sendError,
  readBody,
};

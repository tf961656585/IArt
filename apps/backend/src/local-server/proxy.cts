import type * as http from 'node:http';
import { Readable } from 'node:stream';

import { ERROR_CODES } from './constants.cts';
import { sendError, sendJson, readBody, isAllowedOrigin } from './http-utils.cts';
import { isAllowedRemoteUrl } from './network.cts';
import { writeHttpRequestRecord } from './request-record.cts';
import { getFetchDispatcher } from './fetch-dispatcher.cts';

const isLocalRequest = (req: http.IncomingMessage) => {
  const origin = req.headers.origin;
  if (origin) {
    return isAllowedOrigin(origin);
  }
  const host = req.headers.host || '';
  return host.includes('localhost') || host.includes('127.0.0.1');
};

const rewriteSetCookie = (raw: string, forceLax: boolean) => {
  if (!raw || typeof raw !== 'string') return raw;
  if (!forceLax) return raw;
  const parts = raw.split(';').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return raw;
  const nameValue = parts[0];
  if (!nameValue) return raw;
  const next: string[] = [];
  let hasSameSite = false;
  for (let i = 1; i < parts.length; i += 1) {
    const attr = parts[i];
    if (!attr) continue;
    const lower = attr.toLowerCase();
    if (lower === 'secure') {
      continue;
    }
    if (lower.startsWith('samesite=')) {
      hasSameSite = true;
      const rawValue = attr.split('=')[1] || '';
      const normalized = rawValue.trim().toLowerCase();
      const value = normalized === 'none' ? 'Lax' : normalized === 'strict' ? 'Strict' : 'Lax';
      next.push(`SameSite=${value}`);
      continue;
    }
    next.push(attr);
  }
  if (!hasSameSite) {
    next.push('SameSite=Lax');
  }
  return [nameValue, ...next].join('; ');
};

interface ProxyOptions {
  targetUrl: string;
  corsHeaders: Record<string, string>;
  responseHeaderAllowlist: Set<string> | undefined;
  extraRequestHeaders: Record<string, string> | undefined;
  bodyOverride: Buffer | string | undefined;
  authCookieHeader: string | undefined;
  authUserId: string | undefined;
  captureAuthCookies: boolean | undefined;
  exposeSetCookie: boolean | undefined;
}

const proxyRequest = async (req: http.IncomingMessage, res: http.ServerResponse, options: ProxyOptions) => {
  const {
    targetUrl,
    corsHeaders,
    responseHeaderAllowlist,
    extraRequestHeaders,
    bodyOverride,
    authCookieHeader,
    authUserId,
    exposeSetCookie,
  } = options;
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    sendError(res, 400, ERROR_CODES.INVALID_URL, 'Invalid upstream URL', corsHeaders);
    return;
  }
  if (!isAllowedRemoteUrl(parsedTarget)) {
    sendError(res, 403, ERROR_CODES.REMOTE_HOST_NOT_ALLOWED, 'Remote host not allowed', corsHeaders);
    return;
  }
  const method = req.method || 'GET';
  const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase());
  let bodyBuffer: Buffer | null = null;

  if (hasBody && bodyOverride !== undefined) {
    bodyBuffer = Buffer.isBuffer(bodyOverride) ? bodyOverride : Buffer.from(String(bodyOverride));
  } else if (hasBody) {
    bodyBuffer = (await readBody(req)) as Buffer | null;
  }

  const headers = new Headers();
  Object.entries(req.headers).forEach(([key, value]) => {
    if (!value) return;
    const lower = key.toLowerCase();
    if (['host', 'connection', 'content-length', 'cookie'].includes(lower)) return;
    headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
  });

  if (extraRequestHeaders) {
    Object.entries(extraRequestHeaders).forEach(([key, value]) => {
      if (value) headers.set(key, String(value));
    });
  }

  if (authCookieHeader !== undefined) {
    if (authCookieHeader) {
      headers.set('cookie', authCookieHeader);
    } else {
      headers.delete('cookie');
    }
  }
  if (authUserId) {
    headers.set('new-api-user', authUserId);
  }
  const proxyRequestId = `proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestLogStartMs = Date.now();
  let upstream: Response;
  try {
    const proxyFetchOptions: RequestInit & { dispatcher: unknown | undefined } = {
      method,
      headers,
      dispatcher: getFetchDispatcher(),
      ...(bodyBuffer ? { body: bodyBuffer as BodyInit } : {}),
    };
    upstream = await fetch(targetUrl, proxyFetchOptions);
  } catch (error) {
    try {
      writeHttpRequestRecord({
        projectPath: null,
        taskId: proxyRequestId,
        attempt: 1,
        metadata: { scope: 'proxy', targetUrl: String(targetUrl) },
        request: {
          url: String(targetUrl),
          method,
          headers: Object.fromEntries(headers.entries()),
          body: bodyBuffer ? { byteLength: bodyBuffer.length } : null,
        },
        error,
        timing: {
          startedAt: new Date(requestLogStartMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - requestLogStartMs,
        },
      });
    } catch {
      // ignore
    }
    sendJson(
      res,
      502,
      { code: ERROR_CODES.UPSTREAM_FAILED, message: 'Upstream request failed', detail: String(error) },
      corsHeaders,
    );
    return;
  }

  try {
    const upstreamHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      upstreamHeaders[key] = value;
    });
    writeHttpRequestRecord({
      projectPath: null,
      taskId: proxyRequestId,
      attempt: 1,
      metadata: { scope: 'proxy', targetUrl: String(targetUrl) },
      request: {
        url: String(targetUrl),
        method,
        headers: Object.fromEntries(headers.entries()),
        body: bodyBuffer ? { byteLength: bodyBuffer.length } : null,
      },
      response: {
        status: upstream.status,
        ok: upstream.ok,
        contentType: upstream.headers.get('content-type') || '',
        headers: upstreamHeaders,
        body: null,
        bodyType: null,
        file: null,
        receivedAt: new Date().toISOString(),
      },
      timing: {
        startedAt: new Date(requestLogStartMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - requestLogStartMs,
      },
    });
  } catch {
    // ignore
  }

  const responseHeaders: Record<string, string | string[]> = { ...corsHeaders };
  upstream.headers.forEach((value, key) => {
    if (!responseHeaderAllowlist || responseHeaderAllowlist.has(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  });

  const setCookie: string[] =
    typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : upstream.headers.get('set-cookie')
      ? [upstream.headers.get('set-cookie') ?? '']
        : [];

  if (setCookie.length > 0) {
    if (exposeSetCookie) {
      const shouldRewrite = isLocalRequest(req);
      responseHeaders['Set-Cookie'] = setCookie.map((cookie) => rewriteSetCookie(cookie, shouldRewrite));
    }
  }

  res.writeHead(upstream.status, responseHeaders);
  if (upstream.body) {
    const bodyStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    bodyStream.pipe(res);
  } else {
    res.end();
  }
};

export {
  proxyRequest,
  isLocalRequest,
  rewriteSetCookie,
};

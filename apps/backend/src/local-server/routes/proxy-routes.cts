import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import * as announcementModule from "../announcement.cts";
import * as configStoreModule from "../config-store.cts";
import * as constantsModule from "../constants.cts";
import * as fetchDispatcherModule from "../fetch-dispatcher.cts";
import * as httpUtilsModule from "../http-utils.cts";
import type { HeadersRecord, RouteDefinition } from "../http/route-registry.cts";
import * as networkModule from "../network.cts";
import * as proxyModule from "../proxy.cts";
import * as requestRecordModule from "../request-record.cts";

type FetchInitWithDispatcher = RequestInit & { dispatcher: unknown | undefined };

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;
const { getEffectiveMaxMediaSize } = configStoreModule;
const { writeHttpRequestRecord } = requestRecordModule;
const { proxyRequest } = proxyModule;
const { isAllowedRemoteUrl } = networkModule;
const { readAnnouncement } = announcementModule;

const readAnnouncementSafe = readAnnouncement as () => unknown;

const toHeadersRecord = (headers: Headers): HeadersRecord => {
  const record: HeadersRecord = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

const writeProxyRecordSafely = (record: Parameters<typeof writeHttpRequestRecord>[0]) => {
  try {
    writeHttpRequestRecord(record);
  } catch {
    void 0;
  }
};

const buildProxyTiming = (requestLogStartMs: number) => ({
  startedAt: new Date(requestLogStartMs).toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - requestLogStartMs,
});

const handleHttpProxy = async ({ req, res, url, corsHeaders }: Parameters<RouteDefinition["handle"]>[0]) => {
  const urlParam = url.searchParams.get("url");
  if (!urlParam) {
    sendJson(res, 400, { error: "Missing url", code: ERROR_CODES.INVALID_URL }, corsHeaders);
    return;
  }
  await proxyRequest(req, res, {
    targetUrl: urlParam,
    corsHeaders,
    responseHeaderAllowlist: undefined,
    extraRequestHeaders: undefined,
    bodyOverride: undefined,
    authCookieHeader: undefined,
    authUserId: undefined,
    captureAuthCookies: undefined,
    exposeSetCookie: undefined,
  });
};

const handleMediaProxy = async ({ res, url, corsHeaders }: Parameters<RouteDefinition["handle"]>[0]) => {
  const urlParam = url.searchParams.get("url");
  const format = url.searchParams.get("format") || "blob";
  const maxMediaSize = getEffectiveMaxMediaSize();
  if (!urlParam) {
    sendJson(res, 400, { error: "Missing url", code: ERROR_CODES.INVALID_URL }, corsHeaders);
    return;
  }
  let targetUrl;
  try {
    targetUrl = new URL(urlParam);
  } catch {
    sendJson(res, 400, { error: "Invalid URL", code: ERROR_CODES.INVALID_URL }, corsHeaders);
    return;
  }
  if (!isAllowedRemoteUrl(targetUrl)) {
    sendJson(
      res,
      403,
      {
        error: "Remote host not allowed",
        code: ERROR_CODES.REMOTE_HOST_NOT_ALLOWED,
      },
      corsHeaders,
    );
    return;
  }
  const controller = new AbortController();
  const requestId = `media-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestLogStartMs = Date.now();
  let response;
  try {
    response = await fetch(targetUrl.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": "IARTS-Media-Proxy/1.0" },
      dispatcher: fetchDispatcherModule.getFetchDispatcher(),
    } as FetchInitWithDispatcher);
  } catch (error) {
    writeProxyRecordSafely({
      projectPath: null,
      taskId: requestId,
      attempt: 1,
      metadata: { scope: "media-proxy", url: targetUrl.toString(), format },
      request: {
        url: targetUrl.toString(),
        method: "GET",
        headers: { "User-Agent": "IARTS-Media-Proxy/1.0" },
        body: null,
      },
      error,
      timing: buildProxyTiming(requestLogStartMs),
    });
    sendJson(
      res,
      502,
      {
        error: `Proxy failed: ${String(error)}`,
        code: ERROR_CODES.UPSTREAM_FAILED,
      },
      corsHeaders,
    );
    return;
  }
  if (format !== "base64") {
    writeProxyRecordSafely({
      projectPath: null,
      taskId: requestId,
      attempt: 1,
      metadata: { scope: "media-proxy", url: targetUrl.toString(), format },
      request: {
        url: targetUrl.toString(),
        method: "GET",
        headers: { "User-Agent": "IARTS-Media-Proxy/1.0" },
        body: null,
      },
      response: {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") || "",
        headers: toHeadersRecord(response.headers),
        body: null,
        bodyType: null,
        file: null,
        receivedAt: new Date().toISOString(),
      },
      timing: buildProxyTiming(requestLogStartMs),
    });
  }
  if (!response.ok) {
    sendJson(
      res,
      response.status,
      {
        error: `Upstream ${response.status}`,
        code: ERROR_CODES.UPSTREAM_FAILED,
      },
      corsHeaders,
    );
    return;
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const size = Number.parseInt(contentLength, 10);
    if (size > maxMediaSize) {
      sendJson(res, 413, { error: "File too large", code: ERROR_CODES.FILE_TOO_LARGE }, corsHeaders);
      return;
    }
  }
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (format === "base64") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxMediaSize) {
      sendJson(res, 413, { error: "File too large", code: ERROR_CODES.FILE_TOO_LARGE }, corsHeaders);
      return;
    }
    const base64 = buffer.toString("base64");
    writeProxyRecordSafely({
      projectPath: null,
      taskId: requestId,
      attempt: 1,
      metadata: { scope: "media-proxy", url: targetUrl.toString(), format },
      request: {
        url: targetUrl.toString(),
        method: "GET",
        headers: { "User-Agent": "IARTS-Media-Proxy/1.0" },
        body: null,
      },
      response: {
        status: response.status,
        ok: response.ok,
        contentType,
        headers: toHeadersRecord(response.headers),
        body: {
          data: `data:${contentType};base64,${base64}`,
          mimeType: contentType,
          size: buffer.byteLength,
        },
        bodyType: "json",
        file: null,
        receivedAt: new Date().toISOString(),
      },
      timing: buildProxyTiming(requestLogStartMs),
    });
    sendJson(
      res,
      200,
      {
        data: `data:${contentType};base64,${base64}`,
        mimeType: contentType,
        originalUrl: targetUrl.toString(),
        size: buffer.byteLength,
      },
      corsHeaders,
    );
    return;
  }
  const filename = targetUrl.pathname.split("/").filter(Boolean).pop() || "media";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600",
    "Content-Disposition": `inline; filename="${filename}"`,
    ...corsHeaders,
  });
  if (response.body) {
    const responseBody = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    responseBody.pipe(res);
  } else {
    res.end();
  }
};

const createProxyRoutes = (): RouteDefinition[] => {
  return [
  {
    name: "http-proxy",
    match: ({ pathname }) => pathname === "/api/http-proxy",
    handle: handleHttpProxy,
  },
  {
    name: "media-proxy",
    match: ({ req, pathname }) => pathname === "/api/media-proxy" && req.method === "GET",
    handle: handleMediaProxy,
  },
  {
    name: "workers-announcement",
    match: ({ pathname }) => pathname === "/api/workers-proxy/announcement",
    handle: ({ req, res, corsHeaders }) => {
      if (req.method === "GET") {
        const payload = readAnnouncementSafe();
        sendJson(res, 200, payload, {
          ...corsHeaders,
          "Cache-Control": "no-store, max-age=0",
        });
        return;
      }
      sendError(res, 405, ERROR_CODES.METHOD_NOT_ALLOWED, "Method not allowed", corsHeaders);
    },
  },
  ];
};

export { createProxyRoutes };

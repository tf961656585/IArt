import { MODEL_ASSET_NODE_PROJECTIONS_ROUTE, ModelAssetNodeProjectionResponseSchema } from '@iart/contracts/model-asset-contract';
import { HubLocalWriteTrustProbeResponseSchema } from '@iart/contracts';

import * as configStoreModule from '../config-store.cts';
import * as constantsModule from '../constants.cts';
import * as fetchDispatcherModule from '../fetch-dispatcher.cts';
import * as httpUtilsModule from '../http-utils.cts';
import * as loggingModule from '../logging.cts';
import * as storageModule from '../storage.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';

type BackendConfigLike = {
  allowedRemoteHosts: unknown | undefined;
};

type ModelProjectionCatalogLike = {
  projections: unknown | undefined;
  localization_bundles: unknown | undefined;
  diagnostics: unknown | undefined;
  loaded_at: unknown | undefined;
  package_root: unknown | undefined;
};

type SystemRouteOptions = {
  getServerPort: () => number | null;
  modelPackageCatalog: unknown;
};

const { ERROR_CODES, HOST } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;
const {
  getBackendConfig,
  updateBackendConfig,
  pickBackendConfigUpdate,
  validateProxyConfigUpdate,
  validatePublicRelayTargetsUpdate,
  getEffectiveLogLevel,
  getEffectiveMaxUploadSize,
  getEffectiveMaxMediaSize,
  getEffectiveMaxBatchTasks,
  getEffectiveExpandInlineParamsOnStartup,
  resolveListenPort,
  normalizeAllowedHosts,
  getAllowedRemoteHosts,
} = configStoreModule;
const { ensureStorageDirs } = storageModule;
const { logInfo, readLogTail, getLogFilePath } = loggingModule;

const isJsonObject = (value: unknown): value is object =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const getBackendConfigLike = (value: unknown): BackendConfigLike | null =>
  isJsonObject(value) ? (value as BackendConfigLike) : null;

const getModelProjectionCatalogLike = (value: unknown): ModelProjectionCatalogLike | null =>
  isJsonObject(value) ? (value as ModelProjectionCatalogLike) : null;

const buildConfigResponse = (serverPort: number | null) => {
  const resolved = {
    preferredPort: resolveListenPort(),
    logLevel: getEffectiveLogLevel(),
    maxUploadSize: getEffectiveMaxUploadSize(),
    maxMediaSize: getEffectiveMaxMediaSize(),
    maxBatchTasks: getEffectiveMaxBatchTasks(),
    expandInlineParamsOnStartup: Boolean(getEffectiveExpandInlineParamsOnStartup()),
    agentDefaultModelId: getBackendConfig().agentDefaultModelId,
    generationDefaultModelId: getBackendConfig().generationDefaultModelId,
    allowedRemoteHosts: Array.from(getAllowedRemoteHosts()),
    proxyMode: getBackendConfig().proxyMode,
    proxyUrl: getBackendConfig().proxyUrl || null,
  };
  const server = {
    port: serverPort,
    baseUrl: serverPort ? `http://${HOST}:${serverPort}` : null,
  };
  const backendConfig = getBackendConfigLike(getBackendConfig()) ?? ({} as BackendConfigLike);
  const config = {
    ...backendConfig,
    allowedRemoteHosts: normalizeAllowedHosts(backendConfig.allowedRemoteHosts),
  };
  return { config, resolved, server };
};

const buildDiagnosticsPayload = (serverPort: number | null) => {
  const paths = ensureStorageDirs();
  const logPath = getLogFilePath(paths);
  return {
    timestamp: new Date().toISOString(),
    config: buildConfigResponse(serverPort),
    logs: readLogTail(logPath, 200),
    process: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.round(process.uptime()),
    },
  };
};

const createSystemRoutes = ({ getServerPort, modelPackageCatalog }: SystemRouteOptions): RouteDefinition[] => [
  {
    name: 'health',
    match: ({ req, pathname }) => req.method === 'GET' && (pathname === '/health' || pathname === '/api/health'),
    handle: ({ res, corsHeaders }) => {
      sendJson(res, 200, { status: 'ok', port: getServerPort(), timestamp: new Date().toISOString() }, corsHeaders);
    },
  },
  {
    name: 'model-projections',
    match: ({ req, pathname }) => req.method === 'GET' && pathname === MODEL_ASSET_NODE_PROJECTIONS_ROUTE,
    handle: ({ res, corsHeaders }) => {
      const catalog = getModelProjectionCatalogLike(modelPackageCatalog) ?? ({} as ModelProjectionCatalogLike);
      const payload = ModelAssetNodeProjectionResponseSchema.parse({
        success: true,
        loaded_at: typeof (catalog !== null && catalog !== undefined ? catalog.loaded_at : undefined) === 'string' ? catalog.loaded_at : new Date().toISOString(),
        package_root: typeof (catalog !== null && catalog !== undefined ? catalog.package_root : undefined) === 'string' ? catalog.package_root : '',
        projections: Array.isArray((catalog !== null && catalog !== undefined ? catalog.projections : undefined)) ? catalog.projections : [],
        localization_bundles: Array.isArray((catalog !== null && catalog !== undefined ? catalog.localization_bundles : undefined)) ? catalog.localization_bundles : [],
        diagnostics: Array.isArray((catalog !== null && catalog !== undefined ? catalog.diagnostics : undefined)) ? catalog.diagnostics : [],
      });
      sendJson(
        res,
        200,
        payload,
        { ...corsHeaders, 'Cache-Control': 'no-store' },
      );
    },
  },
  {
    name: 'config',
    match: ({ pathname }) => pathname === '/api/config',
    handle: async ({ req, res, corsHeaders }) => {
      if (req.method === 'GET') {
        sendJson(res, 200, buildConfigResponse(getServerPort()), corsHeaders);
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const typedBody = getBackendConfigLike(body);
        if (!typedBody) {
          sendJson(res, 400, { message: 'Invalid config payload' }, corsHeaders);
          return;
        }
        const update = pickBackendConfigUpdate(typedBody);
        const proxyError = validateProxyConfigUpdate(update, getBackendConfig());
        if (proxyError !== null) {
          sendJson(res, 400, { message: proxyError }, corsHeaders);
          return;
        }
        const relayError = validatePublicRelayTargetsUpdate(update);
        if (relayError !== null) {
          sendJson(res, 400, { message: relayError }, corsHeaders);
          return;
        }
        const prevProxyMode = getBackendConfig().proxyMode;
        const prevProxyUrl = getBackendConfig().proxyUrl;
        const nextConfig = updateBackendConfig(update);
        ensureStorageDirs();
        const proxyChanged =
          nextConfig.proxyMode !== prevProxyMode || nextConfig.proxyUrl !== prevProxyUrl;
        if (proxyChanged) {
          // 保存即生效：按新配置异步重建出站 dispatcher（system 模式需探测 OS 代理）。
          void fetchDispatcherModule.rebuildFetchDispatcher().catch(() => undefined);
        }
        logInfo('config updated', {
          preferredPort: nextConfig.preferredPort || 0,
          logLevel: nextConfig.logLevel,
          maxBatchTasks: nextConfig.maxBatchTasks,
          expandInlineParamsOnStartup: nextConfig.expandInlineParamsOnStartup === true,
          agentDefaultModelId: nextConfig.agentDefaultModelId ?? '(none)',
          generationDefaultModelId: nextConfig.generationDefaultModelId ?? '(none)',
          proxyMode: nextConfig.proxyMode,
          proxyChanged,
        });
        sendJson(res, 200, buildConfigResponse(getServerPort()), corsHeaders);
        return;
      }
      sendError(res, 405, ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed', corsHeaders);
    },
  },
  {
    name: 'hub-local-write-trust-probe',
    match: ({ req, pathname }) => req.method === 'GET' && pathname === '/api/hub/local-write-trust/probe',
    handle: ({ res, corsHeaders }) => {
      sendJson(res, 200, HubLocalWriteTrustProbeResponseSchema.parse({ success: true }), {
        ...corsHeaders,
        'Cache-Control': 'no-store',
      });
    },
  },
  {
    name: 'diagnostics',
    match: ({ pathname }) => pathname === '/api/diagnostics' || pathname === '/api/diagnostics/bundle',
    handle: ({ req, res, pathname, corsHeaders }) => {
      if (req.method !== 'GET') {
        sendError(res, 405, ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed', corsHeaders);
        return;
      }
      const payload = buildDiagnosticsPayload(getServerPort());
      if (pathname === '/api/diagnostics/bundle') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="diagnostics-${Date.now()}.json"`,
          ...corsHeaders,
        });
        res.end(JSON.stringify(payload));
        return;
      }
      sendJson(res, 200, payload, corsHeaders);
    },
  },
];

export { createSystemRoutes };

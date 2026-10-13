import type * as http from 'node:http';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { Duplex } from 'node:stream';

interface ServerUpgradeRouter {
  routes: Map<string, { wss: WebSocketServer }>;
  listener: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
}

const serverRouterRegistry = new WeakMap<http.Server, ServerUpgradeRouter>();

const normalizeUpgradePath = (value: unknown) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed, 'http://127.0.0.1').pathname;
  } catch {
    const queryIndex = trimmed.indexOf('?');
    return queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed;
  }
};

type UpgradeListener = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void;

const removeUpgradeListener = (server: http.Server, listener: UpgradeListener) => {
  if (!server || typeof listener !== 'function') return;
  if (typeof server.off === 'function') {
    server.off('upgrade', listener);
    return;
  }
  if (typeof server.removeListener === 'function') {
    server.removeListener('upgrade', listener);
  }
};

const ensureServerUpgradeRouter = (server: http.Server): ServerUpgradeRouter => {
  const existing = serverRouterRegistry.get(server);
  if (existing) {
    return existing;
  }

  const routes = new Map<string, { wss: WebSocketServer }>();
  const listener: UpgradeListener = (request, socket, head) => {
    const pathname = normalizeUpgradePath((request !== null && request !== undefined ? request.url : undefined) || '');
    const route = pathname ? routes.get(pathname) : null;
    if (!route) {
      return;
    }
    route.wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      route.wss.emit('connection', ws, request);
    });
  };

  server.on('upgrade', listener);
  const created: ServerUpgradeRouter = { routes, listener };
  serverRouterRegistry.set(server, created);
  return created;
};

const attachPathWebSocketServer = (server: http.Server, wsPath: string) => {
  if (!server || typeof server.on !== 'function') {
    throw new TypeError('attachPathWebSocketServer requires a Node HTTP server');
  }

  const normalizedPath = normalizeUpgradePath(wsPath);
  if (!normalizedPath) {
    throw new TypeError('attachPathWebSocketServer requires a valid websocket path');
  }

  const router = ensureServerUpgradeRouter(server);
  if (router.routes.has(normalizedPath)) {
    throw new Error(`WebSocket path already registered: ${normalizedPath}`);
  }

  const wss = new WebSocketServer({ noServer: true });
  router.routes.set(normalizedPath, { wss });

  const originalClose = wss.close.bind(wss);
  wss.close = (callback: (err: Error | undefined) => void | undefined) => {
    router.routes.delete(normalizedPath);
    if (router.routes.size === 0) {
      removeUpgradeListener(server, router.listener);
      serverRouterRegistry.delete(server);
    }
    return originalClose(callback);
  };

  return wss;
};

export {
  attachPathWebSocketServer,
};

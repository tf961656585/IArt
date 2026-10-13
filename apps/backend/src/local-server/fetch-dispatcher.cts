import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';
import { getBackendConfig } from './config-store.cts';
import { logDebug, logInfo, logWarn } from './logging.cts';
import { detectSystemProxy, type DetectedSystemProxy } from './system-proxy-detect.cts';

/**
 * Backend 出站 fetch 的 dispatcher 管理（网络代理挂载点）。
 *
 * 治理原则（docs/runtime/远端请求执行治理原则.md）：不设超时——
 * 所有 dispatcher（直连 Agent / 代理 EnvHttpProxyAgent）统一 headersTimeout/bodyTimeout=0。
 *
 * 模式（Hub「设置 → 网络代理」，config-store proxyMode/proxyUrl）：
 * - direct：裸 Agent 直连（原行为）
 * - manual：EnvHttpProxyAgent 显式绑定 proxyUrl（http/https，可含 user:pass）
 * - system：按 OS 代理设置（scutil / reg / gsettings）绑定；PAC/SOCKS/无代理降级直连并留痕
 *
 * 生命周期：
 * - 初始状态恒为直连；`initFetchDispatcher()`（启动）与 `rebuildFetchDispatcher()`
 *   （PUT /api/config 保存后）异步重建，完成前请求按直连执行。
 * - `getFetchDispatcher()` 为同步消费口（各 fetch 调用点在请求时取当前值），
 *   首次调用若配置非 direct 且未完成初始化，触发一次后台刷新（去重）。
 * - 重建时旧代理 dispatcher 优雅 close（进行中的请求自然跑完，不 destroy）。
 */

const DIRECT_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

// 本地回环永不走代理（backend 自身、渲染层回连等）
const LOCAL_NO_PROXY = '127.0.0.1,localhost,::1,[::1]';

type ProxyResolution = {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
};

/** 仅消费 proxyMode/proxyUrl 两字段（BackendConfig 结构上兼容此视图）。 */
type ProxyConfigView = { proxyMode: string; proxyUrl: string };

const joinNoProxy = (extras: string[]): string =>
  extras.length > 0 ? `${LOCAL_NO_PROXY},${extras.join(',')}` : LOCAL_NO_PROXY;

/** manual 模式解析：直接取已归一化的 proxyUrl（normalizeProxyUrl 保证合法 http/https）。 */
const resolveManualProxy = (config: ProxyConfigView): ProxyResolution | null => {
  if (!config.proxyUrl) {
    logDebug('proxy dispatcher: manual mode without proxyUrl, fallback direct', undefined);
    return null;
  }
  return {
    httpProxy: config.proxyUrl,
    httpsProxy: config.proxyUrl,
    noProxy: LOCAL_NO_PROXY,
  };
};

/** system 模式解析：按 OS 检测结果；PAC/自动检测/双空按直连降级并留痕。 */
const resolveSystemProxy = (detected: DetectedSystemProxy): ProxyResolution | null => {
  if (detected.unsupported !== null) {
    logDebug(`proxy dispatcher: system proxy unsupported (${detected.unsupported}), fallback direct`, undefined);
    return null;
  }
  if (!detected.httpProxy && !detected.httpsProxy) {
    logDebug('proxy dispatcher: system proxy not configured, fallback direct', undefined);
    return null;
  }
  // 只配了单边时用另一边补齐（undici EnvHttpProxyAgent 对空值会回落 process.env，必须显式传串）
  const httpProxy = detected.httpProxy || detected.httpsProxy;
  const httpsProxy = detected.httpsProxy || detected.httpProxy;
  return { httpProxy, httpsProxy, noProxy: joinNoProxy(detected.noProxy) };
};

const buildResolution = async (config: ProxyConfigView): Promise<ProxyResolution | null> => {
  if (config.proxyMode === 'direct') return null;
  if (config.proxyMode === 'manual') return resolveManualProxy(config);
  const detected = await detectSystemProxy();
  return resolveSystemProxy(detected);
};

const createDispatcherFromResolution = (resolution: ProxyResolution): Dispatcher =>
  new EnvHttpProxyAgent({
    httpProxy: resolution.httpProxy,
    httpsProxy: resolution.httpsProxy,
    noProxy: resolution.noProxy,
    headersTimeout: 0,
    bodyTimeout: 0,
  });

let currentDispatcher: Dispatcher = DIRECT_DISPATCHER;
let refreshRequested = false;

const swapDispatcher = (next: Dispatcher | null, reason: string): void => {
  const previous = currentDispatcher;
  if (next === null) {
    currentDispatcher = DIRECT_DISPATCHER;
  } else {
    currentDispatcher = next;
  }
  if (previous !== DIRECT_DISPATCHER && previous !== currentDispatcher) {
    // 优雅关闭旧代理 dispatcher：不再接新请求，进行中请求自然完成
    const close = previous.close();
    if (typeof close?.catch === 'function') {
      close.catch((error: unknown) => {
        logDebug('proxy dispatcher: close previous failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
  logInfo('fetch dispatcher rebuilt', {
    proxied: currentDispatcher !== DIRECT_DISPATCHER,
    reason,
  });
};

const doRefresh = async (reason: string): Promise<void> => {
  const config = getBackendConfig();
  try {
    const resolution = await buildResolution(config);
    if (resolution === null) {
      swapDispatcher(null, reason);
      return;
    }
    swapDispatcher(createDispatcherFromResolution(resolution), reason);
  } catch (error) {
    // 构建/检测失败不改变当前生效 dispatcher，保守回落直连
    swapDispatcher(null, `${reason} (error fallback direct)`);
    logWarn('proxy dispatcher: rebuild failed, fallback direct', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** 异步按当前配置重建 dispatcher（启动与 config 保存后调用；串行排队，后到的重建基于最新配置）。 */
let refreshChain: Promise<void> = Promise.resolve();
const refreshFetchDispatcher = (reason: string): Promise<void> => {
  const task = refreshChain.then(
    () => doRefresh(reason),
    () => doRefresh(reason),
  );
  refreshChain = task.catch(() => undefined);
  return task;
};

/** 启动入口：main.cts 在 loadRuntimeEnv 后调用。 */
const initFetchDispatcher = (): Promise<void> => {
  refreshRequested = true;
  return refreshFetchDispatcher('startup');
};

/** 配置变更后重建：PUT /api/config 代理字段变化时调用。 */
const rebuildFetchDispatcher = (): Promise<void> => {
  refreshRequested = true;
  return refreshFetchDispatcher('config-update');
};

/** 各 fetch 调用点的同步消费口：返回当前生效 dispatcher。 */
const getFetchDispatcher = (): Dispatcher => {
  if (!refreshRequested) {
    const config = getBackendConfig();
    if (config.proxyMode !== 'direct') {
      refreshRequested = true;
      void refreshFetchDispatcher('lazy-first-use').catch(() => undefined);
    }
  }
  return currentDispatcher;
};

export {
  DIRECT_DISPATCHER as DIRECT_FETCH_DISPATCHER,
  type ProxyConfigView,
  type ProxyResolution,
  resolveManualProxy,
  resolveSystemProxy,
  createDispatcherFromResolution,
  initFetchDispatcher,
  rebuildFetchDispatcher,
  getFetchDispatcher,
};

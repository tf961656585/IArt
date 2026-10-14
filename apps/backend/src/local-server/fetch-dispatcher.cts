import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';
import type { EffectiveProxyDecision } from '@iart/contracts';
import { getBackendConfig } from './config-store.cts';
import { sendProxyDecisionNotification } from './backend-ipc-sender.cts';
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
 * - 初始状态恒为直连；`initFetchDispatcher()`（启动）、`rebuildFetchDispatcher()`
 *   （PUT /api/config 保存后 / 窗口聚焦保鲜触发）异步重建，完成前请求按直连执行。
 * - `getFetchDispatcher()` 为同步消费口（各 fetch 调用点在请求时取当前值），
 *   首次调用若配置非 direct 且未完成初始化，触发一次后台刷新（去重）。
 * - 重建时旧代理 dispatcher 优雅 close（进行中的请求自然跑完，不 destroy）。
 * - 每次重建同源产发「生效代理决策」（spec「代理治理」），决策变化才经 fork IPC
 *   推送主进程（主进程据此应用 session 代理；backend 出站与推送值恒一致）。
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

const createDispatcherFromResolution = (resolution: ProxyResolution): Dispatcher =>
  new EnvHttpProxyAgent({
    httpProxy: resolution.httpProxy,
    httpsProxy: resolution.httpsProxy,
    noProxy: resolution.noProxy,
    headersTimeout: 0,
    bodyTimeout: 0,
  });

// ---- 生效代理决策推送（spec「代理治理」验收 PROXY-001/004）----
// 决策与 dispatcher 同源于 doRefresh 的一次解析；决策未变化不重复推送；
// fire-and-forget（主进程消费失败不影响 backend 出站）。
let lastPushedDecisionJson: string | null = null;

const notifyProxyDecision = (decision: EffectiveProxyDecision): void => {
  const json = JSON.stringify(decision);
  if (json === lastPushedDecisionJson) return;
  lastPushedDecisionJson = json;
  sendProxyDecisionNotification({ type: 'proxy:decision-changed', decision });
};

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

/**
 * 由「档位 + 解析结果」推导生效代理决策（spec「代理治理」）。
 * direct 档恒为直连决策；resolution 为 null 时：system 档 = 检出无代理（kind none），
 * manual 档无合法地址（存储层归一化后不应出现）防御性回落直连。
 * 决策与 dispatcher 同源（同一份 resolution），保证 backend 出站行为与推送值一致。
 */
const buildDecisionFromResolution = (
  config: ProxyConfigView,
  resolution: ProxyResolution | null,
): EffectiveProxyDecision => {
  if (config.proxyMode === 'direct') return { mode: 'direct' };
  if (resolution === null) {
    return config.proxyMode === 'system'
      ? { mode: 'system', resolved: { kind: 'none' } }
      : { mode: 'direct' };
  }
  return config.proxyMode === 'system'
    ? { mode: 'system', resolved: { kind: 'proxy', proxyUrl: resolution.httpsProxy } }
    : { mode: 'manual', proxyUrl: config.proxyUrl };
};

const doRefresh = async (reason: string): Promise<void> => {
  const config = getBackendConfig();
  try {
    let resolution: ProxyResolution | null = null;
    if (config.proxyMode === 'manual') {
      resolution = resolveManualProxy(config);
    } else if (config.proxyMode === 'system') {
      resolution = resolveSystemProxy(await detectSystemProxy());
    }
    const decision = buildDecisionFromResolution(config, resolution);
    if (resolution === null) {
      swapDispatcher(null, reason);
    } else {
      swapDispatcher(createDispatcherFromResolution(resolution), reason);
    }
    notifyProxyDecision(decision);
  } catch (error) {
    // 构建/检测失败不改变当前生效 dispatcher，保守回落直连；
    // 决策保持上次推送值不动（主进程 session 维持现状，避免检测抖动把窗口面打成直连）。
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

/** 配置变更后重建：PUT /api/config 代理字段变化时调用；窗口聚焦保鲜触发带 'focus-refresh'。 */
const rebuildFetchDispatcher = (reason: string = 'config-update'): Promise<void> => {
  refreshRequested = true;
  return refreshFetchDispatcher(reason);
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
  buildDecisionFromResolution,
  createDispatcherFromResolution,
  initFetchDispatcher,
  rebuildFetchDispatcher,
  getFetchDispatcher,
};

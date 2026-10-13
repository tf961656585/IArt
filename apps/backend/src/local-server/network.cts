import { PRIVATE_IP_PATTERNS } from './constants.cts';
import { listConnections } from './provider-connection/connection-store.cts';
import * as loggingModule from './logging.cts';

/**
 * 收集全部已配置 connection 的 base_url host（spec 03 §4.2：校验 base_url 而非逐请求 URL）。
 *
 * 新架构：host 闸门基于 ProviderConnection.base_url（spec 03），不再基于 ProviderConfig。
 * 内置服务商不再单独处理，统一由 connection 承载。
 */
const collectConfiguredProviderHosts = (): ReadonlySet<string> => {
  const hosts = new Set<string>();
  for (const connection of listConnections()) {
    try {
      const parsed = new URL(connection.base_url);
      const host = parsed.hostname.toLowerCase();
      if (host) hosts.add(host);
    } catch {
      loggingModule.logWarn('[network] collectConfiguredProviderHosts: invalid connection base_url skipped', {
        connectionId: connection.connection_id,
        baseUrl: connection.base_url,
      });
    }
  }
  return hosts;
};

const isPrivateHost = (hostname: string) => PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));

const isHostAllowed = (host: string, allowed: ReadonlySet<string>) => {
  if (!host || !allowed) return false;
  if (allowed.has('*')) return true;
  if (allowed.has(host)) return true;
  for (const entry of allowed) {
    if (!entry || entry === '*') continue;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      if (suffix && host.endsWith(suffix)) return true;
      continue;
    }
    if (entry.startsWith('.')) {
      const suffix = entry;
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
    }
  }
  return false;
};

const isAllowedRemoteUrl = (url: URL) => {
  if (!url) return false;
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  return true;
};

const isAllowedTaskUrl = (url: URL) => {
  if (!url) return false;
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    // 本地/局域网直接放开
    return true;
  }
  return true;
};

/**
 * 用户连接渠道 host 校验（spec 03 §4.2）。
 *
 * - 必须 https:// 协议（明文 http 拒绝）。
 * - host 必须匹配已配置 connection 的 base_url host。
 *
 * 对全部任务生效：提交侧先经 execution-snapshot 阻断（no_active_deployment -> failed），
 * 轮询侧复用提交时冻结的快照 URL，host 闸门按当前已配置 connection 校验。
 */
const isAllowedTaskUrlForModel = (url: URL, modelId: unknown): boolean => {
  if (!url) return false;
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  if (protocol !== 'https:') {
    loggingModule.logWarn('[network] isAllowedTaskUrlForModel: provider connection requires https', {
      url: url.toString(),
      modelId: modelId === undefined || modelId === null ? null : String(modelId),
    });
    return false;
  }
  const host = url.hostname.toLowerCase();
  const configuredHosts = collectConfiguredProviderHosts();
  if (isHostAllowed(host, configuredHosts)) return true;
  loggingModule.logWarn('[network] isAllowedTaskUrlForModel: host not in configured connections', {
    host,
    url: url.toString(),
    modelId: modelId === undefined || modelId === null ? null : String(modelId),
  });
  return false;
};

export {
  isPrivateHost,
  isHostAllowed,
  isAllowedRemoteUrl,
  isAllowedTaskUrl,
  isAllowedTaskUrlForModel,
  collectConfiguredProviderHosts,
};

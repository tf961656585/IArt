/**
 * 生效代理决策 → Electron session 应用（spec docs/runtime/远端请求执行治理原则.md「代理治理」）。
 *
 * 主进程只消费 backend 推送的生效代理决策，不读原始代理配置（代理解析唯一 owner 是
 * Runtime Backend）。应用面两个 session：
 * - 默认 session：Hub / Editor 窗口与主进程出站请求（`net.fetch` 默认走 default session）
 *   共用，一次 setProxy 同时治理窗口页面与主进程下载（验收 PROXY-002/003）。
 * - 更新器 session：electron-updater 内部固定使用 fromPartition("electron-updater")
 *   （node_modules/electron-updater/out/electronHttpExecutor.js），以同名 partition 取到
 *   同一 session 对象后 setProxy；cache:false 与库内创建参数一致，先建时保留其意图。
 *
 * 档位映射（行为语义见 spec「语义口径」）：
 * - direct → setProxy({ mode: 'direct' })：全链路强制直连（修复直连档关不掉的存量缺陷）
 * - manual → setProxy({ mode: 'fixed_servers', proxyRules: host:port })
 * - system → setProxy({ mode: 'system' })：Chromium 原生跟随（实时，含 PAC）
 *
 * Chromium 隐式回环豁免保证 localhost / 127.0.0.1 不进代理，前后端本地通信不受影响。
 * 手动档代理地址含 user:pass 时，Chromium proxyRules 不解析凭据，由 app 'login' 事件
 * （authInfo.isProxy）提供凭据（extractProxyCredentials 供接线方消费）。
 *
 * 本模块保持 Electron-free（session 目标经依赖注入），可在 node:test / vitest 中验证。
 */

import type { EffectiveProxyDecision } from '@iart/contracts';

/** electron-updater 的专用 partition 名（库内硬编码，主进程以同名 fromPartition 取同一 session）。 */
export const UPDATER_SESSION_PARTITION = 'electron-updater';

/** Electron session.setProxy 配置的本模块字段子集。 */
export interface SessionProxyConfig {
  mode: 'direct' | 'system' | 'fixed_servers';
  proxyRules?: string;
}

/** session 目标的最小结构面（真实实现为 Electron Session，测试为假对象）。 */
export interface ProxySessionTarget {
  setProxy(config: SessionProxyConfig): Promise<void>;
}

/** 诊断元数据（开放结构的具名边界：值域收窄到原始量，替代裸 Record）。 */
export interface ProxyDecisionLogMeta {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface ProxyDecisionApplierDeps {
  /** 返回当前需要应用决策的 session 目标（null/undefined 项跳过并留痕）。 */
  getProxySessionTargets: () => Array<ProxySessionTarget | null | undefined>;
  log?: (level: 'info' | 'warn', message: string, meta?: ProxyDecisionLogMeta) => void;
}

export interface ProxyDecisionApplier {
  apply(decision: EffectiveProxyDecision): Promise<void>;
  /** 最近一次应用的决策（null = 尚未收到）；供代理鉴权等消费方读取。 */
  getLatestDecision(): EffectiveProxyDecision | null;
}

/** manual 档 proxyUrl → Chromium proxyRules（host:port；scheme 决定缺省端口，凭据不走此处）。 */
const toProxyRules = (proxyUrl: string): string => {
  const url = new URL(proxyUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname}:${port}`;
};

/**
 * 档位 → session 代理配置映射。manual 档的 proxyUrl 由 backend 归一化保证合法
 * （http/https + host），此处解析失败按编程错误抛出（contracts 边界已 parse 过）。
 */
export const buildSessionProxyConfig = (decision: EffectiveProxyDecision): SessionProxyConfig => {
  switch (decision.mode) {
    case 'direct':
      return { mode: 'direct' };
    case 'manual':
      return { mode: 'fixed_servers', proxyRules: toProxyRules(decision.proxyUrl) };
    case 'system':
      return { mode: 'system' };
  }
};

/**
 * 从手动档代理地址提取 basic 凭据（user:pass@host 形态），供 app 'login' 事件在
 * 代理质询（authInfo.isProxy）时回填；无凭据或非 manual 档返回 null。
 */
export const extractProxyCredentials = (
  decision: EffectiveProxyDecision | null,
): { username: string; password: string } | null => {
  if (decision === null || decision.mode !== 'manual') return null;
  try {
    const url = new URL(decision.proxyUrl);
    if (!url.username) return null;
    return {
      username: decodeURIComponent(url.username),
      password: url.password ? decodeURIComponent(url.password) : '',
    };
  } catch {
    return null;
  }
};

export const createProxyDecisionApplier = (
  deps: ProxyDecisionApplierDeps,
): ProxyDecisionApplier => {
  const log = deps.log ?? (() => undefined);
  let latestDecision: EffectiveProxyDecision | null = null;

  const apply = async (decision: EffectiveProxyDecision): Promise<void> => {
    latestDecision = decision;
    const config = buildSessionProxyConfig(decision);
    const targets = deps
      .getProxySessionTargets()
      .filter((target): target is ProxySessionTarget => target !== null && target !== undefined);
    if (targets.length === 0) {
      log('warn', '[proxy-decision] no session targets available, decision not applied', {
        mode: decision.mode,
      });
      return;
    }
    const results = await Promise.allSettled(targets.map((target) => target.setProxy(config)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      log('warn', '[proxy-decision] setProxy failed on some sessions', {
        mode: decision.mode,
        failed: failures.length,
        error: failures
          .map((result) => (result.status === 'rejected' && result.reason instanceof Error ? result.reason.message : String(result.reason ?? '')))
          .join('; '),
      });
      return;
    }
    log('info', '[proxy-decision] applied', { mode: decision.mode });
  };

  return {
    apply,
    getLatestDecision: () => latestDecision,
  };
};

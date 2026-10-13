import {
  ADAPTER_REGISTRY,
  type ProtocolAdapter,
  type ProtocolAdapterId,
  ProtocolAdapterIdSchema,
} from '@iart/contracts';
import * as loggingModule from '../logging.cts';

/**
 * ProtocolAdapter 内置静态注册表（随 app 版本不可变，spec 03 §3）。
 *
 * 归属与口径对齐：
 * - spec 主口径 `docs/custom-providers/03-Provider连接、协议适配与模型部署主口径.md` §3
 * - 本地承载与 `packages/contracts/src/provider-connection-contract.ts` 的
 *   ADAPTER_REGISTRY 同源，消费端以此作运行时校验与 endpoint 拼装唯一事实源
 * - 适配器不可被用户创建/编辑/覆盖（spec §3.2），仅随 app 发布升级
 */

const ADAPTER_VERSION = '1.0.0';

const getAdapter = (adapterId: unknown): ProtocolAdapter | null => {
  const parsed = ProtocolAdapterIdSchema.safeParse(adapterId);
  if (!parsed.success) {
    loggingModule.logDebug('[adapter-registry] getAdapter: invalid adapterId', {
      adapterId: String(adapterId),
    });
    return null;
  }
  const adapter = ADAPTER_REGISTRY[parsed.data];
  if (!adapter) {
    loggingModule.logDebug('[adapter-registry] getAdapter: not found', { adapterId: parsed.data });
    return null;
  }
  return adapter;
};

const resolveRelativeEndpoint = (
  adapterId: ProtocolAdapterId,
  key: string,
): string | null => {
  const adapter = ADAPTER_REGISTRY[adapterId];
  if (!adapter || !adapter.relative_endpoints) return null;
  const value = adapter.relative_endpoints[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const buildRequestUrl = (
  baseUrl: string,
  adapterId: ProtocolAdapterId,
  endpointKey: string,
): string | null => {
  const relative = resolveRelativeEndpoint(adapterId, endpointKey);
  if (!relative) {
    loggingModule.logDebug('[adapter-registry] buildRequestUrl: missing relative endpoint', {
      adapterId,
      endpointKey,
    });
    return null;
  }
  // base_url 已在 connection-store 规范化（去 query/fragment、去尾斜杠），此处仅拼接
  const trimmedBase = baseUrl.trim().replace(/\/+$/, '');
  // OpenAI-style relative 已含 /v1/...，直接拼接；Ve0 模板含 {model} 占位由调用方替换
  if (relative.startsWith('/')) return `${trimmedBase}${relative}`;
  return `${trimmedBase}/${relative}`;
};

export {
  ADAPTER_VERSION,
  getAdapter,
  resolveRelativeEndpoint,
  buildRequestUrl,
  ADAPTER_REGISTRY,
};

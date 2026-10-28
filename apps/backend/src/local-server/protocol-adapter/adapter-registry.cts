import {
  ADAPTER_REGISTRY,
  type ProtocolAdapter,
  ProtocolAdapterIdSchema,
} from '@iart/contracts';
import * as loggingModule from '../logging.cts';

/**
 * ProtocolAdapter 内置静态注册表访问口（随 app 版本不可变，spec 03 §3）。
 *
 * 2026-10-27 起只剩**对话族**：生成族的传输定义由接口格式实体声明，执行链不再有代码适配器。
 * 生成侧历史数据（连接遗留字段、已落库任务快照）仍可能带预设格式 id，读取侧由
 * `provider-connection/snapshot-protocol.cts` 统一解析，不经过本模块。
 *
 * 归属与口径对齐：
 * - spec 主口径 `docs/custom-providers/03-Provider连接、协议适配与模型部署主口径.md` §3
 * - 本地承载与 `packages/contracts/src/provider-connection-contract.ts` 的
 *   ADAPTER_REGISTRY 同源，消费端以此作运行时校验唯一事实源
 * - 适配器不可被用户创建/编辑/覆盖（spec §3.2），仅随 app 发布升级
 */

const LIVE_ADAPTER_IDS = new Set<string>(Object.keys(ADAPTER_REGISTRY));

const getAdapter = (adapterId: unknown): ProtocolAdapter | null => {
  const parsed = ProtocolAdapterIdSchema.safeParse(adapterId);
  if (!parsed.success) {
    loggingModule.logDebug('[adapter-registry] getAdapter: invalid adapterId', {
      adapterId: String(adapterId),
    });
    return null;
  }
  // 生成预设 id 仍能通过 schema（历史数据解析需要），但注册表已无生成条目。
  if (!LIVE_ADAPTER_IDS.has(parsed.data)) {
    loggingModule.logDebug('[adapter-registry] getAdapter: not a live adapter', {
      adapterId: parsed.data,
    });
    return null;
  }
  const adapter: ProtocolAdapter | undefined = ADAPTER_REGISTRY[parsed.data as keyof typeof ADAPTER_REGISTRY];
  return adapter ?? null;
};

export { getAdapter, ADAPTER_REGISTRY };

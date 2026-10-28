import type {
  AdapterAuth,
  ExecutionProtocol,
  ExecutionSnapshot,
} from '@iart/contracts';
import { getInterfaceFormat } from '../interface-format/registry.cts';
import type { InterfaceFormat } from '../interface-format/schema.cts';
import { getAdapter } from '../protocol-adapter/adapter-registry.cts';
import * as loggingModule from '../logging.cts';

/**
 * 执行快照的协议身份解析（**唯一实现点**）。
 *
 * 2026-10-27 起生成侧传输定义只由接口格式实体声明，执行链不再读代码适配器。快照冻结
 * `protocol`（格式 id / 适配器 id + 版本 + 鉴权形状），执行时只按冻结值注入凭证——
 * 用户随后编辑或删除格式，不改变在跑任务的传输语义。
 *
 * 历史快照（本批之前落库）只有 `adapter_id`：生成预设 id 与接口格式 id 同名，因此回退
 * 路径先查格式实体、再查现役（对话）适配器。回退只为读取旧记录存在，不得用于新写入。
 */

/** 接口格式声明的鉴权 → 契约鉴权（**唯一换算点**）。 */
export const toProtocolAuth = (format: InterfaceFormat): AdapterAuth => {
  const declared = format.transport.auth;
  switch (declared.kind) {
    case 'bearer':
      return declared.prefix === undefined
        ? { kind: 'bearer', header_name: declared.header_name }
        : { kind: 'bearer', header_name: declared.header_name, prefix: declared.prefix };
    case 'header_api_key':
      // header_api_key 没有 scheme 前缀。
      return { kind: 'header_api_key', header_name: declared.header_name };
    case 'query_api_key':
      // 查询参数鉴权（2026-10-27 起）：执行链按 `buildAdapterAuthInjection` 拼到查询串上。
      return { kind: 'query_api_key', query_name: declared.query_name };
  }
};

/**
 * 取快照的协议身份：新快照直接用冻结值，旧快照按 `adapter_id` 回退解析。
 *
 * 返回 null 表示既没有冻结协议、也无法把历史 id 解析成接口格式或现役适配器——
 * 调用方必须显式失败（携带凭证的请求不能在没有鉴权形状时静默发出）。
 */
export const resolveSnapshotProtocol = (
  snapshot: ExecutionSnapshot,
): ExecutionProtocol | null => {
  if (snapshot.protocol !== undefined) return snapshot.protocol;
  const legacyId = snapshot.adapter_id;
  if (legacyId === undefined) {
    loggingModule.logDebug('[snapshot-protocol] snapshot carries neither protocol nor adapter_id', {
      snapshotId: snapshot.snapshot_id,
      modelId: snapshot.model_id,
    });
    return null;
  }
  const formatLookup = getInterfaceFormat(legacyId);
  if (formatLookup.kind === 'ready') {
    return {
      kind: 'generation_format',
      format_id: formatLookup.format.format_id,
      format_version: formatLookup.format.version,
      auth: toProtocolAuth(formatLookup.format),
    };
  }
  const adapter = getAdapter(legacyId);
  if (adapter !== null) {
    return {
      kind: 'chat_adapter',
      adapter_id: adapter.adapter_id,
      adapter_version: adapter.version,
      auth: adapter.auth,
    };
  }
  loggingModule.logDebug('[snapshot-protocol] legacy protocol id unresolved', {
    snapshotId: snapshot.snapshot_id,
    modelId: snapshot.model_id,
    adapterId: legacyId,
    formatLookup: formatLookup.kind,
  });
  return null;
};

/** 取快照冻结的鉴权形状；null 表示无法识别协议（调用方按各自入口的失败处置）。 */
export const resolveSnapshotAuth = (snapshot: ExecutionSnapshot): AdapterAuth | null =>
  resolveSnapshotProtocol(snapshot)?.auth ?? null;

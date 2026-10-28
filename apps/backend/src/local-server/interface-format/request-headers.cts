import { parseInterfaceFormatRuleTarget } from '@iart/contracts';
import * as loggingModule from '../logging.cts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';

/**
 * 从**已求值**的请求规则树派生「结果获取请求的固定请求头」。
 *
 * 背景（2026-10-27 请求落点批次）：固定请求头在格式里是 `api.headers.<name>` 的**字面量规则**
 * （提交、轮询、取结果共用）。取结果请求（`result_acquisition_strategy`）在运行时按执行计划
 * 独立发起，因此它需要的固定头必须随策略冻结——运行时不去回读格式实体的规则树。
 *
 * 只收 `kind = 'literal'` 且值为字符串的规则：
 * - 字段绑定（参数、提示词）不是固定头，跳过；
 * - 条件节点（`kind = 'when'`）与未求值的宏节点（`$if`）不是「所有请求都带」的固定头，跳过；
 * - 非字符串字面量（`null` = 不发这个头）不带任何请求头值，跳过。
 *
 * 跳过一律写 debug 留痕：条件跳过不能静默（否则「某个定头为什么没随取结果请求发出」无从排查）。
 *
 * 鉴权头不在这里：它由 `requires_auth` + 执行快照的鉴权形状在请求时注入；实体 schema 也禁止
 * 固定头与鉴权头重名。
 */
export const deriveFixedRequestHeaders = (
  payloadRules: unknown,
  context: { formatId?: string; modelId?: string } = {},
): Record<string, string> => {
  const headers: Record<string, string> = {};
  /** 请求头名大小写不敏感：同一份规则树里出现大小写不同的同名头时后写覆盖并留痕。 */
  const seenByLowerCase = new Map<string, string>();
  if (!isObjectRecord(payloadRules)) return headers;
  for (const [target, rawRule] of Object.entries(payloadRules)) {
    const parsed = parseInterfaceFormatRuleTarget(target);
    if (parsed.kind !== 'header') continue;
    if (!isObjectRecord(rawRule) || rawRule.kind !== 'literal' || typeof rawRule.value !== 'string') {
      loggingModule.logDebug('[interface-format] non-literal header rule kept out of fixed request headers', {
        formatId: context.formatId ?? null,
        modelId: context.modelId ?? null,
        target,
        ruleKind: isObjectRecord(rawRule) && typeof rawRule.kind === 'string' ? rawRule.kind : null,
      });
      continue;
    }
    const lower = parsed.name.toLowerCase();
    const previousName = seenByLowerCase.get(lower);
    if (previousName !== undefined && previousName !== parsed.name) {
      loggingModule.logDebug('[interface-format] duplicated header name in fixed request headers, last wins', {
        formatId: context.formatId ?? null,
        modelId: context.modelId ?? null,
        previousName,
        name: parsed.name,
      });
      delete headers[previousName];
    }
    seenByLowerCase.set(lower, parsed.name);
    headers[parsed.name] = rawRule.value;
  }
  return headers;
};

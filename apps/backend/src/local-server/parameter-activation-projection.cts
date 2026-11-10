import {
  applyParameterActivation,
  isPlainObject,
  ParameterActivationSchema,
  type ParameterActivation,
  type ParameterValueMap,
} from '@iart/contracts';
import * as loggingModule from './logging.cts';

const readField = (source: unknown, key: string): unknown => {
  if (source === null || source === undefined) return undefined;
  return Reflect.get(Object(source), key);
};

/**
 * 参数启动条件（activation）的发送层执行点：按投影里的 `parameter_schema.fields`
 * 读条件声明，把不成立的字段值从参数集里剔除。
 *
 * 为什么在发送层做一次、而不是只在编辑器隐藏：
 * CLI / agent / 历史草稿都可能把「当前不适用」的值带进来；只在界面隐藏挡不住它们。
 * 这里剔除后，任何 payload 规则都读不到该值，等于不发。
 *
 * 条件声明非法（形状不符）时按「没有条件」处理并告警：宁可多发一个字段，
 * 也不要把一个拼错的条件当成恒不成立、静默吞掉用户参数。
 */
export const applyActivationFromProjection = (
  argumentsValue: unknown,
  projection: unknown,
): unknown => {
  if (!isPlainObject(argumentsValue)) return argumentsValue;
  const schemaRaw = readField(projection, 'parameter_schema');
  if (!isPlainObject(schemaRaw)) return argumentsValue;
  const fieldsRaw = readField(schemaRaw, 'fields');
  if (!Array.isArray(fieldsRaw)) return argumentsValue;

  const activations: Record<string, ParameterActivation> = {};
  for (const fieldRaw of fieldsRaw) {
    if (!isPlainObject(fieldRaw)) continue;
    const fieldKey = readField(fieldRaw, 'field_key');
    if (typeof fieldKey !== 'string' || fieldKey.length === 0) continue;
    const conditionRaw = readField(fieldRaw, 'visible_when');
    if (conditionRaw === undefined || conditionRaw === null) continue;
    const parsed = ParameterActivationSchema.safeParse(conditionRaw);
    if (!parsed.success) {
      loggingModule.logWarn('[parameter-activation] ignored invalid activation declaration', {
        fieldKey,
        issues: parsed.error.issues.map((issue) => issue.message),
      });
      continue;
    }
    activations[fieldKey] = parsed.data;
  }
  if (Object.keys(activations).length === 0) return argumentsValue;

  const result = applyParameterActivation(argumentsValue as ParameterValueMap, activations);
  if (result.dropped.length > 0) {
    loggingModule.logDebug('[parameter-activation] dropped values whose activation is not satisfied', {
      dropped: result.dropped.map(
        (item) =>
          `${item.fieldKey} <- ${item.activation.field} ${item.activation.op} ${JSON.stringify(item.activation.value)}`,
      ),
    });
  }
  return result.values;
};

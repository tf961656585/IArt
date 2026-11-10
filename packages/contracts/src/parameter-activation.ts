import { z } from 'zod';

/**
 * 参数启动条件（activation）：一个参数是否「在当前这次请求里成立」。
 *
 * 语义边界（必须与消费端一致，改动前先读这里）：
 * - 条件由**接口格式**声明，模型记录只能开关字段、改取值与默认值，不能改条件；
 * - 条件不满足 = 不呈现、不校验、**不发送**（不是置灰、不是清空表单值）；
 * - 条件只描述「值依赖」：依赖另一个参数的取值。模型型号差异不走这里，走模型记录的字段开关。
 *
 * 支持四种比较：`eq` / `neq`（标量）、`in` / `not_in`（标量数组）。
 * 依赖字段缺失（未进入参数集）按「undefined」参与比较：`eq`/`in` 不成立，`neq`/`not_in` 成立。
 */
export const ParameterActivationScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const ParameterActivationSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum(['eq', 'neq', 'in', 'not_in']),
    /** `in` / `not_in` 用标量数组；`eq` / `neq` 用标量。形状不符时求值按不成立处理并留痕。 */
    value: z.union([ParameterActivationScalarSchema, z.array(ParameterActivationScalarSchema).min(1)]),
  })
  .strict();

export type ParameterActivation = z.infer<typeof ParameterActivationSchema>;
export type ParameterActivationScalar = z.infer<typeof ParameterActivationScalarSchema>;

/**
 * 条件求值用的参数集：键是字段键、值来自用户输入，键集由接口格式在运行时决定，属开放结构。
 * 按守卫口径用 `*Map` 命名表达边界，不写裸 `Record<string, unknown>`。
 */
export type ParameterValueMap = Readonly<Record<string, unknown>>;
/** 同上，可写形态（只在求值过程内做浅拷贝与删除）。 */
export type ParameterValueDraftMap = Record<string, unknown>;

const isScalarArray = (
  value: ParameterActivation['value'],
): value is ParameterActivationScalar[] => Array.isArray(value);

/**
 * 求值：依赖字段的当前值是否让该参数成立。
 *
 * 纯函数、无副作用；调用方负责决定「不成立」的处置（呈现层隐藏、发送层剔除）。
 */
export const evaluateParameterActivation = (
  activation: ParameterActivation,
  values: ParameterValueMap,
): boolean => {
  const actual = values[activation.field];
  switch (activation.op) {
    case 'eq':
      return !isScalarArray(activation.value) && actual === activation.value;
    case 'neq':
      return isScalarArray(activation.value) || actual !== activation.value;
    case 'in':
      return isScalarArray(activation.value) && activation.value.includes(actual as ParameterActivationScalar);
    case 'not_in':
      return !(isScalarArray(activation.value) && activation.value.includes(actual as ParameterActivationScalar));
    default:
      return false;
  }
};

/**
 * 从参数集里剔除「条件不成立」的字段，返回新对象（不修改入参）。
 *
 * 求值到不动点：被剔除字段若又被其他条件的依赖字段引用，后续条件同样按不成立处理。
 * `dropped` 供调用方留痕（条件跳过必须有日志，不允许静默丢弃）。
 */
export const applyParameterActivation = (
  values: ParameterValueMap,
  activations: Readonly<Record<string, ParameterActivation>>,
): { values: ParameterValueMap; dropped: Array<{ fieldKey: string; activation: ParameterActivation }> } => {
  const next: ParameterValueDraftMap = { ...values };
  const dropped: Array<{ fieldKey: string; activation: ParameterActivation }> = [];
  // 字段数有限；不动点最多迭代字段数轮，超出即停止，避免异常数据造成死循环。
  const maxRounds = Object.keys(activations).length + 1;
  for (let round = 0; round < maxRounds; round += 1) {
    let changed = false;
    for (const [fieldKey, activation] of Object.entries(activations)) {
      if (!(fieldKey in next)) continue;
      if (evaluateParameterActivation(activation, next)) continue;
      delete next[fieldKey];
      dropped.push({ fieldKey, activation });
      changed = true;
    }
    if (!changed) break;
  }
  return { values: next, dropped };
};

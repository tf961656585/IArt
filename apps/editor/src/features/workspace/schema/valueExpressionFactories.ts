import type { ModelAssetMediaTargetShape } from "@iart/contracts/model-asset-contract";
import type {
  SchemaComputedValue,
  SchemaCondition,
  SchemaConditionalValue,
  SchemaFieldValue,
  SchemaLiteralValue,
  SchemaValueComputeHandler,
  SchemaValueExpression,
  SchemaValueTransform,
} from "./types";

export const literal = <T,>(value: T): SchemaLiteralValue => ({
  kind: "literal",
  value,
});

export const fromField = <FieldKey extends string>(
  field: FieldKey,
  transforms: SchemaValueTransform<FieldKey>[] | undefined,
  mediaTarget: ModelAssetMediaTargetShape | undefined,
): SchemaFieldValue<FieldKey> => ({
  kind: "field",
  field,
  mediaTarget,
  transforms,
  fallback: undefined,
});

export const when = <FieldKey extends string>(
  condition: SchemaCondition<FieldKey>,
  truthy: SchemaValueExpression<FieldKey>,
  falsy: SchemaValueExpression<FieldKey> | undefined
): SchemaConditionalValue<FieldKey> => ({
  kind: "when",
  condition,
  truthy,
  falsy,
});

export const compute = <FieldKey extends string>(
  run: SchemaValueComputeHandler<FieldKey>,
  dependsOn: FieldKey[] | undefined,
  cacheKey: string | undefined,
  mediaTarget: ModelAssetMediaTargetShape | undefined,
): SchemaComputedValue<FieldKey> => ({
  kind: "compute",
  run,
  dependsOn,
  cacheKey,
  mediaTarget,
});

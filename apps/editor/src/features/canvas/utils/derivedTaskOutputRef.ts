import type { GraphNode } from "../types";
import { isUnknownRecord, type UnknownRecord } from "@/client/utils/typeGuards";

export type DerivedTaskOutputRef = {
  parentNodeId: string;
  outputIndex: number;
};

type RawDerivedTaskOutputRef = {
  parentNodeId: unknown | undefined;
  outputIndex: unknown | undefined;
};

type GraphNodeDataWithDerivedTaskOutput = UnknownRecord & {
  __taskOutput: unknown | undefined;
};

const toGraphNodeDataWithDerivedTaskOutput = (
  value: UnknownRecord,
): GraphNodeDataWithDerivedTaskOutput => {
  const candidate = value as UnknownRecord & {
    __taskOutput: unknown | undefined;
  };
  return {
    ...value,
    __taskOutput: candidate.__taskOutput,
  };
};

const pickMatchKey = (value: unknown | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const readDerivedTaskOutputRef = (
  node: GraphNode,
): DerivedTaskOutputRef | null => {
  const data = isUnknownRecord(node.data)
    ? toGraphNodeDataWithDerivedTaskOutput(node.data)
    : null;
  const raw = data !== null ? data.__taskOutput : null;
  if (!isUnknownRecord(raw)) return null;
  const typed = raw as RawDerivedTaskOutputRef;
  const parentNodeId = pickMatchKey(typed.parentNodeId);
  const rawOutputIndex = typed.outputIndex;
  const outputIndex = Number.isFinite(rawOutputIndex)
    ? Number(rawOutputIndex)
    : null;
  if (!parentNodeId || outputIndex == null || outputIndex < 0) return null;
  return { parentNodeId, outputIndex };
};

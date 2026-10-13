import type { NodeTaskInfo } from "../../types/node";
import type { GraphNode } from "../../types";
import { normalizeLocalFileUrl } from "../../utils/mediaUrl";
import { pickMatchKey } from "../../utils/runtimeRef";
import type {
  TaskIndexNodeDataProjection,
} from "./types";

// ── Primitives ──

const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readTaskIndexNodeDataProjection = (
  data: unknown,
): TaskIndexNodeDataProjection => {
  if (!isPlainObject(data)) {
    return {
      label: undefined,
      runtimeRef: undefined,
      taskInfo: undefined,
      valueSource: undefined,
      imageUrl: undefined,
      imageMeta: undefined,
      videoUrl: undefined,
      videoMeta: undefined,
      audioUrl: undefined,
      __taskOutput: undefined,
    };
  }
  return data as TaskIndexNodeDataProjection;
};

const isSameTaskInfoIgnoringUpdatedAt = (
  prev: NodeTaskInfo | null | undefined,
  next: NodeTaskInfo,
): boolean => {
  if (!prev) return false;
  return (
    prev.taskId === next.taskId &&
    (prev.remoteRequestId ?? "") === (next.remoteRequestId ?? "") &&
    (prev.taskIndex ?? 0) === (next.taskIndex ?? 0) &&
    prev.modelId === next.modelId &&
    prev.modelId === next.modelId &&
    prev.status === next.status &&
    JSON.stringify(prev.progress ?? null) === JSON.stringify(next.progress ?? null) &&
    prev.createdAt === next.createdAt &&
    (prev.error ?? "") === (next.error ?? "")
  );
};

const isPlaceholderNode = (node: GraphNode): boolean =>
  node.type === "imageInput" || node.type === "videoInput" || node.type === "audioInput" || node.type === "textInput";

const isAsyncLifecycleNode = (node: GraphNode): boolean =>
  isPlaceholderNode(node) || node.type === "model";

const isLocalMediaValue = (value: unknown | undefined): boolean => {
  const raw = pickMatchKey(value);
  if (!raw) return false;
  return Boolean(normalizeLocalFileUrl(raw));
};

type MediaIdentity = { kind: "files"; key: string } | { kind: "http"; key: string } | { kind: "raw"; key: string };

const normalizeMediaIdentity = (value: unknown | undefined): MediaIdentity | null => {
  const raw = pickMatchKey(value);
  if (!raw) return null;
  const local = normalizeLocalFileUrl(raw);
  if (local) return { kind: "files", key: local };
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return { kind: "http", key: `${parsed.origin}${parsed.pathname}` };
    } catch { /* ignore */ }
  }
  return { kind: "raw", key: raw };
};

const isSameMediaIdentity = (a: unknown | undefined, b: unknown | undefined): boolean => {
  const left = normalizeMediaIdentity(a);
  const right = normalizeMediaIdentity(b);
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind && left.key === right.key;
};

export {
  isAsyncLifecycleNode,
  isLocalMediaValue,
  isPlainObject,
  isSameMediaIdentity,
  isSameTaskInfoIgnoringUpdatedAt,
  readTaskIndexNodeDataProjection,
};

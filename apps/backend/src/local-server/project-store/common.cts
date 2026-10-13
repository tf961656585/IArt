import type { ProjectRecord } from "@iart/contracts";

import { normalizeProjectMediaAssets } from "../project-document.cts";

export const PROJECT_SESSION_TTL_MS = 2 * 60 * 1000;

export type UnknownRecord = object;
export type FieldRecord<TKey extends string> = UnknownRecord & {
  [K in TKey]?: unknown;
};
export type ProjectRecordWithAuthority = ProjectRecord<unknown> & {
  nodeStateAuthority: unknown | undefined;
};
export type ProjectRecordLike = UnknownRecord & {
  name: unknown | undefined;
  path: unknown | undefined;
  nodeGraphId: unknown | undefined;
  nodeGraph: unknown | undefined;
  mediaAssets: unknown | undefined;
  savedAt: unknown | undefined;
  hasUnsavedChanges: unknown | undefined;
  createdAt: unknown | undefined;
  nodeStateAuthority: unknown | undefined;
};
export type ProjectDocumentProjectionLike = UnknownRecord & {
  projectDocument: unknown | undefined;
  canResumePendingChanges: unknown | undefined;
  pendingChangeCount: unknown | undefined;
};
export type CompatFailureDiagnosticsMap = UnknownRecord & { code: unknown | undefined };
export type NodeWithRuntimeLayout = UnknownRecord & {
  data: unknown | undefined;
  size: unknown | undefined;
  measuredSize: unknown | undefined;
};
export type RecentProjectItem = UnknownRecord & {
  name: unknown | undefined;
  path: unknown | undefined;
  lastOpenedAt: unknown | undefined;
  createdAt: unknown | undefined;
};
export type RecentProjectsIndex = UnknownRecord & {
  recentProjects: unknown | undefined;
  updatedAt: unknown | undefined;
};
export type RecentProjectsPayload = UnknownRecord & { index: unknown | undefined };
export type ProjectSessionState = "prepared" | "attached" | "opened" | "closed";
export type ProjectSessionEntry = {
  state: ProjectSessionState;
  lastSeen: number;
  preparedAt: number | null;
  attachedAt: number | null;
  openedAt: number | null;
  closedAt: number | null;
  sessionToken: string;
  preparedProject: ProjectRecord<unknown> | null;
  preparedNodeStateAuthority: unknown;
};
export const projectSessionState = new Map<string, ProjectSessionEntry>();
export const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;
export const normalizeString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
export const LEGACY_COMPAT_FAILED_CODE = "project_legacy_compat_failed";
export const toProjectRecordLike = (
  value: unknown,
): ProjectRecordLike | null =>
  isRecord(value) ? (value as ProjectRecordLike) : null;
export const normalizeProjectRecord = (
  value: unknown,
): ProjectRecordWithAuthority | null => {
  const record = toProjectRecordLike(value);
  if (!record) return null;
  const name = normalizeString(record.name);
  const pathValue = normalizeString(record.path);
  const nodeGraphId = normalizeString(record.nodeGraphId);
  if (!name || !pathValue || !nodeGraphId) return null;
  return {
    name,
    nodeGraph: record.nodeGraph,
    mediaAssets: normalizeProjectMediaAssetsOrEmpty(record.mediaAssets),
    savedAt: typeof record.savedAt === "number" ? record.savedAt : 0,
    hasUnsavedChanges: Boolean(record.hasUnsavedChanges),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    path: pathValue,
    nodeGraphId,
    nodeStateAuthority: record.nodeStateAuthority,
  };
};
export const getProjectNodeStateAuthority = (
  project: ProjectRecord<unknown> | null,
): unknown => {
  const like = toProjectRecordLike(project);
  return like !== null && like !== undefined ? like.nodeStateAuthority : null;
};

export type PendingStateLike = {
  hasPendingWrite: unknown | undefined;
  canResumePendingChanges: unknown | undefined;
  pendingChangeCount: unknown | undefined;
  mergedDelta: UnknownRecord | undefined;
};
export type NodeGraphLike = UnknownRecord & {
  id: unknown | undefined;
  name: unknown | undefined;
  nodes: unknown[] | undefined;
};
export type ProjectDocumentLike = UnknownRecord & {
  nodeGraph: unknown | undefined;
  mediaAssets: unknown | undefined;
};
export type LoadedProject = {
  nodeGraph: unknown;
  mediaAssets: unknown;
  nodeStateAuthority: unknown;
  projectPath: string;
};
export const toPendingStateLike = (value: unknown): PendingStateLike =>
  isRecord(value) ? value as PendingStateLike : {} as PendingStateLike;
export const toNodeGraphLike = (value: unknown): NodeGraphLike | null =>
  isRecord(value) ? value as NodeGraphLike : null;
export const toProjectDocumentLike = (
  value: unknown,
): ProjectDocumentLike | null => (isRecord(value) ? value as ProjectDocumentLike : null);
export const normalizeProjectMediaAssetsOrEmpty = (
  value: unknown,
): ProjectRecord<unknown>["mediaAssets"] => {
  try {
    return normalizeProjectMediaAssets(value ?? {});
  } catch {
    return {};
  }
};
export const getNumericValueOrZero = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
export const getStringField = <TKey extends string>(
  record: FieldRecord<TKey> | null,
  key: TKey,
) => normalizeString((record !== null && record !== undefined ? record[key] : undefined));

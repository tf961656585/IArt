import * as crypto from "node:crypto";

import type { ProjectRecord } from "@iart/contracts";

import { isValidProjectFolder } from "../storage.cts";
import {
  type ProjectSessionEntry,
  getProjectNodeStateAuthority,
  normalizeProjectRecord,
  normalizeString,
  PROJECT_SESSION_TTL_MS,
} from "./common.cts";

export const projectSessionState = new Map<string, ProjectSessionEntry>();
export const sweepProjectSessions = () => {
  const now = Date.now();
  for (const [projectPath, entry] of projectSessionState.entries()) {
    if (!entry.lastSeen || now - entry.lastSeen > PROJECT_SESSION_TTL_MS) {
      projectSessionState.delete(projectPath);
    }
  }
};
export const buildEditorOpenTarget = (
  projectPath: unknown,
  sessionToken: unknown,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  const normalizedSessionToken = normalizeString(sessionToken);
  if (!normalizedProjectPath || !normalizedSessionToken) {
    return null;
  }
  return {
    projectPath: normalizedProjectPath,
    sessionToken: normalizedSessionToken,
  };
};
export const prepareProjectSession = (
  projectPath: unknown,
  options: {
    preparedProject: ProjectRecord<unknown> | null | undefined;
  } = { preparedProject: null },
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return null;
  sweepProjectSessions();
  const existing = projectSessionState.get(normalizedProjectPath) || null;
  if (existing !== null && existing !== undefined && (existing.state === "attached" || existing.state === "opened")) {
    return null;
  }
  const normalizedPreparedProject = normalizeProjectRecord(
    options.preparedProject ?? (existing !== null ? existing.preparedProject : undefined) ?? null,
  );
  if (
    existing !== null && existing !== undefined &&
    existing.state === "prepared" &&
    normalizeString(existing.sessionToken)
  ) {
    if (normalizedPreparedProject) {
      projectSessionState.set(normalizedProjectPath, {
        ...existing,
        preparedProject: normalizedPreparedProject,
        preparedNodeStateAuthority: getProjectNodeStateAuthority(
          normalizedPreparedProject,
        ),
        lastSeen: Date.now(),
      } as ProjectSessionEntry);
    }
    return buildEditorOpenTarget(
      normalizedProjectPath,
      existing.sessionToken,
    );
  }
  const sessionToken = crypto.randomUUID();
  const now = Date.now();
  projectSessionState.set(normalizedProjectPath, {
    state: "prepared",
    lastSeen: now,
    preparedAt: now,
    attachedAt: null,
    openedAt: null,
    closedAt: null,
    sessionToken,
    preparedProject: normalizedPreparedProject,
    preparedNodeStateAuthority: getProjectNodeStateAuthority(
      normalizedPreparedProject,
    ),
  });
  return buildEditorOpenTarget(
    normalizedProjectPath,
    sessionToken,
  );
};
export const getProjectSession = (projectPath: unknown) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return null;
  sweepProjectSessions();
  return projectSessionState.get(normalizedProjectPath) || null;
};
export const attachProjectSession = (
  projectPath: unknown,
  sessionToken: unknown = null,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) {
    return { ok: false, reason: "invalid_project" };
  }
  sweepProjectSessions();
  const normalizedSessionToken = normalizeString(sessionToken) || null;
  const existing = projectSessionState.get(normalizedProjectPath) || null;
  if (!existing) {
    return { ok: false, reason: "missing_session" };
  }
  if (existing.state === "closed") {
    return { ok: false, reason: "closed_session" };
  }
  if (
    !normalizedSessionToken ||
    !existing.sessionToken ||
    existing.sessionToken !== normalizedSessionToken
  ) {
    return { ok: false, reason: "token_mismatch" };
  }
  if (existing.state === "attached" || existing.state === "opened") {
    const nextEntry = { ...existing, lastSeen: Date.now() };
    projectSessionState.set(normalizedProjectPath, nextEntry);
    return {
      ok: true,
      sessionToken: nextEntry.sessionToken,
      preparedProject: nextEntry.preparedProject ?? null,
      preparedNodeStateAuthority: nextEntry.preparedNodeStateAuthority ?? null,
      idempotent: true,
    };
  }
  const nextEntry = {
    ...existing,
    state: "attached" as const,
    attachedAt: Date.now(),
    lastSeen: Date.now(),
  };
  projectSessionState.set(normalizedProjectPath, nextEntry);
  return {
    ok: true,
    sessionToken: nextEntry.sessionToken,
    preparedProject: nextEntry.preparedProject ?? null,
    preparedNodeStateAuthority: nextEntry.preparedNodeStateAuthority ?? null,
  };
};
export const openProjectSessionPresence = (
  projectPath: unknown,
  sessionToken: unknown = null,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) {
    return { ok: false, reason: "invalid_project" } as const;
  }
  sweepProjectSessions();
  const normalizedSessionToken = normalizeString(sessionToken) || null;
  const existing = projectSessionState.get(normalizedProjectPath) || null;
  if (!existing) {
    return { ok: false, reason: "missing_session" } as const;
  }
  if (existing.state === "closed") {
    return { ok: false, reason: "closed_session" } as const;
  }
  if (
    !normalizedSessionToken ||
    !existing.sessionToken ||
    existing.sessionToken !== normalizedSessionToken
  ) {
    return { ok: false, reason: "token_mismatch" } as const;
  }
  if (existing.state !== "attached" && existing.state !== "opened") {
    return { ok: false, reason: "session_not_attached" } as const;
  }
  const transitioned = existing.state !== "opened";
  const nextEntry = {
    ...existing,
    state: "opened" as const,
    openedAt: existing.openedAt || Date.now(),
    lastSeen: Date.now(),
  };
  projectSessionState.set(normalizedProjectPath, nextEntry);
  return {
    ok: true,
    sessionToken: nextEntry.sessionToken,
    transitioned,
  } as const;
};
export const resolveProjectSessionAttach = (
  projectPath: unknown,
  sessionToken: unknown = null,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) {
    return { ok: false, reason: "invalid_project_path" } as const;
  }
  if (!isValidProjectFolder(normalizedProjectPath)) {
    return { ok: false, reason: "invalid_project_path" } as const;
  }
  const attached = attachProjectSession(normalizedProjectPath, sessionToken);
  if (!(attached !== null && attached !== undefined ? attached.ok : undefined)) {
    return {
      ok: false,
      reason: (attached !== null && attached !== undefined ? attached.reason : undefined) || "missing_session",
    } as const;
  }
  const project = attached.preparedProject ?? null;
  if (!project) {
    closeProjectSession(normalizedProjectPath, attached.sessionToken);
    return { ok: false, reason: "missing_preflight_project" } as const;
  }
  return {
    ok: true,
    result: {
      sessionToken: attached.sessionToken,
      project,
      nodeStateAuthority:
        attached.preparedNodeStateAuthority ??
        getProjectNodeStateAuthority(project),
    },
  } as const;
};
export const touchOpenProject = (
  projectPath: unknown,
  sessionToken: unknown = null,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return false;
  sweepProjectSessions();
  const normalizedSessionToken = normalizeString(sessionToken) || null;
  const existing = projectSessionState.get(normalizedProjectPath) || null;
  if (!existing || existing.state !== "opened") {
    return false;
  }
  if (
    !normalizedSessionToken ||
    !existing.sessionToken ||
    existing.sessionToken !== normalizedSessionToken
  ) {
    return false;
  }
  projectSessionState.set(normalizedProjectPath, {
    ...existing,
    lastSeen: Date.now(),
  });
  return true;
};
export const closeProjectSession = (
  projectPath: unknown,
  sessionToken: unknown = null,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return false;
  sweepProjectSessions();
  const normalizedSessionToken = normalizeString(sessionToken) || null;
  const existing = projectSessionState.get(normalizedProjectPath) || null;
  if (
    !existing ||
    (existing.state !== "attached" && existing.state !== "opened")
  ) {
    return false;
  }
  if (
    !normalizedSessionToken ||
    !existing.sessionToken ||
    existing.sessionToken !== normalizedSessionToken
  ) {
    return false;
  }
  projectSessionState.set(normalizedProjectPath, {
    ...existing,
    state: "closed",
    closedAt: Date.now(),
    lastSeen: Date.now(),
  });
  return true;
};
export const registerOpenProject = (
  projectPath: unknown,
  sessionToken: unknown = null,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return false;
  const existing = getProjectSession(normalizedProjectPath);
  const normalizedSessionToken = normalizeString(sessionToken) || null;
  if (!existing) {
    const prepared = prepareProjectSession(normalizedProjectPath);
    if (!prepared) return false;
    return attachProjectSession(normalizedProjectPath, prepared.sessionToken)
      .ok;
  }
  if (existing.state === "prepared") {
    return attachProjectSession(
      normalizedProjectPath,
      normalizedSessionToken || existing.sessionToken,
    ).ok;
  }
  return false;
};
export const releaseOpenProject = (
  projectPath: unknown,
  sessionToken: unknown = null,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return false;
  const normalizedSessionToken = normalizeString(sessionToken) || null;
  if (normalizedSessionToken) {
    return closeProjectSession(normalizedProjectPath, normalizedSessionToken);
  }
  const existing = getProjectSession(normalizedProjectPath);
  if (!existing) return false;
  projectSessionState.delete(normalizedProjectPath);
  return true;
};
export const getOpenedProjectPaths = () => {
  sweepProjectSessions();
  return Array.from(projectSessionState.entries())
    .filter(([, entry]) => entry.state === "opened")
    .map(([projectPath]) => projectPath);
};

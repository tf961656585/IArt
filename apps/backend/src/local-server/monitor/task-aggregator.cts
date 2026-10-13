import { normalizeString } from './remote-response-parser/extractors.cts';

type JobMetadataInput = {
  taskId: unknown | undefined;
  remoteRequestId: unknown | undefined;
  followupOfJobId: unknown | undefined;
};

type JobRemoteInput = {
  remoteRequestId: unknown | undefined;
};

type AggregatorInputJob = {
  id: unknown | undefined;
  type: unknown | undefined;
  status: unknown | undefined;
  projectPath: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
  metadata: unknown | undefined;
  remote: unknown | undefined;
};

type NormalizedAggregatorJob = AggregatorInputJob & {
  id: string;
  type: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  projectPath: string;
};

type AggregationGroup = {
  id: string;
  taskId: string;
  remoteRequestId: string;
  projectPath: string;
  createdAt: number;
  updatedAt: number;
  jobs: NormalizedAggregatorJob[];
};

const isPlainObject = (value: unknown): value is object => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isAggregatorInputJob = (value: unknown): value is AggregatorInputJob => isPlainObject(value);

const asJobMetadataInput = (value: unknown): JobMetadataInput | null => {
  if (!isPlainObject(value)) return null;
  return value as JobMetadataInput;
};

const asJobRemoteInput = (value: unknown): JobRemoteInput | null => {
  if (!isPlainObject(value)) return null;
  return value as JobRemoteInput;
};

const normalizeJobType = (value: unknown): string => {
  const trimmed = normalizeString(value);
  return trimmed ? trimmed : 'http';
};

const normalizeTimestamp = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

const mergeGroups = (target: AggregationGroup, source: AggregationGroup): AggregationGroup => {
  if (target === source) return target;
  target.jobs.push(...source.jobs);
  target.createdAt = Math.min(target.createdAt, source.createdAt);
  target.updatedAt = Math.max(target.updatedAt, source.updatedAt);
  if (!target.taskId && source.taskId) target.taskId = source.taskId;
  if (!target.remoteRequestId && source.remoteRequestId) target.remoteRequestId = source.remoteRequestId;
  if (!target.projectPath && source.projectPath) target.projectPath = source.projectPath;
  return target;
};

const aggregateJobsToTasks = (jobs: unknown = []): AggregationGroup[] => {
  const taskIdToGroup = new Map<string, AggregationGroup>();
  const remoteRequestIdToGroup = new Map<string, AggregationGroup>();
  const taskIdAliasToGroup = new Map<string, AggregationGroup>();

  const allGroups = new Set<AggregationGroup>();
  let nextId = 1;

  const createGroup = (): AggregationGroup => {
    const group: AggregationGroup = {
      id: `g${nextId++}`,
      taskId: '',
      remoteRequestId: '',
      projectPath: '',
      createdAt: Number.POSITIVE_INFINITY,
      updatedAt: 0,
      jobs: [],
    };
    allGroups.add(group);
    return group;
  };

  const pickExistingGroup = (taskId: string, remoteRequestId: string, taskIdAlias: string): AggregationGroup | null => {
    if (taskId && taskIdToGroup.has(taskId)) return taskIdToGroup.get(taskId) ?? null;
    if (remoteRequestId && remoteRequestIdToGroup.has(remoteRequestId)) return remoteRequestIdToGroup.get(remoteRequestId) ?? null;
    if (taskIdAlias && taskIdAliasToGroup.has(taskIdAlias)) return taskIdAliasToGroup.get(taskIdAlias) ?? null;
    return null;
  };

  const inputJobs: readonly unknown[] = Array.isArray(jobs) ? jobs : [];

  for (const rawJob of inputJobs) {
    if (!isAggregatorInputJob(rawJob)) continue;
    const taskIdAliasSource = normalizeString(rawJob.id);
    if (!taskIdAliasSource) continue;

    const meta = asJobMetadataInput(rawJob.metadata);
    const remote = asJobRemoteInput(rawJob.remote);
    const taskId = normalizeString((meta !== null && meta !== undefined ? meta.taskId : undefined));
    const remoteFromMeta = normalizeString((meta !== null && meta !== undefined ? meta.remoteRequestId : undefined));
    const remoteFromParser = normalizeString((remote !== null && remote !== undefined ? remote.remoteRequestId : undefined));
    const remoteRequestId = remoteFromMeta || remoteFromParser;
    const followupOfTaskId = normalizeString((meta !== null && meta !== undefined ? meta.followupOfJobId : undefined));
    const taskIdAlias = followupOfTaskId || taskIdAliasSource;

    const projectPath = normalizeString(rawJob.projectPath);
    const createdAt = normalizeTimestamp(rawJob.createdAt, Number.POSITIVE_INFINITY);
    const updatedAt = normalizeTimestamp(rawJob.updatedAt, createdAt === Number.POSITIVE_INFINITY ? 0 : createdAt);

    let group = pickExistingGroup(taskId, remoteRequestId, taskIdAlias);
    if (!group) group = createGroup();

    const candidates: AggregationGroup[] = [];
    const taskIdGroup = taskId ? taskIdToGroup.get(taskId) ?? null : null;
    const remoteRequestIdGroup = remoteRequestId ? remoteRequestIdToGroup.get(remoteRequestId) ?? null : null;
    const taskIdAliasGroup = taskIdAlias ? taskIdAliasToGroup.get(taskIdAlias) ?? null : null;
    if (taskIdGroup && taskIdGroup !== group) candidates.push(taskIdGroup);
    if (remoteRequestIdGroup && remoteRequestIdGroup !== group) candidates.push(remoteRequestIdGroup);
    if (taskIdAliasGroup && taskIdAliasGroup !== group) candidates.push(taskIdAliasGroup);

    for (const other of candidates) {
      mergeGroups(group, other);
      allGroups.delete(other);

      for (const [key, value] of taskIdToGroup.entries()) {
        if (value === other) taskIdToGroup.set(key, group);
      }
      for (const [key, value] of remoteRequestIdToGroup.entries()) {
        if (value === other) remoteRequestIdToGroup.set(key, group);
      }
      for (const [key, value] of taskIdAliasToGroup.entries()) {
        if (value === other) taskIdAliasToGroup.set(key, group);
      }
    }

    group.taskId = group.taskId || taskId;
    group.remoteRequestId = group.remoteRequestId || remoteRequestId;
    group.projectPath = group.projectPath || projectPath;
    group.createdAt = Math.min(group.createdAt, createdAt);
    group.updatedAt = Math.max(group.updatedAt, updatedAt);
    group.jobs.push({
      ...rawJob,
      id: taskIdAliasSource,
      type: normalizeJobType(rawJob.type),
      status: normalizeString(rawJob.status).toLowerCase() || 'queued',
      createdAt: createdAt === Number.POSITIVE_INFINITY ? 0 : createdAt,
      updatedAt,
      projectPath,
    });

    if (taskId) taskIdToGroup.set(taskId, group);
    if (remoteRequestId) remoteRequestIdToGroup.set(remoteRequestId, group);
    if (taskIdAlias) taskIdAliasToGroup.set(taskIdAlias, group);
    taskIdAliasToGroup.set(taskIdAliasSource, group);
  }

  const groups: AggregationGroup[] = Array.from(allGroups);
  groups.forEach((group) => {
    group.jobs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!Number.isFinite(group.createdAt) || group.createdAt === Number.POSITIVE_INFINITY) {
      const first = group.jobs[group.jobs.length - 1];
      group.createdAt = first ? normalizeTimestamp(first.createdAt, 0) : 0;
    }
  });
  groups.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
};

export {
  aggregateJobsToTasks,
};

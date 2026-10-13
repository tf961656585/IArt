import type { UnifiedGenerationStatus } from '@iart/contracts';
import { normalizeString } from './remote-response-parser/extractors.cts';

type CanvasAlignedStatus = UnifiedGenerationStatus;

type SemanticJobProgress = {
  phase: unknown | undefined;
};

type SemanticJobRemote = {
  remoteStatus: unknown | undefined;
  remoteProgress: unknown | undefined;
};

type SemanticJob = {
  id: unknown | undefined;
  type: unknown | undefined;
  status: unknown | undefined;
  updatedAt: unknown | undefined;
  polling: unknown | undefined;
  progress: SemanticJobProgress | undefined;
  remote: SemanticJobRemote | undefined;
};

type SemanticTaskGroup = {
  jobs: unknown | undefined;
  taskId: unknown | undefined;
  remoteRequestId: unknown | undefined;
};

type SemanticWarningExtra = {
  taskId: string | undefined;
  remoteRequestId: string | undefined;
  submitJobId: string | undefined;
};

type SemanticWarning = SemanticWarningExtra & {
  code: string;
  message: string | null;
};

type TaskSemantic = {
  diagnosticStatus: CanvasAlignedStatus;
  semanticDetail: string | null;
  semanticProgress: number | null;
  jobStatusDetail: string | null;
  warnings: SemanticWarning[];
};

const isObjectLike = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readObjectField = (source: object, key: string): unknown => Reflect.get(source, key) as unknown;

const readOptionalProgress = (value: unknown): SemanticJobProgress | undefined => {
  if (!isObjectLike(value)) return undefined;
  const phase = readObjectField(value, 'phase');
  return phase === undefined ? undefined : { phase };
};

const readOptionalRemote = (value: unknown): SemanticJobRemote | undefined => {
  if (!isObjectLike(value)) return undefined;

  const remoteStatus = readObjectField(value, 'remoteStatus');
  const remoteProgress = readObjectField(value, 'remoteProgress');
  const remote: SemanticJobRemote = {} as SemanticJobRemote;

  if (remoteStatus !== undefined) remote.remoteStatus = remoteStatus;
  if (remoteProgress !== undefined) remote.remoteProgress = remoteProgress;

  return remote;
};

const readOptionalJob = (value: unknown): SemanticJob | null => {
  if (!isObjectLike(value)) return null;

  const job: SemanticJob = {} as SemanticJob;
  const id = readObjectField(value, 'id');
  const type = readObjectField(value, 'type');
  const status = readObjectField(value, 'status');
  const updatedAt = readObjectField(value, 'updatedAt');
  const polling = readObjectField(value, 'polling');
  const progress = readOptionalProgress(readObjectField(value, 'progress'));
  const remote = readOptionalRemote(readObjectField(value, 'remote'));

  if (id !== undefined) job.id = id;
  if (type !== undefined) job.type = type;
  if (status !== undefined) job.status = status;
  if (updatedAt !== undefined) job.updatedAt = updatedAt;
  if (polling !== undefined) job.polling = polling;
  if (progress !== undefined) job.progress = progress;
  if (remote !== undefined) job.remote = remote;

  return job;
};

const readTaskGroup = (value: unknown): SemanticTaskGroup => {
  if (!isObjectLike(value)) return {} as SemanticTaskGroup;

  const jobs = readObjectField(value, 'jobs');
  const taskId = readObjectField(value, 'taskId');
  const remoteRequestId = readObjectField(value, 'remoteRequestId');
  const taskGroup: SemanticTaskGroup = {} as SemanticTaskGroup;

  if (jobs !== undefined) taskGroup.jobs = jobs;
  if (taskId !== undefined) taskGroup.taskId = taskId;
  if (remoteRequestId !== undefined) taskGroup.remoteRequestId = remoteRequestId;

  return taskGroup;
};

const readJobs = (value: unknown): SemanticJob[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const job = readOptionalJob(entry);
    return job ? [job] : [];
  });
};

const normalizeJobType = (value: unknown): string => {
  const trimmed = normalizeString(value);
  return trimmed ? trimmed : 'http';
};

const hasAsyncPollingConfig = (job: SemanticJob | null): boolean => {
  if (!job || normalizeJobType(job.type).toLowerCase() !== 'http') return false;
  const polling = job.polling;
  if (!isObjectLike(polling)) return false;
  return Object.keys(polling).some((key) => {
    const value = readObjectField(polling, key);
    if (typeof value === 'string') return Boolean(value.trim());
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined;
  });
};

const hasAsyncSubmissionSignal = (job: SemanticJob | null): boolean => {
  if (!job || normalizeJobType(job.type).toLowerCase() !== 'http') return false;
  return hasAsyncPollingConfig(job);
};

const deriveCanvasAlignedStatusFromJob = (job: SemanticJob | null): CanvasAlignedStatus => {
  const status = normalizeString((job !== null && job !== undefined ? job.status : undefined)).toLowerCase();
  const type = normalizeJobType((job !== null && job !== undefined ? job.type : undefined)).toLowerCase();
  if (normalizeString((job !== null && job !== undefined && job.progress !== null && job.progress !== undefined ? job.progress.phase : undefined)).toLowerCase() === 'downloading') return 'downloading';
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'canceled' || status === 'cancelled' || status === 'paused') return 'failed';
  if (type === 'polling') return 'polling';
  if (hasAsyncPollingConfig(job)) return 'submitting';
  return 'generating';
};

const readUpdatedAt = (job: SemanticJob): number => (typeof job.updatedAt === 'number' ? job.updatedAt : 0);

const pickLatestJobOfType = (jobs: SemanticJob[], expectedType: unknown): SemanticJob | null => {
  const type = normalizeString(expectedType).toLowerCase();
  const filtered = jobs.filter((job) => normalizeJobType(job.type).toLowerCase() === type);
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => readUpdatedAt(b) - readUpdatedAt(a));
  return filtered[0] ?? null;
};

const withStringField = (extra: SemanticWarningExtra, key: keyof SemanticWarningExtra, value: unknown): void => {
  const normalized = normalizeString(value);
  if (normalized) extra[key] = normalized;
};

const deriveTaskSemantic = (input: unknown): TaskSemantic => {
  const taskGroup = readTaskGroup(input);
  const jobs = readJobs(taskGroup.jobs);
  const pollingJob = pickLatestJobOfType(jobs, 'polling');
  const submitJob = pickLatestJobOfType(jobs, 'http') || (jobs.length > 0 ? jobs[0] ?? null : null);
  const primaryJob = pollingJob || submitJob;

  const warnings: SemanticWarning[] = [];
  const pushWarning = (code: unknown, message: unknown, extra: SemanticWarningExtra = {} as SemanticWarningExtra): void => {
    const c = normalizeString(code);
    if (!c) return;
    const msg = normalizeString(message);
    warnings.push({ code: c, message: msg || null, ...extra });
  };

  const remoteStatus =
    normalizeString((pollingJob !== null && pollingJob !== undefined && pollingJob.remote !== null && pollingJob.remote !== undefined ? pollingJob.remote.remoteStatus : undefined)) || normalizeString((submitJob !== null && submitJob !== undefined && submitJob.remote !== null && submitJob.remote !== undefined ? submitJob.remote.remoteStatus : undefined));
  const pollingRemoteProgress = (pollingJob !== null && pollingJob !== undefined && pollingJob.remote !== null && pollingJob.remote !== undefined) ? pollingJob.remote.remoteProgress : undefined;
  const submitRemoteProgress = (submitJob !== null && submitJob !== undefined && submitJob.remote !== null && submitJob.remote !== undefined) ? submitJob.remote.remoteProgress : undefined;
  const remoteProgressRaw =
    pollingRemoteProgress !== undefined && pollingRemoteProgress !== null
      ? pollingRemoteProgress
      : submitRemoteProgress;
  const remoteProgress =
    typeof remoteProgressRaw === 'number' && Number.isFinite(remoteProgressRaw) ? remoteProgressRaw : null;

  if (pollingJob) {
    const pollingDerived = deriveCanvasAlignedStatusFromJob(pollingJob);
    if (pollingDerived === 'polling' || pollingDerived === 'generating') {
      return {
        diagnosticStatus: 'polling',
        semanticDetail: remoteStatus ? `remote:${remoteStatus}` : null,
        semanticProgress: remoteProgress,
        jobStatusDetail: normalizeString((primaryJob !== null && primaryJob !== undefined ? primaryJob.status : undefined)).toLowerCase() || null,
        warnings,
      };
    }
    return {
      diagnosticStatus: pollingDerived,
      semanticDetail: remoteStatus ? `remote:${remoteStatus}` : null,
      semanticProgress: remoteProgress,
      jobStatusDetail: normalizeString((primaryJob !== null && primaryJob !== undefined ? primaryJob.status : undefined)).toLowerCase() || null,
      warnings,
    };
  }

  const submitDerived = deriveCanvasAlignedStatusFromJob(submitJob);
  const asyncSubmission = hasAsyncSubmissionSignal(submitJob);

  if (asyncSubmission) {
    if (submitDerived === 'succeeded') {
      const warningExtra: SemanticWarningExtra = {} as SemanticWarningExtra;
      withStringField(warningExtra, 'taskId', taskGroup.taskId);
      withStringField(warningExtra, 'remoteRequestId', taskGroup.remoteRequestId);
      withStringField(warningExtra, 'submitJobId', (submitJob !== null && submitJob !== undefined ? submitJob.id : undefined));
      pushWarning(
        'polling-missing',
        '检测到异步提交响应，但未找到关联的 polling job（可能尚未创建/已被清理/项目未打开）',
        warningExtra
      );
    }
    const fallbackStatus = submitDerived === 'succeeded' ? 'submitting' : submitDerived;
    return {
      diagnosticStatus: fallbackStatus,
      semanticDetail: remoteStatus ? `remote:${remoteStatus}` : null,
      semanticProgress: remoteProgress,
      jobStatusDetail: normalizeString((primaryJob !== null && primaryJob !== undefined ? primaryJob.status : undefined)).toLowerCase() || null,
      warnings,
    };
  }

  return {
    diagnosticStatus: submitDerived,
    semanticDetail: remoteStatus ? `remote:${remoteStatus}` : null,
    semanticProgress: remoteProgress,
    jobStatusDetail: normalizeString((primaryJob !== null && primaryJob !== undefined ? primaryJob.status : undefined)).toLowerCase() || null,
    warnings,
  };
};

export {
  deriveTaskSemantic,
  deriveCanvasAlignedStatusFromJob,
};

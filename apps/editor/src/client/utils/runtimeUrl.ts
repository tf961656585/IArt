import { getRuntimeBackendBaseUrl } from '@/client/store/runtimeStore';

export const getRuntimeOrigin = (): string => {
  const runtimeBase = getRuntimeBackendBaseUrl();
  if (runtimeBase) {
    return runtimeBase;
  }
  throw new Error('editor runtime backend base url unavailable');
};

export const resolveRuntimeUrl = (value: string): string => {
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) {
    return new URL(value).toString();
  }
  return new URL(value, getRuntimeOrigin()).toString();
};

import * as fs from 'node:fs';
import {
  DEFAULT_ONBOARDING_STATE,
  ONBOARDING_GUIDE_SCHEMA_VERSION,
  OnboardingStateSchema,
  type OnboardingState,
} from '@iart/contracts';
import { ensureStorageDirs } from '../storage.cts';
import * as loggingModule from '../logging.cts';
import { isPlainObject } from '../utils.cts';

/**
 * 首次指引展示态记忆（docs/hub/首次指引-design.md §4.1）。
 *
 * - 文件：config/onboarding-state.json（独立小文件，先例 announcement.json）
 * - 只承载「用户是否已看过/跳过欢迎指引」这一个展示态标记
 * - 判定「是否触发指引」的配置状态（有无服务商）不在这里：Hub 消费既有端点
 *   （GET /api/provider-connections），本模块不感知配置事实
 * - 读取侧 Schema.safeParse 逐字段校验，损坏/缺字段回退默认值（未看过）；
 *   「文件不存在」与「文件损坏」同为未看过，不做新装机区分（拍板口径见 §3.6）
 */

type OnboardingStatePathMap = { onboardingState: string | undefined };

const asPathMap = (value: unknown): OnboardingStatePathMap | null =>
  isPlainObject(value) ? (value as OnboardingStatePathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null && record !== undefined ? record.onboardingState : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const normalizeState = (raw: unknown): OnboardingState => {
  const parsed = OnboardingStateSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  loggingModule.logDebug('[onboarding-store] drop invalid onboarding state, fallback to default', {
    error: parsed.error.message,
  });
  return { ...DEFAULT_ONBOARDING_STATE };
};

const readFromDisk = (paths: unknown): OnboardingState | null => {
  const filePath = getFilePath(paths);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeState(parsed);
  } catch {
    return null;
  }
};

const writeToDisk = (paths: unknown, state: OnboardingState): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
};

let cache: OnboardingState | null = null;

const getState = (): OnboardingState => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? { ...DEFAULT_ONBOARDING_STATE };
  return cache;
};

const commitState = (next: OnboardingState): OnboardingState => {
  const updated: OnboardingState = {
    ...next,
    version: ONBOARDING_GUIDE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };
  const paths: unknown = ensureStorageDirs();
  cache = updated;
  writeToDisk(paths, updated);
  return updated;
};

/** 当前展示态记忆（缓存读，文件缺失/损坏回退未看过）。 */
const readOnboardingState = (): OnboardingState => getState();

/** 写已看标记；返回写入后的完整状态。 */
const setGuideDismissed = (dismissed: boolean): OnboardingState =>
  commitState({ ...getState(), guideDismissed: dismissed });

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  readOnboardingState,
  setGuideDismissed,
  clearCacheForTest,
  type OnboardingState,
};

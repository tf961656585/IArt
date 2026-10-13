const DEFAULT_TASK_REVISION_KEYS = ['taskInfo', 'items'] as const;

const keySet = new Set<string>(DEFAULT_TASK_REVISION_KEYS);

const normalizeKey = (key: string): string => {
  const trimmed = key.trim();
  return trimmed;
};

export const TaskRevisionKeyRegistry = {
  register(key: string) {
    if (typeof key !== 'string') return;
    const normalized = normalizeKey(key);
    if (!normalized) return;
    keySet.add(normalized);
  },

  has(key: string): boolean {
    if (typeof key !== 'string') return false;
    const normalized = normalizeKey(key);
    if (!normalized) return false;
    return keySet.has(normalized);
  },

  shouldBumpTaskRevision(changedKeys: readonly string[]): boolean {
    for (const key of changedKeys) {
      if (TaskRevisionKeyRegistry.has(key)) return true;
    }
    return false;
  },

  resetForTest() {
    keySet.clear();
    for (const key of DEFAULT_TASK_REVISION_KEYS) {
      keySet.add(key);
    }
  },
} as const;

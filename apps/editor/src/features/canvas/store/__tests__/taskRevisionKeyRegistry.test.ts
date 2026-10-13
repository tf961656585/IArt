import { beforeEach, describe, expect, it } from 'vitest';
import { TaskRevisionKeyRegistry } from '../taskRevisionKeyRegistry';

describe('TaskRevisionKeyRegistry', () => {
  beforeEach(() => {
    TaskRevisionKeyRegistry.resetForTest();
  });

  it('应包含默认 keys（taskInfo/items）', () => {
    expect(TaskRevisionKeyRegistry.has('taskInfo')).toBe(true);
    expect(TaskRevisionKeyRegistry.has('items')).toBe(true);
  });

  it('注册新 key 后应能命中 shouldBumpTaskRevision', () => {
    TaskRevisionKeyRegistry.register('myTaskField');
    expect(TaskRevisionKeyRegistry.shouldBumpTaskRevision(['label'])).toBe(false);
    expect(TaskRevisionKeyRegistry.shouldBumpTaskRevision(['label', 'myTaskField'])).toBe(true);
  });

  it('重复注册应幂等', () => {
    TaskRevisionKeyRegistry.register('taskInfo');
    TaskRevisionKeyRegistry.register('taskInfo');
    expect(TaskRevisionKeyRegistry.shouldBumpTaskRevision(['taskInfo'])).toBe(true);
  });
});

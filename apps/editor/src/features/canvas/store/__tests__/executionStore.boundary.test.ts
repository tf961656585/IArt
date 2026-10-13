import { beforeEach, describe, expect, it } from 'vitest';
import { useExecutionStore } from '../executionStore';

describe('executionStore 边界', () => {
  beforeEach(() => {
    useExecutionStore.getState().reset();
  });

  it('只把错误节点暴露为诊断结果，resolved 输出仍留在瞬时结果通道', () => {
    const store = useExecutionStore.getState();
    const executionId = store.startExecution('graph-1', '测试画板', undefined, undefined);

    store.setNodeResult(
      'node-resolved',
      {
        status: 'resolved',
        outputs: {
          output: '/files/output.png',
        },
      },
      executionId,
    );

    store.setNodeError(
      'node-error',
      '本地执行失败',
      { backendMessage: 'sqlite busy' },
      executionId,
    );

    const transientNodeResults = useExecutionStore.getState().getTransientNodeResults(executionId);
    expect(transientNodeResults.get('node-resolved')?.status).toBe('resolved');
    expect(transientNodeResults.get('node-error')?.status).toBe('error');

    expect(useExecutionStore.getState().getNodeDiagnosticResult('node-resolved', executionId)).toBeUndefined();
    expect(useExecutionStore.getState().getNodeDiagnosticResult('node-error', executionId)?.error).toBe('本地执行失败');
  });

  it('把 backendMessage、瞬时输出与瞬时进度拆到显式 accessor', () => {
    const store = useExecutionStore.getState();
    const executionId = store.startExecution('graph-1', '测试画板', undefined, undefined);

    store.setNodeResult(
      'node-preview',
      {
        status: 'resolved',
        outputs: {
          image: '/files/output.png',
        },
        progress: 72,
      },
      executionId,
    );

    store.setNodeError(
      'node-error',
      '本地执行失败',
      { backendMessage: 'sqlite busy' },
      executionId,
    );

    expect(useExecutionStore.getState().getTransientNodeOutputs('node-preview', executionId)).toEqual({
      image: '/files/output.png',
    });
    expect(useExecutionStore.getState().getTransientNodeProgress('node-preview', executionId)).toBe(72);
    expect(useExecutionStore.getState().getNodeDiagnosticInfo('node-error', executionId)).toMatchObject({
      error: '本地执行失败',
      backendMessage: 'sqlite busy',
    });
    expect(useExecutionStore.getState().getNodeDiagnosticInfo('node-preview', executionId)).toBeUndefined();
  });
});

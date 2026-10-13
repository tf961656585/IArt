/**
 * 画板执行状态管理
 * - 管理画板执行状态
 * - 追踪各节点执行进度
 * - 存储执行结果
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import type {
  ExecutionSession,
  NodeExecutionResult,
  ExecutionStatus,
  NodeExecutionStatus,
  ExecutionLogEntry,
  ExecutionOptions,
} from '../types/execution';
import {
  createExecutionSession,
  createNodeExecutionResult,
  isNodeExecutionActiveStatus,
  isNodeExecutionResolved,
  isNodeExecutionTerminalStatus,
} from '../types/execution';
import { sharedOutputSanitizer } from '../services/outputSanitizer';
import type { UnknownRecord } from '@/client/utils/typeGuards';
import type { ExecutionPreflightIssue } from '../types/executionPreflight';

enableMapSet();

const MAX_HISTORY_SANITIZE_DEPTH = 10;
const INLINE_DATA_MAX_LENGTH = 1024; // 1KB
const BASE64_DATA_URL_REGEX = /^data:[^;]+;base64,/i;
const BASE64_PLACEHOLDER = '[base64-truncated]';
const INLINE_DATA_PLACEHOLDER = '[inline-data-truncated]';
const EMPTY_TRANSIENT_NODE_RESULTS = new Map<string, NodeExecutionResult>();

export interface NodeDiagnosticInfo {
  error: string | undefined;
  errorDetails: unknown | undefined;
  backendMessage: string | undefined;
  duration: number | undefined;
}

const extractBackendMessageFromDiagnosticDetails = (errorDetails: unknown): string | undefined => {
  if (!errorDetails || typeof errorDetails !== 'object') return undefined;
  const backendMessage = (errorDetails as { backendMessage: unknown | undefined }).backendMessage;
  return typeof backendMessage === 'string' ? backendMessage : undefined;
};

export const sanitizeOutputsForHistory = (value: unknown, depth = 0): unknown => {
  if (depth >= MAX_HISTORY_SANITIZE_DEPTH) return value;

  if (typeof value === 'string') {
    if (BASE64_DATA_URL_REGEX.test(value)) {
      return BASE64_PLACEHOLDER;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOutputsForHistory(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const record = value as UnknownRecord;
    const result: UnknownRecord = {};

    for (const [key, val] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'inline_data' || lowerKey === 'inlinedata') {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const inlineObj = val as UnknownRecord;
          const sanitizedInline: UnknownRecord = {};
          for (const [inlineKey, inlineVal] of Object.entries(inlineObj)) {
            if (inlineKey.toLowerCase() === 'data' && typeof inlineVal === 'string') {
              sanitizedInline[inlineKey] = inlineVal.length > INLINE_DATA_MAX_LENGTH
                ? INLINE_DATA_PLACEHOLDER
                : inlineVal;
            } else {
              sanitizedInline[inlineKey] = sanitizeOutputsForHistory(inlineVal, depth + 1);
            }
          }
          result[key] = sanitizedInline;
          continue;
        }
      }

      result[key] = sanitizeOutputsForHistory(val, depth + 1);
    }

    return result;
  }

  return value;
};

const sanitizeExecutionForHistory = (execution: ExecutionSession): void => {
  if (execution.outputs) {
    execution.outputs = sanitizeOutputsForHistory(execution.outputs) as UnknownRecord;
  }

  execution.nodeResults.forEach((result) => {
    if (result.outputs) {
      result.outputs = sanitizeOutputsForHistory(result.outputs) as UnknownRecord;
    }
  });
};

/** 执行 Store 状态 */
interface ExecutionState {
  /** 当前聚焦的执行 (别名 execution) */
  currentExecution: ExecutionSession | undefined;
  /** 当前聚焦执行的 ID */
  currentExecutionId: string | undefined;
  /** 进行中的执行会话（仅本地调度/诊断，不代表正式任务生命周期） */
  executions: Record<string, ExecutionSession>;
  /** 历史执行记录 */
  executionHistory: ExecutionSession[];
  /** 最大历史记录数 */
  maxHistorySize: number;
  /** 执行选项 */
  options: ExecutionOptions;
  /**
   * 执行前置校验未通过的问题（按定位节点分组）。
   * 会话态反馈通道：不依附执行会话（校验不通过时不创建会话），
   * 每次触发执行时整体替换，不进 undo history、不持久化。
   */
  preflightIssuesByNodeId: Record<string, ExecutionPreflightIssue[]>;
}

// 为了兼容性，提供 execution 作为 currentExecution 的别名
type _ExecutionStateWithAlias = ExecutionState & {
  /** currentExecution 的别名 */
  execution: ExecutionSession | undefined;
};

/** 执行 Store 操作 */
interface ExecutionActions {
  // 执行控制
  startExecution: (
    nodeGraphId: string,
    nodeGraphName: string,
    options: ExecutionOptions | undefined,
    initialStatus: ExecutionStatus | undefined
  ) => string;
  updateExecutionStatus: (executionId: string, status: ExecutionStatus) => void;
  pauseExecution: () => void;
  resumeExecution: () => void;
  cancelExecution: (executionId: string | undefined) => void;
  completeExecution: (outputs: UnknownRecord | undefined, executionId: string | undefined) => void;
  failExecution: (error: string, executionId: string | undefined) => void;

  // 节点执行状态
  setNodeStatus: (nodeId: string, status: NodeExecutionStatus, executionId: string | undefined) => void;
  setNodeResult: (nodeId: string, result: Partial<NodeExecutionResult>, executionId: string | undefined) => void;
  setNodeProgress: (nodeId: string, progress: number, executionId: string | undefined) => void;
  setNodeOutputs: (nodeId: string, outputs: UnknownRecord, executionId: string | undefined) => void;
  setNodeError: (nodeId: string, error: string, details: unknown | undefined, executionId: string | undefined) => void;

  // 日志
  addLog: (
    level: ExecutionLogEntry['level'],
    message: string,
    nodeId: string | undefined,
    data: unknown | undefined,
    executionId: string | undefined
  ) => void;
  clearLogs: (executionId: string | undefined) => void;

  // 历史管理
  clearHistory: () => void;
  removeFromHistory: (executionId: string) => void;
  getExecution: (executionId: string) => ExecutionSession | undefined;

  // 状态查询
  /** 写入本次触发的前置校验问题（整体替换；空数组表示校验通过，清空标注） */
  setPreflightIssues: (issues: ExecutionPreflightIssue[]) => void;
  /** 本地诊断结果，仅用于错误/调试展示，不代表正式任务生命周期 */
  getNodeDiagnosticResult: (nodeId: string, executionId: string | undefined) => NodeExecutionResult | undefined;
  /** 本地诊断摘要，仅暴露 UI 允许消费的错误/调试字段 */
  getNodeDiagnosticInfo: (nodeId: string, executionId: string | undefined) => NodeDiagnosticInfo | undefined;
  /** 瞬时输出结果，仅用于本地输入解析，不代表正式任务生命周期 */
  getTransientNodeResults: (executionId: string | undefined) => ReadonlyMap<string, NodeExecutionResult>;
  /** 瞬时节点输出，仅用于输入解析/预览，不代表正式任务生命周期 */
  getTransientNodeOutputs: (nodeId: string, executionId: string | undefined) => UnknownRecord | undefined;
  /** 瞬时本地进度，仅用于节点内局部反馈，不代表正式任务生命周期 */
  getTransientNodeProgress: (nodeId: string, executionId: string | undefined) => number | undefined;
  getNodeResult: (nodeId: string, executionId: string | undefined) => NodeExecutionResult | undefined;
  getNodeOutputs: (nodeId: string, executionId: string | undefined) => UnknownRecord | undefined;
  isNodeExecuting: (nodeId: string, executionId: string | undefined) => boolean;
  isNodeComplete: (nodeId: string, executionId: string | undefined) => boolean;

  // 重置
  reset: () => void;
}

/** 执行 Store */
export const useExecutionStore = create<ExecutionState & ExecutionActions>()(
  immer((set, get) => {
    const resolveExecution = (state: ExecutionState, executionId: string | undefined): ExecutionSession | undefined => {
      const targetId = executionId ?? state.currentExecutionId;
      if (!targetId) return undefined;
      if (state.executions[targetId]) return state.executions[targetId];
      if ((state.currentExecution !== null && state.currentExecution !== undefined ? state.currentExecution.id : undefined) === targetId) return state.currentExecution;
      return state.executionHistory.find((e) => e.id === targetId);
    };

    const archiveExecution = (state: ExecutionState, execution: ExecutionSession) => {
      const exists = state.executionHistory.some((item) => item.id === execution.id);
      if (!exists) {
        sanitizeExecutionForHistory(execution);
        state.executionHistory.unshift(execution);
        if (state.executionHistory.length > state.maxHistorySize) {
          state.executionHistory.pop();
        }
      }
    };

    return {
      // 初始状态
      currentExecution: undefined,
      currentExecutionId: undefined,
      executions: {},
      executionHistory: [],
      maxHistorySize: 20,
      preflightIssuesByNodeId: {},
      options: {
        variables: undefined,
        startFromNode: undefined,
        onlyNodes: undefined,
        includeDependencies: undefined,
        // 0 表示不超时：长耗时任务由 Hub Task 持续执行，前端仅负责展示
        timeout: 0,
        continueOnFailure: false,
        maxConcurrent: 3,
      },

      // 执行控制
      startExecution: (nodeGraphId, nodeGraphName, options, initialStatus = 'dispatching') => {
        const execution = createExecutionSession(nodeGraphId, nodeGraphName, 'manual');
        execution.status = initialStatus;
        execution.variables = (options !== null && options !== undefined ? options.variables : undefined) ?? {};

        set((state) => {
          if (state.currentExecution && !['dispatching', 'scheduled'].includes(state.currentExecution.status)) {
            archiveExecution(state, state.currentExecution);
            if (state.executions[state.currentExecution.id]) {
              delete state.executions[state.currentExecution.id];
            }
          }
          state.executions[execution.id] = execution;
          state.currentExecution = execution;
          state.currentExecutionId = execution.id;
          state.options = { ...state.options, ...options };
        });

        get().addLog(
          'info',
          initialStatus === 'scheduled' ? `画板执行已进入本地调度: ${nodeGraphName}` : `开始执行画板: ${nodeGraphName}`,
          undefined,
          undefined,
          execution.id
        );
        return execution.id;
      },

      updateExecutionStatus: (executionId, status) => {
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (!execution) return;
          execution.status = status;
          if (['settled', 'error', 'aborted'].includes(status)) {
            execution.completedAt = new Date().toISOString();
            const start = new Date(execution.startedAt).getTime();
            execution.duration = Date.now() - start;
          }
        });
      },

      pauseExecution: () => {
        const executionId = get().currentExecutionId ?? undefined;
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (execution && execution.status === 'dispatching') {
            execution.status = 'suspended';
          }
        });
        if (executionId) {
          get().addLog('info', '执行已挂起', undefined, undefined, executionId);
        }
      },

      resumeExecution: () => {
        const executionId = get().currentExecutionId ?? undefined;
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (execution && execution.status === 'suspended') {
            execution.status = 'dispatching';
          }
        });
        if (executionId) {
          get().addLog('info', '执行已继续', undefined, undefined, executionId);
        }
      },

      cancelExecution: (executionId) => {
        const targetId = executionId ?? get().currentExecutionId;
        if (!targetId) return;
        set((state) => {
          const execution = resolveExecution(state, targetId);
          if (execution) {
            execution.status = 'aborted';
            execution.completedAt = new Date().toISOString();
            const start = new Date(execution.startedAt).getTime();
            execution.duration = Date.now() - start;
            archiveExecution(state, execution);
            delete state.executions[targetId];
            state.currentExecution = execution;
            state.currentExecutionId = execution.id;
          }
        });
        get().addLog('warn', '执行已中止', undefined, undefined, targetId);
      },

      completeExecution: (outputs, executionId) => {
        const targetId = executionId ?? get().currentExecutionId;
        if (!targetId) return;
        set((state) => {
          const execution = resolveExecution(state, targetId);
          if (!execution) return;
          execution.status = 'settled';
          execution.completedAt = new Date().toISOString();
          if (outputs !== undefined) execution.outputs = outputs;
          const start = new Date(execution.startedAt).getTime();
          execution.duration = Date.now() - start;
          archiveExecution(state, execution);
          delete state.executions[targetId];
          state.currentExecution = execution;
          state.currentExecutionId = execution.id;
        });
        get().addLog('info', '画板执行已落定', undefined, undefined, targetId);
      },

      failExecution: (error, executionId) => {
        const targetId = executionId ?? get().currentExecutionId;
        if (!targetId) return;
        set((state) => {
          const execution = resolveExecution(state, targetId);
          if (!execution) return;
          execution.status = 'error';
          execution.completedAt = new Date().toISOString();
          execution.error = error;
          const start = new Date(execution.startedAt).getTime();
          execution.duration = Date.now() - start;
          archiveExecution(state, execution);
          delete state.executions[targetId];
          state.currentExecution = execution;
          state.currentExecutionId = execution.id;
        });
        get().addLog('error', `执行报错: ${error}`, undefined, undefined, targetId);
      },

      // 节点执行状态
      setNodeStatus: (nodeId, status, executionId) => {
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (!execution) return;
          let result = execution.nodeResults.get(nodeId);
          if (!result) {
            result = createNodeExecutionResult(nodeId);
            execution.nodeResults.set(nodeId, result);
          }
          result.status = status;

          if (status === 'dispatching' && !result.startedAt) {
            result.startedAt = new Date().toISOString();
          }
          if (isNodeExecutionTerminalStatus(status)) {
            result.completedAt = new Date().toISOString();
            if (result.startedAt) {
              result.duration = new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime();
            }
          }
        });
      },

      setNodeResult: (nodeId, result, executionId) => {
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (!execution) return;
          let existing = execution.nodeResults.get(nodeId);
          if (!existing) {
            existing = createNodeExecutionResult(nodeId);
            execution.nodeResults.set(nodeId, existing);
          }
          Object.assign(existing, result);
          // 清洗 outputs，阻止 base64 泄漏
          if (existing.outputs) {
            existing.outputs = sharedOutputSanitizer.sanitizeSync(existing.outputs);
          }
        });
      },

      setNodeProgress: (nodeId, progress, executionId) => {
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (!execution) return;
          const result = execution.nodeResults.get(nodeId);
          if (result) {
            result.progress = Math.min(100, Math.max(0, progress));
          }
        });
      },

      setNodeOutputs: (nodeId, outputs, executionId) => {
        // 写入时强制清洗，阻止 base64 泄漏到内存
        const sanitizedOutputs = sharedOutputSanitizer.sanitizeSync(outputs);
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (!execution) return;
          let result = execution.nodeResults.get(nodeId);
          if (!result) {
            result = createNodeExecutionResult(nodeId);
            execution.nodeResults.set(nodeId, result);
          }
          result.outputs = sanitizedOutputs;
        });
      },

      setNodeError: (nodeId, error, details, executionId) => {
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (!execution) return;
          let result = execution.nodeResults.get(nodeId);
          if (!result) {
            result = createNodeExecutionResult(nodeId);
            execution.nodeResults.set(nodeId, result);
          }
          result.status = 'error';
          result.error = error;
          result.errorDetails = details;
          result.completedAt = new Date().toISOString();
        });
        get().addLog('error', `节点执行失败: ${error}`, nodeId, details, executionId);
      },

      // 日志
      addLog: (level, message, nodeId, data, executionId) => {
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (execution) {
            execution.logs.push({
              timestamp: new Date().toISOString(),
              level,
              message,
              nodeId,
              data,
            });
          }
        });
      },

      clearLogs: (executionId) => {
        set((state) => {
          const execution = resolveExecution(state, executionId);
          if (execution) {
            execution.logs = [];
          }
        });
      },

      // 历史管理
      clearHistory: () => {
        set((state) => {
          state.executionHistory = [];
        });
      },

      removeFromHistory: (executionId) => {
        set((state) => {
          state.executionHistory = state.executionHistory.filter((e) => e.id !== executionId);
          if (state.currentExecutionId === executionId) {
            state.currentExecutionId = undefined;
            state.currentExecution = undefined;
          }
        });
      },

      getExecution: (executionId) => {
        const { executions, executionHistory } = get();
        if (executions[executionId]) return executions[executionId];
        return executionHistory.find((e) => e.id === executionId);
      },

      // 状态查询
      setPreflightIssues: (issues) => {
        set((state) => {
          const grouped: Record<string, ExecutionPreflightIssue[]> = {};
          for (const issue of issues) {
            const bucket = grouped[issue.nodeId] ?? [];
            bucket.push(issue);
            grouped[issue.nodeId] = bucket;
          }
          state.preflightIssuesByNodeId = grouped;
        });
      },

      getNodeDiagnosticResult: (nodeId, executionId) => {
        const result = get().getNodeResult(nodeId, executionId);
        if (!result) return undefined;
        if (result.status !== 'error' && !result.error && !result.errorDetails) {
          return undefined;
        }
        return result;
      },

      getNodeDiagnosticInfo: (nodeId, executionId) => {
        const result = get().getNodeDiagnosticResult(nodeId, executionId);
        if (!result) return undefined;
        const info: NodeDiagnosticInfo = {
          error: undefined,
          errorDetails: undefined,
          backendMessage: undefined,
          duration: undefined,
        };
        if (result.error !== undefined) info.error = result.error;
        if (result.errorDetails !== undefined) {
          info.errorDetails = result.errorDetails;
          const msg = extractBackendMessageFromDiagnosticDetails(result.errorDetails);
          if (msg !== undefined) info.backendMessage = msg;
        }
        if (result.duration !== undefined) info.duration = result.duration;
        return info;
      },

      getTransientNodeResults: (executionId) => {
        const execution = executionId ? get().getExecution(executionId) : get().currentExecution;
        return (execution !== null && execution !== undefined ? execution.nodeResults : undefined) ?? EMPTY_TRANSIENT_NODE_RESULTS;
      },

      getTransientNodeOutputs: (nodeId, executionId) => {
        const result = get().getTransientNodeResults(executionId).get(nodeId);
        return result !== undefined ? result.outputs : undefined;
      },

      getTransientNodeProgress: (nodeId, executionId) => {
        const result = get().getTransientNodeResults(executionId).get(nodeId);
        return result !== undefined ? result.progress : undefined;
      },

      getNodeResult: (nodeId, executionId) => {
        const { executions, currentExecutionId } = get();
        if (executionId && executions[executionId]) {
          return executions[executionId].nodeResults.get(nodeId);
        }
        if (currentExecutionId && executions[currentExecutionId]) {
          return executions[currentExecutionId].nodeResults.get(nodeId);
        }
        return undefined;
      },

      getNodeOutputs: (nodeId, executionId) => {
        const result = get().getNodeResult(nodeId, executionId);
        return (result !== null && result !== undefined ? result.outputs : undefined);
      },

      isNodeExecuting: (nodeId, executionId) => {
        const result = get().getNodeResult(nodeId, executionId);
        return isNodeExecutionActiveStatus((result !== null && result !== undefined ? result.status : undefined));
      },

      isNodeComplete: (nodeId, executionId) => {
        const result = get().getNodeResult(nodeId, executionId);
        return isNodeExecutionResolved(result);
      },

      // 重置
      reset: () => {
        set((state) => {
          state.currentExecution = undefined;
          state.currentExecutionId = undefined;
          state.executions = {};
          state.executionHistory = [];
          state.preflightIssuesByNodeId = {};
        });
      },
    };
  })
);

// 为方便访问，创建一个带有 execution 别名的 selector
export const selectExecution = (state: ExecutionState & ExecutionActions) => ({
  ...state,
  execution: state.currentExecution,
});

export default useExecutionStore;

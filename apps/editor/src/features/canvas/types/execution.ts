/**
 * 画板执行相关类型定义
 * - 定义执行状态、执行结果
 * - 支持单节点、节点组、完整画板执行
 */

import type { DynamicRecord } from '@/client/utils/typeGuards';

/** 本地执行会话状态（仅用于前端调度/诊断，不代表正式生成生命周期） */
export type ExecutionStatus =
  | 'idle'         // 空闲
  | 'scheduled'    // 已加入本地调度
  | 'dispatching'  // 正在本地执行
  | 'suspended'    // 本地调试挂起
  | 'settled'      // 本地执行已落定
  | 'error'        // 本地执行报错
  | 'aborted';     // 本地执行中止

/** 节点执行诊断状态（仅用于前端本地执行链，不代表正式生成生命周期） */
export type NodeExecutionStatus =
  | 'scheduled'        // 等待本地调度
  | 'dispatching'      // 正在本地执行
  | 'awaiting_remote'  // 等待远端继续推进（如轮询阶段）
  | 'materializing'    // 本地落盘/拉取结果中
  | 'resolved'         // 本地执行已落定
  | 'error'            // 本地执行报错
  | 'skipped'          // 已跳过
  | 'aborted';         // 已中止

/** 节点执行输出 */
export interface NodeExecutionOutput {
  /** 输出端口 ID */
  portId: string;
  /** 输出值 */
  value: unknown;
  /** 输出类型 */
  type: string;
}

/** 节点执行结果 */
export interface NodeExecutionResult {
  /** 节点 ID */
  nodeId: string;
  /** 瞬时执行状态 */
  status: NodeExecutionStatus;
  /** 输出数据 */
  outputs: DynamicRecord;
  /** 错误信息 */
  error: string | undefined;
  /** 错误详情 */
  errorDetails: unknown | undefined;
  /** 开始时间 */
  startedAt: string | undefined;
  /** 完成时间 */
  completedAt: string | undefined;
  /** 执行耗时（毫秒） */
  duration: number | undefined;
  /** 轮询进度（0-100） */
  progress: number | undefined;
  /** 原始响应 */
  rawResponse: unknown | undefined;
  /** 任务 ID（异步任务） */
  taskId: string | undefined;
}

/** 执行日志条目 */
export interface ExecutionLogEntry {
  /** 时间戳 */
  timestamp: string;
  /** 日志级别 */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** 节点 ID */
  nodeId: string | undefined;
  /** 日志消息 */
  message: string;
  /** 附加数据 */
  data: unknown | undefined;
}

/** 画板执行上下文 */
export interface ExecutionContext {
  /** 执行 ID */
  executionId: string;
  /** 画板 ID */
  nodeGraphId: string;
  /** 全局变量 */
  variables: DynamicRecord;
  /** 已完成节点的输出 */
  nodeOutputs: Map<string, DynamicRecord>;
  /** 执行日志 */
  logs: ExecutionLogEntry[];
  /** 是否中止 */
  aborted: boolean;
  /** 是否挂起 */
  suspended: boolean;
}

/** 执行会话 */
export interface ExecutionSession {
  /** 执行 ID */
  id: string;
  /** 画板 ID */
  nodeGraphId: string;
  /** 画板名称（快照） */
  nodeGraphName: string;
  /** 执行状态 */
  status: ExecutionStatus;
  /** 各节点执行结果 */
  nodeResults: Map<string, NodeExecutionResult>;
  /** 全局变量 */
  variables: DynamicRecord;
  /** 最终输出 */
  outputs: DynamicRecord | undefined;
  /** 执行日志 */
  logs: ExecutionLogEntry[];
  /** 开始时间 */
  startedAt: string;
  /** 完成时间 */
  completedAt: string | undefined;
  /** 执行耗时（毫秒） */
  duration: number | undefined;
  /** 错误信息 */
  error: string | undefined;
  /** 触发方式 */
  trigger: 'manual' | 'scheduled' | 'api';
}

/** 执行选项 */
export interface ExecutionOptions {
  /** 初始变量 */
  variables: DynamicRecord | undefined;
  /** 是否从指定节点开始 */
  startFromNode: string | undefined;
  /** 仅执行指定节点 */
  onlyNodes: string[] | undefined;
  /** 单节点执行时是否包含依赖链（默认 false） */
  includeDependencies: boolean | undefined;
  /** 超时时间（毫秒） */
  timeout: number | undefined;
  /** 失败时是否继续 */
  continueOnFailure: boolean | undefined;
  /** 最大并发数 */
  maxConcurrent: number | undefined;
}

/** 生成执行 ID */
export function generateExecutionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** 创建执行记录 */
export function createExecutionSession(
  nodeGraphId: string,
  nodeGraphName: string,
  trigger: ExecutionSession['trigger'] = 'manual'
): ExecutionSession {
  return {
    id: generateExecutionId(),
    nodeGraphId,
    nodeGraphName,
    status: 'scheduled',
    nodeResults: new Map(),
    variables: {},
    outputs: undefined,
    logs: [],
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    duration: undefined,
    error: undefined,
    trigger,
  };
}

/** 创建节点执行结果 */
export function createNodeExecutionResult(nodeId: string): NodeExecutionResult {
  return {
    nodeId,
    status: 'scheduled',
    outputs: {},
    error: undefined,
    errorDetails: undefined,
    startedAt: undefined,
    completedAt: undefined,
    duration: undefined,
    progress: undefined,
    rawResponse: undefined,
    taskId: undefined,
  };
}

export function isNodeExecutionTerminalStatus(status: NodeExecutionStatus | null | undefined): boolean {
  return status === 'resolved' || status === 'error' || status === 'skipped' || status === 'aborted';
}

export function isNodeExecutionActiveStatus(status: NodeExecutionStatus | null | undefined): boolean {
  return (
    status === 'dispatching' ||
    status === 'scheduled' ||
    status === 'awaiting_remote' ||
    status === 'materializing'
  );
}

export function isNodeExecutionResolved(
  result: NodeExecutionResult | null | undefined
): result is NodeExecutionResult & { status: 'resolved' } {
  return (result !== null && result !== undefined ? result.status : undefined) === 'resolved';
}

export function isNodeExecutionError(
  result: NodeExecutionResult | null | undefined
): result is NodeExecutionResult & { status: 'error' } {
  return (result !== null && result !== undefined ? result.status : undefined) === 'error';
}

/** 添加执行日志 */
export function addExecutionLog(
  context: ExecutionContext,
  level: ExecutionLogEntry['level'],
  message: string,
  nodeId: string | undefined,
  data: unknown | undefined
): void {
  const entry: ExecutionLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    nodeId: nodeId ?? undefined,
    data: data ?? undefined,
  };
  context.logs.push(entry);
}

/** 计算执行进度 */
export function calculateExecutionProgress(execution: ExecutionSession): number {
  const total = execution.nodeResults.size;
  if (total === 0) return 0;

  let completed = 0;
  for (const result of execution.nodeResults.values()) {
    if (isNodeExecutionTerminalStatus(result.status)) {
      completed++;
    }
  }

  return Math.round((completed / total) * 100);
}

/** 检查执行是否完成 */
export function isExecutionComplete(execution: ExecutionSession): boolean {
  return ['settled', 'error', 'aborted'].includes(execution.status);
}

/** 获取失败的节点 */
export function getFailedNodes(execution: ExecutionSession): NodeExecutionResult[] {
  const failed: NodeExecutionResult[] = [];
  for (const result of execution.nodeResults.values()) {
    if (isNodeExecutionError(result)) {
      failed.push(result);
    }
  }
  return failed;
}

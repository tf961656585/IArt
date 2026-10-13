/**
 * 音频分段类型定义
 * - 定义音频分段的数据结构
 * - 用于音频输入节点的分段功能
 */

/** 音频分段定义 */
export interface AudioSegment {
  /** 分段唯一标识 */
  id: string;
  /** 分段名称（用户自定义） */
  name: string;
  /** 起始时间（秒） */
  startTime: number;
  /** 结束时间（秒） */
  endTime: number;
  /** 分段是否已切分（执行后才为 true） */
  sliced: boolean;
  /** 切分后的本地音频 URL（仅执行后有值） */
  segmentUrl: string | undefined;
}

/** 生成分段 ID */
export function generateSegmentId(): string {
  return `segment_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** 格式化时间为 mm:ss 格式 */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/** 格式化时长为可读格式 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m${secs}s`;
}

/** 创建默认分段 */
export function createDefaultSegment(
  index: number,
  startTime: number,
  endTime: number
): AudioSegment {
  return {
    id: generateSegmentId(),
    name: `分段 ${index}`,
    startTime,
    endTime,
    sliced: false,
    segmentUrl: undefined,
  };
}

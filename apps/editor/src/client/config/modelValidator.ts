/**
 * 模型配置验证器
 * - 在开发环境启动时检查所有模型配置
 * - 生产环境仅记录警告
 */
import type { ModelConfigEntry } from './models.config';
import { listModelConfigs, listModelConfigsWithSource } from './models.config';

export interface ValidationError {
  modelId: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

let startupValidated = false;

const pushError = (
  errors: ValidationError[],
  modelId: string,
  field: string,
  message: string,
  severity: ValidationError['severity'] = 'error',
) => {
  errors.push({ modelId, field, message, severity });
};

/**
 * 验证单个模型配置
 */
export function validateModelConfig(config: ModelConfigEntry): ValidationError[] {
  const errors: ValidationError[] = [];
  const key = config.modelId || config.modelId || 'unknown-model';
  const workspace = config.workspace;

  // 规则 1: 必需字段检查
  if (!config.label) {
    pushError(errors, key, 'label', '缺少 label');
  }
  if (!config.adapter) {
    pushError(errors, key, 'adapter', '缺少 adapter');
  }
  if (typeof (config.adapter !== null && config.adapter !== undefined ? config.adapter.generate : undefined) !== 'function') {
    pushError(errors, key, 'adapter.generate', 'adapter 缺少 generate 方法');
  }

  // 规则 3: Workspace 配置检查
  const workspaceForm = workspace !== undefined ? workspace.form : undefined;
  if (config.visible !== false && workspaceForm !== undefined) {
    if (typeof workspaceForm.load !== 'function') {
      pushError(errors, key, 'workspace.form', 'form 缺少 load 方法');
    }
  }

  // 规则 4: resultExtractor 类型检查(函数或配置对象均可)
  const workspaceResultExtractor = workspace !== undefined ? workspace.resultExtractor : undefined;
  if (workspaceResultExtractor !== undefined) {
    const extractor = workspaceResultExtractor as unknown;
    const extractorType = typeof extractor;

    if (extractorType !== 'function' && extractorType !== 'object') {
      pushError(errors, key, 'workspace.resultExtractor', 'resultExtractor 需为函数或配置对象');
    }

    if (extractor && extractorType === 'object') {
      interface ResultExtractorConfig { videoPaths: unknown | undefined; imagePaths: unknown | undefined; textPaths: unknown | undefined; excludePaths: unknown | undefined }
      const { videoPaths, imagePaths, textPaths, excludePaths } = extractor as ResultExtractorConfig;

      // 路径字段若存在应为数组
      if (videoPaths !== undefined && !Array.isArray(videoPaths)) {
        pushError(errors, key, 'workspace.resultExtractor.videoPaths', 'videoPaths 需为数组');
      }
      if (imagePaths !== undefined && !Array.isArray(imagePaths)) {
        pushError(errors, key, 'workspace.resultExtractor.imagePaths', 'imagePaths 需为数组');
      }
      if (textPaths !== undefined && !Array.isArray(textPaths)) {
        pushError(errors, key, 'workspace.resultExtractor.textPaths', 'textPaths 需为数组');
      }
      if (excludePaths !== undefined && !Array.isArray(excludePaths)) {
        pushError(errors, key, 'workspace.resultExtractor.excludePaths', 'excludePaths 需为数组');
      }
    }
  }

  // 规则 5: Canvas 端口检查（仅可见模型）
  const hasCanvasPortInputs =
    Boolean((config.canvasPortSpec !== null && config.canvasPortSpec !== undefined && config.canvasPortSpec.inputs !== null && config.canvasPortSpec.inputs !== undefined ? config.canvasPortSpec.inputs.length : undefined)) ||
    Boolean((config.nodeGraphPorts !== null && config.nodeGraphPorts !== undefined && config.nodeGraphPorts.inputs !== null && config.nodeGraphPorts.inputs !== undefined ? config.nodeGraphPorts.inputs.length : undefined));

  if (config.visible !== false && !hasCanvasPortInputs) {
    pushError(errors, key, 'canvasPortSpec', '缺少 canvasPortSpec.inputs 或 nodeGraphPorts.inputs', 'warning');
  }

  // 规则 9: routeSegment 格式
  if (config.routeSegment && typeof config.routeSegment !== 'string') {
    pushError(errors, key, 'routeSegment', 'routeSegment 需为字符串');
  }

  // 规则 11: taskList position 校验
  const taskList = workspace !== undefined ? workspace.taskList : undefined;
  const taskListPosition = taskList !== undefined ? taskList.position : undefined;
  if (taskListPosition !== undefined) {
    if (!['bottom', 'right'].includes(taskListPosition)) {
      pushError(errors, key, 'workspace.taskList.position', 'taskList.position 仅支持 bottom/right');
    }
  }

  // 规则 12: dock mediaSlots 类型检查
  const dock = workspace !== undefined ? workspace.dock : undefined;
  const mediaSlots = dock !== undefined ? dock.mediaSlots : undefined;
  if (mediaSlots !== undefined) {
    const slots = mediaSlots as unknown;
    if (!Array.isArray(slots)) {
      pushError(errors, key, 'workspace.dock.mediaSlots', 'mediaSlots 需为数组');
    }
  }

  return errors;
}

/**
 * 验证所有模型配置
 */
export function validateAllModels(): ValidationError[] {
  const allErrors: ValidationError[] = [];
  const { manual, auto, runtime } = listModelConfigsWithSource();

  // 规则 12: modelId 不得重复（手动+自动源）
  const seenKeys = new Set<string>();
  manual.concat(auto).concat(runtime).forEach((cfg) => {
    const key = cfg.modelId || cfg.modelId || 'unknown-model';
    if (seenKeys.has(key)) {
      // 自动发现会覆盖手动配置，此处提示为警告，避免阻断启动
      pushError(allErrors, key, 'modelId', '检测到重复的 modelId，自动发现将覆盖手动配置', 'warning');
    } else {
      seenKeys.add(key);
    }
  });

  // 对去重后的配置逐个验证
  const configs = listModelConfigs();
  for (const config of configs) {
    const errors = validateModelConfig(config);
    allErrors.push(...errors);
  }

  return allErrors;
}

/**
 * 启动时运行验证
 * - 开发环境:抛出错误
 * - 生产环境:记录警告
 */
export function runStartupValidation(): void {
  if (startupValidated) return;

  const errors = validateAllModels();

  if (errors.length === 0) {
    startupValidated = true;
    return;
  }

  const criticalErrors = errors.filter((e) => e.severity === 'error');

  if (criticalErrors.length > 0) {
    if (process.env['NODE_ENV'] === 'development') {
      throw new Error(
        `模型配置验证失败: ${criticalErrors.map((e) => `${e.modelId}:${e.field}`).join(', ')}`
      );
    }
  }

  // 仅在未抛出异常的情况下标记已验证，避免重复日志与开销
  startupValidated = true;
}

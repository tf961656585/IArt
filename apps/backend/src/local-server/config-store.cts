import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_BACKEND_CONFIG,
  SUPPORTED_LOG_LEVELS,
} from './constants.cts';
import {
  PROXY_MODES,
  PUBLIC_RELAY_TARGET_TYPES,
  type PublicRelayTargetType,
  type ProxyMode,
} from '@iart/contracts';
import {
  parseEnvNumber,
  normalizePort,
  normalizePositiveInt,
} from './utils.cts';

type BackendConfig = typeof DEFAULT_BACKEND_CONFIG;

type RawBackendConfig = {
  version: unknown | undefined;
  preferredPort: unknown | undefined;
  logLevel: unknown | undefined;
  maxUploadSize: unknown | undefined;
  maxMediaSize: unknown | undefined;
  maxBatchTasks: unknown | undefined;
  expandInlineParamsOnStartup: unknown | undefined;
  agentDefaultModelId: unknown | undefined;
  generationDefaultModelId: unknown | undefined;
  allowedRemoteHosts: unknown | undefined;
  publicRelayTargets: unknown | undefined;
  proxyMode: unknown | undefined;
  proxyUrl: unknown | undefined;
};

type BackendConfigInput = Partial<RawBackendConfig>;
type BackendConfigUpdate = Partial<RawBackendConfig>;

const isRawBackendConfig = (value: unknown): value is RawBackendConfig =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 可选模型标识：空串 / null / 非字符串都归一成 null（= 没设默认）。
 *
 * 只做形状归一，**不校验该 model_id 是否存在**：模型可能在设置之后被移除、或接入被换掉，
 * 那时配置里仍留着它，由消费端（创作面）按「目录里找不到就当成没设默认」处理——
 * 在这里校验会让一次模型删除变成对配置的隐式改写，配置与模型两份事实互相纠缠。
 */
const normalizeOptionalModelId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const normalizeLogLevel = (value: unknown) => {
  if (typeof value !== 'string') return DEFAULT_BACKEND_CONFIG.logLevel;
  const trimmed = value.trim().toLowerCase();
  return SUPPORTED_LOG_LEVELS.has(trimmed) ? trimmed : DEFAULT_BACKEND_CONFIG.logLevel;
};

const normalizeHostEntry = (value: unknown) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed === '*') return '*';
  if (trimmed.startsWith('*.') || trimmed.startsWith('.')) {
    return trimmed;
  }
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return new URL(trimmed).hostname.toLowerCase();
    }
    if (trimmed.includes('/') || trimmed.includes(':')) {
      return new URL(`http://${trimmed}`).hostname.toLowerCase();
    }
  } catch {
    // ignore
  }
  return trimmed;
};

const normalizeAllowedHosts = (value: unknown) => {
  if (!Array.isArray(value)) return [...DEFAULT_BACKEND_CONFIG.allowedRemoteHosts];
  const cleaned = value.map(normalizeHostEntry).filter(Boolean);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_BACKEND_CONFIG.allowedRemoteHosts];
};

const normalizeBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value;
  return fallback;
};

const normalizeProxyMode = (value: unknown): ProxyMode => {
  if (typeof value !== 'string') return DEFAULT_BACKEND_CONFIG.proxyMode;
  const trimmed = value.trim().toLowerCase();
  return (PROXY_MODES as readonly string[]).includes(trimmed)
    ? trimmed as ProxyMode
    : DEFAULT_BACKEND_CONFIG.proxyMode;
};

/** 合法代理 URL：必须 http/https 协议 + 合法 host；归一化为 URL 标准串。非法返回空串。 */
const normalizeProxyUrl = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    return url.toString();
  } catch {
    return '';
  }
};

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

type BackendPublicRelayTargets = {
  [K in PublicRelayTargetType]: {
    endpoint: string;
  };
};
type RawPublicRelayTargets = { [K in PublicRelayTargetType]?: unknown };
type RawPublicRelayTargetConfig = {
  endpoint: unknown | undefined;
};

const isObjectValue = (value: unknown): value is object =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readRawPublicRelayTargets = (value: unknown): RawPublicRelayTargets | null =>
  isObjectValue(value) ? value as RawPublicRelayTargets : null;

const readRawPublicRelayTargetConfig = (value: unknown): RawPublicRelayTargetConfig | null =>
  isObjectValue(value) ? value as RawPublicRelayTargetConfig : null;

const normalizePublicRelayTargets = (value: unknown): BackendPublicRelayTargets => {
  // 端点不再内置默认（2026-10-12 拍板：用户自带）：空串 = 未配置，合法且必须可持久化。
  // 归一化只负责把未知形状收敛为「两个已知类型各带一个 endpoint 字符串」；
  // 非法 URL 的拒绝在写入门（validatePublicRelayTargetsUpdate），读取端另有
  // TARGET_ENDPOINT_INVALID 兜底（public-relay-capability.cts）。
  const normalized: BackendPublicRelayTargets = {
    cloudflare_image_public_url: { endpoint: '' },
    self_hosted_image_public_url: { endpoint: '' },
  };
  const rawTargets = readRawPublicRelayTargets(value);
  if (!rawTargets) return normalized;

  for (const targetType of PUBLIC_RELAY_TARGET_TYPES) {
    const rawConfig = readRawPublicRelayTargetConfig(rawTargets[targetType]);
    if (rawConfig === null || rawConfig === undefined) continue;
    const endpoint = normalizeString(rawConfig.endpoint);
    normalized[targetType] = { endpoint };
  }
  return normalized;
};

const normalizePathFromEnv = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const resolveEnvStorageRoot = () =>
  normalizePathFromEnv(process.env['IART_STORAGE_ROOT']) ||
  normalizePathFromEnv(process.env['IART_DATA_ROOT']) ||
  normalizePathFromEnv(process.env['IARTS_DATA_ROOT']);

const resolveInjectedDataRoot = () => {
  const injected = (globalThis as typeof globalThis & { __IARTS_DATA_ROOT: unknown | undefined })
    .__IARTS_DATA_ROOT;
  return typeof injected === 'string' && injected.trim() ? injected.trim() : null;
};

const resolveUserStorageRoot = () => {
  const platform = process.platform;
  const homeDir = typeof os.homedir === 'function' ? os.homedir() : '';
  if (platform === 'win32') {
    const base =
      process.env['LOCALAPPDATA'] ||
      process.env['APPDATA'] ||
      (homeDir ? path.join(homeDir, 'AppData', 'Local') : null);
    if (base) {
      return path.join(base, 'IARTStudio', 'IARTStudio_PC');
    }
  } else if (platform === 'darwin') {
    const base = homeDir ? path.join(homeDir, 'Library', 'Application Support') : null;
    if (base) {
      return path.join(base, 'IARTStudio', 'IARTStudio_PC');
    }
  } else {
    const base =
      process.env['XDG_DATA_HOME'] ||
      (homeDir ? path.join(homeDir, '.local', 'share') : null);
    if (base) {
      return path.join(base, 'IARTStudio', 'IARTStudio_PC');
    }
  }

  // 兜底：至少不要落到系统目录（例如 Program Files / Node 安装目录）
  return path.join(path.resolve(__dirname, '..', '..'), '.iarts-data');
};

const canWriteDir = (dirPath: string | null) => {
  if (!dirPath) return false;
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveFixedDataRoot = () => {
  const fromEnv = resolveEnvStorageRoot();
  if (fromEnv) return fromEnv;

  const injected = resolveInjectedDataRoot();
  if (injected) return injected;

  const isElectronRuntime = Boolean(process.versions['electron']);
  if (isElectronRuntime) {
    const installDir = path.dirname(process.execPath);
    const legacyRoot = path.join(installDir, 'IARTStudio_PC');

    // 兼容旧版本/便携模式：若安装目录下的数据目录已存在且可写，则继续复用。
    // 关键：当用户选择“为所有用户安装”时，安装目录通常在 Program Files，普通用户无写权限。
    try {
      if (fs.existsSync(legacyRoot) && canWriteDir(legacyRoot)) {
        return legacyRoot;
      }
    } catch {
      // ignore
    }

    return resolveUserStorageRoot();
  }

  // 开发/脚本/测试：回落到仓库根目录（避免写入系统 Node 安装目录）
  return path.join(path.resolve(__dirname, '..', '..'), '.iarts-data');
};

const getDefaultStorageRoot = () => resolveFixedDataRoot();

const getConfigFilePath = () =>
  path.join(getDefaultStorageRoot(), 'config', 'backend.json');

const ensureDir = (dirPath: string | null) => {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
};

const normalizeBackendConfig = (raw: unknown = {}): BackendConfig => {
  const config: BackendConfig = { ...DEFAULT_BACKEND_CONFIG };
  if (isRawBackendConfig(raw)) {
    if ('preferredPort' in raw) {
      config.preferredPort = normalizePort(raw.preferredPort);
    }
    if ('logLevel' in raw) {
      config.logLevel = normalizeLogLevel(raw.logLevel);
    }
    if ('maxUploadSize' in raw) {
      config.maxUploadSize = normalizePositiveInt(raw.maxUploadSize, config.maxUploadSize);
    }
    if ('maxMediaSize' in raw) {
      config.maxMediaSize = normalizePositiveInt(raw.maxMediaSize, config.maxMediaSize);
    }
    if ('maxBatchTasks' in raw) {
      config.maxBatchTasks = normalizePositiveInt(raw.maxBatchTasks, config.maxBatchTasks);
    }
    if ('expandInlineParamsOnStartup' in raw) {
      config.expandInlineParamsOnStartup = normalizeBoolean(
        raw.expandInlineParamsOnStartup,
        config.expandInlineParamsOnStartup,
      );
    }
    if ('agentDefaultModelId' in raw) {
      config.agentDefaultModelId = normalizeOptionalModelId(raw.agentDefaultModelId);
    }
    if ('generationDefaultModelId' in raw) {
      config.generationDefaultModelId = normalizeOptionalModelId(raw.generationDefaultModelId);
    }
    if ('allowedRemoteHosts' in raw) {
      config.allowedRemoteHosts = normalizeAllowedHosts(raw.allowedRemoteHosts);
    }
    if ('publicRelayTargets' in raw) {
      config.publicRelayTargets = normalizePublicRelayTargets(raw.publicRelayTargets);
    }
    if ('proxyMode' in raw) {
      config.proxyMode = normalizeProxyMode(raw.proxyMode);
    }
    if ('proxyUrl' in raw) {
      config.proxyUrl = normalizeProxyUrl(raw.proxyUrl);
    }
    // 一致性合并：manual 模式必须带合法代理地址，否则回落 system（缺 URL 的持久化不应生效为 manual）。
    if (config.proxyMode === 'manual' && !config.proxyUrl) {
      config.proxyMode = 'system';
    }
    // 非 manual 模式不保留 proxyUrl（避免语义歧义）。
    if (config.proxyMode !== 'manual') {
      config.proxyUrl = '';
    }
  }
  config.version = DEFAULT_BACKEND_CONFIG.version;
  return config;
};

const loadBackendConfig = () => {
  const filePath = getConfigFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return normalizeBackendConfig(parsed);
    }
  } catch {
    // ignore
  }
  return normalizeBackendConfig();
};

let backendConfig = loadBackendConfig();

const getBackendConfig = () => backendConfig;

/**
 * 仅供测试：把模块级配置状态重置为「从当前环境存储根重新加载」的结果。
 * 与 setBackendIpcTestHandler 同类（测试需要控制模块级单例的起点——fresh-install 语义：
 * 存储根无 backend.json → 全默认）。生产代码不调用。
 */
const resetBackendConfigForTest = () => {
  backendConfig = loadBackendConfig();
};

const saveBackendConfig = (next: BackendConfig) => {
  const filePath = getConfigFilePath();
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
};

const updateBackendConfig = (partial: BackendConfigInput) => {
  backendConfig = normalizeBackendConfig({ ...backendConfig, ...partial });
  saveBackendConfig(backendConfig);
  return backendConfig;
};

const pickBackendConfigUpdate = (raw: unknown): BackendConfigUpdate => {  if (!isRawBackendConfig(raw)) return {};
  const update: BackendConfigUpdate = {};
  if ('preferredPort' in raw) update.preferredPort = raw.preferredPort;
  if ('logLevel' in raw) update.logLevel = raw.logLevel;
  if ('maxUploadSize' in raw) update.maxUploadSize = raw.maxUploadSize;
  if ('maxMediaSize' in raw) update.maxMediaSize = raw.maxMediaSize;
  if ('maxBatchTasks' in raw) update.maxBatchTasks = raw.maxBatchTasks;
  if ('expandInlineParamsOnStartup' in raw) update.expandInlineParamsOnStartup = raw.expandInlineParamsOnStartup;
  if ('agentDefaultModelId' in raw) update.agentDefaultModelId = raw.agentDefaultModelId;
  if ('generationDefaultModelId' in raw) update.generationDefaultModelId = raw.generationDefaultModelId;
  if ('allowedRemoteHosts' in raw) update.allowedRemoteHosts = raw.allowedRemoteHosts;
  if ('publicRelayTargets' in raw) update.publicRelayTargets = raw.publicRelayTargets;
  if ('proxyMode' in raw) update.proxyMode = raw.proxyMode;
  if ('proxyUrl' in raw) update.proxyUrl = raw.proxyUrl;
  return update;
};

const getEffectiveLogLevel = () => {
  const fromEnv = process.env['IART_LOG_LEVEL'];
  if (fromEnv && fromEnv.trim()) {
    return normalizeLogLevel(fromEnv);
  }
  return normalizeLogLevel((backendConfig !== null && backendConfig !== undefined ? backendConfig.logLevel : undefined));
};

const getEffectiveMaxUploadSize = () => {
  const fromEnv = parseEnvNumber(process.env['IART_MAX_UPLOAD']);
  return fromEnv ?? backendConfig.maxUploadSize ?? DEFAULT_BACKEND_CONFIG.maxUploadSize;
};

const getEffectiveMaxMediaSize = () => {
  const fromEnv = parseEnvNumber(process.env['IART_MAX_MEDIA']);
  return fromEnv ?? backendConfig.maxMediaSize ?? DEFAULT_BACKEND_CONFIG.maxMediaSize;
};

const getEffectiveMaxBatchTasks = () => {
  const fromEnv = parseEnvNumber(process.env['IART_MAX_BATCH_TASKS']);
  return fromEnv ?? backendConfig.maxBatchTasks ?? DEFAULT_BACKEND_CONFIG.maxBatchTasks;
};

const getEffectiveExpandInlineParamsOnStartup = () => {
  return normalizeBoolean(
    (backendConfig !== null && backendConfig !== undefined ? backendConfig.expandInlineParamsOnStartup : undefined),
    DEFAULT_BACKEND_CONFIG.expandInlineParamsOnStartup
  );
};

const getEffectiveStorageRoot = () => {
  return getDefaultStorageRoot();
};

const getAllowedRemoteHosts = () => {
  const hosts = normalizeAllowedHosts(backendConfig.allowedRemoteHosts);
  return new Set(hosts);
};

/**
 * 校验 PUT /api/config 的代理相关更新（在合并到当前配置前）：
 * - 显式 manual 但无合法 proxyUrl → 拒绝（归一化阶段的"manual+空 URL 回落 system"
 *   是持久化兜底，不是对错误输入的静默接受）；
 * - 显式提供非空 proxyUrl 但归一化后为空（非法 URL）→ 拒绝，
 *   避免把已有 manual 配置静默降级为 system。
 * 返回 null 表示合法；返回字符串为用户可读错误。
 */
const validateProxyConfigUpdate = (
  update: BackendConfigUpdate,
  current: BackendConfig,
): string | null => {
  const hasProxyFields = 'proxyMode' in update || 'proxyUrl' in update;
  if (!hasProxyFields) return null;
  const merged = normalizeBackendConfig({ ...current, ...update });
  const requestedManual =
    typeof update.proxyMode === 'string' && update.proxyMode.trim().toLowerCase() === 'manual';
  if (requestedManual && merged.proxyMode !== 'manual') {
    return 'manual proxy requires a valid proxy URL (http:// or https://)';
  }
  if (
    'proxyUrl' in update
    && typeof update.proxyUrl === 'string'
    && update.proxyUrl.trim() !== ''
    && !merged.proxyUrl
  ) {
    return 'proxy URL must be a valid http:// or https:// address';
  }
  return null;
};

/**
 * 校验 PUT /api/config 的公共中转端点更新（在合并到当前配置前）：
 * - 提供该键即整体替换两个中转类型的端点配置（与 Hub 设置页整块保存语义一致）；
 * - endpoint 必须是字符串；空串 = 清除该类型配置（用户自带语义下合法）；
 * - 非空必须是合法 http/https URL——与读取端 resolvePublicRelayEndpoint 的
 *   TARGET_ENDPOINT_INVALID 判定同语义，写入门提前拒绝，避免非法值静默入库、
 *   到任务执行时才炸。
 * 返回 null 表示合法；返回字符串为用户可读错误。
 */
const validatePublicRelayTargetsUpdate = (update: BackendConfigUpdate): string | null => {
  if (!('publicRelayTargets' in update)) return null;
  const rawTargets = readRawPublicRelayTargets(update.publicRelayTargets);
  if (rawTargets === null) {
    return 'publicRelayTargets must be an object keyed by relay target type';
  }
  for (const targetType of PUBLIC_RELAY_TARGET_TYPES) {
    const rawConfig = readRawPublicRelayTargetConfig(rawTargets[targetType]);
    if (rawConfig === null) {
      return `publicRelayTargets.${targetType} is required (empty endpoint clears the setting)`;
    }
    if (typeof rawConfig.endpoint !== 'string') {
      return `publicRelayTargets.${targetType}.endpoint must be a string (empty clears the setting)`;
    }
    const trimmed = rawConfig.endpoint.trim();
    if (trimmed === '') continue;
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      parsedUrl = null;
    }
    if (parsedUrl === null || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
      return `publicRelayTargets.${targetType}.endpoint must be a valid http:// or https:// URL`;
    }
  }
  return null;
};

const resolveListenPort = () => {
  const envPort = parseEnvNumber(process.env['IART_BACKEND_PORT'] || '');
  if (envPort) return envPort;
  const configPort = normalizePort((backendConfig !== null && backendConfig !== undefined ? backendConfig.preferredPort : undefined));
  return configPort || 0;
};

export {
  normalizeLogLevel,
  normalizeHostEntry,
  normalizeAllowedHosts,
  normalizeProxyMode,
  normalizeProxyUrl,
  getDefaultStorageRoot,
  getConfigFilePath,
  ensureDir,
  normalizeBackendConfig,
  loadBackendConfig,
  getBackendConfig,
  resetBackendConfigForTest,
  updateBackendConfig,
  pickBackendConfigUpdate,
  validateProxyConfigUpdate,
  validatePublicRelayTargetsUpdate,
  getEffectiveLogLevel,
  getEffectiveMaxUploadSize,
  getEffectiveMaxMediaSize,
  getEffectiveMaxBatchTasks,
  getEffectiveExpandInlineParamsOnStartup,
  getEffectiveStorageRoot,
  getAllowedRemoteHosts,
  resolveListenPort,
};

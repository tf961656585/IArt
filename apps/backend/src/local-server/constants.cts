import {
  PUBLIC_RELAY_TARGET_TYPE,
  type PublicRelayTargetType,
  type ProxyMode,
} from '@iart/contracts';

const HOST = '127.0.0.1';
const SUPPORTED_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const PROJECT_INDEX_VERSION = 1;
const PROJECT_INDEX_FILENAME = 'projects-index.json';
// Provider 连接/部署持久化文件（spec 03 + 45 v3）
const PROVIDER_CONNECTIONS_FILENAME = 'provider-connections.json';
const MODEL_DEPLOYMENTS_FILENAME = 'model-deployments.json';
const ACTIVE_ROUTES_FILENAME = 'active-routes.json';
const PROVIDER_CREDENTIALS_FILENAME = 'provider-credentials.json';
const PROMPT_PRESETS_VERSION = 1;
const PROMPT_PRESETS_FILENAME = 'prompt-presets.json';
// 思考档位全局预设池（spec 37「思考档位」）：自定义档位条目的本机持久化文件
const THINKING_TIER_PRESETS_VERSION = 1;
const THINKING_TIER_PRESETS_FILENAME = 'thinking-tier-presets.json';
// 用户自建对话模型声明（spec 37「对话模型的唯一来源」）：模型声明的本机持久化文件
const CUSTOM_CHAT_MODELS_VERSION = 1;
const CUSTOM_CHAT_MODELS_FILENAME = 'custom-chat-models.json';
// 用户自建生成模型声明（生成模型自建声明试点 §3.2）：模型声明的本机持久化文件
const CUSTOM_GENERATION_MODELS_VERSION = 1;
const CUSTOM_GENERATION_MODELS_FILENAME = 'custom-generation-models.json';
// 首次指引展示态记忆（docs/hub/首次指引-design.md §4.1）：已看标记独立小文件
// （先例 announcement.json；不走 backend.json，引导记忆不是本机配置）
const ONBOARDING_STATE_FILENAME = 'onboarding-state.json';
const TASK_RESULT_INLINE_LIMIT = 256 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 10000;
const DEFAULT_POLL_MAX_ATTEMPTS = 300;
// 轮询请求/失败消息允许的最大连续失败次数（达到后才视为任务失败）
const DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES = 3;
const LOG_LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const ERROR_CODES = {
  ORIGIN_NOT_ALLOWED: 'origin_not_allowed',
  INVALID_JSON: 'invalid_json',
  INVALID_CONFIG: 'invalid_config',
  INVALID_URL: 'invalid_url',
  INVALID_PATH: 'invalid_path',
  REMOTE_HOST_NOT_ALLOWED: 'remote_host_not_allowed',
  UPSTREAM_FAILED: 'upstream_failed',
  FILE_NOT_FOUND: 'file_not_found',
  MISSING_FILE: 'missing_file',
  UPLOAD_FAILED: 'upload_failed',
  FILE_TOO_LARGE: 'file_too_large',
  INVALID_PROJECT: 'invalid_project',
  CREATE_FAILED: 'create_failed',
  INTERNAL_ERROR: 'internal_error',
  PROJECT_NOT_FOUND: 'project_not_found',
  PROJECT_ALREADY_OPEN: 'project_already_open',
  PROJECT_SESSION_INVALID: 'project_session_invalid',
  PROJECT_SESSION_PREPARE_FAILED: 'project_session_prepare_failed',
  PROJECT_DATA_EMPTY: 'project_data_empty',
  INVALID_TASK: 'invalid_task',
  TASK_NOT_FOUND: 'task_not_found',
  TASK_NOT_READY: 'task_not_ready',
  TASK_CANCELED: 'task_canceled',
  TASK_EXECUTION_FAILED: 'task_execution_failed',
  TASK_INCOMPLETE_RESPONSE: 'task_incomplete_response',
  ASYNC_POLLING_REMOTE_REQUEST_ID_MISSING: 'async_polling_remote_request_id_missing',
  ASYNC_POLLING_REQUEST_INVALID: 'async_polling_request_invalid',
  TASK_POLLING_PAUSED: 'task_polling_paused',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  NOT_FOUND: 'not_found',
};

type PublicRelayTargetDefaults = {
  readonly [K in PublicRelayTargetType]: Readonly<{
    endpoint: string;
  }>;
};

/**
 * 公共中转端点不再内置默认值（2026-10-12 拍板：用户自带）：
 * 这里只承载「支持哪些中转类型」的结构事实，endpoint 一律空串 = 未配置。
 * 用户经 Hub 设置（PUT /api/config）、backend.json 或 IART_PUBLIC_UPLOAD_*_ENDPOINT
 * 环境变量自带端点；未配置时消费端得到 TARGET_ENDPOINT_MISSING，不回落任何内置地址。
 */
const DEFAULT_PUBLIC_RELAY_TARGETS: PublicRelayTargetDefaults = Object.freeze({
  [PUBLIC_RELAY_TARGET_TYPE.CLOUDFLARE_IMAGE_PUBLIC_URL]: Object.freeze({
    endpoint: '',
  }),
  [PUBLIC_RELAY_TARGET_TYPE.SELF_HOSTED_IMAGE_PUBLIC_URL]: Object.freeze({
    endpoint: '',
  }),
});

const DEFAULT_BACKEND_CONFIG = {
  version: 1,
  preferredPort: 0,
  logLevel: 'info',
  maxUploadSize: 10 * 1024 * 1024 * 1024,
  maxMediaSize: 100 * 1024 * 1024,
  // 画板生成节点“批量执行”的最大任务数（单次点击上限）
  maxBatchTasks: 30,
  // 画板模型节点参数区：启动时是否默认展开（false=默认收起）
  expandInlineParamsOnStartup: false,
  /**
   * Agent 形态的默认模型（null = 没设默认）：主窗口在服务商详情里设置，
   * 创作面进入 agent 形态且尚未选模型时用它预选（spec docs/agent/06）。
   */
  agentDefaultModelId: null as string | null,
  /**
   * PromptDock 生成形态的默认模型（null = 没设默认）：主窗口在服务商详情里设置，
   * 画布里的生成形态还没选过模型时用它做初始预选（spec docs/hub/hub-information-architecture.md §7.4）。
   * 只影响「还没选过」时的预选，不改变模型接入关系，也不改变创作面判定「当前使用」的模型。
   */
  generationDefaultModelId: null as string | null,
  allowedRemoteHosts: ['*.aliyuncs.com'],
  // Runtime Backend public relay 平台能力；endpoint owner 不在模型包或 Editor。
  publicRelayTargets: DEFAULT_PUBLIC_RELAY_TARGETS,
  /** 出站网络代理模式：system=跟随系统代理 / direct=不使用代理 / manual=手动代理（Hub「设置 → 网络代理」）。 */
  proxyMode: 'system' as ProxyMode,
  /** manual 模式的代理地址（http/https，可含 user:pass 认证）；其余模式为空串。 */
  proxyUrl: '',
};

const API_KEY_PREFIX = 'sk-';

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^localhost$/i,
  /^::1$/i,
  /^fe80:/i,
  /^fc00:/i,
  /^fd/i,
];

const DEFAULT_ANNOUNCEMENT = {
  enabled: false,
  title: '',
  message: '',
  severity: 'info',
  updatedAt: new Date(0).toISOString(),
  updatedBy: '',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
};

const BUNDLE_FORMAT_VERSION = 4;
const BUNDLE_PATHS = {
  MANIFEST: 'manifest.json',
  PROJECT: 'project.json',
  INDEX: 'index.json',
  NODE_TYPE_USAGE: 'node-type-usage.json',
  SQLITE: 'project.sqlite',
  MEDIA_DIR: 'media',
};

// 项目文件夹结构（自包含项目）
const PROJECT_FOLDER_EXT = '.iartproj';     
const PROJECT_FOLDER_PATHS = {
  MANIFEST: 'manifest.json',
  NODE_GRAPH: 'nodeGraph.json',
  SQLITE: 'project.sqlite',
  INDEX: 'index.json',
  MODEL_NODE_USAGE: 'model-node-usage.json',
  NODE_TYPE_USAGE: 'node-type-usage.json',
  NODE_PALETTE_PINS: 'node-palette-pins.json',
  CHARACTER_PINS: 'character-pins.json',
  MEDIA_DIR: 'media',
  TASK_ARCHIVES_DIR: 'task-archives',
  REQUEST_LOGS_DIR: 'request-logs',
  LOCK_FILE: '.iart-lock',
};
const RECENT_PROJECTS_FILENAME = 'recent-projects.json';
const RECENT_PROJECTS_VERSION = 1;
const BUNDLE_MEDIA_FIELDS = {
  imageInput: 'imageUrl',
  videoInput: 'videoUrl',
  audioInput: 'audioUrl',
};
const BUNDLE_MIME_EXTENSION_MAP = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
};

const DEFAULT_STATUS_PATHS = [
  'status',
  'state',
  'task_status',
  'taskStatus',
  'detail.status',
  'detail.state',
];
const DEFAULT_FAILURE_STATUSES = [
  'failed',
  'failure',
  'error',
  'cancelled',
  'canceled',
  'timeout',
  'expired',
  'rejected',
];
const DEFAULT_FAILURE_MESSAGE_PATHS = [
  'detail.failure_reason',
  'detail.pending_info.failure_reason',
  'failure_reason',
  'detail.error',
  'detail.error_message',
  'error.message',
  'error',
  'message',
];

export {
  HOST,
  SUPPORTED_LOG_LEVELS,
  PROJECT_INDEX_VERSION,
  PROJECT_INDEX_FILENAME,
  PROVIDER_CONNECTIONS_FILENAME,
  MODEL_DEPLOYMENTS_FILENAME,
  ACTIVE_ROUTES_FILENAME,
  PROVIDER_CREDENTIALS_FILENAME,
  PROMPT_PRESETS_VERSION,
  PROMPT_PRESETS_FILENAME,
  THINKING_TIER_PRESETS_VERSION,
  THINKING_TIER_PRESETS_FILENAME,
  CUSTOM_CHAT_MODELS_VERSION,
  CUSTOM_CHAT_MODELS_FILENAME,
  CUSTOM_GENERATION_MODELS_VERSION,
  CUSTOM_GENERATION_MODELS_FILENAME,
  ONBOARDING_STATE_FILENAME,
  TASK_RESULT_INLINE_LIMIT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES,
  LOG_LEVEL_ORDER,
  ERROR_CODES,
  DEFAULT_PUBLIC_RELAY_TARGETS,
  DEFAULT_BACKEND_CONFIG,
  API_KEY_PREFIX,
  PRIVATE_IP_PATTERNS,
  DEFAULT_ANNOUNCEMENT,
  MIME_TYPES,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_PATHS,
  BUNDLE_MEDIA_FIELDS,
  BUNDLE_MIME_EXTENSION_MAP,
  DEFAULT_STATUS_PATHS,
  DEFAULT_FAILURE_STATUSES,
  DEFAULT_FAILURE_MESSAGE_PATHS,
  // 新项目文件夹结构
  PROJECT_FOLDER_EXT,
  PROJECT_FOLDER_PATHS,
  RECENT_PROJECTS_FILENAME,
  RECENT_PROJECTS_VERSION,
};

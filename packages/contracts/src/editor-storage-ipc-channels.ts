export const EDITOR_STORAGE_IPC_CHANNELS = {
  // A 组：项目 CRUD
  LIST_PROJECTS: 'storage:list-projects',
  CREATE_PROJECT: 'storage:create-project',
  OPEN_PROJECT: 'storage:open-project',
  GET_PROJECT: 'storage:get-project',
  DELETE_PROJECT: 'storage:delete-project',
  GET_META_INDEX: 'storage:get-meta-index',
  IMPORT_FOLDER: 'storage:import-folder',

  // B 组：Delta/Save
  SAVE_DELTA: 'storage:save-delta',
  FLUSH: 'storage:flush',
  DISCARD_PENDING: 'storage:discard-pending',
  GET_PENDING_SNAPSHOT: 'storage:get-pending-snapshot',
  PERSIST_DELTA: 'storage:persist-delta',

  // C 组：媒体资产
  UPSERT_MEDIA_ASSET: 'storage:upsert-media-asset',
  IMPORT_BUNDLE_ASSETS: 'storage:import-bundle-assets',

  // D 组：使用统计
  GET_NODE_TYPE_USAGE: 'storage:get-node-type-usage',
  TRACK_NODE_TYPE_USAGE: 'storage:track-node-type-usage',

  // E 组：偏好/Pins
  GET_CHARACTER_PINS: 'storage:get-character-pins',
  SAVE_CHARACTER_PINS: 'storage:save-character-pins',

  // F 组：Bundle 导入导出
  EXPORT_BUNDLE: 'storage:export-bundle',
  IMPORT_BUNDLE: 'storage:import-bundle',
  READ_FILE_BYTES: 'storage:read-file-bytes',
  WRITE_TEMP_FILE: 'storage:write-temp-file',

  // G 组：节点输出
  CLEAR_NODE_OUTPUT: 'storage:clear-node-output',
  REMOVE_OUTPUT_ITEM: 'storage:remove-output-item',

  // H 组：运行域读取
  READ_TASK_BY_ID: 'storage:read-task-by-id',
  READ_TASK_OUTPUTS: 'storage:read-task-outputs',
  READ_MEDIA_ASSETS_BY_TASK: 'storage:read-media-assets-by-task',
  READ_ALL_TASKS: 'storage:read-all-tasks',
  READ_ALL_MEDIA_ASSETS: 'storage:read-all-media-assets',
  READ_MEDIA_ASSET_BY_ID: 'storage:read-media-asset-by-id',

  // I 组：缓存统计
  GET_CACHE_STATISTICS: 'storage:get-cache-statistics',

  // J 组：提示词预设
  LIST_PROMPT_PRESETS: 'storage:list-prompt-presets',
  GET_PROMPT_PRESET: 'storage:get-prompt-preset',
  CREATE_PROMPT_PRESET: 'storage:create-prompt-preset',
  UPDATE_PROMPT_PRESET: 'storage:update-prompt-preset',
  DELETE_PROMPT_PRESET: 'storage:delete-prompt-preset',

  // K 组：本地媒体导入
  IMPORT_LOCAL_MEDIA: 'storage:import-local-media',

  // L 组：窗口关闭协议
  PREPARE_CLOSE: 'editor:prepare-close',
  CLOSE_READY: 'editor:close-ready',
  CLOSE_ERROR: 'editor:close-error',

  // N 组：系统提示词库
  LIST_SYSTEM_PROMPTS: 'storage:list-system-prompts',
  GET_SYSTEM_PROMPT: 'storage:get-system-prompt',
  CREATE_SYSTEM_PROMPT: 'storage:create-system-prompt',
  UPDATE_SYSTEM_PROMPT: 'storage:update-system-prompt',
  DELETE_SYSTEM_PROMPT: 'storage:delete-system-prompt',

  // O 组：打包区（画布级素材归集工作区）
  READ_PACKAGE_AREA_BY_GRAPH_ID: 'storage:read-package-area-by-graph-id',
  APPLY_PACKAGE_AREA_MUTATION: 'storage:apply-package-area-mutation',

  // P 组：agent 会话
  READ_AGENT_SESSIONS: 'storage:read-agent-sessions',
  READ_AGENT_SESSION_BY_NODE_ID: 'storage:read-agent-session-by-node-id',
  UPSERT_AGENT_SESSION: 'storage:upsert-agent-session',
  READ_AGENT_MESSAGES: 'storage:read-agent-messages',
  APPEND_AGENT_MESSAGE: 'storage:append-agent-message',
  APPEND_AGENT_SEND_RECORD: 'storage:append-agent-send-record',
  READ_AGENT_SEND_RECORDS: 'storage:read-agent-send-records',
  READ_AGENT_TOOL_CALLS: 'storage:read-agent-tool-calls',
  APPEND_AGENT_TOOL_CALL: 'storage:append-agent-tool-call',
  UPDATE_AGENT_TOOL_CALL: 'storage:update-agent-tool-call',
} as const;

export type EditorStorageIpcChannel =
  (typeof EDITOR_STORAGE_IPC_CHANNELS)[keyof typeof EDITOR_STORAGE_IPC_CHANNELS];

import type {
  HubConfigResponse,
  HubConfigUpdatePayload,
  StorageListProjectsResult,
  StorageCreateProjectParams,
  StorageCreateProjectResult,
  StorageOpenProjectParams,
  StorageOpenProjectResult,
  StorageDeleteProjectParams,
  StorageDeleteProjectResult,
  StorageImportFolderParams,
  StorageImportFolderResult,
  PackagesListParams,
  PackagesCreateParams,
  PackagesRenameParams,
  PackagesDeleteParams,
  PackagesRevealParams,
  PackagesListResult,
  PackagesCreateResult,
  PackagesRenameResult,
  PackagesDeleteResult,
  PackagesRevealResult,
  StorageImportBundleParams,
  StorageImportBundleResult,
  StorageExportBundleParams,
  StorageExportBundleResult,
  HubTaskListResponse,
  HubTaskSummaryItem,
  AppUpdateCommandResult,
  AppUpdateEvent,
  AppUpdateLogInfoResult,
  AppUpdateRevealLogResult,
  AppUpdateState,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInstalledState,
  SkillRevealInstallFolderRequest,
  SkillRevealInstallFolderResult,
  SkillListCustomTargetsResult,
  SkillCustomTargetMutationResult,
  SkillRemoveCustomTargetResult,
  RevealBackendLogFolderResult,
  RevealProjectFolderResult,
  CliStatusDto,
  CliEntryOperationResult,
  ProviderConnectionListResponse,
  ProviderConnectionResponse,
  ProviderConnectionCredentialResponse,
  ActiveRouteMapResponse,
  ActiveRouteResponse,
  ExecutableModelCatalogResponse,
  ChatModelCatalogResponse,
  ThinkingTierPoolResponse,
  ThinkingTierRemovalResponse,
  CustomChatModelListResponse,
  CustomChatModelResponse,
  CustomChatModelRemovalResponse,
  CustomChatModelCreateBody,
  CustomChatModelUpdateBody,
  CustomGenerationModelCreateBody,
  CustomGenerationModelUpdateBody,
  CustomGenerationModelResponse,
  CustomGenerationModelListResponse,
  CustomGenerationModelRemovalResponse,
  FamilyTemplateParameterDescriptor,
  OnboardingStateResponse,
} from '@iart/contracts';
import type {
  OpenEditorWindowRequest,
  OpenEditorWindowResult,
  SelectFolderOptions,
  SelectFolderResult,
} from '@iart/backend-sdk';
import type { ZodType, ZodTypeDef } from 'zod';

export interface HubPlatformBridge {
  isElectron(): boolean;
  openEditorWindow(
    target: OpenEditorWindowRequest,
  ): Promise<OpenEditorWindowResult>;
  openExternal(target: string): Promise<boolean>;
  selectFolder(options: SelectFolderOptions | undefined): Promise<SelectFolderResult>;
  selectProjectFolder(options: SelectFolderOptions | undefined): Promise<SelectFolderResult>;
  revealProjectFolder(projectPath: string): Promise<RevealProjectFolderResult>;
  isStorageReady(): boolean;
  getAppVersion(): Promise<string | null>;
  checkForUpdates(manual: boolean): Promise<AppUpdateCommandResult>;
  startUpdateDownload(): Promise<AppUpdateCommandResult>;
  installUpdate(): Promise<AppUpdateCommandResult>;
  revealDownloadedUpdate(): Promise<AppUpdateCommandResult>;
  getUpdateState(): Promise<AppUpdateState | null>;
  getUpdaterLogInfo(): Promise<AppUpdateLogInfoResult | null>;
  revealUpdaterLog(): Promise<AppUpdateRevealLogResult>;
  /** 打开 backend 业务日志目录（LFJ-008，路径解析归主进程）。 */
  revealBackendLogFolder(): Promise<RevealBackendLogFolderResult>;
  onAppUpdateEvent(callback: (event: AppUpdateEvent) => void): void;
  onUpdateChecking(callback: (snapshot: AppUpdateState) => void): void;
  onUpdateAvailable(callback: (info: AppUpdateState) => void): void;
  onUpdateNotAvailable(callback: (info: AppUpdateState) => void): void;
  onUpdateDownloadProgress(callback: (progress: AppUpdateState) => void): void;
  onUpdateDownloaded(callback: (info: AppUpdateState) => void): void;
  onUpdateError(callback: (error: AppUpdateState) => void): void;
  onTaskStateChanged(callback: (message: unknown) => void): void;
  onTaskStateSnapshot(callback: (message: unknown) => void): void;
  removeTaskStateListeners(): void;

  // ========== 首次指引（docs/hub/首次指引-design.md §4.3） ==========
  /** main → Hub 通知：Editor 请求聚焦主窗口并定位设置页子单元（sectionId 为设置页锚点 id）。 */
  onHubFocusSettings(callback: (notice: { sectionId: string }) => void): void;
  removeHubFocusSettingsListener(): void;

  // ========== Storage IPC (项目 CRUD) ==========
  storageListProjects(): Promise<StorageListProjectsResult>;
  storageCreateProject(params: StorageCreateProjectParams): Promise<StorageCreateProjectResult>;
  storageOpenProject(params: StorageOpenProjectParams): Promise<StorageOpenProjectResult>;
  storageDeleteProject(params: StorageDeleteProjectParams): Promise<StorageDeleteProjectResult>;
  storageImportFolder(params: StorageImportFolderParams): Promise<StorageImportFolderResult>;
  storageImportBundle(params: StorageImportBundleParams): Promise<StorageImportBundleResult>;
  storageExportBundle(params: StorageExportBundleParams): Promise<StorageExportBundleResult>;

  // ========== 包管理 IPC（执行打包产物：项目路径 packages/ 下的自描述包文件夹） ==========
  packagesList(params: PackagesListParams): Promise<PackagesListResult>;
  packagesCreate(params: PackagesCreateParams): Promise<PackagesCreateResult>;
  packagesRename(params: PackagesRenameParams): Promise<PackagesRenameResult>;
  packagesDelete(params: PackagesDeleteParams): Promise<PackagesDeleteResult>;
  packagesReveal(params: PackagesRevealParams): Promise<PackagesRevealResult>;

  // ========== Skill 商店 IPC ==========
  getSkillInstalledState(): Promise<SkillInstalledState>;
  installSkill(request: SkillInstallRequest): Promise<SkillInstallResult>;
  /** 定位 skill 安装目录（LFJ-007，安装目录解析归主进程）。 */
  revealSkillInstallFolder(request: SkillRevealInstallFolderRequest): Promise<SkillRevealInstallFolderResult>;
  /** 自定义安装目标注册表（Hub 弹层统一管理，目录来源为系统选择框 selectFolder）。 */
  listCustomSkillInstallTargets(): Promise<SkillListCustomTargetsResult>;
  addCustomSkillInstallTarget(name: string, dir: string): Promise<SkillCustomTargetMutationResult>;
  /** 编辑自定义目标（全量提交：名称 + 安装目录都必传；目录校验归主进程）。 */
  updateCustomSkillInstallTarget(
    id: string,
    name: string,
    skillsDir: string,
  ): Promise<SkillCustomTargetMutationResult>;
  removeCustomSkillInstallTarget(id: string): Promise<SkillRemoveCustomTargetResult>;

  // ========== CLI 设置页「命令行工具」子单元（docs/integrations/CLI与本地Agent集成.md §8） ==========
  /** CLI 通道只读状态（在役状态/发现文件有效性/入口注册状态/最近命令记录）；能力缺席（非 Electron）返回 null。 */
  getCliStatus(): Promise<CliStatusDto | null>;
  /** 命令入口一键注册（幂等，CLI-016）。 */
  registerCliEntry(): Promise<CliEntryOperationResult>;
  /** 命令入口卸除注册（幂等，CLI-016）。 */
  unregisterCliEntry(): Promise<CliEntryOperationResult>;
}

export interface HubRequestJsonOptions<TBody = unknown> {
  method: string | undefined;
  body: TBody | undefined;
  headers: Record<string, string> | undefined;
  cache: RequestCache | undefined;
  signal: AbortSignal | undefined;
}

export type HubRequestJsonOptionsWithSchema<TBody, TResponse> = HubRequestJsonOptions<TBody> & {
  responseSchema: ZodType<TResponse, ZodTypeDef, unknown>;
};

export interface HubHttpClient {
  requestJson<TResponse, TBody = unknown>(
    path: string,
    options: HubRequestJsonOptionsWithSchema<TBody, TResponse>,
  ): Promise<TResponse>;
  requestVoid<TBody = unknown>(path: string, options: HubRequestJsonOptions<TBody> | undefined): Promise<void>;
}

export interface HubStatusPresenter {
  set(element: Element | null | undefined, message: string): void;
}

export interface HubFeatureContext {
  platform: HubPlatformBridge;
  http: HubHttpClient;
  status: HubStatusPresenter;
}

export interface HubApiClient {
  loadConfig(signal: AbortSignal | undefined): Promise<HubConfigResponse>;  saveConfig(payload: HubConfigUpdatePayload): Promise<HubConfigResponse>;
  loadPromptPresets(): Promise<unknown>;
  savePromptPreset(payload: { id: string | undefined; name: string; content: string }): Promise<unknown>;
  deletePromptPreset(id: string): Promise<unknown>;
  loadTasks(params: { projectPath: string; status: HubTaskSummaryItem['status'] | undefined; limit: number | undefined; offset: number | undefined }, signal: AbortSignal | undefined): Promise<HubTaskListResponse>;
  listProviderConnections(signal: AbortSignal | undefined): Promise<ProviderConnectionListResponse>;
  /**
   * 创建服务商。接口类型不在连接上配置（2026-09-29 起摘除连接级预选）——
   * 它是模型记录的属性，添加模型时再选。
   */
  createProviderConnection(payload: {
    display_name: string;
    base_url: string;
  }): Promise<ProviderConnectionResponse>;
  updateProviderConnection(connectionId: string, payload: { display_name?: string; base_url?: string }): Promise<ProviderConnectionResponse>;
  deleteProviderConnection(connectionId: string): Promise<{ ok: true }>;
  setProviderConnectionCredential(connectionId: string, value: string): Promise<ProviderConnectionCredentialResponse>;
  removeProviderConnectionCredential(connectionId: string): Promise<ProviderConnectionCredentialResponse>;
  setProviderConnectionLifecycle(connectionId: string, lifecycle: 'enabled' | 'disabled' | 'retired'): Promise<ProviderConnectionResponse>;
  /**
   * active 接入目标清单（`model_id → 记录 id`）。
   *
   * 模型只有用户记录一种载体（spec 03 §6.1，2026-10-19）：添加模型时会话内即写入 active，
   * Hub 只读这份投影判断「当前使用」。不再有接入载体的增删方法——模型的增删走
   * `createCustomChatModel` / `createCustomGenerationModel` 与各自的删除方法。
   */
  listActiveRoutes(signal: AbortSignal | undefined): Promise<ActiveRouteMapResponse>;
  setActiveRoute(modelId: string, recordId: string | null): Promise<ActiveRouteResponse>;
  listExecutableModelCatalog(signal: AbortSignal | undefined): Promise<ExecutableModelCatalogResponse>;
  listChatModelCatalog(signal: AbortSignal | undefined): Promise<ChatModelCatalogResponse>;
  listThinkingTiers(signal: AbortSignal | undefined): Promise<ThinkingTierPoolResponse>;
  addThinkingTier(name: string): Promise<ThinkingTierPoolResponse>;
  removeThinkingTier(name: string): Promise<ThinkingTierRemovalResponse>;
  listCustomChatModels(signal: AbortSignal | undefined): Promise<CustomChatModelListResponse>;
  /**
   * 添加自建对话模型：一次写入完成能力属性 + 接入归属（spec 03 §6.1）。
   * 请求体类型取自 contracts（`connection_id` 必填，active 接入由后端在创建内写入）：
   * 字段名写错就编译不过，不靠运行时 400 才发现。响应侧由 contracts schema 在客户端 parse。
   */
  createCustomChatModel(payload: CustomChatModelCreateBody): Promise<CustomChatModelResponse>;
  /** 修改自建对话模型：能力两字段 + 档位两字段整体替换（contracts 的 UpdateBodySchema 钉死）。 */
  updateCustomChatModel(modelId: string, payload: CustomChatModelUpdateBody): Promise<CustomChatModelResponse>;
  deleteCustomChatModel(modelId: string): Promise<CustomChatModelRemovalResponse>;
  /**
   * 自建生成模型（spec 03 §6.1）：一次写入完成能力属性 + 接入归属。
   * 请求体与响应类型取自 contracts：`family_adapter_id` 是族归属声明，取值域由契约枚举钉住。
   */
  listCustomGenerationModels(signal: AbortSignal | undefined): Promise<CustomGenerationModelListResponse>;
  createCustomGenerationModel(payload: CustomGenerationModelCreateBody): Promise<CustomGenerationModelResponse>;
  /**
   * 修改声明：`accepted_media_slots` 整体替换；`parameter_overrides` 缺省 = 不变，
   * 出现 = 整体替换（语义由 contracts 的 UpdateBodySchema 钉死）。
   */
  updateCustomGenerationModel(modelId: string, payload: CustomGenerationModelUpdateBody): Promise<CustomGenerationModelResponse>;
  deleteCustomGenerationModel(modelId: string): Promise<CustomGenerationModelRemovalResponse>;
  /**
   * 族模板参数描述（docs/custom-providers/生成模型参数高级自定义-design.md §3.4）：
   * 参数编辑器官方区的数据源；响应由 contracts schema 在客户端 parse。
   */
  getGenerationFamilyTemplate(familyAdapterId: string, signal: AbortSignal | undefined): Promise<FamilyTemplateParameterDescriptor>;
  /** 首次指引展示态（docs/hub/首次指引-design.md §4.1）：独立小文件，不经 /api/config。 */
  getOnboardingState(signal: AbortSignal | undefined): Promise<OnboardingStateResponse>;
  dismissOnboardingGuide(): Promise<OnboardingStateResponse>;
}

// ========== Task Monitor ==========

export type TaskSummaryItem = HubTaskSummaryItem;
export type TaskListResponse = HubTaskListResponse;

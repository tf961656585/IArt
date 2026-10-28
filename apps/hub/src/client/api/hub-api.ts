import type {
  HubConfigUpdatePayload,
} from '@iart/contracts';
import {
  ChatModelCatalogResponseSchema,
  ExecutableModelCatalogResponseSchema,
  ProviderConnectionListResponseSchema,
  ProviderConnectionResponseSchema,
  ProviderConnectionCredentialResponseSchema,
  ActiveRouteMapResponseSchema,
  ActiveRouteResponseSchema,
  HubConfigResponseSchema,
  HubTaskListResponseSchema,
  HubUnknownResponseSchema,
  ProviderConnectionOkResponseSchema,
  ThinkingTierPoolResponseSchema,
  ThinkingTierRemovalResponseSchema,
  CustomChatModelListResponseSchema,
  CustomChatModelResponseSchema,
  CustomChatModelRemovalResponseSchema,
  CustomGenerationModelResponseSchema,
  CustomGenerationModelListResponseSchema,
  CustomGenerationModelRemovalResponseSchema,
  FamilyTemplateParameterDescriptorSchema,
  OnboardingStateResponseSchema,
  InterfaceRecipeDryRunResponseSchema,
  InterfaceRecipeListResponseSchema,
  InterfaceRecipePathDiscoveryResponseSchema,
  InterfaceRecipeRemovalResponseSchema,
  InterfaceRecipeResponseSchema,
  InterfaceFormatDetailSchema,
  InterfaceFormatListResponseSchema,
  CustomInterfaceFormatCopyResponseSchema,
  CustomInterfaceFormatRemovalResponseSchema,
  CustomInterfaceFormatWriteResponseSchema,
} from '@iart/contracts';
import type {
  CustomInterfaceFormatDraft,
  OnboardingStateUpdateBody,
} from '@iart/contracts';
import type {
  HubApiClient,
  HubHttpClient,
  HubRequestJsonOptions,
  HubRequestJsonOptionsWithSchema,
} from '../types';

export const HUB_API_ROUTES = Object.freeze({
  config: '/api/config',
  promptPresets: '/api/prompt-presets',
  promptPresetById: '/api/prompt-presets/',
  tasks: '/api/tasks',
  providerConnections: '/api/provider-connections',
  activeRoutes: '/api/active-routes',
  executableModelCatalog: '/api/executable-model-catalog',
  chatModelCatalog: '/api/chat-model-catalog',
  thinkingTiers: '/api/thinking-tiers',
  thinkingTierByName: '/api/thinking-tiers/',
  customChatModels: '/api/custom-chat-models',
  customChatModelById: '/api/custom-chat-models/',
  customGenerationModels: '/api/custom-generation-models',
  customGenerationModelById: '/api/custom-generation-models/',
  generationFamilyTemplateById: '/api/generation-family-templates/',
  interfaceRecipes: '/api/interface-recipes',
  interfaceRecipeById: '/api/interface-recipes/',
  interfaceFormats: '/api/interface-formats',
  interfaceFormatById: '/api/interface-formats/',
  onboardingState: '/api/onboarding-state',
} as const);

export const createHubApiClient = (http: HubHttpClient): HubApiClient => {
  const requestOptions = <TResponse, TBody = unknown>(
    responseSchema: HubRequestJsonOptionsWithSchema<TBody, TResponse>['responseSchema'],
    overrides: HubRequestJsonOptions<TBody> | undefined,
  ): HubRequestJsonOptionsWithSchema<TBody, TResponse> => {
    const normalized: HubRequestJsonOptions<TBody> = overrides === undefined
      ? {
          method: undefined,
          body: undefined,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }
      : overrides;

    return {
      method: normalized.method,
      body: normalized.body,
      headers: normalized.headers,
      cache: normalized.cache,
      signal: normalized.signal,
      responseSchema,
    };
  };

  return {
    loadConfig(signal) {
      return http.requestJson(HUB_API_ROUTES.config, requestOptions(HubConfigResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    saveConfig(payload: HubConfigUpdatePayload) {
      return http.requestJson(HUB_API_ROUTES.config, requestOptions(HubConfigResponseSchema, {
        method: 'PUT',
        body: payload,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    loadPromptPresets(): Promise<unknown> {
      return http.requestJson(HUB_API_ROUTES.promptPresets, requestOptions(HubUnknownResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal: undefined,
      }));
    },
    savePromptPreset(payload: { id: string | undefined; name: string; content: string }): Promise<unknown> {
      const isUpdate = Boolean(payload.id);
      return http.requestJson(
        payload.id ? HUB_API_ROUTES.promptPresetById + encodeURIComponent(payload.id) : HUB_API_ROUTES.promptPresets,
        requestOptions(HubUnknownResponseSchema, {
          method: isUpdate ? 'PUT' : 'POST',
          body: { name: payload.name, content: payload.content },
          headers: undefined,
          cache: undefined,
          signal: undefined,
        })
      );
    },
    deletePromptPreset(id: string): Promise<unknown> {
      return http.requestJson(HUB_API_ROUTES.promptPresetById + encodeURIComponent(id), requestOptions(HubUnknownResponseSchema, {
        method: 'DELETE',
        body: undefined,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    loadTasks(params, signal) {
      const query = new URLSearchParams();
      query.set('projectPath', params.projectPath);
      if (params.status) query.set('status', params.status);
      if (params.limit != null) query.set('limit', String(params.limit));
      if (params.offset != null) query.set('offset', String(params.offset));
      return http.requestJson(`${HUB_API_ROUTES.tasks}?${query.toString()}`, requestOptions(HubTaskListResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    // ========== ProviderConnection（spec 03） ==========
    listProviderConnections(signal) {
      return http.requestJson(HUB_API_ROUTES.providerConnections, requestOptions(ProviderConnectionListResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    createProviderConnection(payload) {
      return http.requestJson(HUB_API_ROUTES.providerConnections, requestOptions(ProviderConnectionResponseSchema, {
        method: 'POST',
        body: payload,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    updateProviderConnection(connectionId, payload) {
      return http.requestJson(`${HUB_API_ROUTES.providerConnections}/${encodeURIComponent(connectionId)}`, requestOptions(ProviderConnectionResponseSchema, {
        method: 'PUT',
        body: payload,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    deleteProviderConnection(connectionId) {
      return http.requestJson(`${HUB_API_ROUTES.providerConnections}/${encodeURIComponent(connectionId)}`, requestOptions(ProviderConnectionOkResponseSchema, {
        method: 'DELETE',
        body: undefined,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    setProviderConnectionCredential(connectionId, value) {
      return http.requestJson(`${HUB_API_ROUTES.providerConnections}/${encodeURIComponent(connectionId)}/credential`, requestOptions(ProviderConnectionCredentialResponseSchema, {
        method: 'PUT',
        body: { value },
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    removeProviderConnectionCredential(connectionId) {
      return http.requestJson(`${HUB_API_ROUTES.providerConnections}/${encodeURIComponent(connectionId)}/credential`, requestOptions(ProviderConnectionCredentialResponseSchema, {
        method: 'DELETE',
        body: undefined,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    setProviderConnectionLifecycle(connectionId, lifecycle) {
      return http.requestJson(`${HUB_API_ROUTES.providerConnections}/${encodeURIComponent(connectionId)}/lifecycle`, requestOptions(ProviderConnectionResponseSchema, {
        method: 'PUT',
        body: { lifecycle },
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    listActiveRoutes(signal) {
      return http.requestJson(HUB_API_ROUTES.activeRoutes, requestOptions(ActiveRouteMapResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    setActiveRoute(modelId, recordId) {
      return http.requestJson(`${HUB_API_ROUTES.activeRoutes}/${encodeURIComponent(modelId)}`, requestOptions(ActiveRouteResponseSchema, {
        method: 'PUT',
        body: { deployment_id: recordId },
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    /**
     * 可执行模型目录（spec 45 §1/§3）。
     * 端点不可用时由消费方显式标记（见 useProviderConnectionData 的 catalogUnavailable）：
     * Hub 不得本地推导或伪造模型能力字段，界面区分「读不到目录」与「没有可绑定模型」。
     */
    listExecutableModelCatalog(signal) {
      return http.requestJson(HUB_API_ROUTES.executableModelCatalog, requestOptions(ExecutableModelCatalogResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    /**
     * 对话模型目录（GET /api/chat-model-catalog，spec 03 §1）。
     * 对话模型不进可执行目录，因此由独立端点承载；供对话协议连接的模型清单与行状态判定使用。
     */
    listChatModelCatalog(signal) {
      return http.requestJson(HUB_API_ROUTES.chatModelCatalog, requestOptions(ChatModelCatalogResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    /**
     * 思考档位预设池（GET/POST/DELETE /api/thinking-tiers，spec 37「思考档位」）。
     * 池子是档位标识与展示名的唯一定义处；启用关系不在这里，随自建对话模型记录走
     * （updateCustomChatModel 的整体替换请求体）。
     */
    listThinkingTiers(signal) {
      return http.requestJson(HUB_API_ROUTES.thinkingTiers, requestOptions(ThinkingTierPoolResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    addThinkingTier(name) {
      return http.requestJson(HUB_API_ROUTES.thinkingTiers, requestOptions(ThinkingTierPoolResponseSchema, {
        method: 'POST',
        body: { name },
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    removeThinkingTier(name) {
      return http.requestJson(
        `${HUB_API_ROUTES.thinkingTierByName}${encodeURIComponent(name)}`,
        requestOptions(ThinkingTierRemovalResponseSchema, {
          method: 'DELETE',
          body: undefined,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    /**
     * 用户自建对话模型（GET/POST/PUT/DELETE /api/custom-chat-models，spec 03 §6.1）。
     *
     * 记录即接入：POST 一次写入能力属性与接入归属（active 接入由后端在创建内完成）；
     * PUT 做能力与档位的整体替换。
     */
    listCustomChatModels(signal) {
      return http.requestJson(HUB_API_ROUTES.customChatModels, requestOptions(CustomChatModelListResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    createCustomChatModel(payload) {
      return http.requestJson(HUB_API_ROUTES.customChatModels, requestOptions(CustomChatModelResponseSchema, {
        method: 'POST',
        body: payload,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    updateCustomChatModel(modelId, payload) {
      return http.requestJson(
        `${HUB_API_ROUTES.customChatModelById}${encodeURIComponent(modelId)}`,
        requestOptions(CustomChatModelResponseSchema, {
          method: 'PUT',
          body: payload,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    deleteCustomChatModel(modelId) {
      return http.requestJson(
        `${HUB_API_ROUTES.customChatModelById}${encodeURIComponent(modelId)}`,
        requestOptions(CustomChatModelRemovalResponseSchema, {
          method: 'DELETE',
          body: undefined,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    /**
     * 用户自建生成模型（GET/POST/PUT/DELETE /api/custom-generation-models，spec 03 §6.1）。
     *
     * 与对话侧 createCustomChatModel 同构，记录即接入：POST 一次写入能力属性与接入归属
     * （active 接入由后端在创建内完成），不需要第二次写入。
     */
    listCustomGenerationModels(signal) {
      return http.requestJson(HUB_API_ROUTES.customGenerationModels, requestOptions(CustomGenerationModelListResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    createCustomGenerationModel(payload) {
      return http.requestJson(HUB_API_ROUTES.customGenerationModels, requestOptions(CustomGenerationModelResponseSchema, {
        method: 'POST',
        body: payload,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    deleteCustomGenerationModel(modelId) {
      return http.requestJson(
        `${HUB_API_ROUTES.customGenerationModelById}${encodeURIComponent(modelId)}`,
        requestOptions(CustomGenerationModelRemovalResponseSchema, {
          method: 'DELETE',
          body: undefined,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    /**
     * 族模板参数描述（GET /api/generation-family-templates/:familyAdapterId，
     * docs/custom-providers/生成模型参数高级自定义-design.md §3.4）。
     *
     * 只读投影：参数编辑器官方区的数据源。响应由 contracts 的
     * FamilyTemplateParameterDescriptorSchema 在客户端 parse（reserved_wire_names 供编辑器
     * 做即时提示；权威查重校验唯一实现在 Runtime Backend）。
     */
    getGenerationFamilyTemplate(familyAdapterId, signal) {
      return http.requestJson(
        `${HUB_API_ROUTES.generationFamilyTemplateById}${encodeURIComponent(familyAdapterId)}`,
        requestOptions(FamilyTemplateParameterDescriptorSchema, {
          method: undefined,
          body: undefined,
          headers: undefined,
          cache: 'no-store',
          signal,
        }),
      );
    },
    /**
     * 修改自建生成模型的声明（PUT /api/custom-generation-models/:modelId）。
     *
     * `parameter_overrides` 语义由契约钉死：出现 = 整体替换现有覆盖（显式传空覆盖即清空）；
     * 响应与创建同形（CustomGenerationModelResponse），沿用同一 schema 解析。
     */
    updateCustomGenerationModel(modelId, payload) {
      return http.requestJson(
        `${HUB_API_ROUTES.customGenerationModelById}${encodeURIComponent(modelId)}`,
        requestOptions(CustomGenerationModelResponseSchema, {
          method: 'PUT',
          body: payload,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    // ========== 接口配方（docs/custom-providers/接口配方-design.md） ==========
    listInterfaceRecipes(signal) {
      return http.requestJson(HUB_API_ROUTES.interfaceRecipes, requestOptions(InterfaceRecipeListResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    createInterfaceRecipe(payload) {
      return http.requestJson(HUB_API_ROUTES.interfaceRecipes, requestOptions(InterfaceRecipeResponseSchema, {
        method: 'POST',
        body: payload,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    updateInterfaceRecipe(recipeId, payload) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceRecipeById}${encodeURIComponent(recipeId)}`,
        requestOptions(InterfaceRecipeResponseSchema, {
          method: 'PUT',
          body: payload,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    deleteInterfaceRecipe(recipeId) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceRecipeById}${encodeURIComponent(recipeId)}`,
        requestOptions(InterfaceRecipeRemovalResponseSchema, {
          method: 'DELETE',
          body: undefined,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    dryRunInterfaceRecipe(payload) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceRecipes}/dry-run`,
        requestOptions(InterfaceRecipeDryRunResponseSchema, {
          method: 'POST',
          body: payload,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    discoverInterfaceRecipePaths(sample) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceRecipes}/path-discovery`,
        requestOptions(InterfaceRecipePathDiscoveryResponseSchema, {
          method: 'POST',
          body: { sample },
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    // ========== 接口格式（docs/custom-providers/接口格式旅程-design.md） ==========
    listInterfaceFormats(signal) {
      return http.requestJson(HUB_API_ROUTES.interfaceFormats, requestOptions(InterfaceFormatListResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    getInterfaceFormat(formatId, signal) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceFormatById}${encodeURIComponent(formatId)}`,
        requestOptions(InterfaceFormatDetailSchema, {
          method: undefined,
          body: undefined,
          headers: undefined,
          cache: 'no-store',
          signal,
        }),
      );
    },
    discoverInterfaceFormatPaths(formatId, body) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceFormatById}${encodeURIComponent(formatId)}/path-discovery`,
        requestOptions(InterfaceRecipePathDiscoveryResponseSchema, {
          method: 'POST',
          body,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    createInterfaceFormat(body: CustomInterfaceFormatDraft) {
      return http.requestJson(HUB_API_ROUTES.interfaceFormats, requestOptions(CustomInterfaceFormatWriteResponseSchema, {
        method: 'POST',
        body,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
    updateInterfaceFormat(formatId: string, body: CustomInterfaceFormatDraft) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceFormatById}${encodeURIComponent(formatId)}`,
        requestOptions(CustomInterfaceFormatWriteResponseSchema, {
          method: 'PUT',
          body,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    deleteInterfaceFormat(formatId: string) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceFormatById}${encodeURIComponent(formatId)}`,
        requestOptions(CustomInterfaceFormatRemovalResponseSchema, {
          method: 'DELETE',
          body: undefined,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    copyInterfaceFormat(formatId: string) {
      return http.requestJson(
        `${HUB_API_ROUTES.interfaceFormatById}${encodeURIComponent(formatId)}/copy`,
        requestOptions(CustomInterfaceFormatCopyResponseSchema, {
          method: 'POST',
          body: undefined,
          headers: undefined,
          cache: undefined,
          signal: undefined,
        }),
      );
    },
    getOnboardingState(signal) {
      return http.requestJson(HUB_API_ROUTES.onboardingState, requestOptions(OnboardingStateResponseSchema, {
        method: undefined,
        body: undefined,
        headers: undefined,
        cache: 'no-store',
        signal,
      }));
    },
    dismissOnboardingGuide() {
      return http.requestJson(HUB_API_ROUTES.onboardingState, requestOptions(OnboardingStateResponseSchema, {
        method: 'PUT',
        body: { guideDismissed: true } satisfies OnboardingStateUpdateBody,
        headers: undefined,
        cache: undefined,
        signal: undefined,
      }));
    },
  };
};

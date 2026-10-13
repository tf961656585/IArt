import * as z from 'zod';
import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as loggingModule from '../logging.cts';
import {
  createConnection,
  getConnection,
  listConnections,
  removeConnection,
  setConnectionCredential,
  setConnectionLifecycle,
  updateConnection,
} from '../provider-connection/connection-store.cts';
import {
  clearCredentialForConnection,
  hasActiveLeasesForConnection,
  setCredentialForConnection,
} from '../provider-connection/credential-store.cts';
import {
  createDeployment,
  getDeployment,
  listDeployments,
  removeDeployment,
  removeDeploymentsByConnection,
  updateDeployment,
} from '../provider-connection/deployment-store.cts';
import {
  removeCustomChatModelsByConnection,
} from '../provider-connection/custom-chat-model-store.cts';
import {
  removeCustomGenerationModelsByConnection,
} from '../provider-connection/custom-generation-model-store.cts';
import {
  clearActiveDeployment,
  clearActiveRoutesForConnection,
  clearActiveRoutesForDeployment,
  getActiveDeploymentId,
  getActiveRoutes,
  resolveActiveTargetRecord,
  setActiveDeployment,
} from '../provider-connection/active-route-store.cts';
import { createSkillRuntimeConfigRefresher } from '../skill-runtime/skill-runtime-config-store.cts';

/**
 * Provider 连接、ModelDeployment 与 ActiveRoute 管理路由（spec 03 §4/§6 + spec 45 v3）。
 *
 * 归属与口径对齐：
 * - spec 03 §4 ProviderConnection：地址+凭证（连接级接口类型预选已退役，2026-09-29 起）、
 *   base_url 规范化、credential_ref、lifecycle
 * - spec 03 §5 Credential lease：Key 只进 safeStorage/fallback 文件，DTO 只含 ref/has_credential
 * - spec 03 §6 ModelDeployment + ActiveRoute：model_id+connection_id+remote_model_id，单值 active
 * - spec 03 §7 健康：lifecycle/validity 分离，此处仅持久化，不做探测
 * - 跨边界 DTO 以 packages/contracts 为事实源（ProviderConnection / ModelDeployment / ActiveRouteMap）
 *
 * 路由清单（RESTful）：
 * - GET    /api/provider-connections                      列出全部连接
 * - POST   /api/provider-connections                      创建连接 {display_name, base_url}
 * - GET    /api/provider-connections/:connectionId        查询单个
 * - PUT    /api/provider-connections/:connectionId        更新 display_name/base_url
 * - DELETE /api/provider-connections/:connectionId        删除（级联清 deployments/active/credential）
 * - PUT    /api/provider-connections/:connectionId/lifecycle  {lifecycle: enabled|disabled|retired}
 * - PUT    /api/provider-connections/:connectionId/credential  {value: string} 设置凭证
 * - DELETE /api/provider-connections/:connectionId/credential  清空凭证
 * - GET    /api/model-deployments                         列出全部部署 (?model_id=)
 * - POST   /api/model-deployments                         创建 {model_id, connection_id, remote_model_id}
 * - PUT    /api/model-deployments/:deploymentId           更新 connection_id/remote_model_id
 * - DELETE /api/model-deployments/:deploymentId           删除（级联清 active）
 * - GET    /api/active-routes                             列出全部 active map
 * - GET    /api/active-routes/:modelId                    查询单模型 active
 * - PUT    /api/active-routes/:modelId                    设置 {deployment_id: string|null}，null=清空
 * - DELETE /api/active-routes/:modelId                    清空
 *
 * 写保护：POST/PUT/DELETE 全部走 Hub write token（hub-local-write-policy），GET 只读不加。
 * 凭证写：真实 Key 只进 credential-store，响应只回 has_credential，不回明文。
 */

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;

const ERROR_CODE_CONFLICT = 'conflict';
const NO_STORE_HEADERS = (corsHeaders: Record<string, string>): Record<string, string> => ({
  ...corsHeaders,
  'Cache-Control': 'no-store',
});

const splitPathname = (pathname: string): string[] => pathname.split('/').filter(Boolean);

// ----- schemas（路由层本地，非跨进程 DTO 不进 contracts）-----

const ProviderConnectionCreateBodySchema = z
  .object({
    display_name: z.string().min(1),
    base_url: z.string().regex(/^https:\/\//),
  })
  .strict();

// 连接级接口类型预选（protocol_adapter_id）已退役（2026-09-29 起）：接口类型只在
// 「添加模型」时随模型记录配置，连接创建/更新不再接受该字段（.strict() 拒绝未知键）。
const ProviderConnectionUpdateBodySchema = z
  .object({
    display_name: z.string().min(1).optional(),
    base_url: z.string().regex(/^https:\/\//).optional(),
  })
  .strict()
  .refine((b) => b.display_name !== undefined || b.base_url !== undefined, {
    message: 'at least one updatable field required',
  });

const LifecycleBodySchema = z.object({ lifecycle: z.enum(['enabled', 'disabled', 'retired']) }).strict();
const CredentialBodySchema = z.object({ value: z.string().min(1) }).strict();

const DeploymentCreateBodySchema = z
  .object({
    model_id: z.string().min(1),
    connection_id: z.string().min(1),
    remote_model_id: z.string().min(1),
  })
  .strict();

const DeploymentUpdateBodySchema = z
  .object({
    connection_id: z.string().min(1).optional(),
    remote_model_id: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.connection_id !== undefined
      || b.remote_model_id !== undefined,
    {
      message: 'at least one updatable field required',
    },
  );

const ActiveRoutePutBodySchema = z
  .object({ deployment_id: z.string().regex(/^up_dep_[a-z0-9][a-z0-9-_]*$/).nullable() })
  .strict();

const createProviderConnectionRoutes = (options?: {
  getServerPort?: () => number | null;
}): RouteDefinition[] => {
  const getServerPort = options?.getServerPort;
  const refreshSkillRuntimeConfig = getServerPort
    ? createSkillRuntimeConfigRefresher(getServerPort)
    : (): void => {};
  const routes: RouteDefinition[] = [
  // ----- ProviderConnection -----
  {
    name: 'provider-connections-list',
    match: ({ req, pathname }) => req.method === 'GET' && pathname === '/api/provider-connections',
    handle: ({ res, corsHeaders }) => {
      sendJson(res, 200, { connections: listConnections() }, NO_STORE_HEADERS(corsHeaders));
    },
  },
  {
    name: 'provider-connections-create',
    match: ({ req, pathname }) => req.method === 'POST' && pathname === '/api/provider-connections',
    handle: async ({ req, res, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = ProviderConnectionCreateBodySchema.safeParse(body);
      if (!parsed.success) {
        loggingModule.logDebug('[provider-connection-routes] create: invalid body', { error: parsed.error.message });
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'display_name / base_url 无效（base_url 必须 https://）', corsHeaders);
        return;
      }
      try {
        const connection = createConnection({
          display_name: parsed.data.display_name,
          base_url: parsed.data.base_url,
        });
        sendJson(res, 200, { connection }, NO_STORE_HEADERS(corsHeaders));
      } catch (error) {
        loggingModule.logDebug('[provider-connection-routes] create failed', { error: error instanceof Error ? error.message : String(error) });
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, error instanceof Error ? error.message : '创建连接失败', corsHeaders);
      }
    },
  },
  {
    name: 'provider-connections-by-id',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return segs[0] === 'api' && segs[1] === 'provider-connections' && segs.length === 3 && (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE');
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const connectionId = splitPathname(pathname)[2] ?? '';
      const existing = getConnection(connectionId);
      if (!existing) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, 'ProviderConnection 不存在', corsHeaders);
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { connection: existing }, NO_STORE_HEADERS(corsHeaders));
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const parsed = ProviderConnectionUpdateBodySchema.safeParse(body);
        if (!parsed.success) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '更新字段无效', corsHeaders);
          return;
        }
        // 连接级接口类型预选已退役（2026-09-29 起）：更新只接受 display_name/base_url。
        try {
          const patch: { display_name?: string; base_url?: string } = {};
          if (parsed.data.display_name !== undefined) patch.display_name = parsed.data.display_name;
          if (parsed.data.base_url !== undefined) patch.base_url = parsed.data.base_url;
          const updated = updateConnection(connectionId, patch);
          if (!updated) {
            sendError(res, 404, ERROR_CODES.NOT_FOUND, 'ProviderConnection 不存在', corsHeaders);
            return;
          }
          sendJson(res, 200, { connection: updated }, NO_STORE_HEADERS(corsHeaders));
        } catch (error) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, error instanceof Error ? error.message : '更新失败', corsHeaders);
        }
        return;
      }
      // DELETE：删除即级联清理（2026-09-18 拍板，spec 03 §5.3）——连接与它挂着的全部接入、
      // active 路由、凭证一并移除，不再要求先 retired（Hub 界面本就没有通往 retired 的入口，
      // 旧门槛只制造「等多久都删不掉」的死路）。唯一保留的门是凭证租约：已受理任务靠快照与
      // 租约继续执行，任务未到终态（租约未释放）前阻断物理删除。
      if (hasActiveLeasesForConnection(connectionId)) {
        loggingModule.logDebug('[provider-connection-routes] delete blocked: active leases', { connectionId });
        sendError(res, 409, ERROR_CODE_CONFLICT, '该连接存在活跃凭证租约（有任务正在使用），待任务终态后再删除', corsHeaders);
        return;
      }
      const deploymentsRemoved = removeDeploymentsByConnection(connectionId);
      if (deploymentsRemoved > 0) {
        loggingModule.logDebug('[provider-connection-routes] delete connection: cascaded deployments', { connectionId, deploymentsRemoved });
      }
      // spec 03 §6.1：删除连接级联删除其下全部自建记录（对话/生成两族）——记录的接入归属
      // 内嵌 connection_id，连接不存在后无归属记录非法。active 路由按被删记录逐个清理。
      const removedChatRecords = removeCustomChatModelsByConnection(connectionId);
      const removedGenerationRecords = removeCustomGenerationModelsByConnection(connectionId);
      for (const record of [...removedChatRecords, ...removedGenerationRecords]) {
        clearActiveDeployment(record.model_id);
      }
      if (removedChatRecords.length + removedGenerationRecords.length > 0) {
        loggingModule.logDebug('[provider-connection-routes] delete connection: cascaded custom model records', {
          connectionId,
          removedChatRecords: removedChatRecords.length,
          removedGenerationRecords: removedGenerationRecords.length,
        });
      }
      clearActiveRoutesForConnection(connectionId);
      clearCredentialForConnection(connectionId);
      const ok = removeConnection(connectionId);
      if (!ok) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, 'ProviderConnection 不存在', corsHeaders);
        return;
      }
      sendJson(res, 200, { ok: true }, NO_STORE_HEADERS(corsHeaders));
    },
  },
  {
    name: 'provider-connections-lifecycle',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return segs[0] === 'api' && segs[1] === 'provider-connections' && segs.length === 4 && segs[3] === 'lifecycle' && req.method === 'PUT';
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const connectionId = splitPathname(pathname)[2] ?? '';
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = LifecycleBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'lifecycle 必须为 enabled|disabled|retired', corsHeaders);
        return;
      }
      try {
        const updated = setConnectionLifecycle(connectionId, parsed.data.lifecycle);
        if (!updated) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, 'ProviderConnection 不存在', corsHeaders);
          return;
        }
        // retired 时解除未来 active（已冻结快照不受影响，spec 5.3）
        if (parsed.data.lifecycle === 'retired') {
          const cleared = clearActiveRoutesForConnection(connectionId);
          if (cleared > 0) loggingModule.logDebug('[provider-connection-routes] retired: cleared active routes', { connectionId, cleared });
        }
        sendJson(res, 200, { connection: updated }, NO_STORE_HEADERS(corsHeaders));
      } catch (error) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, error instanceof Error ? error.message : 'lifecycle 更新失败', corsHeaders);
      }
    },
  },
  {
    name: 'provider-connections-credential',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return segs[0] === 'api' && segs[1] === 'provider-connections' && segs.length === 4 && segs[3] === 'credential' && (req.method === 'PUT' || req.method === 'DELETE');
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const connectionId = splitPathname(pathname)[2] ?? '';
      const existing = getConnection(connectionId);
      if (!existing) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, 'ProviderConnection 不存在', corsHeaders);
        return;
      }
      if (existing.lifecycle === 'retired') {
        sendError(res, 409, ERROR_CODE_CONFLICT, 'retired 连接不可绑定凭证', corsHeaders);
        return;
      }
      if (req.method === 'DELETE') {
        clearCredentialForConnection(connectionId);
        const updated = setConnectionCredential(connectionId, null, null, false);
        sendJson(res, 200, { connection: updated ?? existing, has_credential: false }, NO_STORE_HEADERS(corsHeaders));
        return;
      }
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = CredentialBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'value 必须为非空字符串', corsHeaders);
        return;
      }
      const value = parsed.data.value.trim();
      if (!value) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'value 不能为空', corsHeaders);
        return;
      }
      const result = await setCredentialForConnection(connectionId, value);
      if (!result) {
        sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, '凭证存储失败', corsHeaders);
        return;
      }
      const updated = setConnectionCredential(connectionId, result.credentialRef, result.version, true);
      sendJson(res, 200, { connection: updated, has_credential: true, credential_ref: result.credentialRef }, NO_STORE_HEADERS(corsHeaders));
    },
  },
  // ----- ModelDeployment -----
  {
    name: 'model-deployments-list',
    match: ({ req, pathname }) => req.method === 'GET' && pathname === '/api/model-deployments',
    handle: ({ res, url, corsHeaders }) => {
      const modelId = url.searchParams.get('model_id')?.trim() || '';
      const deployments = modelId ? listDeployments().filter((d) => d.model_id === modelId) : listDeployments();
      sendJson(res, 200, { deployments }, NO_STORE_HEADERS(corsHeaders));
    },
  },
  {
    name: 'model-deployments-create',
    match: ({ req, pathname }) => req.method === 'POST' && pathname === '/api/model-deployments',
    handle: async ({ req, res, corsHeaders }) => {
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = DeploymentCreateBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'model_id / connection_id / remote_model_id 无效', corsHeaders);
        return;
      }
      try {
        const deployment = createDeployment({
          model_id: parsed.data.model_id,
          connection_id: parsed.data.connection_id,
          remote_model_id: parsed.data.remote_model_id,
        });
        sendJson(res, 200, { deployment }, NO_STORE_HEADERS(corsHeaders));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('already exists')) {
          sendError(res, 409, ERROR_CODE_CONFLICT, '该 model_id + connection_id + remote_model_id 已存在', corsHeaders);
          return;
        }
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, msg, corsHeaders);
      }
    },
  },
  {
    name: 'model-deployments-by-id',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return segs[0] === 'api' && segs[1] === 'model-deployments' && segs.length === 3 && (req.method === 'PUT' || req.method === 'DELETE' || req.method === 'GET');
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const deploymentId = splitPathname(pathname)[2] ?? '';
      const existing = getDeployment(deploymentId);
      if (!existing) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, 'ModelDeployment 不存在', corsHeaders);
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { deployment: existing }, NO_STORE_HEADERS(corsHeaders));
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const parsed = DeploymentUpdateBodySchema.safeParse(body);
        if (!parsed.success) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, '更新字段无效', corsHeaders);
          return;
        }
        try {
          const patch: {
            connection_id?: string;
            remote_model_id?: string;
          } = {};
          if (parsed.data.connection_id !== undefined) patch.connection_id = parsed.data.connection_id;
          if (parsed.data.remote_model_id !== undefined) patch.remote_model_id = parsed.data.remote_model_id;
          const updated = updateDeployment(deploymentId, patch);
          if (!updated) {
            sendError(res, 404, ERROR_CODES.NOT_FOUND, 'ModelDeployment 不存在', corsHeaders);
            return;
          }
          sendJson(res, 200, { deployment: updated }, NO_STORE_HEADERS(corsHeaders));
        } catch (error) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, error instanceof Error ? error.message : '更新失败', corsHeaders);
        }
        return;
      }
      // DELETE
      const cleared = clearActiveRoutesForDeployment(deploymentId);
      if (cleared > 0) loggingModule.logDebug('[provider-connection-routes] delete deployment: cleared active', { deploymentId, cleared });
      const ok = removeDeployment(deploymentId);
      sendJson(res, 200, { ok }, NO_STORE_HEADERS(corsHeaders));
    },
  },
  // ----- ActiveRoutes -----
  {
    name: 'active-routes-list',
    match: ({ req, pathname }) => req.method === 'GET' && pathname === '/api/active-routes',
    handle: ({ res, corsHeaders }) => {
      sendJson(res, 200, { active_routes: getActiveRoutes() }, NO_STORE_HEADERS(corsHeaders));
    },
  },
  {
    name: 'active-routes-by-model',
    match: ({ req, pathname }) => {
      const segs = splitPathname(pathname);
      return segs[0] === 'api' && segs[1] === 'active-routes' && segs.length === 3 && (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE');
    },
    handle: async ({ req, res, pathname, corsHeaders }) => {
      const rawModelId = splitPathname(pathname)[2] ?? '';
      const modelId = decodeURIComponent(rawModelId).trim();
      if (!modelId) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'model_id 不能为空', corsHeaders);
        return;
      }
      if (req.method === 'GET') {
        const deploymentId = getActiveDeploymentId(modelId);
        sendJson(res, 200, { model_id: modelId, deployment_id: deploymentId }, NO_STORE_HEADERS(corsHeaders));
        return;
      }
      if (req.method === 'DELETE') {
        const ok = clearActiveDeployment(modelId);
        sendJson(res, 200, { ok }, NO_STORE_HEADERS(corsHeaders));
        return;
      }
      const body = await readJsonBodyOrSendError(req, res, corsHeaders);
      if (body == null) return;
      const parsed = ActiveRoutePutBodySchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'deployment_id 必须为 up_dep_ 前缀或 null', corsHeaders);
        return;
      }
      const deploymentId = parsed.data.deployment_id;
      if (deploymentId === null) {
        clearActiveDeployment(modelId);
        sendJson(res, 200, { model_id: modelId, deployment_id: null }, NO_STORE_HEADERS(corsHeaders));
        return;
      }
      try {
        // 目标解析双查（spec 03 §6.1）：已装包 deployment 或自建模型记录（同一 id 空间）。
        const target = resolveActiveTargetRecord(deploymentId);
        if (!target) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, '接入记录不存在', corsHeaders);
          return;
        }
        if (target.model_id !== modelId) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, `接入记录 model_id ${target.model_id} 与路径 ${modelId} 不一致`, corsHeaders);
          return;
        }
        const result = setActiveDeployment(modelId, deploymentId);
        sendJson(res, 200, { model_id: modelId, deployment_id: result }, NO_STORE_HEADERS(corsHeaders));
      } catch (error) {
        sendError(res, 400, ERROR_CODES.INVALID_CONFIG, error instanceof Error ? error.message : '设置 active 失败', corsHeaders);
      }
    },
  },
  ];
  // skill 运行时配置的端点与凭证据取自模型的 active deployment，因此本组的任何写操作
  // （连接、凭证、部署、active 路由）都可能改变它——统一在写操作后刷新一次。
  return routes.map((route) => ({
    ...route,
    handle: async (context: Parameters<RouteDefinition['handle']>[0]) => {
      await route.handle(context);
      if (context.req.method !== 'GET') {
        refreshSkillRuntimeConfig();
      }
    },
  }));
};

export { createProviderConnectionRoutes };

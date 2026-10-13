/**
 * skill 运行时配置文件存储。
 *
 * spec: docs/hub/skill-store.md
 *
 * backend 在启动与凭证变更时，把 skill 运行所需的端点与缓存 Key 写入
 * ~/.iart-studio/skills-runtime/<id>.runtime.json（权限 0600，原子写入）。
 * 已安装的 skill bash 读取该文件，按 proxyBaseUrl 可达性决定走代理或直连。
 *
 * 目录由 desktop-shell 经 IART_SKILL_RUNTIME_DIR env 注入（dev/prod 隔离，
 * 与 editor-storage-recent-projects.cts 先例一致）。backend 不决定目录归属。
 *
 * 端点与凭证来源：skill 目标模型（gpt-image-2）的 **active deployment** ——
 * 经 `buildExecutionSnapshot` 解析出该模型绑定的服务商连接 base_url 与凭证引用，
 * 再经 `acquireLease` 取出凭证明文。与任务主链同一套凭证链（BYOK：凭证随服务商
 * 连接走），不再写死任何网关地址，也不再有全局密钥槽位。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SkillRuntimeConfigSchema, type SkillRuntimeConfig, type SkillRuntimeKeyCandidate } from '@iart/contracts';

import * as loggingModule from '../logging.cts';
import { HOST } from '../constants.cts';
import { buildExecutionSnapshot } from '../provider-connection/execution-snapshot.cts';
import { acquireLease, releaseLease } from '../provider-connection/credential-store.cts';

const DEFAULT_SKILL_MODEL_ID = 'gpt-image-2';
// skill 目标模型：端点与凭证都从它自己的 active deployment 解析，不跨模型串用。
const GPT_IMAGE_2_MODEL_ID = 'gpt-image-2';
const GPT_IMAGE_CONFIG_FILENAME = 'gpt-image.runtime.json';

type ServerPortProvider = () => number | null;

type ResolvedSkillTarget = {
  gatewayBaseUrl: string;
  candidates: SkillRuntimeKeyCandidate[];
};

/**
 * 解析 skill 运行时配置文件的写入目录。
 *
 * 读 IART_SKILL_RUNTIME_DIR env（由 desktop-shell 注入）。未注入时返回 null，
 * backend 跳过写入（不崩溃）。
 */
const resolveRuntimeDir = (): string | null => {
  const dir = process.env.IART_SKILL_RUNTIME_DIR;
  if (typeof dir !== 'string' || !dir.trim()) {
    return null;
  }
  return dir.trim();
};

/**
 * 解析 skill 的目标端点与候选 Key。
 *
 * 与任务主链同源：active deployment → ExecutionSnapshot（base_url + 凭证引用）→
 * CredentialLease（凭证明文）。无 active deployment（尚未接入服务商）或凭证不可读时
 * 返回 null，调用端跳过写配置——skill 侧读不到文件会给出明确报错，不静默半可用。
 *
 * 凭证明文只用于写入 0600 运行时配置文件；取到即释放租约（长时租约语义属于任务主链）。
 */
const resolveSkillTarget = async (): Promise<ResolvedSkillTarget | null> => {
  const snapshotResult = buildExecutionSnapshot({ modelId: GPT_IMAGE_2_MODEL_ID });
  if (!snapshotResult.ok) {
    loggingModule.logDebug('skill-runtime: no execution snapshot for skill model, skip', {
      modelId: GPT_IMAGE_2_MODEL_ID,
      code: snapshotResult.code,
      message: snapshotResult.message,
    });
    return null;
  }
  const { snapshot } = snapshotResult;
  const credentialRef = snapshot.credential_ref;
  if (!credentialRef) {
    loggingModule.logDebug('skill-runtime: snapshot carries no credential ref, skip', {
      modelId: GPT_IMAGE_2_MODEL_ID,
      connectionId: snapshot.connection_id,
    });
    return null;
  }
  const leaseResult = await acquireLease({
    connectionId: snapshot.connection_id,
    credentialRef,
    credentialVersion: typeof snapshot.credential_version === 'number' ? snapshot.credential_version : 0,
    connectionRevision: snapshot.connection_revision,
  });
  if (!leaseResult) {
    loggingModule.logDebug('skill-runtime: acquireLease failed, skip', { credentialRef });
    return null;
  }
  releaseLease(leaseResult.lease.leaseId);
  return {
    gatewayBaseUrl: snapshot.base_url,
    candidates: [{ modelId: GPT_IMAGE_2_MODEL_ID, tierKey: null, apiKey: leaseResult.value }],
  };
};

/**
 * 构建当前生效的 skill 运行时配置。
 *
 * 无法解析目标（未接入服务商 / 凭证缺失）时返回 null，由调用端跳过写入。
 * serverPort 由 listen 回调注入，用于拼装 proxyBaseUrl（端口漂移由该机制解决）。
 */
export const buildSkillRuntimeConfig = async (serverPort: number | null): Promise<SkillRuntimeConfig | null> => {
  const target = await resolveSkillTarget();
  if (!target) {
    return null;
  }
  return {
    proxyBaseUrl: serverPort ? `http://${HOST}:${serverPort}` : '',
    gatewayBaseUrl: target.gatewayBaseUrl,
    candidates: target.candidates,
    modelId: DEFAULT_SKILL_MODEL_ID,
    updatedAt: new Date().toISOString(),
  };
};

/**
 * 原子写入 skill 运行时配置文件。
 *
 * 原子写入策略：写入临时文件（.tmp.<pid>）→ chmod 0600 → rename 到目标路径。
 * 并发刷新不产生截断文件。
 *
 * 写入前用 SkillRuntimeConfigSchema 校验（写入端 parse，保证落盘内容一定合法）。
 *
 * 目录缺失自动创建。env 未注入目录、或目标不可解析时跳过写入并记录 debug 日志。
 */
export const writeSkillRuntimeConfig = async (serverPort: number | null): Promise<void> => {
  const dir = resolveRuntimeDir();
  if (dir === null) {
    loggingModule.logDebug('skill-runtime: IART_SKILL_RUNTIME_DIR not set, skip writing config', undefined);
    return;
  }

  const config = await buildSkillRuntimeConfig(serverPort);
  if (config === null) {
    loggingModule.logDebug('skill-runtime: skill target unresolvable, skip writing config', {
      modelId: GPT_IMAGE_2_MODEL_ID,
    });
    return;
  }
  // 写入端校验：落盘内容必须合法
  const parsed = SkillRuntimeConfigSchema.safeParse(config);
  if (!parsed.success) {
    loggingModule.logWarn('skill-runtime: built config failed schema validation, skip writing', {
      error: parsed.error.message,
    });
    return;
  }

  const targetPath = path.join(dir, GPT_IMAGE_CONFIG_FILENAME);
  const tmpPath = path.join(dir, `${GPT_IMAGE_CONFIG_FILENAME}.tmp.${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(parsed.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    // 显式 chmod 确保 0600（mode 选项受 umask 影响）
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, targetPath);
    loggingModule.logDebug('skill-runtime: wrote runtime config', {
      path: targetPath,
      hasProxy: Boolean(parsed.data.proxyBaseUrl),
      candidateCount: parsed.data.candidates.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    loggingModule.logWarn('skill-runtime: failed to write runtime config', {
      path: targetPath,
      error: message,
    });
    // 清理临时文件
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
  }
};

/**
 * 创建绑定到固定 serverPortProvider 的刷新函数。
 *
 * 各触发点（listen 回调、凭证变更）调用此返回函数即可，不需要各自持有端口引用。
 * 刷新为异步（需异步读取凭证）；失败只记日志，不向调用方抛出。
 */
export const createSkillRuntimeConfigRefresher = (serverPortProvider: ServerPortProvider) => {
  return (): void => {
    void writeSkillRuntimeConfig(serverPortProvider()).catch((error: unknown) => {
      loggingModule.logInfo('skill-runtime: refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
};

// 测试导出
export const __test_only__ = {
  resolveRuntimeDir,
  resolveSkillTarget,
  GPT_IMAGE_CONFIG_FILENAME,
  DEFAULT_SKILL_MODEL_ID,
  GPT_IMAGE_2_MODEL_ID,
};

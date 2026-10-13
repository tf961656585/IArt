import { SkillCatalogSchema, type SkillCatalog } from '@iart/contracts';

/**
 * skill 商店远端目录拉取。
 *
 * spec: docs/hub/skill-store.md
 *
 * 从公开仓 GitHub raw（skill-catalog 分支）拉取 skills/index.json 目录指针。
 * raw 分支有约 5 分钟 CDN 缓存，必须 cache-buster + no-store 双保险规避缓存。
 *
 * CSP 审计：Hub 渲染进程未配置 connect-src 限制，可直接 fetch 外部域名（与 cloud-policy.ts 同先例）。
 */

// skill 目录公共读取地址（GitHub raw 公开分支，无鉴权）。
export const SKILL_CATALOG_URL = 'https://raw.githubusercontent.com/tf961656585/IArt/skill-catalog/skills/index.json';

export class SkillCatalogFetchError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'SkillCatalogFetchError';
    this.status = status;
  }
}

// 构建带 cache-buster 的请求 URL（目录是指针，必须拿最新版本）。
const buildCacheBustedUrl = (): string => {
  const separator = SKILL_CATALOG_URL.includes('?') ? '&' : '?';
  return `${SKILL_CATALOG_URL}${separator}_t=${Date.now()}`;
};

/**
 * 纯函数拉取远端 skill 目录。无 DOM / 外部依赖，便于 mock。
 *
 * 缓存规避双保险：
 *   1. cache: 'no-store' —— 标准 HTTP 层规避。
 *   2. URL 拼 _t=<timestamp> —— URL 层绝对隔离，绕过任何非标准缓存层。
 *
 * 拉取后用 SkillCatalogSchema parse（边界校验，防止非法 JSON 流入下游）。
 */
export async function fetchSkillCatalog(
  signal: AbortSignal | undefined,
): Promise<SkillCatalog> {
  const options: RequestInit = {
    cache: 'no-store',
    ...(signal !== undefined ? { signal } : {}),
  };
  const res = await fetch(buildCacheBustedUrl(), options);
  if (!res.ok) {
    throw new SkillCatalogFetchError(res.status, `Skill 目录拉取失败: HTTP ${res.status}`);
  }
  const raw: unknown = await res.json();
  return SkillCatalogSchema.parse(raw);
}

/**
 * 将目录拉取过程中的错误映射为用户可见文案。
 */
export function mapSkillCatalogError(err: unknown): string {
  if (err instanceof SkillCatalogFetchError) {
    return '没能读取 Skill 商店，请检查网络后重试';
  }
  if (err instanceof Error) {
    return '没能读取 Skill 商店，请稍后重试';
  }
  return '没能读取 Skill 商店，请稍后重试';
}

/**
 * 比较两个版本号（语义化数字段比较）。
 *
 * 返回负数表示 a < b，0 表示相等，正数表示 a > b。
 * 非数字段按 0 处理（如 "1.0" 与 "1.0.0" 视为相等）。
 * 商店页用它判定「远端版本是否高于已安装版本」，字符串相等判定会把
 * 远端回退（远端低于本地）误判为「可更新」，必须按数值段比较。
 */
export function compareSkillVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('.').map((seg) => {
      const n = Number.parseInt(seg, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * 根据 bundleKey 构建完整 bundle 下载 URL。
 *
 * bundleKey 是目录里的 bundle 键（如 skills/bundles/gpt-image-1.0.0.json），
 * 公开 URL 为 https://raw.githubusercontent.com/tf961656585/IArt/skill-catalog/<bundleKey>。
 */
export function buildBundleUrl(bundleKey: string): string {
  return `https://raw.githubusercontent.com/tf961656585/IArt/skill-catalog/${bundleKey}`;
}

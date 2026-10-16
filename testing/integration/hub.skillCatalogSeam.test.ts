// @vitest-environment node
/**
 * Skill 目录链接缝测试：真实 catalog 拉取 + 真实契约 parse + 真实 bundle URL 构建
 * + 真实 installer 安装落盘（两端真实，只在外层挡掉网络）。
 *
 * 使命（批次 2「客户端指向切换」）：
 *   真实 apps/hub/src/client/skills/index.ts 的 fetchSkillCatalog（内部以
 *   SkillCatalogSchema.parse 做边界校验）→ 本机假上游（node http server 服务
 *   index.json 与 bundle JSON，服务端按路径后缀匹配，兼容新旧基座的路径形状）
 *   → 真实 buildBundleUrl 从目录条目构建 bundle URL → 真实 desktop-shell
 *   installer（dist/skill-store/skill-store-installer.cjs：下载 + sha512 流式
 *   校验 + SkillBundleSchema.safeParse + 写盘 + chmod）→ 真实磁盘与状态回读。
 *
 * 外层网络挡板：globalThis.fetch 被包一层「host 重写」shim——真实模块构造出的
 * URL（host + path + 查询串）被原样记录后转发到本机假上游，传输面被挡但请求
 * 语义（cache: 'no-store'、_t cache-buster、路径形状）全部来自真实模块代码。
 * installer 的传输面（node http/https）消费由 buildBundleUrl 输出推导的本机
 * 同形路径 URL（与既有 hub.skillCustomTargetsSeam.test.ts 的本机 bundle 服务
 * 同一挡板口径）。
 *
 * 契约 parse 断言：真实上游响应字节既被消费端（fetchSkillCatalog / installer）
 * 的真实 schema 校验消费，又在测试侧显式过一遍 SkillCatalogSchema，保证
 * 「真实响应形状」与「契约 schema」对得上。
 *
 * 配置事实源钉扎：SKILL_CATALOG_URL 与 buildBundleUrl 输出必须等于
 * raw.githubusercontent.com 公开仓 skill-catalog 分支地址（批次 2 终态）。
 * 红态自证：切换前运行本文件，钉扎断言应失败；链路测试不受切换影响。
 *
 * spec: docs/hub/skill-store.md
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { SkillCatalogSchema, type SkillInstallRequest, type SkillInstallResult } from '@iart/contracts';
import {
  SKILL_CATALOG_URL,
  buildBundleUrl,
  fetchSkillCatalog,
} from '../../apps/hub/src/client/skills';
import { cjsRequireAs, sharedRequire } from './helpers/cjs-mock';

// ── 批次 2 终态：配置事实源钉扎 ──

const GITHUB_SKILL_CATALOG_URL =
  'https://raw.githubusercontent.com/tf961656585/IArt/skill-catalog/skills/index.json';
const GITHUB_SKILL_BUNDLE_BASE = 'https://raw.githubusercontent.com/tf961656585/IArt/skill-catalog';

const installerPath = path.join(process.cwd(), 'apps/desktop-shell/dist/skill-store/skill-store-installer.cjs');

// fetchBundle 是 installSkill 的必传注入参数（生产 = net.fetch 搭 default session，
// 受代理治理约束，spec PROXY-003；fetcher 不属于跨进程契约，故不在 SkillInstallRequest 里）。
type BundleFetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type InstallerModule = {
  installSkill: (request: SkillInstallRequest, fetchBundle: BundleFetcher) => Promise<SkillInstallResult>;
  getInstalledSkillState: () => { skills: Array<{ skillId: string; version: string; target: string }> };
};

// ── 假上游服务的目录与 bundle（字节确定性；sha512 与目录条目一致）──

const SKILL_ID = 'seam-catalog-skill';
const SKILL_VERSION = '2.0.0';
const BUNDLE_KEY = `skills/bundles/${SKILL_ID}-${SKILL_VERSION}.json`;
const SKILL_JSON_CONTENT = JSON.stringify({ id: SKILL_ID, version: SKILL_VERSION });
const RUN_SH_CONTENT = '#!/bin/sh\necho seam-catalog\n';

const bundleJson = JSON.stringify({
  id: SKILL_ID,
  version: SKILL_VERSION,
  files: [
    { path: 'skill.json', content: SKILL_JSON_CONTENT, executable: false },
    { path: 'run.sh', content: RUN_SH_CONTENT, executable: true },
  ],
});
const bundleSha512 = crypto.createHash('sha512').update(bundleJson, 'utf8').digest('hex');

const catalogJson = JSON.stringify({
  version: 1,
  skills: [
    {
      id: SKILL_ID,
      name: 'Seam Catalog Skill',
      version: SKILL_VERSION,
      description: '目录链接缝测试夹具',
      bundleKey: BUNDLE_KEY,
      sha512: bundleSha512,
    },
  ],
});

// ── 假 HTTP 上游 ──

type FakeUpstream = {
  base: string;
  servedPaths: string[];
  close: () => Promise<void>;
};

const startFakeUpstream = async (): Promise<FakeUpstream> => {
  const servedPaths: string[] = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    servedPaths.push(pathname);
    if (pathname.endsWith('/skills/index.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(catalogJson);
      return;
    }
    if (/\/skills\/bundles\/[^/]+\.json$/.test(pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(bundleJson);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('skill catalog fake upstream did not listen on a tcp port');
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    servedPaths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeIdleConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

// ── 外层网络挡板：fetch host 重写 shim ──

type FetchShim = {
  seenUrls: string[];
  seenInits: Array<RequestInit | undefined>;
  restore: () => void;
};

const installFetchShim = (localBase: string): FetchShim => {
  const realFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  const seenInits: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seenUrls.push(rawUrl);
    seenInits.push(init);
    const parsed = new URL(rawUrl);
    // host 重写到本机假上游，path 与查询串原样保留。
    return realFetch(new URL(parsed.pathname + parsed.search, localBase), init);
  }) as typeof fetch;
  return {
    seenUrls,
    seenInits,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
};

// ── 临时 HOME 隔离（内置 agents 目标落盘到临时目录，注册表同理）──

let originalHome = '';
let originalUserProfile = '';
let tempRoot = '';
let fakeHome = '';
let upstream: FakeUpstream | null = null;

const installer = cjsRequireAs<InstallerModule>(sharedRequire(installerPath));

// fetchBundle 必传注入参数：接缝测试按 PROXY-003 允许的同形注入 Node 全局 fetch，
// bundle 由本地假上游同形路径供给。
const installWithTestFetch = (request: SkillInstallRequest): Promise<SkillInstallResult> =>
  installer.installSkill(request, (url) => fetch(url));

describe('Skill 目录链接缝（真实 fetchSkillCatalog + 真实契约 parse + 真实 installer 落盘）', () => {
  it('SKILL_CATALOG_URL 与 buildBundleUrl 指向公开仓 skill-catalog 分支（配置事实源钉扎）', () => {
    expect(SKILL_CATALOG_URL).toBe(GITHUB_SKILL_CATALOG_URL);
    expect(buildBundleUrl(BUNDLE_KEY)).toBe(`${GITHUB_SKILL_BUNDLE_BASE}/${BUNDLE_KEY}`);
  });

  it('拉取目录→契约 parse→构建 bundle URL→安装→落盘全链跑通', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iart-skill-catalog-seam-'));
    fakeHome = path.join(tempRoot, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    originalHome = process.env['HOME'] ?? '';
    originalUserProfile = process.env['USERPROFILE'] ?? '';
    process.env['HOME'] = fakeHome;
    process.env['USERPROFILE'] = fakeHome;

    upstream = await startFakeUpstream();
    const shim = installFetchShim(upstream.base);
    try {
      // 1. 真实目录拉取：请求语义（no-store + _t cache-buster）与响应契约 parse 全部在真实代码内。
      const catalog = await fetchSkillCatalog(undefined);
      // 服务端确实收到了带 _t 的目录请求（防缓存语义保留）。路径比对按 pathname，
      // 查询串（_t=）单独断言。
      const catalogRequestIndex = shim.seenUrls.findIndex(
        (url) => new URL(url).pathname.endsWith('/skills/index.json'),
      );
      const catalogRequestUrl = catalogRequestIndex >= 0 ? shim.seenUrls[catalogRequestIndex] : undefined;
      expect(catalogRequestUrl).toBeDefined();
      expect(catalogRequestUrl).toContain('_t=');
      const catalogInit = catalogRequestIndex >= 0 ? shim.seenInits[catalogRequestIndex] : undefined;
      expect(catalogInit?.cache).toBe('no-store');
      // 显式契约 parse：真实上游响应字节与消费端所用 schema 对得上。
      expect(SkillCatalogSchema.parse(JSON.parse(catalogJson))).toEqual(catalog);
      // 目录形状经真实 SkillCatalogSchema.parse 后可消费。
      expect(catalog.version).toBe(1);
      expect(catalog.skills).toHaveLength(1);
      const entry = catalog.skills[0];
      if (entry === undefined) {
        throw new Error('catalog should contain exactly one skill entry');
      }
      expect(entry.id).toBe(SKILL_ID);
      expect(entry.bundleKey).toBe(BUNDLE_KEY);
      expect(entry.sha512).toBe(bundleSha512);

      // 2. 真实 bundle URL 构建：钉扎输出形状。
      const bundleUrl = buildBundleUrl(entry.bundleKey);
      expect(bundleUrl).toBe(`${GITHUB_SKILL_BUNDLE_BASE}/${BUNDLE_KEY}`);

      // 3. 真实 installer 安装落盘：bundleUrl 用同一 bundleKey 推导的本机同形路径
      //    （外层挡板口径；sha512 取自目录条目，下载侧整包缓冲后校验）。
      const localBundleUrl = new URL(new URL(bundleUrl).pathname, upstream.base).href;
      const installResult = await installWithTestFetch({
        bundleUrl: localBundleUrl,
        sha512: entry.sha512,
        target: 'agents',
        skillId: entry.id,
      });
      expect(installResult).toEqual({
        ok: true,
        installedPath: path.join(fakeHome, '.agents', 'skills', SKILL_ID),
      });
      if (!installResult.ok) {
        throw new Error('unreachable');
      }

      // 真实磁盘写入：内容与可执行位。
      const installDir = installResult.installedPath;
      expect(fs.readFileSync(path.join(installDir, 'skill.json'), 'utf8')).toBe(SKILL_JSON_CONTENT);
      expect(fs.readFileSync(path.join(installDir, 'run.sh'), 'utf8')).toBe(RUN_SH_CONTENT);
      expect(fs.statSync(path.join(installDir, 'run.sh')).mode & 0o111).toBe(0o111);

      // 真实状态回读。
      expect(installer.getInstalledSkillState()).toEqual({
        skills: [{ skillId: SKILL_ID, version: SKILL_VERSION, target: 'agents' }],
      });

      // 假上游确实被真实请求过：目录 + bundle 两条路径。
      expect(upstream.servedPaths.some((p) => p.endsWith('/skills/index.json'))).toBe(true);
      expect(upstream.servedPaths.some((p) => p.endsWith(`/${BUNDLE_KEY}`))).toBe(true);
    } finally {
      shim.restore();
      await upstream.close().catch(() => undefined);
      upstream = null;
      if (originalHome !== '') {
        process.env['HOME'] = originalHome;
      } else {
        delete process.env['HOME'];
      }
      if (originalUserProfile !== '') {
        process.env['USERPROFILE'] = originalUserProfile;
      } else {
        delete process.env['USERPROFILE'];
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // 防御性兜底：测试主体已自行恢复环境，这里只保证异常路径不泄漏 HOME。
    if (process.env['HOME'] !== undefined && tempRoot !== '' && process.env['HOME'].startsWith(tempRoot)) {
      if (originalHome !== '') {
        process.env['HOME'] = originalHome;
      }
    }
  });
});

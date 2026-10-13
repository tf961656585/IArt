import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CustomSkillInstallTarget,
  SkillCatalog,
  SkillCatalogEntry,
  SkillInstallRequest,
  SkillInstallResult,
  SkillInstallTarget,
  SkillInstallTargetId,
  SkillInstalledState,
} from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { buildBundleUrl, compareSkillVersions, fetchSkillCatalog, mapSkillCatalogError } from '../../client/skills';

/**
 * skills 域 React 版操作 hook。逻辑与 vanilla 侧 createSkillsController
 * （controllers/skills-controller.ts）等价：
 * - 目录拉取（fetchSkillCatalog）与已安装状态（platform.getSkillInstalledState）
 *   均为组件内 state（只在本 tab 消费，不入全局 hub-store）；
 * - 自定义安装目标注册表（platform.listCustomSkillInstallTargets）同为组件内 state，
 *   与已安装状态一并加载，构成目标行集合（内置 + 自定义）；
 * - 版本比较用 client/skills 的 compareSkillVersions 数值段比较，
 *   远端低于本地（回退）不视为可更新；
 * - 单目标安装 / 全部更新走 platform.installSkill（IPC），
 *   过程提示写入本地 statusMessage（对应 vanilla 的 skillsStatus）。
 */

/**
 * 内置安装目标行（内置目标固定两行；自定义目标行由注册表承载，运行时合并进 targetRows）。
 * label 是内置目标的显示名事实源，targetShortLabel 的查表由此派生。
 */
export const INSTALL_TARGETS: Array<{ target: SkillInstallTarget; label: string; kind: 'builtin' }> = [
  { target: 'agents', label: '全局 .agents', kind: 'builtin' },
  { target: 'claude', label: 'Claude Code', kind: 'builtin' },
];

/** 安装目标行：内置 + 自定义统一形状（SkillCard 行渲染与更新收集共用） */
export interface InstallTargetRow {
  target: SkillInstallTargetId;
  label: string;
  kind: 'builtin' | 'custom';
}

const BUILTIN_LABEL_BY_TARGET: ReadonlyMap<string, string> = new Map(
  INSTALL_TARGETS.map((row) => [row.target, row.label]),
);

/**
 * 目标显示名：内置查表，自定义按 id 查注册表 name，兜底返回原始 id。
 * 未知目标不得误显示为某个内置名（历史上二元三目会把未知 id 显示成「Claude Code」）。
 */
export const targetShortLabel = (
  target: SkillInstallTargetId,
  customTargets: readonly CustomSkillInstallTarget[] = [],
): string => {
  const builtin = BUILTIN_LABEL_BY_TARGET.get(target);
  if (builtin !== undefined) return builtin;
  const custom = customTargets.find((entry) => entry.id === target);
  return custom ? custom.name : target;
};

/** 单个安装目标的安装状态（等价 vanilla SkillTargetStatus） */
export type SkillTargetStatus =
  | { kind: 'not-installed' }
  | { kind: 'installed'; version: string }
  | { kind: 'update-available'; installedVersion: string }
  | { kind: 'newer-than-remote'; version: string };

/** 待更新组合（等价 vanilla PendingUpdate） */
export interface PendingSkillUpdate {
  skill: SkillCatalogEntry;
  target: SkillInstallTargetId;
  installedVersion: string;
}

/** 安装中按钮的忙碌 key（按 skill + target 区分，等价 vanilla 逐按钮忙碌态） */
export const installBusyKey = (skillId: string, target: SkillInstallTargetId): string => `${skillId}|${target}`;

/** 查找某 skill 在某目标的已安装版本（等价 vanilla findInstalledVersion） */
export function findInstalledVersion(
  installedState: SkillInstalledState,
  skillId: string,
  target: SkillInstallTargetId,
): string | null {
  const entry = installedState.skills.find((s) => s.skillId === skillId && s.target === target);
  return entry ? entry.version : null;
}

/** 计算某 skill 在某目标的安装状态（等价 vanilla resolveTargetStatus） */
export function resolveTargetStatus(
  skill: SkillCatalogEntry,
  target: SkillInstallTargetId,
  installedState: SkillInstalledState,
): SkillTargetStatus {
  const installedVersion = findInstalledVersion(installedState, skill.id, target);
  if (installedVersion === null) return { kind: 'not-installed' };
  const cmp = compareSkillVersions(installedVersion, skill.version);
  if (cmp < 0) return { kind: 'update-available', installedVersion };
  if (cmp > 0) return { kind: 'newer-than-remote', version: installedVersion };
  return { kind: 'installed', version: installedVersion };
}

/** 收集全部待更新的（skill, target）组合（等价 vanilla collectPendingUpdates；targets = 目标行集合） */
export function collectPendingUpdates(
  catalog: SkillCatalog | null,
  installedState: SkillInstalledState,
  targets: readonly InstallTargetRow[],
): PendingSkillUpdate[] {
  if (catalog === null) return [];
  const pending: PendingSkillUpdate[] = [];
  for (const skill of catalog.skills) {
    for (const { target } of targets) {
      const targetStatus = resolveTargetStatus(skill, target, installedState);
      if (targetStatus.kind === 'update-available') {
        pending.push({ skill, target, installedVersion: targetStatus.installedVersion });
      }
    }
  }
  return pending;
}

/** 某 skill 是否存在可更新目标（卡片「有更新」徽章，等价 vanilla renderSkillCard 的 hasUpdate） */
export function skillHasUpdate(
  skill: SkillCatalogEntry,
  installedState: SkillInstalledState,
  targets: readonly InstallTargetRow[],
): boolean {
  return targets.some(({ target }) => resolveTargetStatus(skill, target, installedState).kind === 'update-available');
}

export function useSkills() {
  const { platform } = useHubRuntime();

  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [installedState, setInstalledState] = useState<SkillInstalledState>({ skills: [] });
  const [customTargets, setCustomTargets] = useState<CustomSkillInstallTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('正在读取 Skill 商店...');
  const [error, setError] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [installing, setInstalling] = useState<Set<string>>(() => new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  const updatingAllRef = useRef(false);

  /** 刷新已安装状态（等价 vanilla refreshInstalledState；失败回退空状态并留痕） */
  const refreshInstalledState = useCallback(async (): Promise<void> => {
    try {
      setInstalledState(await platform.getSkillInstalledState());
    } catch (err) {
      console.debug('[skills] getSkillInstalledState 失败，回退空状态:', err);
      setInstalledState({ skills: [] });
    }
  }, [platform]);

  /** 刷新自定义安装目标注册表（失败回退空列表并留痕） */
  const refreshCustomTargets = useCallback(async (): Promise<void> => {
    try {
      const result = await platform.listCustomSkillInstallTargets();
      setCustomTargets(result.targets);
    } catch (err) {
      console.debug('[skills] listCustomSkillInstallTargets 失败，回退空列表:', err);
      setCustomTargets([]);
    }
  }, [platform]);

  /** 目标行集合 = 内置两行 + 自定义（按注册表顺序） */
  const targetRows = useMemo<InstallTargetRow[]>(
    () => [...INSTALL_TARGETS, ...customTargets.map((entry) => ({ target: entry.id, label: entry.name, kind: 'custom' as const }))],
    [customTargets],
  );

  /** 弹层关闭后的父级刷新：自定义目标与已安装状态一并刷新（新目标目录里可能已有已装 skill） */
  const refreshTargets = useCallback(async (): Promise<void> => {
    await Promise.all([refreshInstalledState(), refreshCustomTargets()]);
  }, [refreshCustomTargets, refreshInstalledState]);

  /** 加载目录与已安装状态（进入 tab 或手动刷新时调用，等价 vanilla loadCatalog） */
  const loadSkills = useCallback(async (): Promise<void> => {
    // 取消上一次未完成的拉取
    if (abortControllerRef.current !== null) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);
    setStatusMessage('正在读取 Skill 商店...');
    try {
      await Promise.all([refreshInstalledState(), refreshCustomTargets()]);
      const fetched = await fetchSkillCatalog(controller.signal);
      setCatalog(fetched);
      setStatusMessage(`共 ${fetched.skills.length} 个 Skill`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.debug('[skills] loadSkills 被中止，跳过本次结果');
        return;
      }
      const message = mapSkillCatalogError(err);
      setError(message);
      setStatusMessage(message);
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  }, [refreshCustomTargets, refreshInstalledState]);

  /**
   * 执行一次安装/更新（下载 bundle → IPC 写盘）。返回是否成功。
   * 等价 vanilla installOne + handleInstall：失败写状态文案，
   * 成功刷新已安装状态并重渲染。
   */
  const installSkill = useCallback(
    async (skill: SkillCatalogEntry, target: SkillInstallTargetId): Promise<boolean> => {
      if (updatingAllRef.current) return false;
      const key = installBusyKey(skill.id, target);
      setInstalling((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });

      const request: SkillInstallRequest = {
        bundleUrl: buildBundleUrl(skill.bundleKey),
        sha512: skill.sha512,
        target,
        skillId: skill.id,
      };

      let result: SkillInstallResult;
      try {
        result = await platform.installSkill(request);
      } catch {
        setStatusMessage('没能安装，请重试');
        return false;
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }

      if (!result.ok) {
        setStatusMessage('没能安装，请重试');
        return false;
      }

      await refreshInstalledState();
      setStatusMessage(`${skill.name} 已安装到 ${targetShortLabel(target, customTargets)}`);
      return true;
    },
    [customTargets, platform, refreshInstalledState],
  );

  /** 定位 skill 安装目录（LFJ-007）：路径解析归主进程，这里只传 skillId + target。 */
  const revealInstallFolder = useCallback(
    async (skill: SkillCatalogEntry, target: SkillInstallTargetId): Promise<void> => {
      const result = await platform.revealSkillInstallFolder({ skillId: skill.id, target });
      if (!result.ok) {
        // 失败必须给可见反馈（LFJ spec 失败语义），不静默、不打开别的位置替代
        if (result.reason === 'path-missing') {
          setStatusMessage('没能找到 Skill 安装目录，它可能已被移动或删除');
        } else {
          setStatusMessage('没能打开所在文件夹，请重试');
        }
      }
    },
    [platform],
  );

  /** 全部更新：顺序更新所有「远端版本更高」的（skill, target）组合（等价 vanilla handleUpdateAll） */
  const updateAll = useCallback(async (): Promise<void> => {
    if (updatingAllRef.current) return;
    const pending = collectPendingUpdates(catalog, installedState, targetRows);
    if (pending.length === 0) return;

    updatingAllRef.current = true;
    setUpdatingAll(true);

    let succeeded = 0;
    let failed = 0;
    let index = 0;
    for (const item of pending) {
      index += 1;
      setStatusMessage(
        `正在更新第 ${index}/${pending.length} 个：${item.skill.name}（${targetShortLabel(item.target, customTargets)}）`,
      );
      const ok = await installSkill(item.skill, item.target);
      if (ok) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }

    updatingAllRef.current = false;
    setUpdatingAll(false);
    setStatusMessage(
      failed === 0
        ? `已更新 ${succeeded} 个，全部完成`
        : `已更新 ${succeeded} 个，${failed} 个没能更新，请重试`,
    );
  }, [catalog, customTargets, installSkill, installedState, targetRows]);

  /** 待更新组合（驱动「全部更新」按钮的计数与可见性） */
  const pendingUpdates = useMemo(
    () => collectPendingUpdates(catalog, installedState, targetRows),
    [catalog, installedState, targetRows],
  );

  // 卸载时中止进行中的目录拉取，避免卸载后 setState
  useEffect(() => {
    return () => {
      if (abortControllerRef.current !== null) abortControllerRef.current.abort();
    };
  }, []);

  return {
    catalog,
    installedState,
    customTargets,
    targetRows,
    loading,
    statusMessage,
    error,
    updatingAll,
    installing,
    pendingUpdates,
    loadSkills,
    installSkill,
    revealInstallFolder,
    refreshTargets,
    updateAll,
  };
}

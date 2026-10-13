import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHubRuntime } from '../../components/providers/HubAppProvider';

const LAST_PROJECT_KEY = 'iart.hub.packages.lastProjectPath';

/**
 * packages 域操作 hook：项目选择 + 包列表 + 搜索 + 重命名/删除/定位。
 * 数据经 platform bridge 的包管理 IPC（Main 进程扫描 {project}/packages/ 自描述包文件夹），
 * 过程提示走本地 statusMessage（与 useProjects 同一状态条模式）。
 */
export function usePackages() {
  const { platform } = useHubRuntime();
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([]);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('');
  const [packages, setPackages] = useState<Awaited<ReturnType<typeof platform.packagesList>>['packages']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [search, setSearch] = useState('');

  const loadProjects = useCallback(async (): Promise<void> => {
    try {
      const data = await platform.storageListProjects();
      const list = (data.projects ?? []).map((p) => ({ name: p.name, path: p.path }));
      setProjects(list);
      setSelectedProjectPath((current) => {
        if (current && list.some((p) => p.path === current)) return current;
        try {
          const last = window.localStorage.getItem(LAST_PROJECT_KEY);
          if (last !== null && last.trim() !== '' && list.some((p) => p.path === last)) return last;
        } catch {
          // 存储不可用时回退首个项目。
        }
        return list[0]?.path ?? '';
      });
    } catch (err: unknown) {
      console.error('[hub] loadProjects for packages error:', err);
      setError('没能读取项目列表，请刷新重试');
    }
  }, [platform]);

  const loadPackages = useCallback(
    async (projectPath: string): Promise<void> => {
      if (!projectPath) {
        setPackages([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await platform.packagesList({ projectPath });
        setPackages(data.packages ?? []);
      } catch (err: unknown) {
        console.error('[hub] packagesList error:', err);
        setError('没能读取包列表，请刷新重试');
      } finally {
        setLoading(false);
      }
    },
    [platform],
  );

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectPath) return;
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, selectedProjectPath);
    } catch {
      // 忽略持久化失败。
    }
    void loadPackages(selectedProjectPath);
  }, [selectedProjectPath, loadPackages]);

  const renamePackage = useCallback(
    async (packageId: string, name: string): Promise<boolean> => {
      if (!selectedProjectPath) return false;
      try {
        const result = await platform.packagesRename({
          projectPath: selectedProjectPath,
          packageId,
          name,
        });
        setPackages((current) =>
          current.map((pkg) => (pkg.packageId === packageId ? result.package : pkg)),
        );
        setStatusMessage(`已重命名为「${result.package.name}」`);
        return true;
      } catch (err: unknown) {
        console.error('[hub] packagesRename error:', err);
        setStatusMessage('没能重命名，请关掉正在使用这个包的窗口后重试');
        return false;
      }
    },
    [platform, selectedProjectPath],
  );

  const deletePackage = useCallback(
    async (packageId: string, name: string): Promise<boolean> => {
      if (!selectedProjectPath) return false;
      try {
        const result = await platform.packagesDelete({
          projectPath: selectedProjectPath,
          packageId,
        });
        if (result.ok) {
          setPackages((current) => current.filter((pkg) => pkg.packageId !== packageId));
          setStatusMessage(`已删除包「${name}」（已移入系统回收站）`);
        } else {
          setStatusMessage(`没能删除包「${name}」，请重试`);
        }
        return result.ok;
      } catch (err: unknown) {
        console.error('[hub] packagesDelete error:', err);
        setStatusMessage(`没能删除包「${name}」，请重试`);
        return false;
      }
    },
    [platform, selectedProjectPath],
  );

  const revealPackage = useCallback(
    async (packageId: string): Promise<void> => {
      if (!selectedProjectPath) return;
      try {
        const result = await platform.packagesReveal({
          projectPath: selectedProjectPath,
          packageId,
        });
        if (!result.ok) setStatusMessage('没能找到这个包，它可能已被移动或删除');
      } catch (err: unknown) {
        console.error('[hub] packagesReveal error:', err);
        setStatusMessage('没能找到这个包');
      }
    },
    [platform, selectedProjectPath],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return packages;
    return packages.filter((pkg) => pkg.name.toLowerCase().includes(q));
  }, [packages, search]);

  return {
    projects,
    selectedProjectPath,
    setSelectedProjectPath,
    packages,
    filtered,
    loading,
    error,
    statusMessage,
    setStatusMessage,
    search,
    setSearch,
    refresh: () => void loadPackages(selectedProjectPath),
    renamePackage,
    deletePackage,
    revealPackage,
  };
}

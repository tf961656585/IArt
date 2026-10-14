import { useEffect, useState } from 'react';
import { Button } from '@iart/ui';
import { Blocks, CloudDownload, FolderCog, RefreshCw } from 'lucide-react';
import { SkillCard } from './SkillCard';
import { ManageInstallTargetsDialog } from './ManageInstallTargetsDialog';
import { HubTopBand } from '../../components/HubTopBand';
import { useSkills } from './SkillsTab.hooks';

/**
 * Skill 商店 tab：刷新 + 管理安装目标 + 全部更新 + 状态栏 + Skill 列表 + 空态。
 * tab 挂载即激活（进入即拉取远端目录 + 刷新已安装状态），
 * 卸载时由 useSkills 中止进行中的拉取。
 */
export function SkillsTab() {
  const {
    catalog,
    installedState,
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
  } = useSkills();
  const [manageOpen, setManageOpen] = useState(false);

  // 进入 tab 时加载目录与已安装状态（等价 vanilla onTabActivated → loadCatalog）
  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const statusText: string = error !== null ? error : statusMessage;
  const showUpdateAll: boolean = updatingAll || pendingUpdates.length > 0;

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）：标题左、操作右 */}
      <HubTopBand className="justify-between">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold">Skill 商店</h1>
          <span className="text-sm text-muted-foreground">浏览、安装与更新 Skill</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void loadSkills()}>
            <RefreshCw /> 刷新
          </Button>
          <Button variant="outline" onClick={() => setManageOpen(true)}>
            <FolderCog /> 管理安装目标
          </Button>
          {showUpdateAll ? (
            <Button onClick={() => void updateAll()} disabled={loading} loading={updatingAll}>
              <CloudDownload />
              全部更新（{pendingUpdates.length}）
            </Button>
          ) : null}
        </div>
      </HubTopBand>
      <div className="flex shrink-0 items-center border-b border-border px-4 py-1 text-xs">
        {error !== null ? (
          <span className="text-destructive">{statusText}</span>
        ) : (
          <span className="text-muted-foreground">{statusText}</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading && catalog === null ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">正在读取 Skill 商店...</div>
        ) : catalog === null || catalog.skills.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Blocks className="h-10 w-10 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">商店里暂时还没有可安装的 Skill，稍后再来看看</div>
            <Button variant="outline" onClick={() => void loadSkills()}>
              <RefreshCw /> 重新加载
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {catalog.skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                installedState={installedState}
                targetRows={targetRows}
                busyKeys={installing}
                disabled={updatingAll}
                onInstall={(s, target) => void installSkill(s, target)}
                onReveal={(s, target) => void revealInstallFolder(s, target)}
              />
            ))}
          </div>
        )}
      </div>
      <ManageInstallTargetsDialog
        open={manageOpen}
        onOpenChange={(open) => {
          setManageOpen(open);
          // 关闭时刷新自定义目标与已安装状态：新目标目录里可能已有已装 skill
          if (!open) void refreshTargets();
        }}
      />
    </div>
  );
}

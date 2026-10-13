import { useEffect } from 'react';
import { Button, Progress } from '@iart/ui';
import { useAppUpdate, updateProgressPercent, updateProgressText } from './UpdateSection.hooks';
import { formatDateTime } from '../../client/utils/time';
import { SettingsSection } from './components/SettingsSection';

/**
 * 设置页「检查更新」子单元（通用设置分区）：当前版本 + 状态栏 + 检查按钮 + 诊断工具（打开日志/复制诊断）+ 进度条。
 * 逻辑与 vanilla createUpdateController 的 renderStatus/renderProgress 等价；
 * tab 挂载即激活手动检查（等价 vanilla onSettingsTabActivated → requestCheckUpdates(true)）。
 * 全局 banner/弹窗由 App 顶层的 UpdateBanner 承载（同一 useAppUpdate 数据源）。
 */
export function UpdateSection() {
  const { projection, appVersion, notice, isElectron, checkUpdates, openLog, openLogFolder, copyDiagnostics } = useAppUpdate();

  // 进入设置 tab 时手动检查一次更新（等价 vanilla onSettingsTabActivated → requestCheckUpdates(true)）
  useEffect(() => {
    void checkUpdates(true);
  }, [checkUpdates]);

  const versionSuffix: string = projection.version ? '（' + projection.version + '）' : '';

  const statusLines: string[] = [];
  if (!isElectron) statusLines.push('请在桌面应用中检查更新');
  else if (projection.checking) statusLines.push('正在检查更新...');
  else if (projection.error) statusLines.push('没能完成更新，请检查网络后重新检查');
  else if (projection.downloaded) statusLines.push('新版本已下载完成，可以安装了');
  else if (projection.downloading) statusLines.push('正在下载更新' + versionSuffix);
  else if (projection.available) statusLines.push('发现新版本' + versionSuffix);
  else if (projection.lastCheckedAt) statusLines.push('上次检查：' + formatDateTime(projection.lastCheckedAt));

  const statusText: string = notice !== null ? notice : statusLines.join('\n');

  const showProgress: boolean = projection.downloading && projection.progress !== null;

  return (
    <SettingsSection title="检查更新">
      {/* 至多一行（visual-design §8.5 密度）：左侧信息组（版本 + 状态文本），右侧动作组就近靠右；
          状态文本保留 whitespace-pre-line 折行能力，min-w-0 让长文本先让位换行而非撑破一行 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">当前版本</span>
          <span className="font-mono">{appVersion !== null ? 'v' + appVersion : '未知'}</span>
        </div>

        <div className="min-w-0 whitespace-pre-line text-xs text-muted-foreground">{statusText}</div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void checkUpdates(true)} disabled={!isElectron || projection.checking || projection.downloading}>
            {projection.checking ? '正在检查...' : '重新检查'}
          </Button>
          {isElectron ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void openLog()}>
                打开更新日志
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void openLogFolder()}>
                打开日志文件夹
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()}>
                复制诊断
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {showProgress ? (
        <div className="flex flex-col gap-1">
          <Progress value={updateProgressPercent(projection.progress)} />
          <div className="text-xs text-muted-foreground">{updateProgressText(projection.progress)}</div>
        </div>
      ) : null}
    </SettingsSection>
  );
}

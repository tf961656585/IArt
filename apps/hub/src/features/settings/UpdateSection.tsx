import { useEffect } from 'react';
import { Button, Progress } from '@iart/ui';
import {
  useAppUpdate,
  updateInstallLabel,
  updateProgressPercent,
  updateProgressText,
} from './UpdateSection.hooks';
import { formatDateTime } from '../../client/utils/time';
import { SettingsSection } from './components/SettingsSection';

/**
 * 设置页「检查更新」子单元（设计基准 docs/desktop-updates/更新交互重设计-design.md §3.3）。
 * - 左侧版本信息与状态行，右侧动作组；诊断工具（打开更新日志 / 打开日志文件夹 / 复制诊断）不变。
 * - 状态行永远渲染真实状态；取消、节流、检查失败等提示走独立提示行，不覆盖状态行。
 * - 进入设置页：先 initialize（应用版本 / 日志信息 / 状态快照），再对非 Linux 触发一次检查；
 *   Linux 不发起应用内检查，只渲染「前往下载页」。
 */
export function UpdateSection() {
  const {
    projection,
    appVersion,
    notice,
    isElectron,
    checkUpdates,
    download,
    cancelDownload,
    install,
    openDownloadPage,
    openLog,
    openLogFolder,
    copyDiagnostics,
    initialize,
  } = useAppUpdate();

  // 进入设置 tab：先初始化本实例的诊断数据源，再触发一次检查（Linux 不检查）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = await initialize();
      if (cancelled || !isElectron) return;
      if (snapshot !== null && snapshot.platform === 'linux') return;
      await checkUpdates(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [initialize, checkUpdates, isElectron]);

  const isLinux: boolean = projection.platform === 'linux';
  const version: string = projection.version || '未知';
  const checkError: boolean = projection.error !== null && projection.errorPhase !== 'download';
  const downloadError: boolean = projection.error !== null && projection.errorPhase === 'download';

  const statusText = ((): string => {
    if (!isElectron) return '请在桌面应用中检查更新';
    if (isLinux) return 'Linux 版需要从下载页获取新版本';
    if (projection.checking) return '正在检查更新…';
    if (downloadError) return '更新下载没能完成，可重试';
    if (checkError) return '没能检查更新，可稍后重新检查';
    if (projection.downloaded) return '新版本 ' + version + ' 已下载完成';
    if (projection.downloading) return '正在下载更新 ' + version;
    if (projection.available) return '发现新版本 ' + version;
    if (projection.status === 'not-available') {
      return projection.lastCheckedAt
        ? '已是最新版本；上次检查：' + formatDateTime(projection.lastCheckedAt)
        : '已是最新版本';
    }
    return '';
  })();

  const showProgress: boolean = !isLinux && projection.downloading && projection.progress !== null;

  const recheckButton = (
    <Button
      size="sm"
      loading={projection.checking}
      disabled={!isElectron || projection.checking || projection.downloading}
      onClick={() => void checkUpdates(true, true)}
    >
      重新检查
    </Button>
  );

  const renderActions = () => {
    if (isLinux) {
      return (
        <Button size="sm" onClick={() => void openDownloadPage()}>
          前往下载页
        </Button>
      );
    }
    if (downloadError) {
      return (
        <>
          <Button size="sm" onClick={() => void download()}>
            重试下载
          </Button>
          {recheckButton}
        </>
      );
    }
    if (projection.downloaded) {
      return (
        <>
          <Button size="sm" onClick={() => void install()}>
            {updateInstallLabel(projection)}
          </Button>
          {recheckButton}
        </>
      );
    }
    if (projection.downloading) {
      return (
        <>
          <Button size="sm" onClick={() => void cancelDownload()}>
            取消下载
          </Button>
          {recheckButton}
        </>
      );
    }
    if (projection.available) {
      return (
        <>
          <Button size="sm" onClick={() => void download()}>
            下载
          </Button>
          {recheckButton}
        </>
      );
    }
    return recheckButton;
  };

  return (
    <SettingsSection title="检查更新">
      {/* 至多一行（visual-design §8.5 密度）：左侧信息组（版本 + 状态文本），右侧动作组就近靠右；
          min-w-0 让长文本先让位换行而非撑破一行 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">当前版本</span>
          <span className="font-mono">{appVersion !== null ? 'v' + appVersion : '未知'}</span>
        </div>

        <div className="min-w-0 whitespace-pre-line text-xs text-muted-foreground">{statusText}</div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {renderActions()}
          {isElectron ? (
            <>
              {/* 打开更新日志/打开日志文件夹 = 去某处看内容（按钮样式标准 §4 link 判据「link 是去、ghost 是做」）→ link；
                  复制诊断 = 对当前对象执行的写入动作 → ghost */}
              <Button size="sm" variant="link" onClick={() => void openLog()}>
                打开更新日志
              </Button>
              <Button size="sm" variant="link" onClick={() => void openLogFolder()}>
                打开日志文件夹
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void copyDiagnostics()}>
                复制诊断
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {notice !== null ? <div className="text-xs text-muted-foreground">{notice}</div> : null}

      {showProgress ? (
        <div className="flex flex-col gap-1">
          <Progress value={updateProgressPercent(projection.progress)} />
          <div className="text-xs text-muted-foreground">{updateProgressText(projection.progress)}</div>
        </div>
      ) : null}
    </SettingsSection>
  );
}

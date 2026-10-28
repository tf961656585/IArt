import { useEffect } from 'react';
import { Button, Progress } from '@iart/ui';
import { Package } from 'lucide-react';
import {
  shouldShowUpdateBanner,
  updateBannerTitle,
  updateDetailText,
  updateInstallLabel,
  updateProgressPercent,
  updateProgressText,
  useAppUpdate,
} from './UpdateSection.hooks';

/**
 * 全局更新横幅（App 顶层常驻；设计基准 docs/desktop-updates/更新交互重设计-design.md §3.2）。
 * - 唯一提醒表面：更新弹窗已删除，不做隐藏保留。
 * - 挂载时 initialize：订阅事件 + 恢复状态快照 + 应用版本 + 日志信息。
 * - 展示条件：available / downloading / downloaded / 就地转失败的 download-error，且未被「稍后」收起；
 *   Linux 永不出现，checking / not-available / check-error 永不出现（判定在 shouldShowUpdateBanner 收口）。
 * -「稍后」只收起本次提醒：不发命令、不改状态，后续事件不重新弹出。
 */
export function UpdateBanner() {
  const { projection, bannerDismissed, dismissBanner, download, cancelDownload, install, initialize } = useAppUpdate();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  const bannerVisible: boolean = shouldShowUpdateBanner(projection) && !bannerDismissed;
  const showProgress: boolean = projection.downloading && projection.progress !== null;

  const renderPrimaryAction = () => {
    if (projection.downloading) {
      return (
        <Button size="sm" onClick={() => void cancelDownload()}>
          取消下载
        </Button>
      );
    }
    if (projection.downloaded) {
      return (
        <Button size="sm" onClick={() => void install()}>
          {updateInstallLabel(projection)}
        </Button>
      );
    }
    if (projection.error) {
      return (
        <Button size="sm" onClick={() => void download()}>
          重试下载
        </Button>
      );
    }
    return (
      <Button size="sm" onClick={() => void download()}>
        下载
      </Button>
    );
  };

  if (!bannerVisible) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-feedback flex justify-center px-4 pt-4 pointer-events-none"
    >
      <div className="pointer-events-auto flex w-full max-w-md flex-col gap-2 rounded-md border border-border bg-card p-4 shadow-lg">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Package className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{updateBannerTitle(projection)}</span>
        </div>
        <div className="text-xs text-muted-foreground">{updateDetailText(projection)}</div>
        {showProgress ? (
          <div className="flex flex-col gap-1">
            <Progress value={updateProgressPercent(projection.progress)} />
            <div className="text-xs text-muted-foreground">{updateProgressText(projection.progress)}</div>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          {renderPrimaryAction()}
          <Button size="sm" variant="ghost" onClick={dismissBanner}>
            稍后
          </Button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Progress } from '@iart/ui';
import { Package } from 'lucide-react';
import {
  shouldShowUpdateBanner,
  updateBannerTitle,
  updateDetailText,
  updateInstallText,
  updateProgressPercent,
  updateProgressText,
  useAppUpdate,
} from './UpdateSection.hooks';

/**
 * 全局更新 banner + 更新弹窗（App 顶层常驻，等价 vanilla 的 updateBanner / updateModal）。
 * - 挂载时 initialize：订阅事件 + 恢复状态快照 + 应用版本 + 日志信息；
 *   快照为 available 且用户未忽略过弹窗时自动展示弹窗（等价 vanilla initialize → showUpdateModal）。
 * - banner 展示条件：available / downloading / downloaded / error，且未点击「稍后」；
 *   available / downloaded / error 事件到达时重置忽略标记（等价 vanilla 事件处理）。
 * - 弹窗关闭仅标记忽略，不再自动重开（等价 vanilla updateModalDismissed 不重置）。
 */
export function UpdateBanner() {
  const { projection, rawState, bannerDismissed, setBannerDismissed, download, install, initialize } = useAppUpdate();

  const [modalOpen, setModalOpen] = useState(false);
  const modalDismissedRef = useRef(false);

  // 挂载时初始化（等价 vanilla initialize）：恢复快照；available 且未忽略时展示弹窗
  useEffect(() => {
    let cancelled = false;
    void initialize().then((available: boolean) => {
      if (!cancelled && available && !modalDismissedRef.current) setModalOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [initialize]);

  const dismissModal = (): void => {
    modalDismissedRef.current = true;
    setModalOpen(false);
  };

  const bannerVisible: boolean = shouldShowUpdateBanner(projection) && !bannerDismissed;
  const showProgress: boolean = projection.downloading && projection.progress !== null;

  return (
    <>
      {bannerVisible ? (
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
              {!projection.downloaded ? (
                <Button
                  size="sm"
                  onClick={() => void download()}
                  disabled={projection.downloading || projection.checking}
                >
                  {projection.error ? '重试下载' : '立即下载'}
                </Button>
              ) : null}
              {projection.downloaded ? (
                <Button size="sm" onClick={() => void install()}>
                  {updateInstallText(rawState)}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setBannerDismissed(true)}>
                稍后
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog open={modalOpen} onOpenChange={(open) => { if (!open) dismissModal(); }}>
        <DialogContent form="standard" size="compact">
          <DialogHeader>
            <DialogTitle>{updateBannerTitle(projection)}</DialogTitle>
            <DialogDescription>{updateDetailText(projection)}</DialogDescription>
          </DialogHeader>
          {showProgress ? (
            <div className="flex flex-col gap-1">
              <Progress value={updateProgressPercent(projection.progress)} />
              <div className="text-xs text-muted-foreground">{updateProgressText(projection.progress)}</div>
            </div>
          ) : null}
          <DialogFooter>
            {!projection.downloaded ? (
              <Button onClick={() => void download()} disabled={projection.downloading || projection.checking}>
                {projection.error ? '重试下载' : '立即下载'}
              </Button>
            ) : null}
            {projection.downloaded ? (
              <Button onClick={() => void install()}>{updateInstallText(rawState)}</Button>
            ) : null}
            <Button variant="ghost" onClick={dismissModal}>
              稍后
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppUpdateEvent, AppUpdateErrorPayload, AppUpdateLogInfoResult, AppUpdateProgress, AppUpdateState } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { copyText } from '../../client/utils/clipboard';
import { formatBytes, formatTime } from '../../client/utils/time';

/**
 * 检查更新子域 React 版操作 hook。逻辑与 vanilla 侧 createUpdateController
 * （controller-helpers/update-controller-helper.ts）等价，供两处共享：
 * - UpdateBanner（App 顶层常驻）：挂载时 initialize（订阅事件 + 恢复快照 +
 *   加载应用版本与日志信息 + available 时展示弹窗）；
 * - UpdateSection（设置 tab）：挂载时 requestCheckUpdates(true)
 *   （等价 vanilla onSettingsTabActivated）。
 *
 * platform.onAppUpdateEvent 无退订 API，卸载后以 mountedRef 守卫阻止
 * 对已卸载组件的 setState（多实例订阅互不冲突，与 vanilla 多 listener 一致）。
 *
 * 失败展示规则（spec docs/desktop-updates/README.md「自动更新策略」）：
 * 失败不主动唤起全局横幅；仅横幅已展示发现/下载流程时允许就地转为失败态；
 * error 事件一律不重置「稍后」忽略标记（available/downloaded 是正向新信号，保留重置）。
 */

/** 错误相位：由事件流推导（桥接保证 checking/downloading 状态先于 error 到达），不进跨进程契约 */
export type UpdateErrorPhase = 'check' | 'download';

/** 更新状态 UI 投影（等价 vanilla update-controller-state projectUpdateState） */
export interface UpdateUiProjection {
  status: AppUpdateState['status'];
  checking: boolean;
  available: boolean;
  downloading: boolean;
  downloaded: boolean;
  version: string;
  progress: AppUpdateProgress | null;
  error: AppUpdateErrorPayload | null;
  /** 失败相位：check=检查阶段失败，download=下载阶段失败 */
  errorPhase: UpdateErrorPhase | null;
  /** 失败是否允许在全局横幅就地展示（仅横幅已展示发现/下载流程时为 true；主动唤起路径一律 false） */
  errorBannerEligible: boolean;
  lastCheckedAt: number | null;
  downloadPath: string | null;
  logPath: string | null;
}

const emptyProjection = (): UpdateUiProjection => ({
  status: 'idle',
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  version: '',
  progress: null,
  error: null,
  errorPhase: null,
  errorBannerEligible: false,
  lastCheckedAt: null,
  downloadPath: null,
  logPath: null,
});

const projectUpdateState = (state: AppUpdateState | null | undefined): UpdateUiProjection => {
  if (!state) return emptyProjection();
  const version: string =
    state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded' || state.status === 'error'
      ? state.latestVersion || ''
      : '';
  return {
    status: state.status,
    checking: state.status === 'checking',
    available: state.status === 'available',
    downloading: state.status === 'downloading',
    downloaded: state.status === 'downloaded',
    version,
    progress: state.status === 'downloading' ? state.progress : null,
    error: state.status === 'error' ? state.error : null,
    errorPhase: null,
    errorBannerEligible: false,
    lastCheckedAt: state.lastCheckedAt,
    downloadPath: state.status === 'downloaded' ? state.downloadPath : null,
    logPath: state.logPath,
  };
};

export interface UpdaterLogInfoState {
  path: string;
  exists: boolean;
  size: number;
  updatedAt: number | null;
}

/** 下载进度百分比（0-100，progress 缺失时按 0） */
export const updateProgressPercent = (progress: AppUpdateProgress | null): number =>
  Math.max(0, Math.min(100, Number(progress?.percent) || 0));

/** 下载进度文本（等价 utils/time applyProgress 的 text 分支） */
export const updateProgressText = (progress: AppUpdateProgress | null): string => {
  if (!progress) return '准备下载...';
  const speed: string = formatBytes(Number(progress.bytesPerSecond) || 0) + '/s';
  const transferred: string = formatBytes(Number(progress.transferred) || 0);
  const total: string = formatBytes(Number(progress.total) || 0);
  return transferred + ' / ' + total + ' (' + speed + ')';
};

/** banner 标题（等价 vanilla titleText） */
export const updateBannerTitle = (projection: UpdateUiProjection): string =>
  projection.downloaded
    ? '更新已就绪'
    : projection.error
      ? '更新没能完成'
      : projection.downloading
        ? '正在下载更新'
        : projection.available
          ? '发现新版本'
          : '更新';

/** banner/modal 描述文本：失败按相位分流，不归因网络（发布侧故障用户重试也无法修复） */
export const updateDetailText = (projection: UpdateUiProjection): string => {
  if (projection.error) {
    return projection.errorPhase === 'download' ? '下载没有完成，可稍后重试' : '没能检查更新，可稍后重新检查';
  }
  if (projection.downloaded) return '版本 ' + (projection.version || '未知') + ' 已下载完成，可以安装了';
  if (projection.downloading) return '正在下载版本 ' + (projection.version || '未知');
  if (projection.available) return '发现新版本 ' + (projection.version || '未知') + '，正在自动下载';
  return '';
};

/** 安装按钮文案：darwin 打开安装包，其余立即安装并重启（等价 vanilla installText） */
export const updateInstallText = (rawState: AppUpdateState | null): string =>
  rawState !== null && rawState.platform === 'darwin' ? '打开安装包' : '立即安装并重启';

/** banner 是否应展示（available / downloading / downloaded / 已获准就地展示的 error）：
 * 失败不主动唤起横幅，仅横幅已展示发现/下载流程时允许就地转为失败态 */
export const shouldShowUpdateBanner = (projection: UpdateUiProjection): boolean =>
  projection.available || projection.downloading || projection.downloaded ||
  (projection.error !== null && projection.errorBannerEligible);

export function useAppUpdate() {
  const { platform } = useHubRuntime();

  const [projection, setProjection] = useState<UpdateUiProjection>(emptyProjection());
  const [rawState, setRawState] = useState<AppUpdateState | null>(null);
  const [logInfo, setLogInfo] = useState<UpdaterLogInfoState>({ path: '', exists: false, size: 0, updatedAt: null });
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bannerDismissed, setBannerDismissedState] = useState(false);

  const mountedRef = useRef(true);
  const isElectron: boolean = platform.isElectron();

  // 投影/忽略标记/最近非失败状态的 ref 镜像：applyState 是事件与命令结果的统一收口，
  // 失败展示资格依赖「前一投影在展示什么 + 是否已被忽略」，闭包里的 state 会过期，必须走 ref。
  const projectionRef = useRef<UpdateUiProjection>(emptyProjection());
  const bannerDismissedRef = useRef(false);
  const lastNonErrorStatusRef = useRef<AppUpdateState['status'] | null>(null);

  const setBannerDismissed = useCallback((value: boolean): void => {
    bannerDismissedRef.current = value;
    setBannerDismissedState(value);
  }, []);

  /**
   * 应用状态快照（rawState 保留旧值，投影始终重算）。
   * 失败展示规则在此统一收口：error 相位取最近一次非 error 状态（downloading→download，
   * 其余→check 保守默认）；横幅资格 = 前一投影正展示 available/downloading 且未被忽略
   * （就地降级），或失败态已在横幅上展示（连续失败保持展示）。横幅不在展示流程时
   * （含 downloaded 就绪态）失败一律不上横幅——downloaded 的安装引导不能被检查失败顶掉，
   * 而桥接在非 downloaded 状态下本就会拒绝安装，保持展示只会造出点不动的按钮。
   */
  const applyState = useCallback((state: AppUpdateState | null | undefined): void => {
    if (state !== null && state !== undefined) setRawState(state);
    const prev = projectionRef.current;
    const next = projectUpdateState(state);
    if (next.status === 'error') {
      next.errorPhase = lastNonErrorStatusRef.current === 'downloading' ? 'download' : 'check';
      next.errorBannerEligible =
        prev.status === 'error'
          ? prev.errorBannerEligible
          : (prev.status === 'available' || prev.status === 'downloading') && !bannerDismissedRef.current;
    } else {
      lastNonErrorStatusRef.current = next.status;
    }
    projectionRef.current = next;
    setProjection(next);
  }, []);

  /** 手动检查更新（等价 vanilla requestCheckUpdates） */
  const checkUpdates = useCallback(
    async (manual: boolean): Promise<void> => {
      if (!platform.isElectron()) {
        setNotice('请在桌面应用中检查更新');
        return;
      }
      try {
        const result = await platform.checkForUpdates(manual);
        applyState(result.state);
        if (result.status === 'skipped') {
          setNotice(result.reason === 'throttled' ? '刚刚检查过，请稍后再试' : '正在检查更新，请稍候');
        }
      } catch (error: unknown) {
        console.debug('[update] checkForUpdates 失败:', error);
        setNotice('没能检查更新，请稍后重试');
      }
    },
    [applyState, platform],
  );

  /** 触发更新下载（等价 vanilla requestUpdateDownload）：失败反馈走 notice 与横幅就地降级，
   * 不强制重展示已忽略的横幅 */
  const download = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    const result = await platform.startUpdateDownload();
    applyState(result.state);
    if (result.status === 'failed') {
      setNotice('下载没能完成，请重试');
    }
  }, [applyState, platform]);

  /** 安装/打开安装包（等价 vanilla requestInstallUpdate） */
  const install = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    const result = await platform.installUpdate();
    applyState(result.state);
  }, [applyState, platform]);

  /** 打开更新日志目录（等价 vanilla openUpdateLog） */
  const openLog = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    const result = await platform.revealUpdaterLog();
    if (!result.success) setNotice('没能打开更新日志，请重试');
  }, [platform]);

  /** 打开业务日志目录（LFJ-008：backend.log 落存储根 logs/，路径解析归主进程） */
  const openLogFolder = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    const result = await platform.revealBackendLogFolder();
    if (!result.success) setNotice('没能打开日志文件夹，请重试');
  }, [platform]);

  /** 复制诊断信息（等价 vanilla copyDiagnostics） */
  const copyDiagnostics = useCallback(async (): Promise<void> => {
    const diagnostics = {
      time: formatTime(Date.now()),
      appVersion: appVersion ?? '',
      updateState: rawState,
      updaterLog: logInfo,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent || '' : '',
    };
    const copied: boolean = await copyText(JSON.stringify(diagnostics, null, 2));
    setNotice(copied ? '已复制诊断信息到剪贴板' : '没能复制，请重试');
    window.setTimeout(() => {
      if (mountedRef.current) setNotice(null);
    }, 1200);
  }, [appVersion, logInfo, rawState]);

  /** 加载更新日志文件信息（等价 vanilla loadLogInfo） */
  const loadLogInfo = useCallback(async (): Promise<void> => {
    const info: AppUpdateLogInfoResult | null = await platform.getUpdaterLogInfo().catch(() => null);
    if (info === null || !info.success) return;
    setLogInfo({
      path: info.path || '',
      exists: Boolean(info.exists),
      size: Number(info.size) || 0,
      updatedAt: typeof info.updatedAt === 'number' ? info.updatedAt : null,
    });
  }, [platform]);

  /**
   * 初始化（等价 vanilla initialize）：订阅事件 + 应用版本 + 状态快照 + 日志信息。
   * 返回初始化快照是否为 available，供弹窗「首次展示」判定。
   */
  const initialize = useCallback(async (): Promise<boolean> => {
    if (!platform.isElectron()) return false;
    const version: string | null = await platform.getAppVersion().catch(() => null);
    if (version !== null) setAppVersion(version);
    const snapshot: AppUpdateState | null = await platform.getUpdateState().catch(() => null);
    applyState(snapshot);
    await loadLogInfo();
    return snapshot?.status === 'available';
  }, [applyState, loadLogInfo, platform]);

  // 订阅更新事件：挂载注册、卸载后 mountedRef 守卫（无退订 API）
  useEffect(() => {
    mountedRef.current = true;
    if (!platform.isElectron()) return;
    const handleEvent = (event: AppUpdateEvent): void => {
      if (!mountedRef.current) return;
      applyState(event.state);
      setNotice(null);
      // available / downloaded 是正向新信号，到达时重置 banner 忽略标记（等价 vanilla 事件处理）；
      // error 不重置——失败不得唤起已关闭的横幅（失败展示规则见文件头注释）
      if (event.type === 'available' || event.type === 'downloaded') {
        setBannerDismissed(false);
      }
    };
    platform.onAppUpdateEvent(handleEvent);
    return () => {
      mountedRef.current = false;
    };
  }, [applyState, platform, setBannerDismissed]);

  return {
    projection,
    rawState,
    logInfo,
    appVersion,
    notice,
    isElectron,
    bannerDismissed,
    setBannerDismissed,
    checkUpdates,
    download,
    install,
    openLog,
    openLogFolder,
    copyDiagnostics,
    initialize,
  };
}

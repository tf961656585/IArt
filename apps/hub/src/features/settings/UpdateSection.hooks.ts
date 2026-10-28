import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  AppUpdateEvent,
  AppUpdateErrorPayload,
  AppUpdateLogInfoResult,
  AppUpdatePlatform,
  AppUpdateProgress,
  AppUpdateState,
} from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { copyText } from '../../client/utils/clipboard';
import { formatBytes, formatTime } from '../../client/utils/time';

/**
 * 检查更新子域 React 版操作 hook（设计基准：docs/desktop-updates/更新交互重设计-design.md §3/§4）。
 * 供两处共享：
 * - UpdateBanner（App 顶层常驻）：挂载时 initialize（订阅事件 + 恢复快照 + 加载应用版本与日志信息）；
 * - UpdateSection（设置 tab）：挂载时 initialize，再对非 Linux 触发一次检查。
 *
 * 行为口径：
 * - 「稍后」只置进程内忽略标记：不发命令、不改状态、不落盘；任何更新事件都不重置它；
 *   仅显式点「重新检查」（点击当下）清除，或进程重启（模块重新加载）自然消失。
 * - 横幅是唯一提醒表面：只有 available / downloading / downloaded 与「就地转失败」的 download-error 出现；
 *   检查失败（check-error）永不出现横幅。
 * - 设置页状态行永远渲染真实状态，提示（取消、节流、检查失败）走独立提示行，不覆盖状态行。
 * - Linux 不是应用内更新目标：不发起检查、永不出现横幅，设置页只保留「前往下载页」。
 *
 * platform.onAppUpdateEvent 无退订 API，卸载后以 mountedRef 守卫阻止
 * 对已卸载组件的 setState（多实例订阅互不冲突）。
 */

/** 错误相位：由事件流推导（桥接保证 checking/downloading 状态先于 error 到达），不进跨进程契约 */
export type UpdateErrorPhase = 'check' | 'download';

/** 更新状态 UI 投影 */
export interface UpdateUiProjection {
  status: AppUpdateState['status'];
  platform: AppUpdatePlatform | null;
  checking: boolean;
  available: boolean;
  downloading: boolean;
  downloaded: boolean;
  version: string;
  progress: AppUpdateProgress | null;
  error: AppUpdateErrorPayload | null;
  /** 失败相位：check=检查阶段失败，download=下载阶段失败 */
  errorPhase: UpdateErrorPhase | null;
  /** 失败是否允许在全局横幅就地展示（仅横幅已展示发现/下载流程时为 true） */
  errorBannerEligible: boolean;
  lastCheckedAt: number | null;
  downloadPath: string | null;
  logPath: string | null;
}

const emptyProjection = (): UpdateUiProjection => ({
  status: 'idle',
  platform: null,
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
    platform: state.platform,
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

/** 下载进度文本 */
export const updateProgressText = (progress: AppUpdateProgress | null): string => {
  if (!progress) return '准备下载...';
  const speed: string = formatBytes(Number(progress.bytesPerSecond) || 0) + '/s';
  const transferred: string = formatBytes(Number(progress.transferred) || 0);
  const total: string = formatBytes(Number(progress.total) || 0);
  return transferred + ' / ' + total + ' (' + speed + ')';
};

const versionText = (projection: UpdateUiProjection): string => projection.version || '未知';

/** 横幅标题（设计文档 §3.2） */
export const updateBannerTitle = (projection: UpdateUiProjection): string => {
  if (projection.downloaded) return '更新已就绪';
  if (projection.error) return '更新没能完成';
  if (projection.downloading) return '正在下载更新';
  if (projection.available) return '发现新版本';
  return '更新';
};

/** 横幅正文（设计文档 §3.2）：download-error 只描述下载失败，不归因网络 */
export const updateDetailText = (projection: UpdateUiProjection): string => {
  if (projection.error) return '下载没有完成，可重试';
  if (projection.downloaded) return '版本 ' + versionText(projection) + ' 已下载完成，可以安装了';
  if (projection.downloading) return '正在下载版本 ' + versionText(projection);
  if (projection.available) return '版本 ' + versionText(projection) + ' 可以下载';
  return '';
};

/**
 * 安装主动作文案（设计文档 §3.4）：按下载文件类型派生。
 * macOS 更新 feed 只携带 zip，故 macOS 常态（无路径或 zip）为「打开文件所在位置」；
 * 「打开安装包」只在拿到 dmg 时出现；Windows 固定「打开安装器」。
 */
export const updateInstallLabel = (projection: UpdateUiProjection): string => {
  if (projection.platform === 'win32') return '打开安装器';
  const downloadPath: string = (projection.downloadPath ?? '').toLowerCase();
  return downloadPath.endsWith('.dmg') ? '打开安装包' : '打开文件所在位置';
};

/** Linux 最新正式 release 下载页（spec「Draft release 与发版语义」声明的入口） */
export const UPDATE_DOWNLOAD_PAGE_URL = 'https://github.com/tf961656585/IArt/releases/latest';

/**
 * 横幅是否应展示（设计文档 §3.2）：
 * available / downloading / downloaded 常驻；download-error 仅就地转失败时出现；
 * checking / not-available / check-error / idle 永不出现；Linux 永不出现。
 */
export const shouldShowUpdateBanner = (projection: UpdateUiProjection): boolean => {
  if (projection.platform === 'linux') return false;
  if (projection.available || projection.downloading || projection.downloaded) return true;
  return projection.error !== null && projection.errorPhase === 'download' && projection.errorBannerEligible;
};

/**
 * 「稍后」忽略标记：进程内展示态，单一持有在模块级供两个 hook 实例共享。
 * 只由显式「重新检查」清除；任何更新事件、进入设置页触发的检查都不清除。
 */
let bannerDismissedState = false;
const bannerDismissedListeners = new Set<() => void>();

const subscribeBannerDismissed = (listener: () => void): (() => void) => {
  bannerDismissedListeners.add(listener);
  return () => {
    bannerDismissedListeners.delete(listener);
  };
};

const readBannerDismissed = (): boolean => bannerDismissedState;

const writeBannerDismissed = (value: boolean): void => {
  if (bannerDismissedState === value) return;
  bannerDismissedState = value;
  for (const listener of [...bannerDismissedListeners]) listener();
};

/** 模拟进程重启：忽略标记是进程内展示态，随模块重新加载自然消失。 */
export const resetUpdateBannerDismissed = (): void => {
  writeBannerDismissed(false);
};

export function useAppUpdate() {
  const { platform } = useHubRuntime();

  const [projection, setProjection] = useState<UpdateUiProjection>(emptyProjection());
  const [rawState, setRawState] = useState<AppUpdateState | null>(null);
  const [logInfo, setLogInfo] = useState<UpdaterLogInfoState>({ path: '', exists: false, size: 0, updatedAt: null });
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [noticeState, setNoticeState] = useState<string | null>(null);
  const [throttleLeftSeconds, setThrottleLeftSeconds] = useState<number | null>(null);
  const bannerDismissed: boolean = useSyncExternalStore(subscribeBannerDismissed, readBannerDismissed, readBannerDismissed);

  const mountedRef = useRef(true);
  const isElectron: boolean = platform.isElectron();

  // 投影/最近非失败状态的 ref 镜像：applyState 是事件与命令结果的统一收口，
  // 失败展示资格依赖「前一投影在展示什么」，闭包里的 state 会过期，必须走 ref。
  const projectionRef = useRef<UpdateUiProjection>(emptyProjection());
  const lastNonErrorStatusRef = useRef<AppUpdateState['status'] | null>(null);

  /** 清空提示（下一次更新事件或下一次用户动作） */
  const clearNotice = useCallback((): void => {
    setNoticeState(null);
    setThrottleLeftSeconds(null);
  }, []);

  /** 「稍后」：只收起本次提醒（不发命令、不改状态），同时清除已有提示（用户动作） */
  const dismissBanner = useCallback((): void => {
    writeBannerDismissed(true);
    clearNotice();
  }, [clearNotice]);

  /**
   * 应用状态快照（rawState 保留旧值，投影始终重算）。
   * 失败展示规则在此统一收口：error 相位取最近一次非 error 状态（downloading→download，
   * 其余→check）；横幅资格 = 前一投影正展示 available/downloading 且未被「稍后」收起。
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
          : (prev.status === 'available' || prev.status === 'downloading') && !readBannerDismissed();
    } else {
      lastNonErrorStatusRef.current = next.status;
    }
    projectionRef.current = next;
    setProjection(next);
  }, []);

  /**
   * 检查更新。`explicit` 标记来自用户显式点「重新检查」——在点击当下清除忽略标记，
   * 不等待检查结果（被节流时横幅也按当前真实状态立即恢复可见）。
   * 进入设置页触发的检查不带该标记。
   */
  const checkUpdates = useCallback(
    async (manual: boolean, explicit = false): Promise<void> => {
      if (explicit) writeBannerDismissed(false);
      if (!platform.isElectron()) return;
      clearNotice();
      try {
        const result = await platform.checkForUpdates(manual);
        applyState(result.state);
        if (result.status === 'skipped') {
          if (result.reason === 'throttled') {
            const retryAfterMs: number = Math.max(0, Number(result.retryAfterMs) || 0);
            setThrottleLeftSeconds(Math.max(1, Math.ceil(retryAfterMs / 1000)));
          } else {
            setNoticeState('暂时无法检查更新，请稍后重试');
          }
          return;
        }
        if (result.status === 'failed' && explicit) {
          // 检查失败但桥接保留了可行动的更新（available / downloaded）：状态行不变，就地提示
          const preserved: boolean = result.state.status === 'available' || result.state.status === 'downloaded';
          if (preserved) setNoticeState('没能检查更新，可稍后重新检查');
        }
      } catch (error: unknown) {
        console.debug('[update] checkForUpdates 失败:', error);
        setNoticeState('没能检查更新，请稍后重试');
      }
    },
    [applyState, clearNotice, platform],
  );

  /** 触发更新下载：失败反馈走提示与横幅就地降级，不强制重展示已收起的横幅 */
  const download = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    clearNotice();
    const result = await platform.startUpdateDownload();
    applyState(result.state);
    if (result.status === 'failed') {
      setNoticeState('下载没能完成，请重试');
    }
  }, [applyState, clearNotice, platform]);

  /** 取消下载：成功回到 available（不算失败），就地提示「已取消下载」。
   *  取消晚于真实失败（state 已进入 error）时不再提示取消失败——状态行/横幅已显示下载失败。 */
  const cancelDownload = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    clearNotice();
    const result = await platform.cancelUpdateDownload();
    applyState(result.state);
    if (result.status === 'success') {
      setNoticeState('已取消下载');
    } else if (result.status === 'failed' && result.state.status !== 'error') {
      setNoticeState('没能取消下载，请重试');
    }
  }, [applyState, clearNotice, platform]);

  /** 安装/打开已下载的安装包：安装包缺失是真实死路，必须给可恢复的反馈（旁边就是「重新检查」） */
  const install = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    clearNotice();
    const result = await platform.installUpdate();
    applyState(result.state);
    if (result.status === 'failed') {
      setNoticeState('没能打开安装包，请重试');
    } else if (result.status === 'skipped' && result.reason.startsWith('missing-download')) {
      setNoticeState('安装包已不存在，请重新检查更新');
    }
  }, [applyState, clearNotice, platform]);

  /** Linux：打开最新正式 release 下载页 */
  const openDownloadPage = useCallback(async (): Promise<void> => {
    const opened: boolean = await platform.openExternal(UPDATE_DOWNLOAD_PAGE_URL).catch(() => false);
    if (!opened) setNoticeState('没能打开下载页，请重试');
  }, [platform]);

  /** 打开更新日志目录 */
  const openLog = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    const result = await platform.revealUpdaterLog();
    if (!result.success) setNoticeState('没能打开更新日志，请重试');
  }, [platform]);

  /** 打开业务日志目录（LFJ-008：backend.log 落存储根 logs/，路径解析归主进程） */
  const openLogFolder = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) return;
    const result = await platform.revealBackendLogFolder();
    if (!result.success) setNoticeState('没能打开日志文件夹，请重试');
  }, [platform]);

  /** 复制诊断信息 */
  const copyDiagnostics = useCallback(async (): Promise<void> => {
    const diagnostics = {
      time: formatTime(Date.now()),
      appVersion: appVersion ?? '',
      updateState: rawState,
      updaterLog: logInfo,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent || '' : '',
    };
    const copied: boolean = await copyText(JSON.stringify(diagnostics, null, 2));
    setNoticeState(copied ? '已复制诊断信息到剪贴板' : '没能复制，请重试');
    window.setTimeout(() => {
      if (mountedRef.current) setNoticeState(null);
    }, 1200);
  }, [appVersion, logInfo, rawState]);

  /** 加载更新日志文件信息 */
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
   * 初始化：订阅前置数据（应用版本 + 状态快照 + 日志信息）。
   * 返回初始化快照，供设置页判定 Linux 变体（不发起应用内检查）。
   */
  const initialize = useCallback(async (): Promise<AppUpdateState | null> => {
    if (!platform.isElectron()) return null;
    const version: string | null = await platform.getAppVersion().catch(() => null);
    if (version !== null) setAppVersion(version);
    const snapshot: AppUpdateState | null = await platform.getUpdateState().catch(() => null);
    applyState(snapshot);
    await loadLogInfo();
    return snapshot;
  }, [applyState, loadLogInfo, platform]);

  // 订阅更新事件：挂载注册、卸载后 mountedRef 守卫（无退订 API）。
  // 任何事件都不重置「稍后」忽略标记（设计文档 §4.2），只清除就地提示。
  useEffect(() => {
    mountedRef.current = true;
    if (!platform.isElectron()) return;
    const handleEvent = (event: AppUpdateEvent): void => {
      if (!mountedRef.current) return;
      applyState(event.state);
      setNoticeState(null);
      setThrottleLeftSeconds(null);
    };
    platform.onAppUpdateEvent(handleEvent);
    return () => {
      mountedRef.current = false;
    };
  }, [applyState, platform]);

  // 节流提示按 1s 递减，归零后清除（设计文档 §3.3/§4.7）
  useEffect(() => {
    if (throttleLeftSeconds === null) return;
    if (throttleLeftSeconds <= 0) {
      setThrottleLeftSeconds(null);
      return;
    }
    const timer: number = window.setInterval(() => {
      setThrottleLeftSeconds((prev: number | null) => (prev === null ? null : prev - 1));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [throttleLeftSeconds]);

  const notice: string | null =
    throttleLeftSeconds !== null
      ? '刚刚检查过，' + String(throttleLeftSeconds) + ' 秒后可再次检查'
      : noticeState;

  return {
    projection,
    rawState,
    logInfo,
    appVersion,
    notice,
    isElectron,
    bannerDismissed,
    dismissBanner,
    checkUpdates,
    download,
    cancelDownload,
    install,
    openDownloadPage,
    openLog,
    openLogFolder,
    copyDiagnostics,
    initialize,
  };
}

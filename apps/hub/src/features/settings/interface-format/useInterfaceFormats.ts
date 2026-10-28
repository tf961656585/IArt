import { useCallback, useEffect, useState } from 'react';
import type { InterfaceFormatDetail, InterfaceFormatSummary } from '@iart/contracts';
import type { HubApiClient } from '../../../client/types';
import { useHubRuntime } from '../../../components/providers/HubAppProvider';
import { describeError } from '../provider-connection/useProviderConnectionData';

/**
 * 「接口格式」页的数据源（docs/custom-providers/接口格式旅程-design.md §1.2）。
 *
 * 一次装载同时取列表与每条的详情：列表行要显示「同步 / 异步」标记，而摘要契约
 * （`InterfaceFormatSummary`）不承载传输形态——该事实只在详情里。这里不做逐行点击才补取，
 * 否则未点过的行没有标记，同一份列表会一半有一半没有。
 *
 * 三态显式化：列表请求失败 → `error`（不能把失败说成「没有格式」）；列表成功但为空 →
 * `empty`（由调用方按 `ready + formats.length === 0` 判定，本 hook 不另设枚举值）。
 * 单条详情失败不拖垮整页：该行不显示标记，选中它时详情栏给「重新读取」，不伪装成定义。
 */

export type InterfaceFormatsLoadState = 'loading' | 'ready' | 'error';

export interface InterfaceFormatsData {
  api: HubApiClient;
  formats: InterfaceFormatSummary[];
  /** 已读到的详情（按 format_id）；读取失败或未就绪的条目不在表里。 */
  details: ReadonlyMap<string, InterfaceFormatDetail>;
  selectedId: string | null;
  selectedDetail: InterfaceFormatDetail | null;
  /** 选中格式的详情读取失败原因（未失败为 null）。 */
  selectedDetailError: string | null;
  loadState: InterfaceFormatsLoadState;
  loadError: string | null;
  select: (formatId: string) => void;
  reload: () => Promise<void>;
  /** 只重读当前选中格式的详情（详情栏「重新读取」）。 */
  reloadSelectedDetail: () => Promise<void>;
}

export function useInterfaceFormats(): InterfaceFormatsData {
  const { api } = useHubRuntime();
  const [formats, setFormats] = useState<InterfaceFormatSummary[]>([]);
  const [details, setDetails] = useState<ReadonlyMap<string, InterfaceFormatDetail>>(new Map());
  const [detailErrors, setDetailErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<InterfaceFormatsLoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoadState('loading');
    try {
      const list = await api.listInterfaceFormats(undefined);
      setFormats(list.formats);
      setLoadError(null);

      const outcome = await Promise.allSettled(
        list.formats.map((item) => api.getInterfaceFormat(item.format_id, undefined)),
      );
      const nextDetails = new Map<string, InterfaceFormatDetail>();
      const nextErrors = new Map<string, string>();
      outcome.forEach((result, index) => {
        const format = list.formats[index];
        if (format === undefined) return;
        if (result.status === 'fulfilled') {
          nextDetails.set(format.format_id, result.value);
          return;
        }
        nextErrors.set(
          format.format_id,
          describeError(result.reason, `没能读取「${format.display_name}」的定义，请重试`),
        );
      });
      setDetails(nextDetails);
      setDetailErrors(nextErrors);
      setLoadState('ready');
    } catch (error: unknown) {
      setFormats([]);
      setDetails(new Map());
      setDetailErrors(new Map());
      setLoadState('error');
      // 标题已经说明「没能读取接口格式」，这里只补一句用户能据以判断的现状，不复读标题。
      setLoadError(describeError(error, '网络或后端暂时没有响应。已经配置好的内容不会丢失。'));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 选中态兜底：有数据即选中第一条就绪格式（与服务商页同一口径）。
   * 手动选择仍然优先——只在「没有选中」或「选中的已不在列表里」时回落。
   */
  useEffect(() => {
    if (formats.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId !== null && formats.some((item) => item.format_id === selectedId)) return;
    const firstReady = formats.find((item) => item.status === 'ready') ?? formats[0];
    setSelectedId(firstReady?.format_id ?? null);
  }, [formats, selectedId]);

  const reloadSelectedDetail = useCallback(async (): Promise<void> => {
    if (selectedId === null) return;
    try {
      const detail = await api.getInterfaceFormat(selectedId, undefined);
      setDetails((current) => new Map(current).set(selectedId, detail));
      setDetailErrors((current) => {
        const next = new Map(current);
        next.delete(selectedId);
        return next;
      });
    } catch (error: unknown) {
      setDetailErrors((current) => new Map(current).set(
        selectedId,
        describeError(error, '没能读取这个接口格式的定义，请重试'),
      ));
    }
  }, [api, selectedId]);

  const selectedDetail = selectedId === null ? null : details.get(selectedId) ?? null;
  const selectedDetailError = selectedId === null || selectedDetail !== null
    ? null
    : detailErrors.get(selectedId) ?? null;

  return {
    api,
    formats,
    details,
    selectedId,
    selectedDetail,
    selectedDetailError,
    loadState,
    loadError,
    select: setSelectedId,
    reload,
    reloadSelectedDetail,
  };
}

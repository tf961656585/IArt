import { useEffect, useState } from 'react';
import { Button, Textarea } from '@iart/ui';
import type { InterfaceRecipePathDiscoveryResponse } from '@iart/contracts';
import { Check, X } from 'lucide-react';
import type { HubApiClient } from '../../../client/types';
import { InfoHint } from '../provider-connection/InfoHint';
import { describeError, describeErrorWithReason } from '../provider-connection/useProviderConnectionData';

/**
 * 「接口格式」页右栏：响应样本验证面板（docs/custom-providers/接口格式旅程-design.md §4）。
 *
 * 本面板只做路径发现：粘贴一段响应样本 → 列出其中可用的字段路径与取值 → 点一条复制到剪贴板，
 * 再去「判定配方」里填进路径框。本地试跑仍未实现（需要草稿试跑通道），本面板不放不可用按钮。
 *
 * 路径发现不自动判定任何东西：选哪条路径、哪些值算完成仍由用户在配方里确认（设计 §4「只做发现」）。
 */

const VALUE_KIND_LABELS: Readonly<Record<string, string>> = {
  string: '文字',
  number: '数字',
  boolean: '是或否',
  null: '空值',
  array: '列表',
  object: '对象',
};

const PREVIEW_LIMIT = 80;

const formatPreview = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.length > PREVIEW_LIMIT ? `${value.slice(0, PREVIEW_LIMIT)}…` : value;
  }
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return '—';
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
  } catch {
    return '—';
  }
};

export function InterfaceFormatSamplePanel({
  formatId,
  formatName,
  api,
  onClose,
}: {
  formatId: string | null;
  formatName: string | null;
  api: HubApiClient;
  onClose: () => void;
}) {
  const [sampleText, setSampleText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<InterfaceRecipePathDiscoveryResponse | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  // 换一个格式就清掉上一份样本的结论：路径属于那一段样本，跨格式沿用会让人按错的路径填配方。
  useEffect(() => {
    setDiscovery(null);
    setError(null);
    setCopiedPath(null);
  }, [formatId]);

  // 复制反馈只短暂停留，避免面板上多一条永久状态。
  useEffect(() => {
    if (copiedPath === null) return;
    const timer = window.setTimeout(() => setCopiedPath(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedPath]);

  const runDiscovery = async (): Promise<void> => {
    if (formatId === null) return;
    const trimmed = sampleText.trim();
    if (trimmed === '') {
      setError('先粘贴一段响应样本。');
      setDiscovery(null);
      return;
    }
    let sample: unknown;
    try {
      sample = JSON.parse(trimmed);
    } catch {
      setError('这段内容不是有效的 JSON，检查后再试。');
      setDiscovery(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.discoverInterfaceFormatPaths(formatId, { sample });
      setDiscovery(result);
    } catch (failure: unknown) {
      setDiscovery(null);
      setError(describeErrorWithReason(
        failure,
        '没能分析这段样本，请重试',
        '这个接口格式已经不在了，换一个格式再试',
      ));
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
    } catch (failure: unknown) {
      // 剪贴板被系统拒绝时给可执行的替代动作，不把浏览器原文上屏。
      console.debug('[interface-format] 复制路径失败', failure);
      setError(describeError(failure, '没能复制到剪贴板，可以手动选中路径再复制。'));
    }
  };

  return (
    <aside
      data-interface-format-sample-panel
      aria-label="验证面板"
      className="flex w-80 shrink-0 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">验证面板</h3>
        <InfoHint text="这里的路径可直接填到接口配方里。" subject="字段路径" />
        <Button
          type="button"
          size="2xs"
          variant="ghost"
          className="ml-auto"
          aria-label="收起验证面板"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>

      {formatId === null ? (
        <p className="text-xs text-muted-foreground">左边选一个接口格式，就能分析它的响应样本。</p>
      ) : (
        <>
          <p className="truncate text-2xs text-muted-foreground">{`分析「${formatName ?? formatId}」的响应样本`}</p>
          <Textarea
            value={sampleText}
            onChange={(event) => setSampleText(event.target.value)}
            aria-label="响应样本"
            placeholder={'把服务端返回的 JSON 粘贴到这里，例如 {"id":"task-1","status":"succeeded"}'}
            className="min-h-32 font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" loading={busy} onClick={() => void runDiscovery()}>
              解析字段路径
            </Button>
            {copiedPath === null ? null : (
              <span role="status" className="flex items-center gap-1 text-2xs text-success">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                已复制
              </span>
            )}
          </div>

          {error === null ? null : <p role="alert" className="text-xs text-destructive">{error}</p>}

          {discovery === null ? null : discovery.paths.length === 0 ? (
            <p className="text-xs text-muted-foreground">这段样本里没有可用的字段路径。</p>
          ) : (
            <div className="flex flex-col gap-1">
              <span className="text-2xs text-muted-foreground">{`找到 ${discovery.paths.length} 个字段路径，点一个复制。`}</span>
              <div className="flex flex-col gap-1">
                {discovery.paths.map((item) => (
                  <Button
                    key={item.path}
                    type="button"
                    variant="ghost"
                    size="2xs"
                    aria-label={`复制路径 ${item.path}`}
                    onClick={() => void copyPath(item.path)}
                    className="h-auto w-full flex-col items-start justify-start gap-0.5 px-2 py-1 text-left"
                  >
                    <span className="w-full truncate font-mono">{item.path}</span>
                    <span className="flex w-full min-w-0 items-center gap-2 text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">{formatPreview(item.value)}</span>
                      <span className="shrink-0">{VALUE_KIND_LABELS[item.value_kind] ?? item.value_kind}</span>
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

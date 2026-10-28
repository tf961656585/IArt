import { useEffect, useState } from 'react';
import type { HubApiClient } from '../../../client/types';

/** 接口格式下拉选项（id + 展示名）。 */
export type InterfaceFormatOption = { value: string; label: string };

/**
 * 接口格式下拉选项的唯一装载点（预设 + 用户自建，只列 ready）。
 *
 * 2026-10-27 起 Hub 不再有第二份「接口格式展示名」清单：生成侧内置适配器退场后，
 * 名称只能来自接口格式实体（`/api/interface-formats`）。读不到时返回空数组并留痕，
 * 由调用方按场景回落（表单回落到预设 id、只读展示回落到 id），不伪装成某条格式存在。
 */
export function useInterfaceFormatOptions(api: HubApiClient): InterfaceFormatOption[] {
  const [options, setOptions] = useState<InterfaceFormatOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api.listInterfaceFormats(undefined)
      .then((list) => {
        if (cancelled) return;
        setOptions(
          list.formats
            .filter((item) => item.status === 'ready')
            .map((item) => ({ value: item.format_id, label: item.display_name })),
        );
      })
      .catch((error: unknown) => {
        console.debug('[provider-connection] 读取接口格式失败，下拉不可用', {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  return options;
}

/** 由选项表取展示名：查不到原样显示 id（错名比 id 更难排查）。 */
export const interfaceFormatLabel = (
  formatId: string,
  options: readonly InterfaceFormatOption[],
): string => options.find((option) => option.value === formatId)?.label ?? formatId;

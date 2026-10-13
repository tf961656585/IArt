import { createContext, useContext, type ReactNode } from 'react';
import {
  useProviderConnectionData,
  type ProviderConnectionData,
} from './useProviderConnectionData';

/**
 * 「服务商与模型」分区共享数据 context。
 *
 * 目的：让服务商列表、服务商详情与各弹窗共用同一个数据实例（见
 * `useProviderConnectionData` 文件头的单一实例说明），避免双份请求与状态不同步。
 *
 * 用法：`SettingsTab` 的「服务商与模型」分区外层包一次 `<ProviderDataProvider>`，
 * 子组件用 `useProviderData()` 取数；禁止子组件自行再调 `useProviderConnectionData()`。
 */

const ProviderDataContext = createContext<ProviderConnectionData | null>(null);

export function ProviderDataProvider({ children }: { children: ReactNode }) {
  const data = useProviderConnectionData();
  return <ProviderDataContext.Provider value={data}>{children}</ProviderDataContext.Provider>;
}

export function useProviderData(): ProviderConnectionData {
  const value = useContext(ProviderDataContext);
  if (value === null) {
    throw new Error('useProviderData 必须在 ProviderDataProvider 内使用');
  }
  return value;
}

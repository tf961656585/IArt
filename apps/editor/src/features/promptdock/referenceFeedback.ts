import { toast } from 'sonner';

import type { AddReferencesResult } from './referenceOps';

/**
 * 「加入参考」结果的 toast 呈现（呈现面共用，单一实现）。
 *
 * 操作层（referenceOps）只返回结构化结果，不弹提示；呈现面各自映射：PromptDock 参考区
 * 用按钮行内短文案（选中项批量加入的场景，`PromptDockReferenceArea`），画布底栏与会话视图
 * 产物「用作参考」共用本模块的 toast（单点动作，短反馈在画布上没有承载行）。
 *
 * 口径：仅全无新增时反馈（`duplicate` / `rejected` 变体）；部分成功（`added` 变体，同批含
 * 重复 / 不符项）静默——chip 数量变化即反馈。文案与触发顺序沿用底栏原实现逐字一致。
 */
export function announceReferenceAddResult(result: AddReferencesResult): void {
  if (result.kind === 'added') return;
  if (result.duplicates > 0) {
    toast.info(
      result.duplicates === 1
        ? '这张图片已经在参考里了'
        : `${result.duplicates} 张图片已经在参考里了`,
    );
  }
  if (result.rejected.length > 0) {
    const firstReason = result.rejected[0]?.reason ?? '无法加入参考';
    toast.warning(
      result.rejected.length === 1
        ? firstReason
        : `${result.rejected.length} 项无法加入：${firstReason}`,
    );
  }
}

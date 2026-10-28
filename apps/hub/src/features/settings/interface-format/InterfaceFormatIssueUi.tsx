import { IssueLine } from '../provider-connection/ParameterOverrideRowControls';

/**
 * 接口格式编辑器的行内错误小件（与 `collectIssues` 是同一份数据）。
 *
 * - `issueAria`：给控件补 `aria-invalid` / `aria-describedby`；未点保存前不标红。
 * - `IssueSlot`：渲染控件下方的错误行；未点保存前不显示，避免首次打开满屏红字。
 */

export type IssueAriaProps = {
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
};

export const issueAria = (
  fieldId: string,
  errors: ReadonlyMap<string, string[]>,
  showErrors: boolean,
): IssueAriaProps => {
  const hasIssue = showErrors && (errors.get(fieldId)?.length ?? 0) > 0;
  return {
    'aria-invalid': hasIssue,
    'aria-describedby': hasIssue ? `${fieldId}-error` : undefined,
  };
};

export function IssueSlot({
  fieldId,
  errors,
  showErrors,
}: {
  fieldId: string;
  errors: ReadonlyMap<string, string[]>;
  showErrors: boolean;
}) {
  if (!showErrors) return null;
  const messages = errors.get(fieldId);
  if (messages === undefined || messages.length === 0) return null;
  return <IssueLine messages={messages} id={`${fieldId}-error`} />;
}

import { Button, Input } from '@iart/ui';
import { FormField } from '../../../components/FormField';
import { InfoHint } from '../provider-connection/InfoHint';
import { InterfaceFormatDraftRow } from './InterfaceFormatDraftRow';
import { IssueSlot } from './InterfaceFormatIssueUi';
import type { NameValueRow } from './interfaceFormatDraft';

/**
 * 固定请求头 / 固定查询参数的小表（提交段与轮询段共用同一套行控件）。
 *
 * 校验不在这里另写一份：名称/取值能否发出由 contracts 的草稿校验判定，`collectIssues`
 * 每次输入都重算，这里把同一份结果直接铺在行内（不等「保存」）——不合法请求头名与
 * 禁止头（如 `Authorization`、`Content-Type`）越早看到越省事。
 */

const COPY: Readonly<Record<'header' | 'query', { namePlaceholder: string }>> = {
  header: { namePlaceholder: '例如：X-Client-Version' },
  query: { namePlaceholder: '例如：api-version' },
};

export function FixedWireRows({
  kind,
  scope,
  rows,
  errors,
  onChange,
  hint,
  hintSubject,
}: {
  kind: 'header' | 'query';
  scope: 'submit' | 'polling';
  rows: NameValueRow[];
  errors: ReadonlyMap<string, string[]>;
  onChange: (rows: NameValueRow[]) => void;
  /** 表格标题旁「?」气泡里的说明（只在「不看说明就会填错」时给）。 */
  hint?: string;
  hintSubject: string;
}) {
  const copy = COPY[kind];
  const rowName = kind === 'header' ? '请求头' : '查询参数';
  const scopePrefix = scope === 'submit' ? '固定' : '轮询';
  const idPrefix = scope === 'submit' ? 'interface-format-fixed' : 'interface-format-polling';
  const rowKindLabel = `${scopePrefix}${rowName}`;
  // 提交段与轮询段同屏各有一张表：按钮文案带上各自的表名，否则两处同名按钮分不清。
  const addLabel = `添加${rowKindLabel}`;
  const emptyHint = `还没有${rowKindLabel}。`;

  const replaceRow = (index: number, next: NameValueRow): void => {
    onChange(rows.map((item, i) => (i === index ? next : item)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground">{rowKindLabel}</span>
        {hint === undefined ? null : <InfoHint text={hint} subject={hintSubject} />}
      </div>
      {rows.length === 0 ? (
        <p className="text-2xs text-muted-foreground">{emptyHint}</p>
      ) : null}
      {rows.map((row, index) => {
        const nameId = `${idPrefix}-${kind}-${index}-name`;
        const valueId = `${idPrefix}-${kind}-${index}-value`;
        return (
          <InterfaceFormatDraftRow key={index}>
            <FormField label="名称" htmlFor={nameId} className="min-w-36 flex-1">
              <Input
                id={nameId}
                aria-label={`第 ${index + 1} 行${rowKindLabel}名称`}
                value={row.name}
                onChange={(event) => replaceRow(index, { ...row, name: event.target.value })}
                placeholder={copy.namePlaceholder}
              />
              <IssueSlot fieldId={nameId} errors={errors} showErrors />
            </FormField>
            <FormField label="取值" htmlFor={valueId} className="min-w-36 flex-1">
              <Input
                id={valueId}
                aria-label={`第 ${index + 1} 行${rowKindLabel}取值`}
                value={row.value}
                onChange={(event) => replaceRow(index, { ...row, value: event.target.value })}
                placeholder="例如：2026-01-01"
              />
              <IssueSlot fieldId={valueId} errors={errors} showErrors />
            </FormField>
            <div className="shrink-0">
              <Button
                type="button"
                size="sm"
                variant="ghost-destructive"
                aria-label={`删除第 ${index + 1} 行${rowKindLabel}`}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                删除
              </Button>
            </div>
          </InterfaceFormatDraftRow>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => onChange([...rows, { name: '', value: '' }])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

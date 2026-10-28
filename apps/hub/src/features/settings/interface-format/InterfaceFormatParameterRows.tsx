import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@iart/ui';
import { FormField } from '../../../components/FormField';
import { InterfaceFormatDraftRow } from './InterfaceFormatDraftRow';
import { IssueSlot, issueAria } from './InterfaceFormatIssueUi';
import { ParameterDefaultValueField } from './ParameterDefaultValueField';
import { coerceDefaultForType } from './parameterDefaults';
import { OptionListEditor } from '../components/ParameterValueControls';
import type { ParamRow, WireLocation } from './interfaceFormatDraft';

/**
 * 接口格式的「参数表」编辑块（从编辑器拆出，控制在单文件行数上限内）。
 *
 * 每行先声明「发送到」（请求体 / 查询参数 / 请求头）再填名称：同一份错误按落点说成
 * 「字段位置 / 查询参数名 / 请求头名」，用户不用去猜路径与名称的区别。
 * 行内错误与固定字段同源：`errors` 是按控件 id 分组的 `collectIssues` 结果，
 * 未点保存前（`showErrors = false`）只保留顶部汇总，不铺红字。
 */

const LOCATION_OPTIONS: ReadonlyArray<{ value: WireLocation; label: string }> = [
  { value: 'body', label: '请求体' },
  { value: 'query', label: '查询参数' },
  { value: 'header', label: '请求头' },
];

const KEY_LABELS: Readonly<Record<WireLocation, string>> = {
  body: '请求体路径',
  query: '查询参数名',
  header: '请求头名',
};

const KEY_PLACEHOLDERS: Readonly<Record<WireLocation, string>> = {
  body: '例如：size',
  query: '例如：size',
  header: '例如：X-Quality',
};

export function InterfaceFormatParameterRows({
  rows,
  errors,
  showErrors,
  onChange,
}: {
  rows: ParamRow[];
  errors: ReadonlyMap<string, string[]>;
  showErrors: boolean;
  onChange: (rows: ParamRow[]) => void;
}) {
  const replaceRow = (index: number, next: ParamRow): void => {
    onChange(rows.map((item, i) => (i === index ? next : item)));
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => {
        const locationId = `interface-format-param-${index}-location`;
        const keyId = `interface-format-param-${index}-key`;
        const labelId = `interface-format-param-${index}-label`;
        const typeId = `interface-format-param-${index}-type`;
        const defaultId = `interface-format-param-${index}-default`;
        const enumValuesId = `interface-format-param-${index}-enum-values`;
        const requiredId = `interface-format-param-${index}-required`;
        const defaultAria = issueAria(defaultId, errors, showErrors);
        const enumAria = issueAria(enumValuesId, errors, showErrors);
        const rowName = row.label.trim() === ''
          ? (row.key.trim() === '' ? '未命名' : row.key.trim())
          : row.label.trim();
        return (
          <InterfaceFormatDraftRow key={index}>
            <FormField label="发送到" htmlFor={locationId} className="w-28 shrink-0">
              <Select
                value={row.location}
                onValueChange={(value) => {
                  const nextLocation = value as WireLocation;
                  // 请求体是路径、另外两个是名称：跨过这条界线时旧值必然不兼容，清掉并说明。
                  const crossesScope = (row.location === 'body') !== (nextLocation === 'body');
                  replaceRow(index, {
                    ...row,
                    location: nextLocation,
                    key: crossesScope ? '' : row.key,
                    locationNote: crossesScope ? '发送位置变了，原来的位置已清空，请按新的位置重新填' : '',
                  });
                }}
              >
                <SelectTrigger
                  id={locationId}
                  size="sm"
                  className="w-full"
                  aria-label={`第 ${index + 1} 行参数发送位置`}
                  {...issueAria(locationId, errors, showErrors)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <IssueSlot fieldId={locationId} errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField
              label={KEY_LABELS[row.location]}
              htmlFor={keyId}
              className="min-w-36 flex-[1.2]"
            >
              <Input
                id={keyId}
                aria-label={`第 ${index + 1} 行参数${KEY_LABELS[row.location]}`}
                {...issueAria(keyId, errors, showErrors)}
                value={row.key}
                onChange={(event) => replaceRow(index, {
                  ...row,
                  key: event.target.value,
                  locationNote: '',
                })}
                placeholder={KEY_PLACEHOLDERS[row.location]}
              />
              <IssueSlot fieldId={keyId} errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="名称" htmlFor={labelId} className="min-w-36 flex-1">
              <Input
                id={labelId}
                aria-label={`第 ${index + 1} 行参数名称`}
                {...issueAria(labelId, errors, showErrors)}
                value={row.label}
                onChange={(event) => replaceRow(index, { ...row, label: event.target.value })}
                placeholder="例如：画面尺寸"
              />
              <IssueSlot fieldId={labelId} errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="类型" htmlFor={typeId} className="w-26 shrink-0">
              <Select
                value={row.type}
                onValueChange={(value) => {
                  const nextType = value as ParamRow['type'];
                  const coerced = coerceDefaultForType(row.defaultValue, nextType, row.enumValues);
                  replaceRow(index, {
                    ...row,
                    type: nextType,
                    defaultValue: coerced.value,
                    defaultNote: coerced.cleared ? '原默认值和新类型不兼容，已清空' : '',
                  });
                }}
              >
                <SelectTrigger
                  id={typeId}
                  size="sm"
                  className="w-full"
                  aria-label={`第 ${index + 1} 行参数类型`}
                  {...issueAria(typeId, errors, showErrors)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">文本</SelectItem>
                  <SelectItem value="number">数字</SelectItem>
                  <SelectItem value="boolean">开关</SelectItem>
                  <SelectItem value="enum">选项</SelectItem>
                </SelectContent>
              </Select>
              <IssueSlot fieldId={typeId} errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="默认值" htmlFor={defaultId} className="min-w-32 flex-1">
              <ParameterDefaultValueField
                type={row.type}
                value={row.defaultValue}
                enumValues={row.enumValues}
                id={defaultId}
                ariaLabel={`第 ${index + 1} 行参数默认值`}
                invalid={defaultAria['aria-invalid']}
                describedBy={defaultAria['aria-describedby']}
                onChange={(raw) => replaceRow(index, { ...row, defaultValue: raw, defaultNote: '' })}
              />
              <IssueSlot fieldId={defaultId} errors={errors} showErrors={showErrors} />
            </FormField>
            <div className="flex shrink-0 items-end gap-2">
              <label
                htmlFor={requiredId}
                className="flex cursor-pointer items-center gap-1 text-2xs text-muted-foreground"
              >
                必填
                <Switch
                  id={requiredId}
                  aria-label={`第 ${index + 1} 行参数必填`}
                  {...issueAria(requiredId, errors, showErrors)}
                  checked={row.required}
                  onCheckedChange={(checked) => replaceRow(index, { ...row, required: checked })}
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost-destructive"
                aria-label={`删除第 ${index + 1} 行参数「${rowName}」`}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                删除
              </Button>
            </div>
            {showErrors && (errors.get(requiredId)?.length ?? 0) > 0 ? (
              <div className="basis-full">
                <IssueSlot fieldId={requiredId} errors={errors} showErrors={showErrors} />
              </div>
            ) : null}
            {row.defaultNote === '' ? null : (
              <p className="basis-full min-w-0 text-2xs text-muted-foreground">{row.defaultNote}</p>
            )}
            {row.locationNote === '' ? null : (
              <p className="basis-full min-w-0 text-2xs text-muted-foreground">{row.locationNote}</p>
            )}
            {row.type === 'enum' ? (
              <FormField label="可选值" htmlFor={enumValuesId} className="basis-full min-w-0">
                <OptionListEditor<string>
                  options={row.enumValues}
                  onChange={(nextValues) => {
                    const current = row.defaultValue.trim();
                    const keepDefault = current === '' || nextValues.includes(current);
                    replaceRow(index, {
                      ...row,
                      enumValues: nextValues,
                      defaultValue: keepDefault ? row.defaultValue : '',
                      defaultNote: keepDefault ? '' : '默认值已不在可选值里，已清空',
                    });
                  }}
                  addInputAriaLabel={`第 ${index + 1} 行参数的新可选值`}
                  addButtonAriaLabel={`为第 ${index + 1} 行参数添加可选值`}
                  removeButtonAriaPrefix={`删掉第 ${index + 1} 行参数的可选值`}
                  inputId={enumValuesId}
                  invalid={enumAria['aria-invalid']}
                  describedBy={enumAria['aria-describedby']}
                />
                <IssueSlot fieldId={enumValuesId} errors={errors} showErrors={showErrors} />
              </FormField>
            ) : null}
          </InterfaceFormatDraftRow>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rows, {
          location: 'body',
          key: '',
          label: '',
          type: 'string',
          required: false,
          defaultValue: '',
          enumValues: [],
          defaultNote: '',
          locationNote: '',
        }])}
      >
        添加参数
      </Button>
    </div>
  );
}

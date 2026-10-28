import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@iart/ui';
import type { CustomInterfaceFormatMediaCarrier, GenerationMediaSlotId } from '@iart/contracts';
import { FormField } from '../../../components/FormField';
import { InterfaceFormatDraftRow } from './InterfaceFormatDraftRow';
import { IssueSlot, issueAria } from './InterfaceFormatIssueUi';

/**
 * 素材位编辑块（从 `InterfaceFormatEditor` 拆出，控制在单文件行数上限内）。
 *
 * 一行 = 一个受控素材位：位标识决定数据类型与表单组件，字段位置是请求体路径，
 * 上传方式决定请求规则里的 `media_target`。把上传方式改成「表单文件」时由父层把提交体
 * 同步切成 multipart——multipart 文件字段不可能出现在 JSON 请求体里。
 */

export type MediaSlotRow = {
  slotId: GenerationMediaSlotId;
  fieldKey: string;
  label: string;
  required: boolean;
  maxFiles: string;
  /** 上传方式；预设详情判不出载体时为 `''`（界面显示未选择，由用户明确选）。 */
  carrier: CustomInterfaceFormatMediaCarrier | '';
};

/**
 * 新素材位行的上传方式默认值：提交体只接受表单文件时才走 multipart。
 *
 * 四种请求体形态里只有 `multipart` 能承载文件；其余（JSON / 网址编码表单 / 纯文本）都只能
 * 通过公网 URL 或内嵌内容把素材交给服务商。
 */
export const defaultMediaCarrier = (
  payloadFormat: 'json' | 'multipart' | 'form' | 'text',
): CustomInterfaceFormatMediaCarrier => (payloadFormat === 'multipart' ? 'multipart_file' : 'public_url');

export const MEDIA_SLOT_OPTIONS: ReadonlyArray<{ value: GenerationMediaSlotId; label: string }> = [
  { value: 'reference_image', label: '参考图' },
  { value: 'first_frame', label: '首帧' },
  { value: 'last_frame', label: '尾帧' },
  { value: 'reference_video', label: '参考视频' },
  { value: 'reference_audio', label: '参考音频' },
  { value: 'feature_video', label: '特征视频' },
  { value: 'base_video', label: '基础视频' },
];

export function InterfaceFormatMediaSlotFields({
  rows,
  payloadFormat,
  errors,
  showErrors,
  onChange,
}: {
  rows: MediaSlotRow[];
  payloadFormat: 'json' | 'multipart' | 'form' | 'text';
  errors: ReadonlyMap<string, string[]>;
  showErrors: boolean;
  /** 行变化；第二个参数非空表示父层需要同步切换提交体形态。 */
  onChange: (rows: MediaSlotRow[], switchToMultipart?: true) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-2xs text-muted-foreground">这个接口不需要图片、视频或音频输入。</p>
      ) : null}
      {rows.map((row, index) => {
        const rowName = row.label.trim() === ''
          ? (MEDIA_SLOT_OPTIONS.find((option) => option.value === row.slotId)?.label ?? '未命名')
          : row.label.trim();
        return (
          <InterfaceFormatDraftRow key={index}>
            <FormField
              label="位"
              htmlFor={`interface-format-media-${index}-slot`}
              className="min-w-28 flex-1"
            >
              <Select
                value={row.slotId}
                onValueChange={(value) => {
                  onChange(rows.map((item, i) => (i === index ? { ...item, slotId: value as GenerationMediaSlotId } : item)));
                }}
              >
                <SelectTrigger
                  id={`interface-format-media-${index}-slot`}
                  size="sm"
                  className="w-full"
                  aria-label={`第 ${index + 1} 行素材位`}
                  {...issueAria(`interface-format-media-${index}-slot`, errors, showErrors)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEDIA_SLOT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <IssueSlot
                fieldId={`interface-format-media-${index}-slot`}
                errors={errors}
                showErrors={showErrors}
              />
            </FormField>
            <FormField
              label="字段位置"
              htmlFor={`interface-format-media-${index}-field`}
              className="min-w-36 flex-[1.2]"
            >
              <Input
                id={`interface-format-media-${index}-field`}
                aria-label={`第 ${index + 1} 行素材位字段位置`}
                {...issueAria(`interface-format-media-${index}-field`, errors, showErrors)}
                value={row.fieldKey}
                onChange={(event) => {
                  onChange(rows.map((item, i) => (i === index ? { ...item, fieldKey: event.target.value } : item)));
                }}
                placeholder="例如：image"
              />
              <IssueSlot
                fieldId={`interface-format-media-${index}-field`}
                errors={errors}
                showErrors={showErrors}
              />
            </FormField>
            <FormField
              label="名称"
              htmlFor={`interface-format-media-${index}-label`}
              className="min-w-32 flex-1"
            >
              <Input
                id={`interface-format-media-${index}-label`}
                aria-label={`第 ${index + 1} 行素材位名称`}
                {...issueAria(`interface-format-media-${index}-label`, errors, showErrors)}
                value={row.label}
                onChange={(event) => {
                  onChange(rows.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)));
                }}
                placeholder="例如：参考图"
              />
              <IssueSlot
                fieldId={`interface-format-media-${index}-label`}
                errors={errors}
                showErrors={showErrors}
              />
            </FormField>
            <FormField
              label="最多几张"
              htmlFor={`interface-format-media-${index}-max`}
              className="w-28 shrink-0"
            >
              <Input
                id={`interface-format-media-${index}-max`}
                aria-label={`第 ${index + 1} 行素材位最多张数`}
                {...issueAria(`interface-format-media-${index}-max`, errors, showErrors)}
                value={row.maxFiles}
                onChange={(event) => {
                  onChange(rows.map((item, i) => (i === index ? { ...item, maxFiles: event.target.value.replace(/[^0-9]/g, '') } : item)));
                }}
              />
              <IssueSlot
                fieldId={`interface-format-media-${index}-max`}
                errors={errors}
                showErrors={showErrors}
              />
            </FormField>
            <FormField
              label="上传方式"
              htmlFor={`interface-format-media-${index}-carrier`}
              className="min-w-32 flex-1"
            >
              <Select
                value={row.carrier === '' ? '' : row.carrier}
                onValueChange={(value) => {
                  const carrier = value as CustomInterfaceFormatMediaCarrier;
                  onChange(
                    rows.map((item, i) => (i === index ? { ...item, carrier } : item)),
                    carrier === 'multipart_file' ? true : undefined,
                  );
                }}
              >
                <SelectTrigger
                  id={`interface-format-media-${index}-carrier`}
                  size="sm"
                  className="w-full"
                  aria-label={`第 ${index + 1} 行素材位上传方式`}
                  {...issueAria(`interface-format-media-${index}-carrier`, errors, showErrors)}
                >
                  <SelectValue placeholder="请选择上传方式" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="multipart_file">表单文件</SelectItem>
                  <SelectItem value="public_url">公网 URL</SelectItem>
                  <SelectItem value="inline_data">内嵌内容</SelectItem>
                </SelectContent>
              </Select>
              <IssueSlot
                fieldId={`interface-format-media-${index}-carrier`}
                errors={errors}
                showErrors={showErrors}
              />
            </FormField>
            <div className="flex shrink-0 items-end gap-2">
              <label
                htmlFor={`interface-format-media-${index}-required`}
                className="flex cursor-pointer items-center gap-1 text-2xs text-muted-foreground"
              >
                必填
                <Switch
                  id={`interface-format-media-${index}-required`}
                  aria-label={`第 ${index + 1} 行素材位必填`}
                  checked={row.required}
                  onCheckedChange={(checked) => {
                    onChange(rows.map((item, i) => (i === index ? { ...item, required: checked } : item)));
                  }}
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="ghost-destructive"
                aria-label={`删除第 ${index + 1} 行素材位「${rowName}」`}
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
        onClick={() => onChange([
          ...rows,
          {
            slotId: 'reference_image',
            fieldKey: '',
            label: '',
            required: false,
            maxFiles: '1',
            carrier: defaultMediaCarrier(payloadFormat),
          },
        ])}
      >
        添加素材位
      </Button>
    </div>
  );
}

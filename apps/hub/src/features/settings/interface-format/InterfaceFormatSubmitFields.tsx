import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@iart/ui';
import { defaultCustomInterfaceFormatContentType } from '@iart/contracts';
import type { ModelLocation, PayloadFormat } from './interfaceFormatDraft';
import type { EditorState } from './interfaceFormatDraft';
import { FormField } from '../../../components/FormField';
import { InfoHint } from '../provider-connection/InfoHint';
import { FixedWireRows } from './InterfaceFormatFixedWireRows';
import { IssueSlot, issueAria } from './InterfaceFormatIssueUi';

/**
 * 编辑器的「提交请求」分节（从 `InterfaceFormatEditor` 拆出，控制在单文件行数上限内）。
 *
 * 只负责提交段自己的字段：路径 / 方法 / 请求体形态 / Content-Type / 鉴权 / 模型 ID 落点 /
 * 固定请求头与固定查询参数。参数行的落点在参数分节里改，这里不重复。
 */

const PAYLOAD_FORMAT_LABELS: ReadonlyArray<{ value: PayloadFormat; label: string }> = [
  { value: 'json', label: 'JSON' },
  { value: 'multipart', label: '表单上传（文件）' },
  { value: 'form', label: '表单（x-www-form-urlencoded）' },
  { value: 'text', label: '纯文本' },
];

const MODEL_LOCATION_OPTIONS: ReadonlyArray<{ value: ModelLocation; label: string }> = [
  { value: 'body', label: '请求体' },
  { value: 'query', label: '查询参数' },
  { value: 'path', label: '地址路径（{model}）' },
  { value: 'none', label: '不发送' },
];

export function InterfaceFormatSubmitFields({
  state,
  errors,
  showErrors,
  update,
}: {
  state: EditorState;
  errors: ReadonlyMap<string, string[]>;
  showErrors: boolean;
  update: <K extends keyof EditorState>(key: K, value: EditorState[K]) => void;
}) {
  const modelKeyLabel = state.modelLocation === 'query' ? '模型 ID 查询参数名' : '模型 ID 位置';

  const changePayloadFormat = (next: PayloadFormat): void => {
    update('payloadFormat', next);
    // Content-Type 按形态的标准值预填（multipart 由运行时生成边界，留空）。
    update('contentType', defaultCustomInterfaceFormatContentType(next) ?? '');
    // 纯文本正文与「提示词发到哪个字段」是一对：切形态时把提示词落点同步过去，
    // 避免用户面对一条无法从界面上修掉的组合错误。
    if (next === 'text' && state.promptLocation !== 'text') update('promptLocation', 'text');
    if (next !== 'text' && state.promptLocation === 'text') update('promptLocation', 'body');
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <FormField label="提交路径" htmlFor="interface-format-submit-path">
          <Input
            id="interface-format-submit-path"
            {...issueAria('interface-format-submit-path', errors, showErrors)}
            value={state.submitPath}
            onChange={(event) => update('submitPath', event.target.value)}
            placeholder="例如：/v1/images/generations"
          />
          <IssueSlot fieldId="interface-format-submit-path" errors={errors} showErrors={showErrors} />
        </FormField>
        <FormField label="请求方法" htmlFor="interface-format-method">
          <Select value={state.method} onValueChange={(value) => update('method', value as EditorState['method'])}>
            <SelectTrigger
              id="interface-format-method"
              size="sm"
              {...issueAria('interface-format-method', errors, showErrors)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['POST', 'GET', 'PUT', 'PATCH'] as const).map((method) => (
                <SelectItem key={method} value={method}>{method}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IssueSlot fieldId="interface-format-method" errors={errors} showErrors={showErrors} />
        </FormField>
        <FormField label="请求体" htmlFor="interface-format-payload-format">
          <Select value={state.payloadFormat} onValueChange={(value) => changePayloadFormat(value as PayloadFormat)}>
            <SelectTrigger
              id="interface-format-payload-format"
              size="sm"
              {...issueAria('interface-format-payload-format', errors, showErrors)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAYLOAD_FORMAT_LABELS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IssueSlot fieldId="interface-format-payload-format" errors={errors} showErrors={showErrors} />
        </FormField>
        <FormField
          label="Content-Type（可留空）"
          htmlFor="interface-format-content-type"
          hint={<InfoHint text="表单文件上传时留空：软件会按文件生成边界，填死会让上传失败。" subject="Content-Type" />}
        >
          <Input
            id="interface-format-content-type"
            {...issueAria('interface-format-content-type', errors, showErrors)}
            value={state.contentType}
            onChange={(event) => update('contentType', event.target.value)}
            placeholder="例如：application/json"
          />
          <IssueSlot fieldId="interface-format-content-type" errors={errors} showErrors={showErrors} />
        </FormField>
        <FormField label="鉴权方式" htmlFor="interface-format-auth-kind">
          <Select value={state.authKind} onValueChange={(value) => update('authKind', value as EditorState['authKind'])}>
            <SelectTrigger
              id="interface-format-auth-kind"
              size="sm"
              {...issueAria('interface-format-auth-kind', errors, showErrors)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bearer">Bearer 令牌</SelectItem>
              <SelectItem value="header_api_key">API Key 请求头</SelectItem>
              <SelectItem value="query_api_key">API Key 查询参数</SelectItem>
            </SelectContent>
          </Select>
          <IssueSlot fieldId="interface-format-auth-kind" errors={errors} showErrors={showErrors} />
        </FormField>
        {state.authKind === 'query_api_key' ? (
          <FormField label="鉴权查询参数名" htmlFor="interface-format-auth-query-name">
            <Input
              id="interface-format-auth-query-name"
              {...issueAria('interface-format-auth-query-name', errors, showErrors)}
              value={state.authQueryName}
              onChange={(event) => update('authQueryName', event.target.value)}
              placeholder="例如：key"
            />
            <IssueSlot fieldId="interface-format-auth-query-name" errors={errors} showErrors={showErrors} />
          </FormField>
        ) : (
          <FormField label="鉴权头名" htmlFor="interface-format-auth-header">
            <Input
              id="interface-format-auth-header"
              {...issueAria('interface-format-auth-header', errors, showErrors)}
              value={state.authHeaderName}
              onChange={(event) => update('authHeaderName', event.target.value)}
              placeholder="例如：Authorization"
            />
            <IssueSlot fieldId="interface-format-auth-header" errors={errors} showErrors={showErrors} />
          </FormField>
        )}
        {state.authKind === 'bearer' ? (
          <FormField label="令牌前缀" htmlFor="interface-format-auth-prefix">
            <Input
              id="interface-format-auth-prefix"
              {...issueAria('interface-format-auth-prefix', errors, showErrors)}
              value={state.authPrefix}
              onChange={(event) => update('authPrefix', event.target.value)}
              placeholder="例如：Bearer"
            />
            <IssueSlot fieldId="interface-format-auth-prefix" errors={errors} showErrors={showErrors} />
          </FormField>
        ) : null}
        <FormField label="模型 ID 发送到" htmlFor="interface-format-model-location">
          <Select
            value={state.modelLocation}
            onValueChange={(value) => update('modelLocation', value as ModelLocation)}
          >
            <SelectTrigger
              id="interface-format-model-location"
              size="sm"
              aria-label="模型 ID 发送到"
              {...issueAria('interface-format-model-location', errors, showErrors)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_LOCATION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IssueSlot fieldId="interface-format-model-location" errors={errors} showErrors={showErrors} />
        </FormField>
        {state.modelLocation === 'body' || state.modelLocation === 'query' ? (
          <FormField label={modelKeyLabel} htmlFor="interface-format-model-key">
            <Input
              id="interface-format-model-key"
              aria-label={modelKeyLabel}
              {...issueAria('interface-format-model-key', errors, showErrors)}
              value={state.modelKey}
              onChange={(event) => update('modelKey', event.target.value)}
              placeholder="例如：model"
            />
            <IssueSlot fieldId="interface-format-model-key" errors={errors} showErrors={showErrors} />
          </FormField>
        ) : null}
      </div>

      {state.modelLocation === 'path' ? (
        <p className="text-2xs text-muted-foreground">
          提交路径里要包含 {'{model}'}，发送时换成实际模型 ID。
        </p>
      ) : null}

      {state.payloadFormat === 'form' ? (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="嵌套字段写法" htmlFor="interface-format-form-field-style">
            <Select
              value={state.formFieldStyle}
              onValueChange={(value) => update('formFieldStyle', value as EditorState['formFieldStyle'])}
            >
              <SelectTrigger
                id="interface-format-form-field-style"
                size="sm"
                {...issueAria('interface-format-form-field-style', errors, showErrors)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dotted">点号分层（a.b）</SelectItem>
                <SelectItem value="bracket">方括号（a[b]）</SelectItem>
              </SelectContent>
            </Select>
            <IssueSlot fieldId="interface-format-form-field-style" errors={errors} showErrors={showErrors} />
          </FormField>
          <FormField label="数组写法" htmlFor="interface-format-form-array-style">
            <Select
              value={state.formArrayStyle}
              onValueChange={(value) => update('formArrayStyle', value as EditorState['formArrayStyle'])}
            >
              <SelectTrigger
                id="interface-format-form-array-style"
                size="sm"
                {...issueAria('interface-format-form-array-style', errors, showErrors)}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="repeat">重复同名键</SelectItem>
                <SelectItem value="bracket">方括号（a[]）</SelectItem>
                <SelectItem value="index">下标（a[0]）</SelectItem>
              </SelectContent>
            </Select>
            <IssueSlot fieldId="interface-format-form-array-style" errors={errors} showErrors={showErrors} />
          </FormField>
        </div>
      ) : null}

      <FixedWireRows
        kind="header"
        scope="submit"
        rows={state.fixedHeaders}
        errors={errors}
        onChange={(rows) => update('fixedHeaders', rows)}
        hint="这些请求头发送请求、查询任务和取结果时都会带上；鉴权头与 Content-Type 由上面的设置负责，不在这里填。"
        hintSubject="固定请求头"
      />
      <FixedWireRows
        kind="query"
        scope="submit"
        rows={state.fixedQuery}
        errors={errors}
        onChange={(rows) => update('fixedQuery', rows)}
        hint="这些查询参数只加在提交请求的地址上。"
        hintSubject="固定查询参数"
      />
    </div>
  );
}

import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@iart/ui';
import type { EditorState } from './interfaceFormatDraft';
import { FormField } from '../../../components/FormField';
import { InfoHint } from '../provider-connection/InfoHint';
import { OptionListEditor } from '../components/ParameterValueControls';
import { FixedWireRows } from './InterfaceFormatFixedWireRows';
import { IssueSlot, issueAria } from './InterfaceFormatIssueUi';

/**
 * 编辑器的「任务」分节（从 `InterfaceFormatEditor` 拆出）。
 *
 * 轮询请求可以额外带请求头、查询参数与 POST 请求体；三者的取值里都可以写 `{id}` 等占位，
 * 查询时由运行时换成实际的任务标识。请求体只在 POST 查询下存在——GET 时不渲染，避免
 * 用户填了一段永远不会发出去的内容。
 */

const POLLING_BODY_HINT =
  '取值里可以写 {id}、{taskId}、{requestId} 等占位，查询时会换成实际的任务标识。';

export function InterfaceFormatTaskFields({
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
  const successValuesAria = issueAria('interface-format-success-values', errors, showErrors);
  const failureValuesAria = issueAria('interface-format-failure-values', errors, showErrors);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <FormField label="任务模式" htmlFor="interface-format-task-mode">
          <Select
            value={state.taskMode}
            onValueChange={(value) => update('taskMode', value as EditorState['taskMode'])}
          >
            <SelectTrigger
              id="interface-format-task-mode"
              size="sm"
              aria-label="任务模式"
              {...issueAria('interface-format-task-mode', errors, showErrors)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sync">一次请求直接拿到结果</SelectItem>
              <SelectItem value="async">先返回任务，稍后再取</SelectItem>
            </SelectContent>
          </Select>
          <IssueSlot fieldId="interface-format-task-mode" errors={errors} showErrors={showErrors} />
        </FormField>
        {state.taskMode === 'sync' ? null : (
          <>
            <FormField label="任务标识位置" htmlFor="interface-format-identity-path">
              <Input
                id="interface-format-identity-path"
                aria-label="任务标识位置"
                {...issueAria('interface-format-identity-path', errors, showErrors)}
                value={state.identityPath}
                onChange={(event) => update('identityPath', event.target.value)}
                placeholder="例如：id"
              />
              <IssueSlot fieldId="interface-format-identity-path" errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="轮询地址" htmlFor="interface-format-polling-path">
              <Input
                id="interface-format-polling-path"
                aria-label="轮询地址"
                {...issueAria('interface-format-polling-path', errors, showErrors)}
                value={state.pollingPath}
                onChange={(event) => update('pollingPath', event.target.value)}
                placeholder="例如：/v1/tasks/{id}"
              />
              <IssueSlot fieldId="interface-format-polling-path" errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField
              label="轮询方法"
              htmlFor="interface-format-polling-method"
              hint={<InfoHint text="GET 查询不带请求体；需要提交请求体时改成 POST。" subject="轮询方法" />}
            >
              <Select
                value={state.pollingMethod}
                onValueChange={(value) => update('pollingMethod', value as EditorState['pollingMethod'])}
              >
                <SelectTrigger
                  id="interface-format-polling-method"
                  size="sm"
                  aria-label="轮询方法"
                  {...issueAria('interface-format-polling-method', errors, showErrors)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                </SelectContent>
              </Select>
              <IssueSlot fieldId="interface-format-polling-method" errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="状态字段" htmlFor="interface-format-status-path">
              <Input
                id="interface-format-status-path"
                aria-label="状态字段"
                {...issueAria('interface-format-status-path', errors, showErrors)}
                value={state.statusPath}
                onChange={(event) => update('statusPath', event.target.value)}
                placeholder="例如：status"
              />
              <IssueSlot fieldId="interface-format-status-path" errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="成功值" htmlFor="interface-format-success-values">
              <OptionListEditor<string>
                options={state.successValues}
                onChange={(next) => update('successValues', next)}
                addInputAriaLabel="成功值的新取值"
                addButtonAriaLabel="为成功值添加取值"
                removeButtonAriaPrefix="删掉成功值"
                inputId="interface-format-success-values"
                invalid={successValuesAria['aria-invalid']}
                describedBy={successValuesAria['aria-describedby']}
              />
              <IssueSlot fieldId="interface-format-success-values" errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="失败值（可留空）" htmlFor="interface-format-failure-values">
              <OptionListEditor<string>
                options={state.failureValues}
                onChange={(next) => update('failureValues', next)}
                addInputAriaLabel="失败值的新取值"
                addButtonAriaLabel="为失败值添加取值"
                removeButtonAriaPrefix="删掉失败值"
                inputId="interface-format-failure-values"
                invalid={failureValuesAria['aria-invalid']}
                describedBy={failureValuesAria['aria-describedby']}
              />
              <IssueSlot fieldId="interface-format-failure-values" errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="轮询间隔（毫秒）" htmlFor="interface-format-interval">
              <Input
                id="interface-format-interval"
                aria-label="轮询间隔"
                {...issueAria('interface-format-interval', errors, showErrors)}
                value={state.intervalMs}
                onChange={(event) => update('intervalMs', event.target.value.replace(/[^0-9]/g, ''))}
              />
              <IssueSlot fieldId="interface-format-interval" errors={errors} showErrors={showErrors} />
            </FormField>
            <FormField label="最多查询次数" htmlFor="interface-format-max-attempts">
              <Input
                id="interface-format-max-attempts"
                aria-label="最多查询次数"
                {...issueAria('interface-format-max-attempts', errors, showErrors)}
                value={state.maxAttempts}
                onChange={(event) => update('maxAttempts', event.target.value.replace(/[^0-9]/g, ''))}
              />
              <IssueSlot fieldId="interface-format-max-attempts" errors={errors} showErrors={showErrors} />
            </FormField>
          </>
        )}
      </div>

      {state.taskMode === 'sync' ? null : (
        <>
          {state.pollingMethod === 'POST' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="轮询请求体形态" htmlFor="interface-format-polling-body-format">
                  <Select
                    value={state.pollingBodyFormat}
                    onValueChange={(value) => {
                      const next = value as EditorState['pollingBodyFormat'];
                      update('pollingBodyFormat', next);
                      if (next === 'form' && state.pollingContentType.trim() === '') {
                        update('pollingContentType', 'application/x-www-form-urlencoded');
                      }
                    }}
                  >
                    <SelectTrigger
                      id="interface-format-polling-body-format"
                      size="sm"
                      aria-label="轮询请求体形态"
                      {...issueAria('interface-format-polling-body-format', errors, showErrors)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="json">结构化 JSON</SelectItem>
                      <SelectItem value="form">x-www-form-urlencoded</SelectItem>
                    </SelectContent>
                  </Select>
                  <IssueSlot fieldId="interface-format-polling-body-format" errors={errors} showErrors={showErrors} />
                </FormField>
                <FormField label="轮询 Content-Type（可留空）" htmlFor="interface-format-polling-content-type">
                  <Input
                    id="interface-format-polling-content-type"
                    aria-label="轮询 Content-Type"
                    {...issueAria('interface-format-polling-content-type', errors, showErrors)}
                    value={state.pollingContentType}
                    onChange={(event) => update('pollingContentType', event.target.value)}
                    placeholder="例如：application/json"
                  />
                  <IssueSlot fieldId="interface-format-polling-content-type" errors={errors} showErrors={showErrors} />
                </FormField>
              </div>
              <FormField
                label="轮询请求体（JSON，可留空）"
                htmlFor="interface-format-polling-body"
                hint={<InfoHint text={POLLING_BODY_HINT} subject="轮询请求体" />}
              >
                <Textarea
                  id="interface-format-polling-body"
                  aria-label="轮询请求体"
                  {...issueAria('interface-format-polling-body', errors, showErrors)}
                  value={state.pollingBody}
                  onChange={(event) => update('pollingBody', event.target.value)}
                  placeholder={'例如：{"task_id": "{id}"}'}
                  rows={3}
                />
                <IssueSlot fieldId="interface-format-polling-body" errors={errors} showErrors={showErrors} />
              </FormField>
            </>
          ) : null}
          <FixedWireRows
            kind="header"
            scope="polling"
            rows={state.pollingHeaders}
            errors={errors}
            onChange={(rows) => update('pollingHeaders', rows)}
            hint={POLLING_BODY_HINT}
            hintSubject="轮询请求头"
          />
          <FixedWireRows
            kind="query"
            scope="polling"
            rows={state.pollingQuery}
            errors={errors}
            onChange={(rows) => update('pollingQuery', rows)}
            hint={POLLING_BODY_HINT}
            hintSubject="轮询查询参数"
          />
        </>
      )}
    </div>
  );
}

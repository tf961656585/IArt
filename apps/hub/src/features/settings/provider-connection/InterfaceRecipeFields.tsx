import type { Dispatch, SetStateAction } from 'react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@iart/ui';
import type {
  InterfaceRecipeDryRunResponse,
  RecipeCondition,
  RecipeInlineEncoding,
  RecipeMediaType,
  RecipeResultForm,
} from '@iart/contracts';
import { FieldLabelRow, InfoHint } from './InfoHint';
import {
  emptyConditionRow,
  replaceConditionRowPath,
  type RecipeConditionRowDraft,
} from './interfaceRecipeConditions';
import type { InterfaceRecipeFormState, PathTarget } from './InterfaceRecipeForm';

/**
 * 接口配方表单的字段树与样本工具（从 `InterfaceRecipeForm` 拆出：表单文件只保留状态与提交）。
 *
 * 纯展示：所有状态与回调都来自 `useInterfaceRecipeForm`；本文件不发请求、不改数据形状。
 */

const MEDIA_TYPE_OPTIONS: ReadonlyArray<{ value: RecipeMediaType; label: string }> = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];

const ENCODING_OPTIONS: ReadonlyArray<{ value: RecipeInlineEncoding; label: string }> = [
  { value: 'data_url', label: '值已经是 data: 开头' },
  { value: 'json_inline', label: 'JSON 里的 data 字段' },
  { value: 'raw_base64', label: '裸 Base64' },
];

const RESULT_KIND_OPTIONS: ReadonlyArray<{ value: RecipeResultForm['kind']; label: string }> = [
  { value: 'direct_url', label: '直接返回链接' },
  { value: 'inline_media', label: '直接返回内容' },
  { value: 'needs_fetch', label: '需要再取一次' },
];

const VALUE_KIND_LABELS: Readonly<Record<string, string>> = {
  string: '文字',
  number: '数字',
  boolean: '是或否',
  null: '空值',
  array: '列表',
  object: '对象',
};

const ACCEPT_OPTIONS = [
  { value: 'binary', label: '文件本身' },
  { value: 'json', label: '一段 JSON' },
] as const;

const AFTER_KIND_OPTIONS = [
  { value: 'direct_url', label: '里面的链接' },
  { value: 'inline_media', label: '里面的内容' },
] as const;

const CONDITION_HINT: Record<'success' | 'failure', string> = {
  success: '填的字段路径命中这里的允许值时，就认为生成完成。多个允许值之间是「任一命中」；添加多行也是「任一命中」。',
  failure: '命中这里的条件时直接算作失败，不再继续等待。',
};

const RESULT_HINT =
  '选择服务商把产物放在哪里：查询响应里直接给链接、直接给内容，还是只给任务标识、需要再取一次。';

/** 标量在界面上的文本（试跑结果与路径发现共用）。 */
const formatPreview = (value: unknown): string => {
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return '—';
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return '—';
  }
};

const mediaTypeLabel = (mediaType: string): string =>
  MEDIA_TYPE_OPTIONS.find((option) => option.value === mediaType)?.label ?? mediaType;

/** 把条件树里「简单模式表达不了」的原始树展示出来；不静默丢弃用户的既有判定。 */
function UnsupportedConditionNotice({
  label,
  tree,
  onUseSimple,
}: {
  label: string;
  tree: RecipeCondition;
  onUseSimple: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2">
      <p className="text-2xs text-muted-foreground">
        这份{label}用了这个表单表达不了的条件。不改它时保存会原样保留。
      </p>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-2xs text-muted-foreground">
        {JSON.stringify(tree, null, 2)}
      </pre>
      <Button type="button" variant="outline" size="2xs" className="self-start" onClick={onUseSimple}>
        清空并改为按行填写
      </Button>
    </div>
  );
}

/** 简单模式的一组判定的编辑区（成功 / 失败共用）。 */
function ConditionRowsEditor({
  label,
  rows,
  onChange,
  onFocusPath,
}: {
  label: string;
  rows: RecipeConditionRowDraft[];
  onChange: Dispatch<SetStateAction<RecipeConditionRowDraft[]>>;
  onFocusPath: (target: PathTarget) => void;
}) {
  const targetKind = label === '成功判定' ? 'success' : 'failure';
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-md bg-elevated px-3 py-2">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`${label}第 ${index + 1} 行的字段路径`}
              className="h-7 flex-1 text-xs"
              value={row.path}
              placeholder="例如 status"
              autoComplete="off"
              onFocus={() => onFocusPath({ kind: targetKind, index })}
              onChange={(event) =>
                onChange((current) => replaceConditionRowPath(current, index, event.target.value))
              }
            />
            <Button
              type="button"
              variant="ghost-destructive"
              size="2xs"
              aria-label={`删掉${label}第 ${index + 1} 行`}
              onClick={() => onChange((current) => (current.length === 1 ? [emptyConditionRow()] : current.filter((_, i) => i !== index)))}
            >
              删除这行
            </Button>
          </div>
          <Input
            aria-label={`${label}第 ${index + 1} 行的允许值`}
            className="h-7 text-xs"
            value={row.valuesText}
            placeholder="允许的值，多个用逗号分开；留空表示只要这个字段存在"
            autoComplete="off"
            onChange={(event) =>
              onChange((current) =>
                current.map((item, i) => (i === index ? { ...item, valuesText: event.target.value } : item)),
              )
            }
          />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange((current) => [...current, emptyConditionRow()])}
      >
        添加一行
      </Button>
    </div>
  );
}

/** 路径字段列表（产物地址 / 取回后的产物地址共用）。 */
function PathListFields({
  label,
  placeholder,
  paths,
  focusKind,
  onFocus,
  onChange,
  onAdd,
  onRemove,
}: {
  label: string;
  placeholder: string;
  paths: string[];
  focusKind: 'media' | 'afterMedia';
  onFocus: (target: PathTarget) => void;
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {paths.map((path, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`${label}第 ${index + 1} 行的字段路径`}
            className="h-7 flex-1 text-xs"
            value={path}
            placeholder={placeholder}
            autoComplete="off"
            onFocus={() => onFocus({ kind: focusKind, index })}
            onChange={(event) => onChange(index, event.target.value)}
          />
          <Button
            type="button"
            variant="ghost-destructive"
            size="2xs"
            aria-label={`删掉${label}第 ${index + 1} 行`}
            onClick={() => onRemove(index)}
          >
            删除这行
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={onAdd}>
        添加一行
      </Button>
    </div>
  );
}

/** 表单字段树（纯展示）：状态全部来自 `useInterfaceRecipeForm`。 */
export function InterfaceRecipeFields({ form }: { form: InterfaceRecipeFormState }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <FieldLabelRow htmlFor="interface-recipe-name" label="名称" />
        <Input
          id="interface-recipe-name"
          value={form.name}
          placeholder="例如：Seedance 任务查询"
          autoComplete="off"
          onChange={(event) => form.onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') form.submit();
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabelRow
          htmlFor="interface-recipe-family"
          label="接口格式"
          hint={{ text: '配方只能用于同一种接口格式的模型。创建后不能改。', subject: '接口格式' }}
        />
        {form.editing ? (
          <span className="text-xs text-muted-foreground">
            {form.familyOptions.find((option) => option.value === form.familyAdapterId)?.label
              ?? form.familyAdapterId
              ?? ''}
          </span>
        ) : (
          <Select
            {...(form.familyAdapterId === null ? {} : { value: form.familyAdapterId })}
            onValueChange={(next) => {
              const matched = form.familyOptions.find((option) => option.value === next);
              if (matched !== undefined) form.onFamilyAdapterIdChange(matched.value);
            }}
          >
            <SelectTrigger id="interface-recipe-family" size="sm" className="w-full">
              <SelectValue placeholder="请选择接口格式" />
            </SelectTrigger>
            <SelectContent>
              {form.familyOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {form.recipeResetNotice === null ? null : (
          <p className="text-2xs text-muted-foreground">{form.recipeResetNotice}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold tracking-wider text-muted-foreground">成功判定</span>
          <InfoHint text={CONDITION_HINT.success} subject="成功判定" />
        </div>
        {form.successUnsupported === null ? (
          <ConditionRowsEditor
            label="成功判定"
            rows={form.successRows}
            onChange={form.onSuccessRowsChange}
            onFocusPath={form.onFocusPath}
          />
        ) : (
          <UnsupportedConditionNotice
            label="成功判定"
            tree={form.successUnsupported}
            onUseSimple={form.useSimpleSuccess}
          />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            checked={form.failureEnabled}
            onCheckedChange={form.onFailureEnabledChange}
            aria-label="同时判断失败"
          />
          <span className="text-2xs font-semibold tracking-wider text-muted-foreground">失败判定</span>
          <InfoHint text={CONDITION_HINT.failure} subject="失败判定" />
        </div>
        {form.failureEnabled ? (
          form.failureUnsupported === null ? (
            <ConditionRowsEditor
              label="失败判定"
              rows={form.failureRows}
              onChange={form.onFailureRowsChange}
              onFocusPath={form.onFocusPath}
            />
          ) : (
            <UnsupportedConditionNotice
              label="失败判定"
              tree={form.failureUnsupported}
              onUseSimple={form.useSimpleFailure}
            />
          )
        ) : null}
        {form.failureEnabled ? (
          <div className="flex flex-col gap-2">
            <FieldLabelRow
              htmlFor="interface-recipe-failure-reason"
              label="失败原因"
              hint={{
                text: '失败判定命中时，任务失败的提示里会显示这句话。留空就显示服务商返回的内容。',
                subject: '失败原因',
              }}
            />
            <Textarea
              id="interface-recipe-failure-reason"
              aria-label="失败原因"
              className="min-h-16 text-xs"
              maxLength={140}
              value={form.failureReason}
              placeholder="例如：这段内容被服务商拒绝了，改一下提示词再试。"
              onChange={(event) => form.onFailureReasonChange(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabelRow
          htmlFor="interface-recipe-result-kind"
          label="结果形态"
          hint={{ text: RESULT_HINT, subject: '结果形态' }}
        />
        <Select
          value={form.resultKind}
          onValueChange={(next) => {
            const matched = RESULT_KIND_OPTIONS.find((option) => option.value === next);
            if (matched !== undefined) form.onResultKindChange(matched.value);
          }}
        >
          <SelectTrigger id="interface-recipe-result-kind" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESULT_KIND_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {form.resultKind === 'needs_fetch' ? (
          <NeedsFetchResultFields form={form} />
        ) : (
          <DirectResultFields form={form} />
        )}
      </div>

      <div className="flex items-center gap-2">
        <Switch
          checked={form.requiresAuth}
          onCheckedChange={form.onRequiresAuthChange}
          aria-label="产物地址需要凭证"
        />
        <span className="text-xs">产物地址需要凭证</span>
        <InfoHint text="下载产物时会带上这个服务商的密钥。" subject="产物地址需要凭证" />
      </div>

      <SampleTools form={form} />

      {form.attempted && form.issues.length > 0 ? (
        <div className="flex flex-col gap-1">
          {form.issues.map((issue) => (
            <p key={issue} role="alert" className="text-2xs text-destructive">{issue}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}

function MediaTypeField({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: RecipeMediaType;
  onChange: (next: RecipeMediaType) => void;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <FieldLabelRow htmlFor={id} label={label} />
      <Select
        value={value}
        onValueChange={(next) => {
          const matched = MEDIA_TYPE_OPTIONS.find((option) => option.value === next);
          if (matched !== undefined) onChange(matched.value);
        }}
      >
        <SelectTrigger id={id} size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MEDIA_TYPE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DirectResultFields({ form }: { form: InterfaceRecipeFormState }) {
  const inline = form.resultKind === 'inline_media';
  return (
    <div className="flex flex-col gap-2 rounded-md bg-elevated px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground">
          {inline ? '产物内容在哪' : '产物链接在哪'}
        </span>
        <InfoHint
          text={inline
            ? '填响应里放着产物内容的字段路径。'
            : '填响应里放着产物下载地址的字段路径。'}
          subject={inline ? '产物内容' : '产物链接'}
        />
      </div>
      <PathListFields
        label={inline ? '产物内容' : '产物地址'}
        placeholder={inline ? '例如 data.b64_json' : '例如 data.url'}
        paths={form.mediaPaths}
        focusKind="media"
        onFocus={form.onFocusPath}
        onChange={form.onMediaPathChange}
        onAdd={form.onAddMediaPath}
        onRemove={form.onRemoveMediaPath}
      />
      <MediaTypeField
        id="interface-recipe-media-type"
        label="产物类型"
        value={form.mediaType}
        onChange={form.onMediaTypeChange}
      />
      {inline ? (
        <>
          <div className="flex flex-col gap-2">
            <FieldLabelRow htmlFor="interface-recipe-encoding" label="内容格式" />
            <Select
              value={form.encoding}
              onValueChange={(next) => {
                const matched = ENCODING_OPTIONS.find((option) => option.value === next);
                if (matched !== undefined) form.onEncodingChange(matched.value);
              }}
            >
              <SelectTrigger id="interface-recipe-encoding" size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCODING_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {form.encoding === 'raw_base64' ? (
            <div className="flex flex-col gap-2">
              <FieldLabelRow htmlFor="interface-recipe-mime-type" label="内容类型（可选）" />
              <Input
                id="interface-recipe-mime-type"
                className="h-7 text-xs"
                value={form.mimeType}
                placeholder="留空按产物类型判断"
                autoComplete="off"
                onChange={(event) => form.onMimeTypeChange(event.target.value)}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function NeedsFetchResultFields({ form }: { form: InterfaceRecipeFormState }) {
  return (
    <div className="flex flex-col gap-3 rounded-md bg-elevated px-3 py-2">
      <div className="flex flex-col gap-2">
        <FieldLabelRow htmlFor="interface-recipe-identity-path" label="任务标识的字段路径" />
        <Input
          id="interface-recipe-identity-path"
          className="h-7 text-xs"
          value={form.identityPath}
          placeholder="例如 data.task_id"
          autoComplete="off"
          onFocus={() => form.onFocusPath({ kind: 'identity' })}
          onChange={(event) => form.onIdentityPathChange(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <FieldLabelRow
          htmlFor="interface-recipe-content-url"
          label="结果地址模板"
          hint={{ text: '用任务标识替换 {id} 后再请求一次，拿到最终产物。', subject: '结果地址模板' }}
        />
        <Input
          id="interface-recipe-content-url"
          className="h-7 text-xs"
          value={form.contentUrlTemplate}
          placeholder="例如 /v1/videos/{id}/content"
          autoComplete="off"
          onChange={(event) => form.onContentUrlTemplateChange(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <FieldLabelRow htmlFor="interface-recipe-accept" label="结果地址返回" />
        <Select
          value={form.accept}
          onValueChange={(next) => {
            const matched = ACCEPT_OPTIONS.find((option) => option.value === next);
            if (matched !== undefined) form.onAcceptChange(matched.value);
          }}
        >
          <SelectTrigger id="interface-recipe-accept" size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACCEPT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <MediaTypeField
        id="interface-recipe-needs-fetch-media-type"
        label="产物类型"
        value={form.mediaType}
        onChange={form.onMediaTypeChange}
      />
      {form.accept === 'json' ? (
        <div className="flex flex-col gap-2">
          <FieldLabelRow htmlFor="interface-recipe-after-kind" label="取回后从哪取产物" />
          <Select
            value={form.afterKind}
            onValueChange={(next) => {
              const matched = AFTER_KIND_OPTIONS.find((option) => option.value === next);
              if (matched !== undefined) form.onAfterKindChange(matched.value);
            }}
          >
            <SelectTrigger id="interface-recipe-after-kind" size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AFTER_KIND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <PathListFields
            label={form.afterKind === 'inline_media' ? '取回后的产物内容' : '取回后的产物地址'}
            placeholder={form.afterKind === 'inline_media' ? '例如 data.b64_json' : '例如 data.url'}
            paths={form.afterPaths}
            focusKind="afterMedia"
            onFocus={form.onFocusPath}
            onChange={form.onAfterPathChange}
            onAdd={form.onAddAfterPath}
            onRemove={form.onRemoveAfterPath}
          />
          {form.afterKind === 'inline_media' ? (
            <Select
              value={form.afterEncoding}
              onValueChange={(next) => {
                const matched = ENCODING_OPTIONS.find((option) => option.value === next);
                if (matched !== undefined) form.onAfterEncodingChange(matched.value);
              }}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="取回内容的内容格式">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCODING_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {form.afterKind === 'inline_media' && form.afterEncoding === 'raw_base64' ? (
            <Input
              aria-label="取回内容的内容类型"
              className="h-7 text-xs"
              value={form.afterMimeType}
              placeholder="内容类型，留空按产物类型判断"
              autoComplete="off"
              onChange={(event) => form.onAfterMimeTypeChange(event.target.value)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SampleTools({ form }: { form: InterfaceRecipeFormState }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground">响应样本</span>
        <InfoHint
          text="把服务商查询任务时返回的响应贴进来，可以找字段路径，也可以先试跑这份配方。试跑只在本机计算，不会发出请求。"
          subject="响应样本"
        />
      </div>
      <Textarea
        aria-label="响应样本"
        className="min-h-24 font-mono text-xs"
        value={form.sampleText}
        placeholder='粘贴一段响应 JSON，例如 {"status":"succeeded","data":{"task_id":"..."}}'
        onChange={(event) => form.onSampleTextChange(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={form.discoveryBusy}
          onClick={form.runDiscovery}
        >
          找出字段路径
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={form.dryRunBusy}
          onClick={form.runDryRun}
        >
          试跑
        </Button>
        {form.pathNotice === null ? null : (
          <span className="text-2xs text-muted-foreground">{form.pathNotice}</span>
        )}
      </div>

      {form.discoveryError === null ? null : (
        <p role="alert" className="text-2xs text-destructive">{form.discoveryError}</p>
      )}
      {form.discovery === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">
            {form.discovery.paths.length === 0
              ? '这段样本里没有可用的字段路径。'
              : `找到 ${form.discovery.paths.length} 个字段路径，点一个填进刚才点过的路径框。`}
          </span>
          {form.discovery.paths.length === 0 ? null : (
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {form.discovery.paths.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-left text-2xs transition-colors hover:bg-muted"
                  onClick={() => form.applyPath(item.path)}
                >
                  <span className="font-mono">{item.path}</span>
                  <span className="text-muted-foreground">{formatPreview(item.value)}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {VALUE_KIND_LABELS[item.value_kind] ?? item.value_kind}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {form.dryRunError === null ? null : (
        <p role="alert" className="text-2xs text-destructive">{form.dryRunError}</p>
      )}
      {form.dryRun === null ? null : <DryRunReport report={form.dryRun} />}
    </div>
  );
}

function DryRunReport({ report }: { report: InterfaceRecipeDryRunResponse }) {
  const verdictText =
    report.verdict === 'success'
      ? '按现在的配方，这段样本会被判为成功。'
      : report.verdict === 'failure'
        ? '按现在的配方，这段样本会被判为失败。'
        : '按现在的配方，这段样本还不算结束，会继续等待。';

  return (
    <div className="flex flex-col gap-2 rounded-md bg-elevated px-3 py-2">
      <p className="text-xs font-medium">{verdictText}</p>

      <div className="flex flex-col gap-1">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground">命中的字段</span>
        {report.matched.length === 0 ? (
          <span className="text-2xs text-muted-foreground">没有命中任何条件字段。</span>
        ) : (
          report.matched.map((item) => (
            <span key={`${item.path}:${formatPreview(item.value)}`} className="font-mono text-2xs">
              {item.path} = {formatPreview(item.value)}
            </span>
          ))
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-2xs font-semibold tracking-wider text-muted-foreground">取到的产物</span>
        {report.outputs.length === 0 ? (
          <span className="text-2xs text-muted-foreground">这段样本里没有抽到产物。</span>
        ) : (
          report.outputs.map((output, index) => (
            <span key={`${output.source_path}:${index}`} className="break-all text-2xs">
              {mediaTypeLabel(output.media_type)} · {output.source_path}
              {' → '}
              {output.url ?? output.text_value ?? '没有可显示的内容'}
            </span>
          ))
        )}
      </div>

      {report.unseen_paths.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-2xs font-semibold tracking-wider text-muted-foreground">
            样本里没找到的字段
          </span>
          <span className="text-2xs text-muted-foreground">
            检查一下路径是否写错：
            {report.unseen_paths.join('、')}
          </span>
        </div>
      )}
    </div>
  );
}


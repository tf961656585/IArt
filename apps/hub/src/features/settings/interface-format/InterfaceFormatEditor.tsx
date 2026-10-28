import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  cn,
  SELECTION_SOFT_COMPACT_CLASSES,
} from '@iart/ui';
import type {
  FamilyTemplateOfficialField,
  InterfaceFormatDetail,
  InterfaceRecipe,
  RecipeDirectResult,
} from '@iart/contracts';
import { InterfaceFormatMediaSlotFields, MEDIA_SLOT_OPTIONS } from './InterfaceFormatMediaSlotFields';
import { InterfaceFormatParameterRows } from './InterfaceFormatParameterRows';
import { InterfaceFormatSubmitFields } from './InterfaceFormatSubmitFields';
import { InterfaceFormatTaskFields } from './InterfaceFormatTaskFields';
import { IssueSlot, issueAria } from './InterfaceFormatIssueUi';
import {
  buildInterfaceFormatDraft,
  conditionValues,
  type EditorState,
  type ParamRow,
  type PromptLocation,
} from './interfaceFormatDraft';
import {
  SECTION_BASIC,
  SECTION_MEDIA,
  SECTION_PARAMS,
  SECTION_RESULT,
  SECTION_SUBMIT,
  SECTION_TASK,
  collectIssues,
  groupIssuesByField,
  type EditorIssue,
} from './interfaceFormatIssues';
import type { HubApiClient } from '../../../client/types';
import { FormField } from '../../../components/FormField';
import { ConfirmDialog } from '../provider-connection/ConfirmDialog';
import {
  emptyConditionRow,
  conditionToRows,
} from '../provider-connection/interfaceRecipeConditions';
import { describeErrorWithReason } from '../provider-connection/useProviderConnectionData';

/**
 * 用户自建接口格式的整页编辑器（docs/custom-providers/接口格式旅程-design.md §2/§3）。
 *
 * 表单只认识**声明式草稿**（`CustomInterfaceFormatDraft`）：传输（提交路径 / 方法 / 请求体形态 /
 * 鉴权形状 / 固定请求头与固定查询参数）、参数表与每个值的发送落点（请求体 / 查询参数 /
 * 请求头，提示词另有纯文本正文、模型 ID 另有地址路径）、轮询请求、结果形态与可选失败判定。
 * 实体与判定配方的合成都由 Runtime Backend 完成——界面不拼请求规则树、不碰宏，
 * 也不持有第二份实体形状。
 *
 * 保存前校验只有一份来源：`collectIssues` 把契约校验（`CustomInterfaceFormatDraftSchema`）
 * 与界面才知道的检查（默认值类型）合并成一组可定位错误。保存按钮始终可点，点击后才铺开
 * 行内错误并聚焦第一个问题。
 */

type EditorInitial = {
  detail: InterfaceFormatDetail;
  recipe: InterfaceRecipe | null;
};

export type InterfaceFormatEditorProps = {
  mode: 'create' | 'edit';
  initial?: EditorInitial;
  api: HubApiClient;
  onCancel: () => void;
  onSaved: (detail: InterfaceFormatDetail) => void;
  /** 打开编辑器时的一句提示（如「已复制传输设置，请补全判定与结果」）。 */
  notice?: string;
  /**
   * 把「有未保存改动时能不能离开」的判断交给外壳（左侧设置导航），
   * 让编辑器以外的离开入口也走同一份确认。传 null 表示守卫已撤销。
   */
  registerLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
};

/** 分节导航项，顺序与右侧分节一致（也用于滚动时判定当前节）。 */
const SECTION_NAV_ITEMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: SECTION_BASIC, label: '基本信息' },
  { id: SECTION_SUBMIT, label: '提交请求' },
  { id: SECTION_PARAMS, label: '参数' },
  { id: SECTION_MEDIA, label: '素材位' },
  { id: SECTION_TASK, label: '任务' },
  { id: SECTION_RESULT, label: '判定与结果' },
];

/** 判定「当前节」的顶部容差：滚动停在分节标题附近时仍算该节。 */
const ACTIVE_SECTION_TOLERANCE = 24;

/** 官方字段的组件形态 → 参数类型（权威来源；未知组件回落到旧的取值推断）。 */
const TYPE_FROM_COMPONENT: Readonly<Record<string, ParamRow['type']>> = {
  select: 'enum',
  switch: 'boolean',
  number: 'number',
  text: 'string',
};

const parameterTypeOf = (field: FamilyTemplateOfficialField): ParamRow['type'] => {
  const byComponent = TYPE_FROM_COMPONENT[field.component];
  if (byComponent !== undefined) return byComponent;
  if (field.enum_options.length > 0) return 'enum';
  if (field.default_value === null) return 'string';
  if (typeof field.default_value === 'number') return 'number';
  if (typeof field.default_value === 'boolean') return 'boolean';
  return 'string';
};

const buildInitialState = (initial: EditorInitial | undefined): EditorState => {
  if (initial === undefined) {
    return {
      displayName: '',
      submitPath: '',
      method: 'POST',
      payloadFormat: 'json',
      contentType: 'application/json',
      formFieldStyle: 'dotted',
      formArrayStyle: 'repeat',
      authKind: 'bearer',
      authHeaderName: 'Authorization',
      authPrefix: 'Bearer',
      authQueryName: 'key',
      fixedHeaders: [],
      fixedQuery: [],
      promptLocation: 'body',
      promptKey: 'prompt',
      modelLocation: 'none',
      modelKey: '',
      params: [],
      mediaSlots: [],
      taskMode: 'sync',
      identityPath: '',
      pollingPath: '',
      pollingMethod: 'GET',
      pollingHeaders: [],
      pollingQuery: [],
      pollingBody: '',
      pollingBodyFormat: 'json',
      pollingContentType: '',
      statusPath: '',
      successValues: [],
      failureValues: [],
      intervalMs: '10000',
      maxAttempts: '300',
      resultKind: 'direct_url',
      resultPathsText: '',
      mediaType: 'image',
      encoding: 'data_url',
      fetchIdentityPath: '',
      contentUrlTemplate: '',
      requiresAuth: false,
      failureRows: [emptyConditionRow()],
      failureReason: '',
    };
  }

  const { detail, recipe } = initial;
  const transport = detail.transport;
  const result = recipe?.result;
  const directResult: RecipeDirectResult | null =
    result !== undefined && result.kind !== 'needs_fetch' ? result : null;
  const afterResult = result !== undefined && result.kind === 'needs_fetch' ? result.after ?? null : null;
  const officialFields = detail.parameter_descriptor?.official_fields ?? [];
  const asyncConfig = transport?.async ?? null;
  const successWhen = recipe?.success_when;
  const failureWhen = recipe?.failure_when;
  const statusFromRecipe =
    successWhen !== undefined && (successWhen.op === 'in' || successWhen.op === 'eq')
      ? successWhen.path
      : '';

  // 回填落点：判不出来（null）时给一个可编辑的空位置，不按名字猜。
  const promptBinding = transport?.prompt_binding ?? null;
  const promptLocation: PromptLocation = promptBinding === null ? 'body' : promptBinding.location;
  const promptKey = promptBinding === null || promptBinding.location === 'text'
    ? ''
    : promptBinding.location === 'body'
      ? promptBinding.path
      : promptBinding.name;
  const modelBinding = transport?.model_binding ?? null;
  const modelLocation = modelBinding === null ? 'none' : modelBinding.location;
  const modelKey = modelBinding === null || modelBinding.location === 'path'
    ? ''
    : modelBinding.location === 'body'
      ? modelBinding.path
      : modelBinding.name;
  const polling = asyncConfig?.polling ?? null;

  return {
    displayName: detail.summary.display_name,
    submitPath: transport?.submit.path ?? '',
    method: (transport?.submit.method as 'POST' | 'GET' | 'PUT' | 'PATCH' | undefined) ?? 'POST',
    payloadFormat: transport?.submit.payload_format ?? 'json',
    contentType: transport?.submit.content_type ?? '',
    formFieldStyle: transport?.submit.form_field_style ?? 'dotted',
    formArrayStyle: transport?.submit.form_array_style ?? 'repeat',
    authKind: transport?.auth.kind ?? 'bearer',
    authHeaderName: transport?.auth.kind === 'query_api_key' ? 'Authorization' : transport?.auth.header_name ?? 'Authorization',
    authPrefix: transport?.auth.kind === 'bearer' ? transport.auth.prefix ?? '' : '',
    authQueryName: transport?.auth.kind === 'query_api_key' ? transport.auth.query_name : 'key',
    fixedHeaders: transport?.submit.headers.map((entry) => ({ name: entry.name, value: entry.value })) ?? [],
    fixedQuery: transport?.submit.query.map((entry) => ({ name: entry.name, value: entry.value })) ?? [],
    promptLocation,
    promptKey,
    modelLocation,
    modelKey,
    params: officialFields
      .filter((field) => field.field_key !== '__prompt' && field.media_slot_id === undefined)
      .map((field) => ({
        location: field.wire_location,
        key: field.wire_name,
        label: field.label,
        type: parameterTypeOf(field),
        required: field.required,
        defaultValue: field.default_value === null ? '' : String(field.default_value),
        enumValues: field.enum_options.map((value) => String(value)),
        defaultNote: '',
        locationNote: '',
      })),
    mediaSlots: detail.media_slots.map((slot) => ({
      slotId: slot.slot_id,
      fieldKey: slot.field_key,
      label: officialFields.find((field) => field.media_slot_id === slot.slot_id)?.label
        ?? MEDIA_SLOT_OPTIONS.find((option) => option.value === slot.slot_id)?.label
        ?? slot.slot_id,
      required: slot.required,
      maxFiles: String(slot.max_files ?? 1),
      // 详情契约判不出载体时给 null（不按名字猜）：界面回填为「未选择」，由用户明确选。
      carrier: slot.carrier ?? '',
    })),
    taskMode: asyncConfig === null ? 'sync' : 'async',
    identityPath: asyncConfig?.identity_path ?? '',
    pollingPath: asyncConfig?.polling.url_template ?? '',
    pollingMethod: (asyncConfig?.polling.method as 'GET' | 'POST' | undefined) ?? 'GET',
    pollingHeaders: polling?.headers.map((entry) => ({ name: entry.name, value: entry.value })) ?? [],
    pollingQuery: polling?.query.map((entry) => ({ name: entry.name, value: entry.value })) ?? [],
    pollingBody: polling?.body === undefined ? '' : JSON.stringify(polling.body, null, 2),
    pollingBodyFormat: polling?.body_format ?? 'json',
    pollingContentType: polling?.content_type ?? '',
    statusPath: statusFromRecipe,
    successValues: conditionValues(successWhen),
    failureValues: conditionValues(failureWhen),
    intervalMs: String(asyncConfig?.polling.interval_ms ?? 10000),
    maxAttempts: String(asyncConfig?.polling.max_attempts ?? 300),
    resultKind: result?.kind ?? 'direct_url',
    resultPathsText: (directResult ?? afterResult)?.media_field_paths.join('\n') ?? '',
    mediaType: (directResult ?? afterResult)?.media_type ?? 'image',
    encoding: directResult?.kind === 'inline_media' ? directResult.encoding : 'data_url',
    fetchIdentityPath: result?.kind === 'needs_fetch' ? result.identity_field_path : '',
    contentUrlTemplate: result?.kind === 'needs_fetch' ? result.content_url_template : '',
    requiresAuth: recipe?.requires_auth ?? false,
    failureRows: conditionToRows(recipe?.failure_when) ?? [emptyConditionRow()],
    failureReason: recipe?.failure_reason ?? '',
  };
};

export function InterfaceFormatEditor({
  mode,
  initial,
  api,
  onCancel,
  onSaved,
  notice,
  registerLeaveGuard,
}: InterfaceFormatEditorProps) {
  const [state, setState] = useState<EditorState>(() => buildInitialState(initial));
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [failureText, setFailureText] = useState<string | null>(null);
  /** 用户是否动过表单。所有字段/行修改都经 `update`，因此在这里统一置位。
   *  用 ref 而非 state：保存成功后页面会立即跳转，守卫必须在这条同步路径上读到「已保存」。 */
  const dirtyRef = useRef(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  /** 离开确认框的 Promise resolver；同一时刻最多一个（防叠弹窗）。 */
  const leaveResolverRef = useRef<((ok: boolean) => void) | null>(null);
  /** 右侧滚动容器：分节导航的当前节由它的滚动位置决定。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<string>(SECTION_BASIC);

  const update = <K extends keyof EditorState>(key: K, value: EditorState[K]): void => {
    dirtyRef.current = true;
    setState((current) => ({ ...current, [key]: value }));
  };

  /**
   * 「能离开吗」的唯一判定口：编辑器「返回」与设置页导航切换都问它。
   * 没改过内容直接放行；有改动则弹一次确认，用户确认才放行。
   * 已有确认框在处理中时再次调用返回 false，不叠第二个弹窗。
   */
  const askLeave = useCallback((): Promise<boolean> => {
    if (!dirtyRef.current) return Promise.resolve(true);
    if (leaveResolverRef.current !== null) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      leaveResolverRef.current = resolve;
      setLeaveConfirmOpen(true);
    });
  }, []);

  const resolveLeave = (ok: boolean): void => {
    setLeaveConfirmOpen(false);
    const resolve = leaveResolverRef.current;
    leaveResolverRef.current = null;
    resolve?.(ok);
  };

  // 把守卫交给外壳；卸载或守卫变化时撤销，并把仍在等待的调用以「不许离开」收尾，
  // 避免外壳永久 await 一个再也不会 resolve 的 Promise。
  useEffect(() => {
    if (registerLeaveGuard === undefined) return;
    registerLeaveGuard(askLeave);
    return () => {
      registerLeaveGuard(null);
      const resolve = leaveResolverRef.current;
      leaveResolverRef.current = null;
      resolve?.(false);
    };
  }, [askLeave, registerLeaveGuard]);

  const handleCancel = async (): Promise<void> => {
    if (await askLeave()) onCancel();
  };

  const issues = useMemo(() => collectIssues(state), [state]);
  const errorsByField = useMemo(() => groupIssuesByField(issues), [issues]);

  // 当前节按右侧滚动容器的真实几何判定：取「顶部已越过容差」的最后一节。
  // 不用 IntersectionObserver 的交叉比例——长分节会让高亮在节内中段跳到下一节。
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const syncActiveSection = (): void => {
      const rootTop = root.getBoundingClientRect().top;
      let current: string = SECTION_BASIC;
      for (const item of SECTION_NAV_ITEMS) {
        const element = root.querySelector<HTMLElement>(`#${item.id}`);
        if (element === null) continue;
        if (element.getBoundingClientRect().top - rootTop <= ACTIVE_SECTION_TOLERANCE) {
          current = item.id;
        }
      }
      // 可滚动且滚到底时，最后一节可能永远越不过顶部容差（末节短于视口），显式兜底到末节。
      if (
        root.scrollHeight > root.clientHeight + 1
        && root.scrollTop + root.clientHeight >= root.scrollHeight - 1
      ) {
        current = SECTION_RESULT;
      }
      setActiveSection(current);
    };
    syncActiveSection();
    root.addEventListener('scroll', syncActiveSection, { passive: true });
    return () => root.removeEventListener('scroll', syncActiveSection);
  }, []);

  const focusIssue = (issue: EditorIssue): void => {
    const target = document.getElementById(issue.fieldId) ?? document.getElementById(issue.sectionId);
    if (target === null) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailureText(null);
    const formatId = mode === 'edit' && initial !== undefined
      ? initial.detail.summary.format_id
      : undefined;
    const draft = buildInterfaceFormatDraft(state, formatId).draft;

    try {
      const response = mode === 'edit' && initial !== undefined
        ? await api.updateInterfaceFormat(initial.detail.summary.format_id, draft)
        : await api.createInterfaceFormat(draft);
      // 内容已落库：外壳可能紧接着自动跳转（「用此格式添加模型」），不得再弹离开确认。
      dirtyRef.current = false;
      onSaved(response.detail);
    } catch (error: unknown) {
      setFailureText(describeErrorWithReason(error, '没能保存接口格式，请重试'));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = (): void => {
    if (busy) return;
    setShowErrors(true);
    const first = issues[0];
    if (first !== undefined) {
      focusIssue(first);
      return;
    }
    void submit();
  };

  const scrollTo = (sectionId: string): void => {
    const element = document.getElementById(sectionId);
    if (element === null) return;
    element.scrollIntoView({ block: 'start' });
  };

  /** 提示词落点的界面名称：请求体是字段路径，查询参数是名字。 */
  const promptKeyLabel = state.promptLocation === 'query' ? '提示词查询参数名' : '提示词位置';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            void handleCancel();
          }}
        >
          返回
        </Button>
        <h3 className="text-sm font-semibold">{mode === 'edit' ? '编辑接口格式' : '新建接口格式'}</h3>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {issues.length === 0 ? null : (
            <>
              <span className="text-2xs text-muted-foreground">{`还差 ${issues.length} 项：`}</span>
              <div className="flex flex-wrap items-center gap-1">
                {issues.map((issue) => (
                  <Button
                    key={issue.id}
                    type="button"
                    size="2xs"
                    variant="ghost"
                    onClick={() => {
                      setShowErrors(true);
                      focusIssue(issue);
                    }}
                  >
                    {issue.label}
                  </Button>
                ))}
              </div>
            </>
          )}
          <Button type="button" size="sm" disabled={busy} onClick={handleSave}>
            保存
          </Button>
        </div>
      </div>

      {failureText === null ? null : (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-2xs text-destructive">
          {failureText}
        </p>
      )}

      {notice === undefined || notice === '' ? null : (
        <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">
          {notice}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <nav aria-label="接口格式编辑分节" className="flex w-40 shrink-0 flex-col gap-1">
          {SECTION_NAV_ITEMS.map((item) => {
            const active = activeSection === item.id;
            return (
              <Button
                key={item.id}
                type="button"
                size="sm"
                variant="ghost"
                aria-current={active ? 'location' : undefined}
                className={cn('justify-start', active && SELECTION_SOFT_COMPACT_CLASSES)}
                onClick={() => {
                  setActiveSection(item.id);
                  scrollTo(item.id);
                }}
              >
                {item.label}
              </Button>
            );
          })}
        </nav>

        <div ref={scrollRef} className="min-w-0 flex-1 basis-0 overflow-y-auto rounded-md border border-border p-4">
          <div className="flex flex-col gap-6">
            <section id={SECTION_BASIC} tabIndex={-1} className="flex flex-col gap-3 scroll-mt-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <h4 className="text-xs font-semibold">基本信息</h4>
              <FormField label="名称" htmlFor="interface-format-name">
                <Input
                  id="interface-format-name"
                  {...issueAria('interface-format-name', errorsByField, showErrors)}
                  value={state.displayName}
                  onChange={(event) => update('displayName', event.target.value)}
                  placeholder="例如：我的图像接口"
                />
                <IssueSlot fieldId="interface-format-name" errors={errorsByField} showErrors={showErrors} />
              </FormField>
            </section>

            <section id={SECTION_SUBMIT} tabIndex={-1} className="flex flex-col gap-3 scroll-mt-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <h4 className="text-xs font-semibold">提交请求</h4>
              <InterfaceFormatSubmitFields
                state={state}
                errors={errorsByField}
                showErrors={showErrors}
                update={update}
              />
            </section>

            <section id={SECTION_PARAMS} tabIndex={-1} className="flex flex-col gap-3 scroll-mt-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <h4 className="text-xs font-semibold">参数</h4>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="提示词发送到" htmlFor="interface-format-prompt-location">
                  <Select
                    value={state.promptLocation}
                    onValueChange={(value) => update('promptLocation', value as PromptLocation)}
                  >
                    <SelectTrigger
                      id="interface-format-prompt-location"
                      size="sm"
                      aria-label="提示词发送到"
                      {...issueAria('interface-format-prompt-location', errorsByField, showErrors)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="body">请求体</SelectItem>
                      <SelectItem value="query">查询参数</SelectItem>
                      <SelectItem value="text">纯文本正文</SelectItem>
                    </SelectContent>
                  </Select>
                  <IssueSlot
                    fieldId="interface-format-prompt-location"
                    errors={errorsByField}
                    showErrors={showErrors}
                  />
                </FormField>
                {state.promptLocation === 'text' ? null : (
                  <FormField label={promptKeyLabel} htmlFor="interface-format-prompt-key">
                    <Input
                      id="interface-format-prompt-key"
                      aria-label={promptKeyLabel}
                      {...issueAria('interface-format-prompt-key', errorsByField, showErrors)}
                      value={state.promptKey}
                      onChange={(event) => update('promptKey', event.target.value)}
                      placeholder="例如：prompt"                    />
                    <IssueSlot
                      fieldId="interface-format-prompt-key"
                      errors={errorsByField}
                      showErrors={showErrors}
                    />
                  </FormField>
                )}
              </div>
              {state.promptLocation === 'text' ? (
                <p className="text-2xs text-muted-foreground">整个请求体就是提示词，不再单独填位置。</p>
              ) : null}

              <InterfaceFormatParameterRows
                rows={state.params}
                errors={errorsByField}
                showErrors={showErrors}
                onChange={(rows) => update('params', rows)}
              />
            </section>

            <section id={SECTION_MEDIA} tabIndex={-1} className="flex flex-col gap-3 scroll-mt-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <h4 className="text-xs font-semibold">素材位</h4>
              <InterfaceFormatMediaSlotFields
                rows={state.mediaSlots}
                payloadFormat={state.payloadFormat}
                errors={errorsByField}
                showErrors={showErrors}
                onChange={(rows, switchToMultipart) => {
                  update('mediaSlots', rows);
                  if (switchToMultipart) {
                    update('payloadFormat', 'multipart');
                    update('contentType', '');
                  }
                }}
              />
            </section>

            <section id={SECTION_TASK} tabIndex={-1} className="flex flex-col gap-3 scroll-mt-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <h4 className="text-xs font-semibold">任务</h4>
              <InterfaceFormatTaskFields
                state={state}
                errors={errorsByField}
                showErrors={showErrors}
                update={update}
              />
            </section>

            <section id={SECTION_RESULT} tabIndex={-1} className="flex flex-col gap-3 scroll-mt-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              <h4 className="text-xs font-semibold">判定与结果</h4>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="结果形态" htmlFor="interface-format-result-kind">
                  <Select value={state.resultKind} onValueChange={(value) => update('resultKind', value as EditorState['resultKind'])}>
                    <SelectTrigger
                      id="interface-format-result-kind"
                      size="sm"
                      aria-label="结果形态"
                      {...issueAria('interface-format-result-kind', errorsByField, showErrors)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="direct_url">直接返回链接</SelectItem>
                      <SelectItem value="inline_media">直接返回内容</SelectItem>
                      <SelectItem value="needs_fetch">只给标识，需再取一次</SelectItem>
                    </SelectContent>
                  </Select>
                  <IssueSlot fieldId="interface-format-result-kind" errors={errorsByField} showErrors={showErrors} />
                </FormField>
                <FormField label="媒体类型" htmlFor="interface-format-media-type">
                  <Select value={state.mediaType} onValueChange={(value) => update('mediaType', value as EditorState['mediaType'])}>
                    <SelectTrigger
                      id="interface-format-media-type"
                      size="sm"
                      {...issueAria('interface-format-media-type', errorsByField, showErrors)}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="image">图片</SelectItem>
                      <SelectItem value="video">视频</SelectItem>
                      <SelectItem value="audio">音频</SelectItem>
                    </SelectContent>
                  </Select>
                  <IssueSlot fieldId="interface-format-media-type" errors={errorsByField} showErrors={showErrors} />
                </FormField>
                {state.resultKind === 'inline_media' ? (
                  <FormField label="内容编码" htmlFor="interface-format-encoding">
                    <Select value={state.encoding} onValueChange={(value) => update('encoding', value as EditorState['encoding'])}>
                      <SelectTrigger
                        id="interface-format-encoding"
                        size="sm"
                        {...issueAria('interface-format-encoding', errorsByField, showErrors)}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="data_url">data URL</SelectItem>
                        <SelectItem value="json_inline">JSON 内嵌块</SelectItem>
                        <SelectItem value="raw_base64">裸 base64</SelectItem>
                      </SelectContent>
                    </Select>
                    <IssueSlot fieldId="interface-format-encoding" errors={errorsByField} showErrors={showErrors} />
                  </FormField>
                ) : null}
              </div>
              {state.resultKind === 'needs_fetch' ? (
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="再取一次的标识路径" htmlFor="interface-format-fetch-identity">
                    <Input
                      id="interface-format-fetch-identity"
                      aria-label="再取一次的标识路径"
                      {...issueAria('interface-format-fetch-identity', errorsByField, showErrors)}
                      value={state.fetchIdentityPath}
                      onChange={(event) => update('fetchIdentityPath', event.target.value)}
                      placeholder="例如：id"
                    />
                    <IssueSlot fieldId="interface-format-fetch-identity" errors={errorsByField} showErrors={showErrors} />
                  </FormField>
                  <FormField label="内容地址模板（含 {id}）" htmlFor="interface-format-content-url">
                    <Input
                      id="interface-format-content-url"
                      aria-label="内容地址模板"
                      {...issueAria('interface-format-content-url', errorsByField, showErrors)}
                      value={state.contentUrlTemplate}
                      onChange={(event) => update('contentUrlTemplate', event.target.value)}
                      placeholder="例如：/v1/files/{id}/content"
                    />
                    <IssueSlot fieldId="interface-format-content-url" errors={errorsByField} showErrors={showErrors} />
                  </FormField>
                </div>
              ) : (
                <FormField label="产物路径（每行一个）" htmlFor="interface-format-result-paths">
                  <Textarea
                    id="interface-format-result-paths"
                    {...issueAria('interface-format-result-paths', errorsByField, showErrors)}
                    value={state.resultPathsText}
                    onChange={(event) => update('resultPathsText', event.target.value)}
                    placeholder="例如：data.0.url"
                    rows={3}
                  />
                  <IssueSlot fieldId="interface-format-result-paths" errors={errorsByField} showErrors={showErrors} />
                </FormField>
              )}

              <label
                htmlFor="interface-format-requires-auth"
                className="flex cursor-pointer items-center gap-2 text-2xs text-muted-foreground"
              >
                产物地址需要带本连接凭证
                <Switch
                  id="interface-format-requires-auth"
                  aria-label="产物地址需要带本连接凭证"
                  checked={state.requiresAuth}
                  onCheckedChange={(checked) => update('requiresAuth', checked)}
                />
              </label>

              <div className="flex flex-col gap-2">
                <span className="text-2xs text-muted-foreground">失败判定（可选）</span>
                {state.failureRows.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <FormField
                      label="字段路径"
                      htmlFor={`interface-format-failure-${index}-path`}
                      className="min-w-48 flex-1"
                    >
                      <Input
                        id={`interface-format-failure-${index}-path`}
                        aria-label={`第 ${index + 1} 行失败条件字段路径`}
                        value={row.path}
                        onChange={(event) => {
                          const next = state.failureRows.map((item, i) => (i === index ? { ...item, path: event.target.value } : item));
                          update('failureRows', next);
                        }}
                        placeholder="例如：error.code"
                      />
                    </FormField>
                    <FormField
                      label="命中值（逗号分隔，留空=只看字段是否存在）"
                      htmlFor={`interface-format-failure-${index}-values`}
                      className="min-w-48 flex-1"
                    >
                      <Input
                        id={`interface-format-failure-${index}-values`}
                        aria-label={`第 ${index + 1} 行失败条件命中值`}
                        value={row.valuesText}
                        onChange={(event) => {
                          const next = state.failureRows.map((item, i) => (i === index ? { ...item, valuesText: event.target.value } : item));
                          update('failureRows', next);
                        }}
                      />
                    </FormField>
                    <div className="shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost-destructive"
                        aria-label={`删除第 ${index + 1} 行失败条件`}
                        onClick={() => update('failureRows', state.failureRows.filter((_, i) => i !== index))}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => update('failureRows', [...state.failureRows, emptyConditionRow()])}
                >
                  添加失败条件
                </Button>
              </div>

              <FormField label="失败原因（可选，最多 140 字）" htmlFor="interface-format-failure-reason">
                <Input
                  id="interface-format-failure-reason"
                  {...issueAria('interface-format-failure-reason', errorsByField, showErrors)}
                  value={state.failureReason}
                  onChange={(event) => update('failureReason', event.target.value)}
                  maxLength={140}
                />
                <IssueSlot fieldId="interface-format-failure-reason" errors={errorsByField} showErrors={showErrors} />
              </FormField>
            </section>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={leaveConfirmOpen}
        title="放弃这次编辑？"
        message="还有未保存的内容，离开后不会保留。"
        confirmLabel="放弃并返回"
        danger
        onResolve={resolveLeave}
      />
    </div>
  );
}

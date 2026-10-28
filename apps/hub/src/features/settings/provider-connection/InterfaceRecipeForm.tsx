import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@iart/ui';
import type {
  InterfaceRecipe,
  InterfaceRecipeCreateBody,
  InterfaceRecipeDryRunBody,
  InterfaceRecipeDryRunResponse,
  InterfaceRecipePathDiscoveryResponse,
  InterfaceRecipeUpdateBody,
  RecipeCondition,
  RecipeDirectResult,
  RecipeInlineEncoding,
  RecipeMediaType,
  RecipeResultForm,
} from '@iart/contracts';
import { InterfaceRecipeFields } from './InterfaceRecipeFields';
import type { InterfaceFormatOption } from './useInterfaceFormatOptions';
import {
  buildConditionFromRows,
  conditionToRows,
  emptyConditionRow,
  replaceConditionRowPath,
  type InterfaceRecipeDraft,
  type RecipeConditionRowDraft,
} from './interfaceRecipeConditions';
import { describeErrorWithReason } from './useProviderConnectionData';

/**
 * 接口配方的编辑表单（`docs/custom-providers/接口配方-design.md` §5/§8）。
 *
 * 表单只做三件事：判定（简单模式 → 条件树）、结果形态（三选一）、下载鉴权。
 * 数据形状归 `packages/contracts`，语义校验的权威实现在 Runtime Backend；这里只拦
 * 客户端可判定的必然失败（空名字、空路径、地址模板缺 `{id}`），错误按字段逐条落到
 * 表单里，不笼统成一句「格式不对」。
 *
 * 样本工具（路径发现 / 试跑）走注入的两个函数：表单自己不碰网络，组件测试可以只断言
 * 「点按钮时发出什么参数」。两者都不改配方数据，只帮用户确认字段路径填对了。
 */

export type InterfaceRecipeFormPayload =
  | { mode: 'create'; create: InterfaceRecipeCreateBody }
  | { mode: 'edit'; recipeId: string; update: InterfaceRecipeUpdateBody };

export interface InterfaceRecipeFormApiBinding {
  discoverPaths: (sample: unknown) => Promise<InterfaceRecipePathDiscoveryResponse>;
  dryRun: (body: InterfaceRecipeDryRunBody) => Promise<InterfaceRecipeDryRunResponse>;
}

export type PathTarget =
  | { kind: 'success'; index: number }
  | { kind: 'failure'; index: number }
  | { kind: 'media'; index: number }
  | { kind: 'identity' }
  | { kind: 'afterMedia'; index: number };

type BuiltResult = { ok: true; result: RecipeResultForm } | { ok: false; issue: string };

const replacePathAt = (paths: string[], index: number, value: string): string[] =>
  paths.map((path, i) => (i === index ? value : path));

const withoutAt = (paths: string[], index: number): string[] =>
  paths.length === 1 ? [''] : paths.filter((_, i) => i !== index);

/** 读样本：界面里先判一次 JSON 是否完整，避免把半截内容发给后端。 */
const readSampleText = (text: string): { ok: true; sample: unknown } | { ok: false; message: string } => {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, message: '先贴一段响应样本。' };
  try {
    const sample: unknown = JSON.parse(trimmed);
    return { ok: true, sample };
  } catch {
    return { ok: false, message: '这段样本不是完整的 JSON，检查一下括号和引号。' };
  }
};

export function useInterfaceRecipeForm({
  initial,
  api,
  familyOptions = [],
  onSubmit,
  onClose,
}: {
  initial: InterfaceRecipe | null;
  api: InterfaceRecipeFormApiBinding;
  /**
   * 可绑定的接口格式（来自接口格式列表 API，含用户自建格式）。
   *
   * 2026-10-27 起不再从内置适配器清单派生：生成侧适配器已退场，格式名称与可选项都只认
   * 接口格式实体；列表读不到时为空数组（此时建不出配方，避免绑到一个界面上不存在的格式）。
   */
  familyOptions?: readonly InterfaceFormatOption[];
  /** 返回 false 表示没有保存成功（保留输入内容，不静默清空） */
  onSubmit: (payload: InterfaceRecipeFormPayload) => Promise<boolean>;
  onClose: () => void;
}) {
  const editing = initial !== null;
  // 新建时两组各给一个空行（不是零行），用户打开就能直接填；编辑时尝试把树还原成行。
  const initialSuccessRows: RecipeConditionRowDraft[] | null =
    initial === null ? [emptyConditionRow()] : conditionToRows(initial.success_when);
  const initialFailureRows: RecipeConditionRowDraft[] | null =
    initial === null || initial.failure_when === undefined
      ? [emptyConditionRow()]
      : conditionToRows(initial.failure_when);
  const initialResult = initial?.result ?? null;
  const initialNeedsFetch = initialResult?.kind === 'needs_fetch' ? initialResult : null;
  const initialAfter = initialNeedsFetch?.after;

  const [name, setName] = useState(initial?.name ?? '');
  const [familyAdapterId, setFamilyAdapterId] = useState<string | null>(initial?.family_adapter_id ?? null);
  const [recipeResetNotice, setRecipeResetNotice] = useState<string | null>(null);

  const [successRows, setSuccessRows] = useState<RecipeConditionRowDraft[]>(
    initialSuccessRows ?? [emptyConditionRow()],
  );
  const [successUnsupported, setSuccessUnsupported] = useState<RecipeCondition | null>(
    initial !== null && initialSuccessRows === null ? initial.success_when : null,
  );

  const [failureEnabled, setFailureEnabled] = useState(initial?.failure_when !== undefined);
  const [failureRows, setFailureRows] = useState<RecipeConditionRowDraft[]>(
    initialFailureRows ?? [emptyConditionRow()],
  );
  const [failureUnsupported, setFailureUnsupported] = useState<RecipeCondition | null>(
    initial !== null && initial.failure_when !== undefined && initialFailureRows === null
      ? initial.failure_when
      : null,
  );
  // 失败原因与判定树是两份数据：简单模式与原始树两种视图都能设置、互不覆盖。
  const [failureReason, setFailureReason] = useState(initial?.failure_reason ?? '');

  const [resultKind, setResultKind] = useState<RecipeResultForm['kind']>(initialResult?.kind ?? 'direct_url');
  const [mediaPaths, setMediaPaths] = useState<string[]>(
    initialResult !== null && initialResult.kind !== 'needs_fetch'
      ? [...initialResult.media_field_paths]
      : [''],
  );
  const [afterPaths, setAfterPaths] = useState<string[]>(
    initialAfter === undefined ? [''] : [...initialAfter.media_field_paths],
  );
  const [mediaType, setMediaType] = useState<RecipeMediaType>(
    initialResult !== null && initialResult.kind !== 'needs_fetch'
      ? initialResult.media_type
      : initialNeedsFetch?.media_type ?? 'image',
  );
  const [encoding, setEncoding] = useState<RecipeInlineEncoding>(
    initialResult?.kind === 'inline_media' ? initialResult.encoding : 'data_url',
  );
  const [mimeType, setMimeType] = useState(
    initialResult?.kind === 'inline_media' ? initialResult.mime_type ?? '' : '',
  );
  const [afterKind, setAfterKind] = useState<'direct_url' | 'inline_media'>(
    initialAfter?.kind ?? 'direct_url',
  );
  const [afterEncoding, setAfterEncoding] = useState<RecipeInlineEncoding>(
    initialAfter?.kind === 'inline_media' ? initialAfter.encoding : 'data_url',
  );
  const [afterMimeType, setAfterMimeType] = useState(
    initialAfter?.kind === 'inline_media' ? initialAfter.mime_type ?? '' : '',
  );

  const [identityPath, setIdentityPath] = useState(initialNeedsFetch?.identity_field_path ?? '');
  const [contentUrlTemplate, setContentUrlTemplate] = useState(
    initialNeedsFetch?.content_url_template ?? '',
  );
  const [accept, setAccept] = useState<'binary' | 'json'>(initialNeedsFetch?.accept ?? 'binary');
  const [requiresAuth, setRequiresAuth] = useState(initial?.requires_auth ?? false);

  const [sampleText, setSampleText] = useState('');
  const [discovery, setDiscovery] = useState<InterfaceRecipePathDiscoveryResponse | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [dryRun, setDryRun] = useState<InterfaceRecipeDryRunResponse | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [focusedPathTarget, setFocusedPathTarget] = useState<PathTarget | null>(null);
  const [pathNotice, setPathNotice] = useState<string | null>(null);

  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const trimmedName = name.trim();
  const trimmedFailureReason = failureReason.trim();

  /** 条件树：优先用原始树（简单模式表达不了时），否则按当前行编译。 */
  const buildSuccess = (): RecipeCondition | null =>
    successUnsupported ?? buildConditionFromRows(successRows);

  const buildFailure = (): RecipeCondition | null =>
    failureUnsupported ?? buildConditionFromRows(failureRows);

  const buildDirectResult = (
    kind: 'direct_url' | 'inline_media',
    paths: string[],
    type: RecipeMediaType,
    inlineEncoding: RecipeInlineEncoding,
    inlineMimeType: string,
  ): RecipeDirectResult | null => {
    const cleaned = paths.map((path) => path.trim()).filter((path) => path !== '');
    if (cleaned.length === 0) return null;
    if (kind === 'direct_url') {
      return { kind: 'direct_url', media_field_paths: cleaned, media_type: type };
    }
    const mime = inlineMimeType.trim();
    return {
      kind: 'inline_media',
      media_field_paths: cleaned,
      media_type: type,
      encoding: inlineEncoding,
      ...(inlineEncoding === 'raw_base64' && mime !== '' ? { mime_type: mime } : {}),
    };
  };

  const buildResult = (): BuiltResult => {
    if (resultKind === 'direct_url' || resultKind === 'inline_media') {
      const result = buildDirectResult(resultKind, mediaPaths, mediaType, encoding, mimeType);
      return result === null
        ? { ok: false, issue: '产物在哪还空着，填一个字段路径。' }
        : { ok: true, result };
    }
    const identity = identityPath.trim();
    if (identity === '') return { ok: false, issue: '任务标识还空着，填一个字段路径。' };
    const template = contentUrlTemplate.trim();
    if (template === '') return { ok: false, issue: '结果地址模板还空着，填一个带 {id} 的地址。' };
    if (!template.includes('{id}')) {
      return { ok: false, issue: '结果地址模板里要有 {id}，比如 /v1/videos/{id}/content。' };
    }
    if (accept === 'binary') {
      return {
        ok: true,
        result: {
          kind: 'needs_fetch',
          identity_field_path: identity,
          content_url_template: template,
          accept: 'binary',
          media_type: mediaType,
        },
      };
    }
    const after = buildDirectResult(afterKind, afterPaths, mediaType, afterEncoding, afterMimeType);
    if (after === null) {
      return { ok: false, issue: '取回的响应里，产物所在字段还空着。' };
    }
    return {
      ok: true,
      result: {
        kind: 'needs_fetch',
        identity_field_path: identity,
        content_url_template: template,
        accept: 'json',
        media_type: mediaType,
        after,
      },
    };
  };

  const hasSuccess = successUnsupported !== null || successRows.some((row) => row.path.trim() !== '');
  const hasFailure = failureUnsupported !== null || failureRows.some((row) => row.path.trim() !== '');
  const canSubmit = trimmedName !== '' && familyAdapterId !== null && hasSuccess && !busy;

  /** 客户端可判定的必然失败：逐条给可整行替换的说明。 */
  const issues: string[] = [];
  if (trimmedName === '') issues.push('给这份配方起一个名字。');
  if (familyAdapterId === null) issues.push('先选一个接口格式。');
  if (!hasSuccess) issues.push('成功判定还空着，填一个字段路径。');
  if (failureEnabled && !hasFailure) issues.push('失败判定还空着：填一个字段路径，或关掉「同时判断失败」。');
  const resultCheck = buildResult();
  if (!resultCheck.ok) issues.push(resultCheck.issue);

  const applyPath = (path: string): void => {
    const target = focusedPathTarget;
    if (target === null) {
      setPathNotice('先点一下要填的路径框，再点这里的路径。');
      return;
    }
    setPathNotice(null);
    if (target.kind === 'success') setSuccessRows((rows) => replaceConditionRowPath(rows, target.index, path));
    else if (target.kind === 'failure') setFailureRows((rows) => replaceConditionRowPath(rows, target.index, path));
    else if (target.kind === 'identity') setIdentityPath(path);
    else if (target.kind === 'media') {
      setMediaPaths((paths) => replacePathAt(paths, target.index, path));
    } else {
      setAfterPaths((paths) => replacePathAt(paths, target.index, path));
    }
  };

  /** 换样本即作废上一次的发现 / 试跑结果：它们只对当时那段样本成立。 */
  const updateSampleText = (value: string): void => {
    setSampleText(value);
    setDiscovery(null);
    setDiscoveryError(null);
    setPathNotice(null);
    setDryRun(null);
    setDryRunError(null);
  };

  const runDiscovery = (): void => {
    if (discoveryBusy) return;
    const sample = readSampleText(sampleText);
    if (!sample.ok) {
      setDiscovery(null);
      setDiscoveryError(sample.message);
      return;
    }
    setDiscoveryBusy(true);
    setDiscoveryError(null);
    void api
      .discoverPaths(sample.sample)
      .then((response) => {
        setDiscovery(response);
        setPathNotice(null);
      })
      .catch((error: unknown) => {
        setDiscovery(null);
        setDiscoveryError(
          describeErrorWithReason(error, '没能从这段样本里找出字段路径，请检查样本后重试'),
        );
      })
      .finally(() => setDiscoveryBusy(false));
  };

  const buildDraft = (): InterfaceRecipeDraft | null => {
    const success = buildSuccess();
    if (success === null || familyAdapterId === null) return null;
    const builtResult = buildResult();
    if (!builtResult.ok) return null;
    const failure = failureEnabled ? buildFailure() : null;
    if (failureEnabled && failure === null) return null;
    return {
      // 不要把已保存配方的 recipe_id 带进草稿：草稿必须完整表达**眼前这份表单**。
      // 带上会让后端在「用户刚关掉失败判定」时回退到已保存的 failure_when（草稿无法表达清除）。
      ...(trimmedName === '' ? {} : { name: trimmedName }),
      family_adapter_id: familyAdapterId,
      success_when: success,
      ...(failure === null ? {} : { failure_when: failure }),
      ...(failure === null || trimmedFailureReason === ''
        ? {}
        : { failure_reason: trimmedFailureReason }),
      result: builtResult.result,
      requires_auth: requiresAuth,
    };
  };

  const runDryRun = (): void => {
    if (dryRunBusy) return;
    const sample = readSampleText(sampleText);
    if (!sample.ok) {
      setDryRun(null);
      setDryRunError(sample.message);
      return;
    }
    const draft = buildDraft();
    if (draft === null) {
      setDryRun(null);
      setDryRunError('试跑还差接口格式、成功判定或结果形态，先填好再试。');
      return;
    }
    setDryRunBusy(true);
    setDryRunError(null);
    void api
      .dryRun({ sample: sample.sample, draft })
      .then((response) => setDryRun(response))
      .catch((error: unknown) => {
        setDryRun(null);
        setDryRunError(describeErrorWithReason(error, '没能试跑这份配方，请检查填写后重试'));
      })
      .finally(() => setDryRunBusy(false));
  };

  const changeFamilyAdapter = (next: string): void => {
    if (editing) return;
    const displayName = familyOptions.find((option) => option.value === next)?.label ?? next;
    setFamilyAdapterId(next);
    setRecipeResetNotice(`已换成「${displayName}」，保存后这份配方只能用于这个接口格式的模型。`);
  };

  const submit = (): void => {
    if (busy || !canSubmit) {
      setAttempted(true);
      return;
    }
    setAttempted(true);
    const success = buildSuccess();
    const builtResult = buildResult();
    const failure = failureEnabled ? buildFailure() : null;
    if (
      success === null
      || familyAdapterId === null
      || !builtResult.ok
      || (failureEnabled && failure === null)
    ) {
      return;
    }
    const payload: InterfaceRecipeFormPayload = initial === null
      ? {
          mode: 'create',
          create: {
            name: trimmedName,
            family_adapter_id: familyAdapterId,
            success_when: success,
            ...(failure === null ? {} : { failure_when: failure }),
            ...(failure === null || trimmedFailureReason === ''
              ? {}
              : { failure_reason: trimmedFailureReason }),
            result: builtResult.result,
            requires_auth: requiresAuth,
          },
        }
      : {
          mode: 'edit',
          recipeId: initial.recipe_id,
          update: {
            name: trimmedName,
            success_when: success,
            failure_when: failure,
            // 编辑是整体替换：清空或关掉失败判定都提交 null，否则旧原因会留在配方里。
            failure_reason:
              failure === null || trimmedFailureReason === '' ? null : trimmedFailureReason,
            result: builtResult.result,
            requires_auth: requiresAuth,
          },
        };
    setBusy(true);
    void onSubmit(payload)
      .then((saved) => {
        if (saved) onClose();
      })
      .finally(() => setBusy(false));
  };

  return {
    editing,
    name,
    onNameChange: setName,
    familyAdapterId,
    familyOptions,
    onFamilyAdapterIdChange: changeFamilyAdapter,
    recipeResetNotice,
    successRows,
    onSuccessRowsChange: setSuccessRows,
    successUnsupported,
    useSimpleSuccess: () => {
      setSuccessUnsupported(null);
      setSuccessRows([emptyConditionRow()]);
    },
    failureEnabled,
    onFailureEnabledChange: setFailureEnabled,
    failureRows,
    onFailureRowsChange: setFailureRows,
    failureUnsupported,
    useSimpleFailure: () => {
      setFailureUnsupported(null);
      setFailureRows([emptyConditionRow()]);
    },
    failureReason,
    onFailureReasonChange: setFailureReason,
    resultKind,
    onResultKindChange: setResultKind,
    mediaPaths,
    onMediaPathChange: (index: number, value: string) =>
      setMediaPaths((paths) => replacePathAt(paths, index, value)),
    onAddMediaPath: () => setMediaPaths((paths) => [...paths, '']),
    onRemoveMediaPath: (index: number) => setMediaPaths((paths) => withoutAt(paths, index)),
    afterPaths,
    onAfterPathChange: (index: number, value: string) =>
      setAfterPaths((paths) => replacePathAt(paths, index, value)),
    onAddAfterPath: () => setAfterPaths((paths) => [...paths, '']),
    onRemoveAfterPath: (index: number) => setAfterPaths((paths) => withoutAt(paths, index)),
    mediaType,
    onMediaTypeChange: setMediaType,
    encoding,
    onEncodingChange: setEncoding,
    mimeType,
    onMimeTypeChange: setMimeType,
    afterKind,
    onAfterKindChange: setAfterKind,
    afterEncoding,
    onAfterEncodingChange: setAfterEncoding,
    afterMimeType,
    onAfterMimeTypeChange: setAfterMimeType,
    identityPath,
    onIdentityPathChange: setIdentityPath,
    contentUrlTemplate,
    onContentUrlTemplateChange: setContentUrlTemplate,
    accept,
    onAcceptChange: setAccept,
    requiresAuth,
    onRequiresAuthChange: setRequiresAuth,
    sampleText,
    onSampleTextChange: updateSampleText,
    discovery,
    discoveryError,
    discoveryBusy,
    runDiscovery,
    dryRun,
    dryRunError,
    dryRunBusy,
    runDryRun,
    focusedPathTarget,
    onFocusPath: setFocusedPathTarget,
    pathNotice,
    applyPath,
    attempted,
    issues,
    busy,
    canSubmit,
    submit,
  };
}

export type InterfaceRecipeFormState = ReturnType<typeof useInterfaceRecipeForm>;

/** 配方编辑弹层：标题 + 字段树 + 底部按钮。 */
export function InterfaceRecipeDialog({
  initial,
  api,
  familyOptions = [],
  failureText = null,
  onSubmit,
  onClose,
}: {
  initial: InterfaceRecipe | null;
  api: InterfaceRecipeFormApiBinding;
  /** 可绑定的接口格式（来自接口格式列表 API） */
  familyOptions?: readonly InterfaceFormatOption[];
  failureText?: string | null;
  onSubmit: (payload: InterfaceRecipeFormPayload) => Promise<boolean>;
  onClose: () => void;
}) {
  const form = useInterfaceRecipeForm({ initial, api, familyOptions, onSubmit, onClose });
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent form="standard" size="wide">
        <DialogHeader>
          <DialogTitle>{initial === null ? '新建接口配方' : `修改「${initial.name}」`}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <InterfaceRecipeFields form={form} />
          {failureText === null ? null : (
            <p role="alert" className="text-2xs text-destructive">{failureText}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="button" disabled={form.busy || !form.canSubmit} onClick={form.submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

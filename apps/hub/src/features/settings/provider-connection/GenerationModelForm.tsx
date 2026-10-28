import { useState } from 'react';
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@iart/ui';
import type {
  FamilyTemplateParameterDescriptor,
  GenerationMediaSlotId,
  InterfaceRecipe,
  ParameterOverrides,
} from '@iart/contracts';
import {
  CustomGenerationModelIdSchema,
  GENERATION_FAMILY_ADAPTER_IDS,
} from '@iart/contracts';
import { interfaceFormatLabel, type InterfaceFormatOption } from './useInterfaceFormatOptions';
import { FieldLabelRow } from './InfoHint';
import {
  GenerationOverridesSection,
  useGenerationOverridesSection,
} from './GenerationOverridesSection';
import {
  effectiveMediaSlots,
  GenerationMediaSlotChecklist,
  useGenerationMediaSlots,
} from './GenerationMediaSlotFields';
import { emptyParameterOverrides, pruneOfficialOverridesForLiveMediaSlots } from './ParameterOverridesEditor';

/**
 * 接口格式的展示名：从接口格式选项表里查，查不到原样显示 id。
 *
 * 2026-10-27 生成侧内置适配器退场后，Hub 不再有第二份展示名清单；选项表由
 * `/api/interface-formats` 提供（`useInterfaceFormatOptions`）。
 */
export const familyDisplayName = (
  familyAdapterId: string,
  options: readonly InterfaceFormatOption[] = [],
): string => interfaceFormatLabel(familyAdapterId, options);

/**
 * 自建生成模型的表单体（docs/custom-providers/生成模型自建声明试点-design.md §3.7；
 * 高级参数自定义见 生成模型参数高级自定义-design.md §3.4）。
 *
 * 原是独立弹层（GenerationModelDialog）；2026-09-26 界面收敛后生成族连接的「添加模型」
 * 只开合并弹窗（AddModelDialog），本模块降为它的「自定义接口的模型」区块：
 * `useGenerationModelForm` 持有全部表单状态与提交逻辑（状态在弹窗壳层，底部按钮才能
 * 落在 DialogContent 的 footer 槽位上），`GenerationModelFields` 只渲染一棵字段树。
 *
 * 与对话侧 `CustomModelDialog` 同构，但只有「添加」一个入口：生成族行没有「修改」配置弹层
 * （思考档位、能力值都不属于生成模型），声明的修改与删除由后续生命周期另做。提交只交回
 * 表单草稿，「声明 + 接入 + 设为当前使用」三步由调用方串起来，用户不必知道这是多个动作。
 *
 * 接口格式是表单字段（2026-09-26 起协议归属模型级）：记录自带 `family_adapter_id` 声明，
 * 不再从连接继承——本批值域来自内置接口格式的预设清单快照（`GENERATION_FAMILY_ADAPTER_IDS`，
 * 下一批改走接口格式列表 API），选项展示名取自契约注册表。
 * 空态起步、必选（2026-09-29 起连接级预选摘除），选了才能提交。
 *
 * 没有思考档位区块：生成族连接不承载档位（spec 37「声明位置」的生成侧空集）。
 * 没有常驻解释文字：两个 ID 字段靠占位符自解释，素材位勾选框只写业务名，不印说明。
 * 「高级参数自定义」默认收起：展开才会按所选接口格式拉取参数描述；尚未选择接口格式时展开
 * 不发请求（收起再展开会按新选择再试）；不带覆盖的提交与不展开完全一致
 * （请求体不带 parameter_overrides，行为与现状零差异）。
 */

/** 与 backend 校验失败文案同一句（contracts 的 model_id 正则在两端共用，不另写一份）。 */
const MODEL_ID_FORMAT_HINT = '模型 ID 只能用字母、数字、.、_、-，且以字母或数字开头';
/**
 * 提交被即时提示拦下时的弹层级说明（行内红字在折叠区里）。收起时指认去哪展开；
 * 已经展开的不再复述「展开」这个动作，直接指红字。
 */
const advancedBlockedHint = (advancedOpen: boolean): string =>
  advancedOpen
    ? '高级参数还有没改好的地方，按红字提示改。'
    : '高级参数还有没改好的地方，展开「高级参数自定义」按红字提示改。';

/**
 * 「接口格式」的兜底选项：列表读不到时仍能选出预设格式（标签用 id，不复制展示名）。
 *
 * 正常路径一律用 `formatOptions`（接口格式列表，含用户自建格式）。
 */
const PRESET_FORMAT_FALLBACK_OPTIONS: ReadonlyArray<InterfaceFormatOption> =
  GENERATION_FAMILY_ADAPTER_IDS.map((formatId) => ({ value: formatId, label: formatId }));

/** Select 不接受空字符串值：用哨兵值表示「不选配方，用内置默认」。 */
export const USE_BUILTIN_RECIPE = '__builtin_recipe__';

/** 「新建接口格式…」的哨兵值：它是动作，不写入记录。 */
export const CREATE_INTERFACE_FORMAT_SENTINEL = '__create_interface_format__';

export type GenerationModelFormPayload = {
  /**
   * 该记录的接口格式声明（2026-09-26 起协议归属模型级，不再从连接继承）。
   *
   * 类型是 `string`：2026-10-26 起契约只约束 id 形状，值域由 backend 的接口格式实体注册表
   * 裁定（本批下拉仍来自预设清单快照，因此界面里只会选到内置格式）。
   */
  familyAdapterId: string;
  modelId: string;
  /**
   * 服务商那边的模型 ID；null = 留空，按模型 ID 请求——与对话侧先例
   * （`remote_model_id: modelId`）同一个语义，由调用方落成具体值。
   */
  remoteModelId: string | null;
  /**
   * 该模型接受的素材位清单（输入模态是模型属性，进记录）。
   *
   * 由所选接口格式的族能力逐项勾选得来（`supports_media_slots`），换接口格式即清空重选。
   * 0 位族（可灵文生视频）提交空清单。
   */
  acceptedMediaSlots: GenerationMediaSlotId[];
  /**
   * 参数覆盖（生成模型参数高级自定义-design §3.4）；null = 没有自定义任何参数，
   * 请求体不带 parameter_overrides，与不带本字段的既有行为完全一致。
   */
  parameterOverrides: ParameterOverrides | null;
  /** 引用的接口配方；null = 使用该接口格式的内置默认判定（请求体不带 recipe_id）。 */
  recipeId: string | null;
};

/**
 * 表单状态与提交逻辑（合并弹窗壳层调用；状态在这里，footer 按钮才拿得到 busy 与可提交性）。
 *
 * 「接口格式」空态起步、必选（2026-09-29 起连接级预选摘除）。`loadParameterTemplate`
 * 按表单当前所选接口格式拉取参数描述（展开「高级参数自定义」时调用；由调用方注入，
 * 表单自己不碰网络）。`onSubmit` 返回 false 表示没添加成功（保留输入内容，不静默清空）；
 * 成功后调用 `onClose` 收掉弹窗。
 */
export function useGenerationModelForm({
  loadParameterTemplate,
  recipes,
  recipesUnavailable = false,
  formatOptions,
  initialFamilyAdapterId = null,
  onCreateInterfaceFormat,
  onSubmit,
  onClose,
}: {
  loadParameterTemplate: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  /** 全局配方库；按当前所选接口格式过滤后作为可选项（不选 = 内置默认）。 */
  recipes: readonly InterfaceRecipe[];
  /** 配方列表读取失败：不把失败呈现成「这个接口格式没有配方」，也不清掉已选引用。 */
  recipesUnavailable?: boolean;
  /** 接口格式选项；缺省回落到随软件分发的预设清单快照。 */
  formatOptions?: ReadonlyArray<{ value: string; label: string }>;
  /** 从「接口格式」页带过来的预选格式。 */
  initialFamilyAdapterId?: string | null;
  /** 下拉末尾「新建接口格式…」的动作；缺省不渲染该选项。 */
  onCreateInterfaceFormat?: () => void;
  onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
  onClose: () => void;
}) {
  const [familyAdapterId, setFamilyAdapterId] = useState<string | null>(initialFamilyAdapterId);
  const [modelId, setModelId] = useState('');
  const [remoteModelId, setRemoteModelId] = useState('');
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [recipeResetNotice, setRecipeResetNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 模型 ID 非空但格式非法（失焦或提交时按 contracts 的 model_id schema 判定）。空串不算——它由按钮禁用拦截。 */
  const [idFormatInvalid, setIdFormatInvalid] = useState(false);
  // 素材位按所选接口格式的族能力逐项勾选：换接口格式时清空并给可见反馈（不静默清空）
  const mediaSlots = useGenerationMediaSlots({
    familyAdapterId,
    familyDisplayName:
      familyAdapterId === null ? null : familyDisplayName(familyAdapterId, formatOptions ?? []),
    loadDescriptor: loadParameterTemplate,
  });
  /** 当前勾选的素材位：素材位行只在勾选后出现，提交时也据此裁掉未勾选位的覆盖 */
  const liveMediaSlots = effectiveMediaSlots(mediaSlots);
  const overrides = useGenerationOverridesSection(
    // 展开那一刻读当前所选接口格式：每次渲染重建闭包，读到的是最新选择。
    // 尚未选择接口格式时不发请求（留痕后折叠区按 pending 指引呈现；收起再展开会按新选择再试）
    () =>
      familyAdapterId === null
        ? Promise.reject(new Error('尚未选择接口格式，不拉取族模板参数描述'))
        : loadParameterTemplate(familyAdapterId),
    emptyParameterOverrides(),
    liveMediaSlots,
  );
  /** 提交被参数提示拦过一次：提示要留在弹层里，改好一处就撤掉 */
  const [advancedBlocked, setAdvancedBlocked] = useState(false);

  /** 能选的配方：同一接口格式下才有意义（后端也会拒绝族不匹配的引用）。 */
  const availableRecipes =
    familyAdapterId === null
      ? []
      : recipes.filter((recipe) => recipe.family_adapter_id === familyAdapterId);

  /**
   * 换接口格式：旧配方绑定的是旧类型，必然不适用。清掉并给可见反馈，不静默保留一个保存必失败的引用。
   */
  const changeFamilyAdapterId = (next: string): void => {
    setFamilyAdapterId(next);
    if (recipeId === null) {
      setRecipeResetNotice(null);
      return;
    }
    const stillApplicable = recipes.some(
      (recipe) => recipe.recipe_id === recipeId && recipe.family_adapter_id === next,
    );
    if (!stillApplicable) {
      setRecipeId(null);
      setRecipeResetNotice('接口格式变了，之前选的配方不再适用，已改用内置默认。');
      return;
    }
    setRecipeResetNotice(null);
  };

  const trimmedId = modelId.trim();
  // 接口格式在创建表单必选（与后端契约对齐：生成记录 `family_adapter_id` 必填，创建后不可变）；
  // 素材位必须已确定（读到了该族能力），否则会落一条素材位未知的记录
  const canSubmit = trimmedId !== '' && familyAdapterId !== null && mediaSlots.blocked === false;
  /**
   * 提交用的覆盖：丢掉「该素材位已取消勾选」留下的条目。
   *
   * 弹层状态里仍保留用户填过的值（同一次弹层内勾回来还能看到），但不进请求体——后端按
   * 本次勾选的模板校验覆盖，带上它必然被整次拒绝。
   */
  const submittedOverrides = pruneOfficialOverridesForLiveMediaSlots(
    overrides.value,
    liveMediaSlots,
    mediaSlots.load.kind === 'ready' ? mediaSlots.load.fieldKeyBySlotId : {},
  );
  const hasOverrides = submittedOverrides.official.length > 0 || submittedOverrides.custom.length > 0;

  /** 空串交回按钮禁用拦截；非空时按契约 schema 判格式，非法则显示拦截文案。返回是否放行提交。 */
  const checkIdFormat = (): boolean => {
    if (trimmedId === '') return true;
    const ok = CustomGenerationModelIdSchema.safeParse(trimmedId).success;
    setIdFormatInvalid(!ok);
    return ok;
  };

  const onModelIdChange = (value: string): void => {
    setModelId(value);
    if (idFormatInvalid) setIdFormatInvalid(false);
  };

  const submit = (): void => {
    if (busy || trimmedId === '' || familyAdapterId === null) return;
    // 素材位还没读到（loading/failed）：此时提交等于猜一份清单，拦在提交前
    if (mediaSlots.blocked) return;
    if (!checkIdFormat()) return;
    // 客户端可判定的必然失败提交前拦下（ui-copy-standard 落地口径第 6 条）；
    // 拦不住的剩余理由由后端拒绝并原样透进弹层
    if (overrides.issues.length > 0) {
      setAdvancedBlocked(true);
      return;
    }
    setAdvancedBlocked(false);
    setBusy(true);
    void onSubmit({
      familyAdapterId,
      modelId: trimmedId,
      remoteModelId: remoteModelId.trim() === '' ? null : remoteModelId.trim(),
      acceptedMediaSlots: liveMediaSlots,
      parameterOverrides: hasOverrides ? submittedOverrides : null,
      recipeId,
    })
      .then((added) => {
        if (added) onClose();
      })
      .finally(() => setBusy(false));
  };

  return {
    familyAdapterId,
    onFamilyAdapterIdChange: changeFamilyAdapterId,
    familyAdapterOptions: formatOptions ?? PRESET_FORMAT_FALLBACK_OPTIONS,
    onCreateInterfaceFormat,
    availableRecipes,
    recipesUnavailable,
    recipeId,
    onRecipeIdChange: setRecipeId,
    recipeResetNotice,
    modelId,
    /** 输入即撤掉格式拦截提示：改一个字符说明用户在改它 */
    onModelIdChange,
    onModelIdBlur: checkIdFormat,
    remoteModelId,
    onRemoteModelIdChange: setRemoteModelId,
    mediaSlots,
    /** 当前勾选的素材位（已与族能力求交）：高级参数区与提交共用同一份 */
    liveMediaSlots,
    overrides,
    advancedBlocked,
    busy,
    canSubmit,
    submit,
    idFormatInvalid,
  };
}

export type GenerationModelFormState = ReturnType<typeof useGenerationModelForm>;

/** 表单字段树（纯展示）：状态全部来自 `useGenerationModelForm`，提交按钮由弹窗壳层的 footer 承载。 */
export function GenerationModelFields({ form }: { form: GenerationModelFormState }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <FieldLabelRow htmlFor="generation-family-adapter" label="接口格式" />
        <Select
          {...(form.familyAdapterId === null ? {} : { value: form.familyAdapterId })}
          onValueChange={(next) => {
            // 「新建接口格式…」是动作而不是值：不写入表单，交给调用方切页。
            if (next === CREATE_INTERFACE_FORMAT_SENTINEL) {
              form.onCreateInterfaceFormat?.();
              return;
            }
            // 选项值域即注册表清单：按选项收窄，选不中（不可能发生）就保持原值
            const matched = form.familyAdapterOptions.find((option) => option.value === next);
            if (matched !== undefined) form.onFamilyAdapterIdChange(matched.value);
          }}
        >
          <SelectTrigger id="generation-family-adapter" size="sm" className="w-full">
            <SelectValue placeholder="请选择接口格式" />
          </SelectTrigger>
          <SelectContent>
            {form.familyAdapterOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
            {form.onCreateInterfaceFormat === undefined ? null : (
              <SelectItem value={CREATE_INTERFACE_FORMAT_SENTINEL}>＋ 新建接口格式…</SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabelRow htmlFor="generation-model-id" label="模型 ID" />
        <Input
          id="generation-model-id"
          value={form.modelId}
          placeholder="服务商文档里的模型 ID，如 gpt-image-1"
          autoComplete="off"
          onChange={(event) => form.onModelIdChange(event.target.value)}
          onBlur={form.onModelIdBlur}
          onKeyDown={(event) => {
            if (event.key === 'Enter') form.submit();
          }}
        />
        {form.idFormatInvalid ? (
          <p role="alert" className="text-2xs text-destructive">{MODEL_ID_FORMAT_HINT}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {/* 两个字段同屏，标签必须能分清各指哪个：模型 ID 是全局身份，另一个只在这边生效 */}
        <FieldLabelRow htmlFor="generation-remote-model-id" label="服务商那边的模型 ID" />
        <Input
          id="generation-remote-model-id"
          value={form.remoteModelId}
          placeholder="两边不一样时才填；留空就跟上面的模型 ID 相同"
          autoComplete="off"
          onChange={(event) => form.onRemoteModelIdChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') form.submit();
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <FieldLabelRow
          htmlFor="generation-recipe"
          label="接口配方"
          hint={{
            text: '配方决定任务什么时候算完成、产物从哪里取。不选就用这个接口格式的默认判定。',
            subject: '接口配方',
          }}
        />
        {form.familyAdapterId === null ? (
          <p className="text-2xs text-muted-foreground">先选接口格式，再看这个类型有哪些配方。</p>
        ) : (
          <Select
            value={form.recipeId ?? USE_BUILTIN_RECIPE}
            onValueChange={(next) => {
              form.onRecipeIdChange(next === USE_BUILTIN_RECIPE ? null : next);
            }}
          >
            <SelectTrigger id="generation-recipe" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={USE_BUILTIN_RECIPE}>使用内置默认</SelectItem>
              {form.availableRecipes.map((recipe) => (
                <SelectItem key={recipe.recipe_id} value={recipe.recipe_id}>
                  {recipe.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {form.recipesUnavailable ? (
          <p className="text-2xs text-muted-foreground">暂时读不到配方列表，会使用内置默认。</p>
        ) : form.familyAdapterId !== null && form.availableRecipes.length === 0 ? (
          <p className="text-2xs text-muted-foreground">这个接口格式还没有配方，会使用内置默认。</p>
        ) : null}
        {form.recipeResetNotice === null ? null : (
          <p className="text-2xs text-muted-foreground">{form.recipeResetNotice}</p>
        )}
      </div>

      {/* 素材位按所选接口格式的族能力逐项渲染；0 位族（可灵文生视频）整块不出现 */}
      <GenerationMediaSlotChecklist state={form.mediaSlots} />

      <GenerationOverridesSection
        state={form.overrides}
        liveMediaSlotIds={form.liveMediaSlots}
        pending={form.familyAdapterId === null}
      />

      {form.advancedBlocked && form.overrides.issues.length > 0 ? (
        <p role="alert" className="text-2xs text-destructive">{advancedBlockedHint(form.overrides.open)}</p>
      ) : null}
    </>
  );
}

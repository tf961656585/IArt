import { useState } from 'react';
import { Checkbox, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@iart/ui';
import type {
  FamilyTemplateParameterDescriptor,
  ParameterOverrides,
} from '@iart/contracts';
import {
  ADAPTER_REGISTRY,
  CustomGenerationModelIdSchema,
  GENERATION_FAMILY_ADAPTER_IDS,
} from '@iart/contracts';
import { FieldLabelRow } from './InfoHint';
import {
  GenerationOverridesSection,
  useGenerationOverridesSection,
} from './GenerationOverridesSection';
import { emptyParameterOverrides } from './ParameterOverridesEditor';

/**
 * 生成族适配器 id 的值域（contracts 未单独导出该类型别名，从契约枚举常量推导；
 * 契约扩族时这里自动跟随）。
 */
export type GenerationFamilyAdapterId = (typeof GENERATION_FAMILY_ADAPTER_IDS)[number];

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
 * 接口类型是表单字段（2026-09-26 起协议归属模型级）：记录自带 `family_adapter_id` 声明，
 * 不再从连接继承——值域随 `GENERATION_FAMILY_ADAPTER_IDS` 放宽，选项展示名取自契约注册表，
 * 契约扩族时这里自动跟随。空态起步、必选（2026-09-29 起连接级预选摘除），选了才能提交。
 *
 * 没有思考档位区块：生成族连接不承载档位（spec 37「声明位置」的生成侧空集）。
 * 没有常驻解释文字：两个 ID 字段靠占位符自解释，勾选框文案就是「支持参考图」的全部说明。
 * 「高级参数自定义」默认收起：展开才会按所选接口类型拉取参数描述；尚未选择接口类型时展开
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

/** 「接口类型」选项：值域来自契约枚举，展示名取自契约注册表（单一事实源，不另写一份）。 */
const FAMILY_ADAPTER_OPTIONS: ReadonlyArray<{ value: GenerationFamilyAdapterId; label: string }> =
  GENERATION_FAMILY_ADAPTER_IDS.map((adapterId) => ({
    value: adapterId,
    label: ADAPTER_REGISTRY[adapterId].display_name,
  }));

export type GenerationModelFormPayload = {
  /** 该记录的接口类型声明（2026-09-26 起协议归属模型级，不再从连接继承） */
  familyAdapterId: GenerationFamilyAdapterId;
  modelId: string;
  /**
   * 服务商那边的模型 ID；null = 留空，按模型 ID 请求——与对话侧先例
   * （`remote_model_id: modelId`）同一个语义，由调用方落成具体值。
   */
  remoteModelId: string | null;
  /** 图生图能力随声明落库（试点设计 C4：输入模态是模型属性） */
  supportsReferenceImage: boolean;
  /**
   * 参数覆盖（生成模型参数高级自定义-design §3.4）；null = 没有自定义任何参数，
   * 请求体不带 parameter_overrides，与不带本字段的既有行为完全一致。
   */
  parameterOverrides: ParameterOverrides | null;
};

/**
 * 表单状态与提交逻辑（合并弹窗壳层调用；状态在这里，footer 按钮才拿得到 busy 与可提交性）。
 *
 * 「接口类型」空态起步、必选（2026-09-29 起连接级预选摘除）。`loadParameterTemplate`
 * 按表单当前所选接口类型拉取参数描述（展开「高级参数自定义」时调用；由调用方注入，
 * 表单自己不碰网络）。`onSubmit` 返回 false 表示没添加成功（保留输入内容，不静默清空）；
 * 成功后调用 `onClose` 收掉弹窗。
 */
export function useGenerationModelForm({
  loadParameterTemplate,
  onSubmit,
  onClose,
}: {
  loadParameterTemplate: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
  onClose: () => void;
}) {
  const [familyAdapterId, setFamilyAdapterId] = useState<GenerationFamilyAdapterId | null>(null);
  const [modelId, setModelId] = useState('');
  const [remoteModelId, setRemoteModelId] = useState('');
  const [supportsReferenceImage, setSupportsReferenceImage] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 模型 ID 非空但格式非法（失焦或提交时按 contracts 的 model_id schema 判定）。空串不算——它由按钮禁用拦截。 */
  const [idFormatInvalid, setIdFormatInvalid] = useState(false);
  const overrides = useGenerationOverridesSection(
    // 展开那一刻读当前所选接口类型：每次渲染重建闭包，读到的是最新选择。
    // 尚未选择接口类型时不发请求（留痕后折叠区按 pending 指引呈现；收起再展开会按新选择再试）
    () =>
      familyAdapterId === null
        ? Promise.reject(new Error('尚未选择接口类型，不拉取族模板参数描述'))
        : loadParameterTemplate(familyAdapterId),
    emptyParameterOverrides(),
  );
  /** 提交被参数提示拦过一次：提示要留在弹层里，改好一处就撤掉 */
  const [advancedBlocked, setAdvancedBlocked] = useState(false);

  const trimmedId = modelId.trim();
  // 接口类型在创建表单必选（与后端契约对齐：生成记录 `family_adapter_id` 必填，创建后不可变）
  const canSubmit = trimmedId !== '' && familyAdapterId !== null;
  const hasOverrides = overrides.value.official.length > 0 || overrides.value.custom.length > 0;

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
      supportsReferenceImage,
      parameterOverrides: hasOverrides ? overrides.value : null,
    })
      .then((added) => {
        if (added) onClose();
      })
      .finally(() => setBusy(false));
  };

  return {
    familyAdapterId,
    onFamilyAdapterIdChange: setFamilyAdapterId,
    familyAdapterOptions: FAMILY_ADAPTER_OPTIONS,
    modelId,
    /** 输入即撤掉格式拦截提示：改一个字符说明用户在改它 */
    onModelIdChange,
    onModelIdBlur: checkIdFormat,
    remoteModelId,
    onRemoteModelIdChange: setRemoteModelId,
    supportsReferenceImage,
    onSupportsReferenceImageChange: setSupportsReferenceImage,
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
        <FieldLabelRow htmlFor="generation-family-adapter" label="接口类型" />
        <Select
          {...(form.familyAdapterId === null ? {} : { value: form.familyAdapterId })}
          onValueChange={(next) => {
            // 选项值域即契约枚举：按选项收窄，选不中（不可能发生）就保持原值
            const matched = form.familyAdapterOptions.find((option) => option.value === next);
            if (matched !== undefined) form.onFamilyAdapterIdChange(matched.value);
          }}
        >
          <SelectTrigger id="generation-family-adapter" size="sm" className="w-full">
            <SelectValue placeholder="请选择接口类型" />
          </SelectTrigger>
          <SelectContent>
            {form.familyAdapterOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
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

      <label htmlFor="generation-supports-reference-image" className="flex cursor-pointer items-center gap-2 text-xs">
        <Checkbox
          id="generation-supports-reference-image"
          checked={form.supportsReferenceImage}
          onCheckedChange={(checked) => form.onSupportsReferenceImageChange(checked === true)}
          aria-label="支持参考图"
        />
        <span>支持参考图</span>
      </label>

      <GenerationOverridesSection
        state={form.overrides}
        pending={form.familyAdapterId === null}
      />

      {form.advancedBlocked && form.overrides.issues.length > 0 ? (
        <p role="alert" className="text-2xs text-destructive">{advancedBlockedHint(form.overrides.open)}</p>
      ) : null}
    </>
  );
}

import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@iart/ui';
import type {
  CustomGenerationModel,
  FamilyTemplateParameterDescriptor,
  GenerationMediaSlotId,
  InterfaceRecipe,
  ParameterOverrides,
} from '@iart/contracts';
import { FieldLabelRow } from './InfoHint';
import { USE_BUILTIN_RECIPE, familyDisplayName } from './GenerationModelForm';
import type { InterfaceFormatOption } from './useInterfaceFormatOptions';
import { resolveRecipeReferenceState } from './invalidity';
import {
  effectiveMediaSlots,
  GenerationMediaSlotChecklist,
  useGenerationMediaSlots,
} from './GenerationMediaSlotFields';
import {
  GenerationOverridesSection,
  useGenerationOverridesSection,
} from './GenerationOverridesSection';
import { pruneOfficialOverridesForLiveMediaSlots } from './ParameterOverridesEditor';

/**
 * 修改一个已添加的生成模型（docs/custom-providers/生成模型参数高级自定义-design.md §3.4）。
 *
 * 弹层 = 参数编辑器 + 素材位逐项勾选：能改的就是 UpdateBody 承载的两样——素材位清单与
 * 参数覆盖（出现即整体替换）。编辑器初始值回填记录的现有覆盖；没展开高级区就保存时，
 * 覆盖原样写回。
 *
 * **接口格式只读**：`family_adapter_id` 创建后不可变（契约如此，换族等于换一个模型），
 * 所以这里不给下拉，只按该族的族能力渲染素材位勾选——能改的只有「这个模型接受其中哪些」。
 *
 * 入口长在服务商详情里该模型自己的行上（记录即接入，记录在哪一行就在哪个服务商详情里）；
 * 模型 ID 是身份不提供改名（改名等于换一个模型，已建引用会指向不存在的模型），只读展示。
 * 标题与动作措辞对齐对话侧先例（「修改…的模型配置」）。
 */

/**
 * 提交被即时提示拦下时的弹层级说明（行内红字在折叠区里）。收起时指认去哪展开；
 * 已经展开的不再复述「展开」这个动作，直接指红字。
 */
const advancedBlockedHint = (advancedOpen: boolean): string =>
  advancedOpen
    ? '高级参数还有没改好的地方，按红字提示改。'
    : '高级参数还有没改好的地方，展开「高级参数自定义」按红字提示改。';

export type GenerationModelEditPayload = {
  /** 整体替换：该模型接受的素材位清单（按该族能力逐项勾选的结果） */
  acceptedMediaSlots: GenerationMediaSlotId[];
  /** 出现即整体替换（UpdateBody 契约口径）；保存未改动的覆盖等于原样写回 */
  parameterOverrides: ParameterOverrides;
  /**
   * 接口配方引用三态：`undefined` = 不改（配方列表读不到时），`null` = 清除引用（回到内置默认），
   * 字符串 = 引用该配方。
   */
  recipeId: string | null | undefined;
};

export function GenerationModelEditDialog({
  entry,
  loadParameterTemplate,
  recipes,
  recipesUnavailable = false,
  formatOptions = [],
  failureText = null,
  onClose,
  onSubmit,
}: {
  entry: CustomGenerationModel;
  /** 拉取族模板参数描述（素材位与「高级参数自定义」共用一次装载；由调用方注入，弹层自己不碰网络） */
  loadParameterTemplate: () => Promise<FamilyTemplateParameterDescriptor>;
  /** 接口配方公共库（按记录自带的接口格式过滤）；列表读不到时本次不改引用。 */
  recipes: readonly InterfaceRecipe[];
  recipesUnavailable?: boolean;
  /** 接口格式选项表：只用于把格式 id 显示成人话名（不承载选择，记录里的格式不可改）。 */
  formatOptions?: readonly InterfaceFormatOption[];
  /**
   * 上一次写入的失败原因，显示在表单底部。
   *
   * 分区顶部的提示条在弹层期间被遮罩挡住——写入是从这个弹层发起的，失败原因就得出现在这里；
   * 后端逐条拒绝原因（别名撞保留键、空枚举这类）由调用方原样透传，不笼统化。
   */
  failureText?: string | null;
  /** 返回 false 表示没保存成功（保留输入内容，不静默清空） */
  onSubmit: (payload: GenerationModelEditPayload) => Promise<boolean>;
  onClose: () => void;
}) {
  // 接口格式只读：族能力按记录自带的 family_adapter_id 拉取，回填记录里已勾的素材位
  const mediaSlots = useGenerationMediaSlots({
    familyAdapterId: entry.family_adapter_id,
    familyDisplayName: familyDisplayName(entry.family_adapter_id, formatOptions),
    loadDescriptor: () => loadParameterTemplate(),
    initialSelected: entry.accepted_media_slots,
  });
  const [busy, setBusy] = useState(false);
  const liveMediaSlots = effectiveMediaSlots(mediaSlots);
  const overrides = useGenerationOverridesSection(
    loadParameterTemplate,
    entry.parameter_overrides,
    liveMediaSlots,
  );
  /** 提交被参数提示拦过一次：提示要留在弹层里，改好一处就撤掉 */
  const [advancedBlocked, setAdvancedBlocked] = useState(false);

  const availableRecipes = recipes.filter(
    (recipe) => recipe.family_adapter_id === entry.family_adapter_id,
  );
  // 与模型列表的行内标记共用同一处判定（`invalidity.ts`）：列表说失效、弹层说没事
  // 的分叉会让用户在两处读到相反的结论。
  const currentRecipeMissing =
    resolveRecipeReferenceState({
      recipeId: entry.recipe_id,
      familyAdapterId: entry.family_adapter_id,
      recipes,
      recipesUnavailable,
    }) === 'missing';
  /**
   * 三态初值：
   * - 配方列表读不到 → undefined（保存时不改引用，绝不因为「读不到」把用户的配方清掉）
   * - 本来没有引用 → undefined（未改动时不往请求体加键，既有修改请求保持原样）
   * - 现有引用能在列表里找到 → 该 id
   * - 引用已不在列表里（配方被删）→ null（保存时清掉悬空引用）
   */
  const [recipeId, setRecipeId] = useState<string | null | undefined>(
    recipesUnavailable || entry.recipe_id === undefined
      ? undefined
      : !currentRecipeMissing
        ? entry.recipe_id
        : null,
  );
  /** 没有任何配方可选、记录也没有引用时，不渲染这个字段（不增加一个只有一项的下拉）。 */
  const showRecipeField =
    recipesUnavailable || availableRecipes.length > 0 || entry.recipe_id !== undefined;

  const submit = (): void => {
    if (busy) return;
    // 素材位还没读到（loading/failed）时保存等于猜一份清单，拦在提交前
    if (mediaSlots.blocked) return;
    // 客户端可判定的必然失败提交前拦下；拦不住的剩余理由由后端拒绝并原样透进弹层
    if (overrides.issues.length > 0) {
      setAdvancedBlocked(true);
      return;
    }
    setAdvancedBlocked(false);
    setBusy(true);
    void onSubmit({
      acceptedMediaSlots: liveMediaSlots,
      // 未勾选素材位留下的条目不进请求体：后端按本次勾选的模板校验，带上它必然整次被拒。
      // 弹层状态里仍保留输入，同一次弹层内勾回来还能看到。
      parameterOverrides: pruneOfficialOverridesForLiveMediaSlots(
        overrides.value,
        liveMediaSlots,
        mediaSlots.load.kind === 'ready' ? mediaSlots.load.fieldKeyBySlotId : {},
      ),
      recipeId,
    })
      .then((saved) => {
        if (saved) onClose();
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent form="standard" size="standard">
        <DialogHeader>
          <DialogTitle>修改「{entry.model_id}」的模型配置</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">模型 ID</span>
            <span className="break-all text-xs text-muted-foreground">{entry.model_id}</span>
          </div>

          {/* 接口格式创建后不可变：只读出展示名，不给下拉（换族等于换一个模型） */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">接口格式</span>
            <span className="text-xs text-muted-foreground">
              {familyDisplayName(entry.family_adapter_id, formatOptions)}
            </span>
          </div>

          {showRecipeField ? (
            <div className="flex flex-col gap-2">
              <FieldLabelRow
                htmlFor="generation-recipe-edit"
                label="接口配方"
                hint={{
                  text: '配方决定任务什么时候算完成、产物从哪里取。不选就用这个接口格式的默认判定。',
                  subject: '接口配方',
                }}
              />
              {recipesUnavailable ? (
                <p className="text-2xs text-muted-foreground">暂时读不到配方列表，这次不改配方。</p>
              ) : (
                <Select
                  value={recipeId ?? USE_BUILTIN_RECIPE}
                  onValueChange={(next) => {
                    setRecipeId(next === USE_BUILTIN_RECIPE ? null : next);
                  }}
                >
                  <SelectTrigger id="generation-recipe-edit" size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={USE_BUILTIN_RECIPE}>使用内置默认</SelectItem>
                    {availableRecipes.map((recipe) => (
                      <SelectItem key={recipe.recipe_id} value={recipe.recipe_id}>
                        {recipe.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {currentRecipeMissing && !recipesUnavailable ? (
                <p className="text-2xs text-muted-foreground">
                  之前选的配方已经不在了，保存后会改用内置默认。
                </p>
              ) : null}
            </div>
          ) : null}

          <GenerationMediaSlotChecklist state={mediaSlots} />

          <GenerationOverridesSection state={overrides} liveMediaSlotIds={liveMediaSlots} />

          {advancedBlocked && overrides.issues.length > 0 ? (
            <p role="alert" className="text-2xs text-destructive">{advancedBlockedHint(overrides.open)}</p>
          ) : null}
          {failureText === null ? null : (
            <p role="alert" className="text-2xs text-destructive">{failureText}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="button" disabled={busy || mediaSlots.blocked} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

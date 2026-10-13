import { useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@iart/ui';
import type {
  CustomGenerationModel,
  FamilyTemplateParameterDescriptor,
  ParameterOverrides,
} from '@iart/contracts';
import {
  GenerationOverridesSection,
  useGenerationOverridesSection,
} from './GenerationOverridesSection';

/**
 * 修改一个已声明的生成模型（docs/custom-providers/生成模型参数高级自定义-design.md §3.4）。
 *
 * 弹层 = 参数编辑器 + 「支持参考图」开关：能改的就是 UpdateBody 承载的两样——参考图支持
 * 与参数覆盖（出现即整体替换）。编辑器初始值回填声明的现有覆盖；没展开高级区就保存时，
 * 覆盖原样写回，行为等于只改了参考图开关。
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
  supportsReferenceImage: boolean;
  /** 出现即整体替换（UpdateBody 契约口径）；保存未改动的覆盖等于原样写回 */
  parameterOverrides: ParameterOverrides;
};

export function GenerationModelEditDialog({
  entry,
  loadParameterTemplate,
  failureText = null,
  onClose,
  onSubmit,
}: {
  entry: CustomGenerationModel;
  /** 拉取族模板参数描述（展开「高级参数自定义」时调用；由调用方注入，弹层自己不碰网络） */
  loadParameterTemplate: () => Promise<FamilyTemplateParameterDescriptor>;
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
  const [supportsReferenceImage, setSupportsReferenceImage] = useState(entry.supports_reference_image);
  const [busy, setBusy] = useState(false);
  const overrides = useGenerationOverridesSection(loadParameterTemplate, entry.parameter_overrides);
  /** 提交被参数提示拦过一次：提示要留在弹层里，改好一处就撤掉 */
  const [advancedBlocked, setAdvancedBlocked] = useState(false);

  const submit = (): void => {
    if (busy) return;
    // 客户端可判定的必然失败提交前拦下；拦不住的剩余理由由后端拒绝并原样透进弹层
    if (overrides.issues.length > 0) {
      setAdvancedBlocked(true);
      return;
    }
    setAdvancedBlocked(false);
    setBusy(true);
    void onSubmit({
      supportsReferenceImage,
      parameterOverrides: overrides.value,
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

          <label htmlFor="generation-edit-supports-reference-image" className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              id="generation-edit-supports-reference-image"
              checked={supportsReferenceImage}
              onCheckedChange={(checked) => setSupportsReferenceImage(checked === true)}
              aria-label="支持参考图"
            />
            <span>支持参考图</span>
          </label>

          <GenerationOverridesSection state={overrides} />

          {advancedBlocked && overrides.issues.length > 0 ? (
            <p role="alert" className="text-2xs text-destructive">{advancedBlockedHint(overrides.open)}</p>
          ) : null}
          {failureText === null ? null : (
            <p role="alert" className="text-2xs text-destructive">{failureText}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="button" disabled={busy} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

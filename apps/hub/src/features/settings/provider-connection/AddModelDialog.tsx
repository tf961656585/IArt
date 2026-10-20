import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@iart/ui';
import type { FamilyTemplateParameterDescriptor } from '@iart/contracts';
import {
  GenerationModelFields,
  useGenerationModelForm,
  type GenerationModelFormPayload,
} from './GenerationModelForm';

/**
 * 生成侧的「添加模型」弹窗（**单一表单**，2026-10-19）。
 *
 * 此前这里有两个区块 + 分段切换：内置模型的勾选区块与自定义表单。软件不再内置任何具体模型
 * （spec 03 §6.1 单一载体 / §12 PC-14），勾选区块连同切换项一并退场——模型只有用户添加这一个
 * 来源，就只剩一个表单，也就没有「选来源」这一步可做
 * （`docs/hub/hub-information-architecture.md` §7.4：单一入口 → 单一表单；
 * `docs/ui-copy-standard.md` 禁止任何来源区分措辞）。
 *
 * 失败原因由调用方透传，显示在 footer 上方：分区顶部的提示条在弹窗期间被遮罩挡住，
 * 从弹窗发起的写入，原因必须出现在这里。
 */

/** 表单区块的绑定：由调用方装配（模板装载按表单所选接口类型发请求）。 */
export interface CustomModelFormBinding {
  /** 拉取族模板参数描述（展开「高级参数自定义」时按表单当前所选接口类型调用；由调用方注入，弹窗自己不碰网络） */
  loadParameterTemplate: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  /** 返回 false 表示没添加成功（保留输入内容，不静默清空） */
  onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
}

export function AddModelDialog({
  providerName,
  customForm,
  failureText = null,
  onClose,
}: {
  providerName: string;
  /**
   * 表单区块的绑定。仍然由调用方按连接装配（模板装载要发请求），因此保留这个可空入参：
   * 装配缺失时弹窗不渲染表单控件，只留一句可读说明——比渲染一个提交必然失败的空白表单好。
   */
  customForm: CustomModelFormBinding | null;
  /**
   * 上一次添加失败的原因，显示在 footer 上方。
   *
   * 分区顶部的提示条在弹窗期间被遮罩挡住，用户看不到——添加是从这个弹窗发起的，失败原因就得
   * 出现在这里；成功或关掉弹窗后由调用方把它清掉（null）。
   */
  failureText?: string | null;
  onClose: () => void;
}) {
  // 表单状态挂在弹窗壳层：footer 按钮与字段树都要读它。customForm 为 null 时字段树不渲染，
  // 这组状态是惰性的——传入的兜底加载器不会被任何渲染出来的控件调用。
  const form = useGenerationModelForm({
    loadParameterTemplate:
      customForm?.loadParameterTemplate ?? (() => Promise.reject(new Error('该连接没有生成模型表单'))),
    onSubmit: customForm?.onSubmit ?? (async () => false),
    onClose,
  });

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent form="standard" size="standard">
        <DialogHeader>
          <DialogTitle>添加模型到「{providerName}」</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {customForm === null ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              暂时没法添加模型，关掉这个窗口后点「刷新」再试。
            </p>
          ) : (
            <GenerationModelFields form={form} />
          )}

          {failureText === null ? null : (
            <p role="alert" className="text-2xs text-destructive">{failureText}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            disabled={customForm === null || form.busy || !form.canSubmit}
            onClick={form.submit}
          >
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

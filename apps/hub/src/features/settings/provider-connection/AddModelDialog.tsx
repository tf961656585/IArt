import { useMemo, useState } from 'react';
import { Button, Checkbox, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, cn } from '@iart/ui';
import type { ExecutableModelDirectoryEntry, FamilyTemplateParameterDescriptor } from '@iart/contracts';
import { FieldLabelRow } from './InfoHint';
import {
  GenerationModelFields,
  useGenerationModelForm,
  type GenerationModelFormPayload,
} from './GenerationModelForm';

/**
 * 生成侧的「添加模型」合并弹窗（2026-09-26 界面收敛：原「添加模型」「接入模型」两个并排
 * 入口与两个弹层合并为一个入口、一个弹窗）。
 *
 * 结构：分段切换两个区块——
 * - 「软件自带的模型」：已装能力包模型的多选勾选（过渡期形态；候选口径不变：
 *   自建模型记录归属创建它的连接、不经弹窗复用，候选只剩已装包模型）。
 * - 「自定义接口的模型」：自建生成模型表单（GenerationModelForm）。2026-09-26 起协议归属
 *   模型级（记录自带 `family_adapter_id`），这条连接的生成侧入口都带这块；接口类型
 *   空态起步、必选（2026-09-29 起连接级预选摘除）。
 *
 * 过渡期设计，不留死壳：目录读到了且为空、而表单区块存在时，「软件自带的模型」区块连同切换项
 * 整体不渲染，弹窗直接是表单——后续预装模型按协议族退役后，这里自然退化成纯表单。其余两个
 * 「没有可选模型」的状态保留区块：目录读不到要给「刷新」的出路（与「目录为空」必须区分，
 * 不允许混为一谈）；都添加过了要说明缺口在哪（软件自带的都加完了，剩下的路是自定义表单）。
 * 这两种状态下默认落在表单区块——落在一个没有东西可勾的区块上等于让用户多点一次。
 *
 * 两个区块都保持挂载（非活动块挂 Tailwind `hidden` 类收起）：切走再切回，勾选与填了一半的
 * 表单都还在。提交按钮共用 footer 槽位，按当前区块切换；失败原因由调用方透传，显示在 footer 上方
 * （分区顶部的提示条在弹窗期间被遮罩挡住，从弹窗发起的写入，原因必须出现在这里）。
 */

export interface ModelMappingDraft {
  model_id: string;
  remote_model_id: string;
}

/** 「自定义接口的模型」区块的绑定：由调用方装配（模板装载按表单所选接口类型发请求）。 */
export interface CustomModelFormBinding {
  /** 拉取族模板参数描述（展开「高级参数自定义」时按表单当前所选接口类型调用；由调用方注入，弹窗自己不碰网络） */
  loadParameterTemplate: (familyAdapterId: string) => Promise<FamilyTemplateParameterDescriptor>;
  /** 返回 false 表示没添加成功（保留输入内容，不静默清空） */
  onSubmit: (payload: GenerationModelFormPayload) => Promise<boolean>;
}

/** 「软件自带的模型」区块没有可勾候选时的说明。三分支互斥，写成函数不写嵌套三元。 */
const builtinEmptyText = ({
  sourceUnavailable,
  sourceCatalogSize,
}: {
  sourceUnavailable: boolean;
  sourceCatalogSize: number;
}): string => {
  if (sourceUnavailable) return '暂时读不到模型清单，关掉这个窗口后点「刷新」再试。';
  // 目录为空且没有表单区块时才会渲染到这句：没有别处可指，只说明情况
  return sourceCatalogSize === 0
    ? '软件里还没有可用的模型。'
    : '软件自带的模型都已经添加到这个服务商了。';
};

export function AddModelDialog({
  providerName,
  catalog,
  catalogUnavailable,
  boundModelIds,
  customForm,
  failureText = null,
  onClose,
  onSubmitBuiltIn,
}: {
  providerName: string;
  /** 自带模型候选（GET /api/executable-model-catalog，已装能力包模型） */
  catalog: ExecutableModelDirectoryEntry[];
  /** 候选目录端点不可用。与「目录可用但没有模型」必须给不同文案，不允许混为一谈。 */
  catalogUnavailable: boolean;
  /** 该服务商已经添加的自带模型 */
  boundModelIds: ReadonlySet<string>;
  /** 「自定义接口的模型」区块；null = 这条连接没有自建表单（区块不渲染） */
  customForm: CustomModelFormBinding | null;
  /**
   * 上一次添加失败的原因，显示在 footer 上方。
   *
   * 分区顶部的提示条在弹窗期间被遮罩挡住，用户看不到——添加是从这个弹窗发起的，失败原因就得
   * 出现在这里；成功或关掉弹窗后由调用方把它清掉（null）。
   */
  failureText?: string | null;
  onClose: () => void;
  /** 提交「软件自带的模型」区块的勾选（逐条建接入，由调用方串行写入） */
  onSubmitBuiltIn: (items: ModelMappingDraft[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const available = useMemo(
    () =>
      catalog
        .slice()
        .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || a.model_id.localeCompare(b.model_id))
        .filter((entry) => !boundModelIds.has(entry.model_id)),
    [catalog, boundModelIds],
  );

  const toggle = (modelId: string): void => {
    const next = new Set(picked);
    if (next.has(modelId)) next.delete(modelId);
    else next.add(modelId);
    setPicked(next);
  };

  // 提交与计数都按「候选里还在的」算。添加失败后候选会被重新装载，已经加上的模型随即从中消失，
  // 而 picked 里可能还留着它——按 picked.size 会显示一个永远提交不出去的个数。
  const submitting = available.filter((entry) => picked.has(entry.model_id));

  const submitBuiltIn = (): void => {
    setBusy(true);
    const items = submitting.map((entry) => ({
      model_id: entry.model_id,
      remote_model_id: (names[entry.model_id] ?? '').trim() === '' ? entry.model_id : (names[entry.model_id] ?? '').trim(),
    }));
    void onSubmitBuiltIn(items).finally(() => setBusy(false));
  };

  // 表单区块的状态挂在弹窗壳层：footer 按钮与字段树都要读它。customForm 为 null 时区块不渲染，
  // 这组状态是惰性的——传入的兜底加载器不会被任何渲染出来的控件调用。
  const form = useGenerationModelForm({
    loadParameterTemplate: customForm?.loadParameterTemplate ?? (() => Promise.reject(new Error('该连接没有自定义表单区块'))),
    onSubmit: customForm?.onSubmit ?? (async () => false),
    onClose,
  });

  // 「软件自带的模型」区块显隐：目录读不到、或目录里有模型时保留（后两者各有说明可看）；
  // 读到了且为空、又有表单区块可去时，整个区块连同切换项一起消失。
  const builtinVisible = catalogUnavailable || catalog.length > 0 || customForm === null;
  const showToggle = builtinVisible && customForm !== null;
  // 默认落在有东西可做的区块：有可勾的自带模型落在勾选；否则落在表单（仅剩一个区块时落它）
  const [section, setSection] = useState<'builtin' | 'custom'>(
    available.length > 0 || customForm === null ? 'builtin' : 'custom',
  );

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent form="standard" size="standard">
        <DialogHeader>
          <DialogTitle>添加模型到「{providerName}」</DialogTitle>
        </DialogHeader>

        {showToggle ? (
          // 分段选项卡（复合控件，按钮样式标准 §7 出路①）：选项是控件的组成件，
          // 视觉语义（选中填充/aria-pressed）由本分段控件整体承载，不走共享 Button
          <div role="group" aria-label="模型来源" className="flex w-fit items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
            <button
              type="button"
              aria-pressed={section === 'builtin'}
              onClick={() => setSection('builtin')}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                section === 'builtin' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              软件自带的模型
            </button>
            <button
              type="button"
              aria-pressed={section === 'custom'}
              onClick={() => setSection('custom')}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                section === 'custom' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              自定义接口的模型
            </button>
          </div>
        ) : null}

        {/* 切换项与两个区块包进同一个纵向容器：standard 弹窗的其余直接子级会被归入自动滚动
            DialogBody，块级堆叠没有间距，容器自己扛 gap；两块都挂载保活，收起用条件挂 Tailwind
            `hidden` 类——不用 HTML hidden 属性叠布局类：同一元素上 display 布局类（flex 等）会与
            hidden 属性的 display:none 竞争生效路径（2026-09-21 实锤先例），条件挂类让两者互斥，
            收起块的 display 声明只来自 hidden 机制 */}
        <div className="flex flex-col gap-4">
          {builtinVisible ? (
            <div className={section === 'builtin' ? 'flex flex-col gap-3' : 'hidden'}>
              {available.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {builtinEmptyText({
                    sourceUnavailable: catalogUnavailable,
                    sourceCatalogSize: catalog.length,
                  })}
                </p>
              ) : (
                <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                  {available.map((entry) => {
                    const checked = picked.has(entry.model_id);
                    // 候选行呼吸档（visual-design §8.6 律二）：px-3 py-2
                    return (
                      <div key={entry.model_id} className="flex flex-col gap-2 rounded-md px-3 py-2 hover:bg-accent/40">
                        <label className="flex cursor-pointer items-center gap-2 text-xs">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggle(entry.model_id)}
                            aria-label={`添加 ${entry.model_id}`}
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">{entry.model_id}</span>
                        </label>
                        {checked ? (
                          // 纵向字段行 label↔控件 8px（visual-design §8.6 律一）
                          <div className="flex flex-col gap-2 pl-6">
                            <FieldLabelRow htmlFor={`remote-${entry.model_id}`} label="服务商那边的模型 ID" />
                            <Input
                              id={`remote-${entry.model_id}`}
                              value={names[entry.model_id] ?? ''}
                              placeholder={entry.model_id}
                              onChange={(event) => setNames({ ...names, [entry.model_id]: event.target.value })}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {customForm !== null ? (
            <div className={section === 'custom' ? 'flex flex-col gap-3' : 'hidden'}>
              <GenerationModelFields form={form} />
            </div>
          ) : null}

          {failureText === null ? null : (
            <p role="alert" className="text-2xs text-destructive">{failureText}</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          {section === 'builtin' ? (
            <Button type="button" disabled={busy || submitting.length === 0} onClick={submitBuiltIn}>
              {submitting.length === 0 ? '添加模型' : `添加 ${submitting.length} 个模型`}
            </Button>
          ) : (
            <Button type="button" disabled={form.busy || !form.canSubmit} onClick={form.submit}>
              添加
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

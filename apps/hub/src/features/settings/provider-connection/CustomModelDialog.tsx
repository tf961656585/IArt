import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@iart/ui';
import type { CustomChatModel, ThinkingTierPool } from '@iart/contracts';
import { ADAPTER_REGISTRY, CHAT_PROTOCOL_ADAPTER_IDS, type ChatProtocolAdapterId } from '@iart/contracts';
import { FieldLabelRow } from './InfoHint';
import {
  CustomModelCapabilityFields,
  useCustomModelCapability,
  type CustomModelCapabilityDraft,
} from './CustomModelCapabilityFields';
import { ThinkingTierFields, type ThinkingTierChoice } from './ThinkingTierFields';

/**
 * 自建模型的表单，两个入口共用（spec 03 §6.1「记录即接入」、spec 37）。
 *
 * - `create`：添加一个对话模型到某个服务商。提交一次写入创建自建对话模型记录
 *   （接口类型、能力值、思考档位与接入归属同一次落库，active 接入由后端在创建内完成）。
 *   「接口类型」由用户选择（2026-09-26 起协议归属模型级，记录自带 `protocol_adapter_id`，
 *   不再从连接继承；2026-09-29 起连接级预选摘除），空态起步、必选后才可提交。
 * - `edit`：改一个自建对话模型记录的配置——能力值与思考档位（档位随记录走，
 *   服务商详情里该模型行的「修改」入口）。接口类型是记录身份的一部分，不提供修改。
 *   带 `onDelete` 时，这个模型还能在同一个弹层里被删掉：
 *   删除入口只此一处（2026-09-18 起不再有独立的「我添加的模型」区块），跟着模型自己的配置走
 *   才不会让人找两个地方。
 *
 * 两个入口字段重叠，所以是同一个组件：各写一份会让同一字段在不同入口上校验与说明分叉。
 * 差别只有标题、模型 ID 与接口类型可不可改、是否带思考档位、以及提交后调用方做什么。
 * 用 `mode` 判别而不是一堆 optional，少写一个分支字段直接编译不过。思考档位随模型记录走
 * （记录归属一条连接，模型不复用到另一条连接），所以它只在有连接上下文时传入；读不到那条
 * 连接时不传，弹层因此不给档位——写进去也没有连接承载它。
 *
 * 档位的可表达性按记录/表单当前的接口类型判定（契约注册表为唯一元数据源）。
 */

export type CustomModelDialogMode =
  | { kind: 'create'; providerName: string }
  | { kind: 'edit'; model: CustomChatModel };

/** 有连接上下文时传入：候选档位池与该记录当前的档位。 */
export type CustomModelThinkingContext = {
  pool: ThinkingTierPool;
  unavailable: boolean;
  /** 该记录当前启用的档位（顺序即创作面展示顺序） */
  initialTiers: string[];
  /** 该记录当前的默认档位；null = 没有默认 */
  initialDefaultTier: string | null;
  /** 加一个自定义档位进全局池；返回 true 表示已加上（失败时保留输入内容） */
  onAddCustom: (name: string) => Promise<boolean>;
  /** 把自定义档位删出全局池（会级联摘掉其他正在用它的模型，确认与写入由调用方负责） */
  onDeleteCustom: (tier: string) => void;
};

export type CustomModelDialogPayload = CustomModelCapabilityDraft & {
  modelId: string;
  /** 本次创建声明的接口类型；null = 本次不涉及（修改入口，协议随记录不可改） */
  protocolAdapterId: ChatProtocolAdapterId | null;
  /** 本次要写入该接入的启用档位（有序）；null = 本次不涉及档位（提交方按不写处理） */
  enabledThinkingTiers: string[] | null;
  /** 本次要写入的默认档位；null = 没有默认（提交方在带档位时按「清空默认」写） */
  defaultThinkingTier: string | null;
};

/** 「接口类型」选项：值域来自契约枚举，展示名取自契约注册表（单一事实源，不另写一份）。 */
const CHAT_ADAPTER_OPTIONS: ReadonlyArray<{ value: ChatProtocolAdapterId; label: string }> =
  CHAT_PROTOCOL_ADAPTER_IDS.map((adapterId) => ({
    value: adapterId,
    label: ADAPTER_REGISTRY[adapterId].display_name,
  }));

export function CustomModelDialog({
  mode,
  thinking = null,
  onDelete,
  failureText = null,
  onClose,
  onSubmit,
}: {
  mode: CustomModelDialogMode;
  thinking?: CustomModelThinkingContext | null;
  /** 删除这个模型（记录本身，其 active 接入由后端级联清理）。只在改配置时传入：确认与写入由调用方负责 */
  onDelete?: () => void;
  /**
   * 上一次写入的失败原因，显示在表单底部。
   *
   * 分区顶部的提示条在弹层期间被遮罩挡住，用户看不到——写入是从这个弹层发起的，失败原因就得
   * 出现在这里；成功或再次提交后由调用方把它清掉（null）。
   */
  failureText?: string | null;
  /** 返回 false 表示没保存成功（保留输入内容，不静默清空） */
  onSubmit: (payload: CustomModelDialogPayload) => Promise<boolean>;
  onClose: () => void;
}) {
  const editing = mode.kind === 'edit';
  const [modelId, setModelId] = useState(editing ? mode.model.model_id : '');
  // 创建态的接口类型空态起步、必选（2026-09-29 起连接级预选摘除）；修改态接口类型随记录
  // 不可改，不进表单状态
  const [protocolAdapterId, setProtocolAdapterId] = useState<ChatProtocolAdapterId | null>(
    editing ? mode.model.protocol_adapter_id : null,
  );
  const [tierChoice, setTierChoice] = useState<ThinkingTierChoice>(() => ({
    tiers: thinking?.initialTiers ?? [],
    defaultTier: thinking?.initialDefaultTier ?? null,
  }));
  const [busy, setBusy] = useState(false);
  const capability = useCustomModelCapability(editing ? mode.model : null);

  const trimmedId = modelId.trim();
  // 接口类型在创建态必选（与后端契约对齐：对话记录 `protocol_adapter_id` 必填，创建后不可变）；
  // 修改态它随记录恒有值，不参与拦截
  const canSubmit = trimmedId !== '' && capability.draft !== null && protocolAdapterId !== null;

  /** 新增档位一律追加到末尾：顺序即创作面展示顺序，插到中间会替用户决定他没表达过的次序 */
  const addTier = (tier: string): void => {
    setTierChoice((previous) =>
      previous.tiers.includes(tier)
        ? previous
        : { tiers: [...previous.tiers, tier], defaultTier: previous.defaultTier },
    );
  };

  const removeTier = (tier: string): void => {
    setTierChoice((previous) => ({
      tiers: previous.tiers.filter((item) => item !== tier),
      // 默认档位必须还在启用列表里：摘掉它就等于没有默认（跨字段不变量，写入侧也校验）
      defaultTier: previous.defaultTier === tier ? null : previous.defaultTier,
    }));
  };

  const submit = (): void => {
    const draft = capability.draft;
    if (busy || draft === null || trimmedId === '' || protocolAdapterId === null) return;
    setBusy(true);
    void onSubmit({
      modelId: trimmedId,
      ...draft,
      protocolAdapterId: editing ? null : protocolAdapterId,
      enabledThinkingTiers: thinking === null ? null : tierChoice.tiers,
      defaultThinkingTier: thinking === null ? null : tierChoice.defaultTier,
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
          <DialogTitle>
            {editing
              ? `修改「${mode.model.model_id}」的模型配置`
              : `添加模型到「${mode.providerName}」`}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {editing ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">模型 ID</span>
              <span className="break-all text-xs text-muted-foreground">{mode.model.model_id}</span>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <FieldLabelRow htmlFor="custom-model-adapter" label="接口类型" />
                <Select
                  {...(protocolAdapterId === null ? {} : { value: protocolAdapterId })}
                  onValueChange={(next) => {
                    // 选项值域即契约枚举：按选项收窄，选不中（不可能发生）就保持原值
                    const matched = CHAT_ADAPTER_OPTIONS.find((option) => option.value === next);
                    if (matched !== undefined) setProtocolAdapterId(matched.value);
                  }}
                >
                  <SelectTrigger id="custom-model-adapter" size="sm" className="w-full">
                    <SelectValue placeholder="请选择接口类型" />
                  </SelectTrigger>
                  <SelectContent>
                    {CHAT_ADAPTER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <FieldLabelRow htmlFor="custom-model-id" label="模型 ID" />
                <Input
                  id="custom-model-id"
                  value={modelId}
                  placeholder="服务商文档里的模型 ID，如 gpt-5.6-preview"
                  autoComplete="off"
                  onChange={(event) => setModelId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submit();
                  }}
                />
              </div>
            </>
          )}

          <CustomModelCapabilityFields
            idPrefix={editing ? 'custom-model-edit' : 'custom-model-add'}
            capability={capability}
            onEnter={submit}
          />

          {thinking === null ? null : (
            <ThinkingTierFields
              idPrefix={editing ? 'custom-model-edit' : 'custom-model-add'}
              selection={{
                pool: thinking.pool,
                // 可表达性按记录/表单当前的接口类型判定（契约注册表是唯一元数据源）；
                // 尚未选择接口类型时传 null——档位字段按「适配器缺失」呈现（见 ThinkingTierSelection）
                adapter: protocolAdapterId === null ? null : ADAPTER_REGISTRY[protocolAdapterId],
                unavailable: thinking.unavailable,
                choice: tierChoice,
                onAdd: addTier,
                onRemove: removeTier,
                onReorder: (tiers) => setTierChoice((previous) => ({ ...previous, tiers })),
                onSetDefault: (tier) => setTierChoice((previous) => ({ ...previous, defaultTier: tier })),
                onAddCustom: (name) =>
                  thinking.onAddCustom(name).then((added) => {
                    // 新档位进池后即为本模型启用：用户按「添加档位」表达的是「我要用它」，
                    // 只进池不启用会让他再找一次。默认档位不动——那是另一个决定。
                    if (added) addTier(name);
                    return added;
                  }),
                onDeleteCustom: thinking.onDeleteCustom,
              }}
            />
          )}

          {failureText === null ? null : (
            <p role="alert" className="text-2xs text-destructive">{failureText}</p>
          )}
        </div>

        <DialogFooter>
          {onDelete === undefined ? null : (
            // 破坏性动作放左侧、与「保存」拉开距离：它动的是整个模型，不是这次表单里的配置值。
            // 行内危险动作统一 ghost-destructive（按钮样式标准 §4），不再手写 text-destructive
            <Button type="button" variant="ghost-destructive" className="mr-auto" onClick={onDelete}>
              删除模型
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="button" disabled={busy || !canSubmit} onClick={submit}>
            {editing ? '保存' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

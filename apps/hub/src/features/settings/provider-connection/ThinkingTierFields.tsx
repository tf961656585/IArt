import { useState } from 'react';
import { Button, Input } from '@iart/ui';
import { GripVertical, X } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  THINKING_TIER_NAME_MAX_LENGTH,
  ThinkingTierSchema,
  type ProtocolAdapter,
  type ThinkingTierPool,
} from '@iart/contracts';
import { InfoHint } from './InfoHint';

/**
 * 思考档位字段（spec 37「思考档位」、spec hub-information-architecture §7.4）。
 *
 * 「添加模型」与「修改」两个入口共用本文件：两处的候选、顺序语义与「顺手加一个档位」的写法
 * 必须逐字一致，各写一套会让同一件事在两个入口上表现为两种能力。
 *
 * 形状是「已启用（可拖动排序）+ 可添加」两段，不是一列勾选框：
 * 已启用档位的**顺序就是创作面的展示顺序**（spec 37），而顺序是拖出来的，不是一个勾选框能表达的；
 * 默认档位只能从已启用档位里选一个，因此它挂在已启用行上、不单独占一个字段。
 * 「不思考」恒定可用、不作为可选项出现。
 *
 * 档位池的维护也收在这里（2026-09-18）：新增走「添加档位」，自定义档位在「可添加」里就地删除。
 * 池子不再有独立的列表区块——它的内容在页面上与这里逐条重复，而档位只在配置模型时才被关心。
 * 删除是池子级的（会级联摘掉其他正在用它的模型），所以只对自定义档位出现、且要先由调用方确认；
 * 已启用的档位不在「可添加」里，也就不在这里被删——先把它从本模型移除，再删出池子。
 *
 * 自定义档位只在档位字段接受自由字符串的接口类型上可添加，其余接口类型下说明原因；
 * 接口类型还没选时是另一种原因（还没法判断）——让用户在配置时就看见约束，而不是发出去才失败。
 */

/** 一个接入上的档位选择：顺序即创作面展示顺序，默认档位是其中一个（或没有）。 */
export interface ThinkingTierChoice {
  /** 已启用档位（有序） */
  tiers: string[];
  /** 默认档位；null = 没有默认，创作面按「不思考」初始化 */
  defaultTier: string | null;
}

/** 档位选择区的输入面：候选池、可表达性判定源、当前选择与各动作。 */
export interface ThinkingTierSelection {
  pool: ThinkingTierPool;
  /** 该连接接口类型（自定义档位可表达性的唯一判定源）；适配器缺失时为 null */
  adapter: ProtocolAdapter | null;
  choice: ThinkingTierChoice;
  /** 池子读不到。与「池子里没有可加的档位」必须给不同文案，不允许混为一谈。 */
  unavailable: boolean;
  onAdd: (tier: string) => void;
  onRemove: (tier: string) => void;
  /** 拖动排序的结果：已启用档位的新顺序 */
  onReorder: (tiers: string[]) => void;
  /** 设为默认 / 取消默认（传 null） */
  onSetDefault: (tier: string | null) => void;
  /** 返回 true 表示已加进池子（失败时保留输入内容，不静默清空） */
  onAddCustom: (name: string) => Promise<boolean>;
  /** 把自定义档位删出池子（会级联摘掉其他正在用它的模型，确认与写入由调用方负责） */
  onDeleteCustom: (tier: string) => void;
}

/** 当前接口类型能否承载自定义档位（spec 37：只有档位字段接受自由字符串的协议可以）。 */
export const adapterAllowsCustomTiers = (adapter: ProtocolAdapter | null): boolean =>
  adapter?.supports_custom_thinking_tiers === true;

/**
 * 档位名不合规时的提示。
 *
 * 范围与字符集取契约常量拼出，不写死数字：档位标识会被原样透传给厂商档位字段，只能用
 * 无空白、无引号的短标识，所以这句话必须在**输入时就**出现——名字里带空格、引号或中文
 * 的用户，光看「添加失败」猜不出规则。
 */
export const THINKING_TIER_NAME_INVALID_TEXT =
  `档位名只能用字母、数字、下划线或短横线，以字母或数字开头，最多 ${THINKING_TIER_NAME_MAX_LENGTH} 个字符`;

/**
 * 拖拽的读屏播报（dnd-kit 默认是英文串，直接漏进中文界面）。
 *
 * 位置用「第 N 位」表达：这是排序这件事里用户唯一关心的量，比报出相邻项名字更稳
 * （相邻项名字在快速移动时会与播报时点不一致）。
 */
const DRAG_ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `已拿起档位「${String(active.id)}」。用方向键移动位置，按空格放下，按 Esc 取消。`,
  onDragOver: ({ active, over }) => (over === null ? undefined : `档位「${String(active.id)}」移到「${String(over.id)}」的位置。`),
  onDragEnd: ({ active, over }) =>
    over === null
      ? `档位「${String(active.id)}」已放回原位。`
      : `档位「${String(active.id)}」已移到「${String(over.id)}」的位置。`,
  onDragCancel: ({ active }) => `已取消，档位「${String(active.id)}」回到原位。`,
};

const DRAG_INSTRUCTIONS = {
  draggable: '按空格或回车拿起档位，用方向键移动位置，按空格放下，按 Esc 取消。',
};

export function ThinkingTierFields({ idPrefix, selection }: { idPrefix: string; selection: ThinkingTierSelection }) {
  const { pool, adapter, choice, unavailable, onAdd, onRemove, onReorder, onSetDefault, onAddCustom, onDeleteCustom } = selection;
  const customAllowed = adapterAllowsCustomTiers(adapter);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const inPool = [...pool.builtin, ...pool.custom.map((item) => item.name)];
  const available = inPool.filter((tier) => !choice.tiers.includes(tier));
  const blockedCustom = available.filter((tier) => !pool.builtin.includes(tier) && !customAllowed);

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = choice.tiers.indexOf(String(active.id));
    const to = choice.tiers.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    console.debug('[provider-connection] 思考档位排序', { from, to });
    onReorder(arrayMove(choice.tiers, from, to));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span id={`${idPrefix}-thinking-label`} className="text-xs font-medium">思考档位</span>
        <InfoHint
          text="不启用任何档位就是「不思考」；设了默认档位，画布里会用它开始。"
          subject="思考档位"
        />
      </div>

      {unavailable ? (
        <p className="text-xs text-muted-foreground">思考档位暂时读不到，关掉这个窗口后点「刷新」再试。</p>
      ) : (
        <div className="flex flex-col gap-2" role="group" aria-labelledby={`${idPrefix}-thinking-label`}>
          <div className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">已启用（拖动排序）</span>
            {choice.tiers.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没有启用档位，只有「不思考」。</p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
                accessibility={{ announcements: DRAG_ANNOUNCEMENTS, screenReaderInstructions: DRAG_INSTRUCTIONS }}
              >
                <SortableContext items={choice.tiers} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-1">
                    {choice.tiers.map((tier) => (
                      <TierRow
                        key={tier}
                        tier={tier}
                        custom={!pool.builtin.includes(tier)}
                        isDefault={choice.defaultTier === tier}
                        onRemove={() => onRemove(tier)}
                        onSetDefault={() => onSetDefault(tier)}
                        onClearDefault={() => onSetDefault(null)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">可添加</span>
            {available.length === 0 ? (
              <p className="text-xs text-muted-foreground">所有可添加的档位都已经启用了。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {available.map((tier) => {
                  const blocked = blockedCustom.includes(tier);
                  const custom = !pool.builtin.includes(tier);
                  return (
                    <div key={tier} className="flex items-center gap-0.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-2xs"
                        aria-label={`启用档位「${tier}」`}
                        disabled={blocked}
                        onClick={() => onAdd(tier)}
                      >
                        {`＋ ${tier}`}
                      </Button>
                      {custom ? (
                        // 池子级的删除：自定义档位才有，内置常用档只读
                        <button
                          type="button"
                          aria-label={`删除档位「${tier}」`}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                          onClick={() => onDeleteCustom(tier)}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            {blockedCustom.length > 0 ? (
              <p className="text-2xs text-muted-foreground">
                {adapter === null
                  ? '先选好接口类型，再看能不能加自定义档位。'
                  : '当前接口类型不支持自定义档位。'}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {customAllowed ? (
        <div className="mt-1">
          <AddCustomTierRow onAdd={onAddCustom} />
        </div>
      ) : null}
    </div>
  );
}

/** 已启用档位的一行：拖动手柄 + 档位名 + 默认标记 + 移除。 */
function TierRow({
  tier,
  custom,
  isDefault,
  onRemove,
  onSetDefault,
  onClearDefault,
}: {
  tier: string;
  custom: boolean;
  isDefault: boolean;
  onRemove: () => void;
  onSetDefault: () => void;
  onClearDefault: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tier });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={
        // 行承载容器呼吸档（visual-design §8.6 律二）：px-3 py-2；可见性由表面阶梯承担，
        // 不靠 border（§9.1 边框退场——列表行禁用 border 建形状）
        'flex items-center gap-2 rounded-md bg-elevated px-3 py-2 '
        + (isDragging ? 'opacity-60' : '')
      }
    >
      <button
        type="button"
        aria-label={`拖动排序「${tier}」`}
        className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
        {...attributes}
        aria-roledescription="可拖动排序"
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{tier}</span>
      {custom ? <span className="shrink-0 text-2xs text-muted-foreground">自定义</span> : null}
      {isDefault ? (
        <>
          <span className="shrink-0 rounded-sm bg-muted px-1 text-2xs text-muted-foreground">默认档位</span>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-2xs" onClick={onClearDefault}>
            取消默认档位
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-2xs" onClick={onSetDefault}>
          设为默认档位
        </Button>
      )}
      <button
        type="button"
        aria-label={`移除档位「${tier}」`}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * 「加一个自定义档位」的输入行：档位字段里新增档位的唯一入口。
 *
 * 空值不提交、名字不合规当场说清规则、失败保留输入、提交期间按钮不可再点，四件事都只有这一份实现。
 */
function AddCustomTierRow({ onAdd }: { onAdd: (name: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const trimmed = draft.trim();
  // 与写入侧同一个 schema：输入时就能说清规则，不必等一次失败往返（口径同能力字段的越界提示）
  const nameValid = trimmed === '' || ThinkingTierSchema.safeParse(trimmed).success;

  const submit = (): void => {
    if (busy || trimmed === '' || !nameValid) return;
    setBusy(true);
    void onAdd(trimmed)
      .then((added) => {
        if (added) setDraft('');
      })
      .finally(() => setBusy(false));
  };

  return (
    // 字段行 label↔控件 8px（visual-design §8.6 律一：纵向字段行 gap-2）
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label="自定义档位名"
          className="h-8 flex-1 text-xs"
          placeholder="档位名，如 ultra"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <Button size="sm" variant="outline" disabled={busy || trimmed === '' || !nameValid} onClick={submit}>
          添加档位
        </Button>
      </div>
      {trimmed !== '' && !nameValid ? (
        <p className="text-2xs text-destructive">{THINKING_TIER_NAME_INVALID_TEXT}</p>
      ) : null}
      <p className="text-2xs text-muted-foreground">添加后，其他模型也能选它。</p>
    </div>
  );
}
